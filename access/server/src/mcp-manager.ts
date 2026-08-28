import { ToolRegistry } from '@agent-harness/core';
import {
  connectMcpServer,
  disconnectAllMcp,
  reconnectMcpServer,
  parseMcpServersEnv,
  getPreset,
  listPresets,
  headersForPreset,
  envForPreset,
  type McpServerMeta,
  type McpServerConfig,
  type McpPreset,
} from '@agent-harness/core';

/**
 * MCP 服务的运行时管理器（单例）。
 *
 * - 持有一个共享 ToolRegistry，存放所有已接入 MCP 服务的工具（按服务前缀避免冲突），
 *   供每次 Agent 运行合并使用。
 * - 启动时从环境变量加载服务：
 *    - `MCP_SERVERS`：JSON 数组，形如 [{"name":"context7","url":"...","headers":{...}}]
 *    - `MCP_SERVER_URL`：单服务快捷配置，默认命名为 "context7"
 * - 运行时可通过 `addServer` 逐步添加更多服务（对应「后续逐步添加」的诉求）。
 */
class McpManager {
  private registry = new ToolRegistry();
  private servers: McpServerMeta[] = [];
  /** 各服务的原始连接配置，便于「引导期从未连上」时经 /api/mcp/reconnect 重新发起连接。 */
  private configs = new Map<string, McpServerConfig>();
  private initialized = false;
  /** 防止 shutdown 与 init 并发造成状态错乱的互斥锁。 */
  private initPromise: Promise<void> | null = null;
  /**
   * 变更串行化链：addServer / reconnect / connectPreset / init 的连接循环 / shutdown
   * 都通过 withLock 串行执行，确保同一时刻只有一个变更在改 `this.servers` 与共享
   * `registry`（消除并发 push / 重复注册竞态）。读操作（list / liveRegistry /
   * presets）不加锁，返回副本即可安全并发读。
   */
  private chain: Promise<unknown> = Promise.resolve();

  /** 把一次变更排入串行链；无论前序成败都接着执行，且链本身不会因异常断掉。 */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** 启动连接：从环境变量加载并接入所有已配置服务（不阻塞调用方）。 */
  init(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    // 共用 core 的解析入口（MCP_SERVERS JSON 与 MCP_SERVER_URL 兜底），
    // 每个 server 可独立携带 transport / command / args / headers。
    const list = parseMcpServersEnv();
    this.initialized = true;
    // 顺序连接，避免并发握手压垮免费服务；连接进度实时反映到 servers 列表。
    // 整个启动连接过程纳入串行链，确保后续运行时变更排在它之后。
    this.initPromise = this.withLock(async () => {
      for (const s of list) {
        this.configs.set(s.name, s);
        // 先放一个占位 meta（connecting），无论成败都保留可见状态，
        // 避免「单个服务连接失败」中断其余服务的接入。
        const placeholder: McpServerMeta = {
          name: s.name,
          status: 'connecting',
          health: 'unknown',
          tools: [],
          reconnectAttempts: 0,
        };
        this.servers.push(placeholder);
        try {
          const meta = await connectMcpServer(this.registry, {
            name: s.name,
            serverUrl: s.serverUrl,
            command: s.command,
            args: s.args,
            env: s.env,
            headers: s.headers,
            transportType: s.transportType,
          });
          Object.assign(placeholder, meta);
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          placeholder.status = 'error';
          placeholder.health = 'unhealthy';
          placeholder.error = msg;
          console.error(
            `[mcp-manager] 启动连接 MCP 服务 ${s.name} 失败（已跳过，其余服务继续）：`,
            msg
          );
        }
      }
    }).catch((e) => console.error('[mcp-manager] init error:', e));
    return this.initPromise;
  }

  /**
   * 运行时新增一个 MCP 服务，返回其连接元数据。
   * 入参与 `parseMcpServersEnv` 同构（McpServerConfig），完整透传
   * serverUrl / command / args / env / headers / transportType，
   * 与启动期从环境变量加载的服务保持一致的配置能力。
   */
  async addServer(config: McpServerConfig): Promise<McpServerMeta> {
    // 必填项校验：至少需要一个可识别的连接目标。
    if (!config.serverUrl && !config.command) {
      throw new Error(
        `[mcp-manager] addServer 需要至少一个连接目标 (serverUrl 或 command)，收到: ${JSON.stringify(config)}`
      );
    }
    return this.withLock(async () => {
      const clean = (config.name ?? '').trim() || this.slug(config.serverUrl ?? config.command ?? '');
      this.configs.set(clean, config);
      const meta = await connectMcpServer(this.registry, {
        name: clean,
        serverUrl: config.serverUrl,
        command: config.command,
        args: config.args,
        env: config.env,
        headers: config.headers,
        transportType: config.transportType,
      });
      // 同名服务则覆盖旧条目。
      const idx = this.servers.findIndex((s) => s.name === clean);
      if (idx >= 0) this.servers[idx] = meta;
      else this.servers.push(meta);
      return meta;
    });
  }

  /**
   * 后台接入 MCP 服务（非阻塞）：立刻返回一个「connecting」占位 meta，
   * 然后异步执行 connectMcpServer；连接结果通过后续 refresh / 健康探测反映到状态上。
   * 用于「添加服务」API 响应，避免因 stdio 服务器启动耗时（如 uvx 下载包）
   * 而阻塞 HTTP 响应 — 用户立即可见「连接中」，刷新后或自动探测到最终状态。
   */
  addServerBackground(config: McpServerConfig): McpServerMeta {
    if (!config.serverUrl && !config.command) {
      throw new Error(
        `[mcp-manager] addServerBackground 需要至少一个连接目标 (serverUrl 或 command)，收到: ${JSON.stringify(config)}`
      );
    }
    const clean = (config.name ?? '').trim() || this.slug(config.serverUrl ?? config.command ?? '');
    this.configs.set(clean, config);
    // 同步推入占位 meta，立即可见。
    const idx = this.servers.findIndex((s) => s.name === clean);
    const placeholder: McpServerMeta = {
      name: clean,
      url: config.serverUrl,
      command: config.command,
      status: 'connecting',
      health: 'unknown',
      tools: [],
      transportType: config.transportType ?? 'auto',
      reconnectAttempts: 0,
    };
    if (idx >= 0) this.servers[idx] = placeholder;
    else this.servers.push(placeholder);
    // 异步执行 — 不阻塞 HTTP 响应。
    this.withLock(async () => {
      const meta = await connectMcpServer(this.registry, {
        name: clean,
        serverUrl: config.serverUrl,
        command: config.command,
        args: config.args,
        env: config.env,
        headers: config.headers,
        transportType: config.transportType,
      });
      const i = this.servers.findIndex((s) => s.name === clean);
      if (i >= 0) this.servers[i] = meta;
      else this.servers.push(meta);
      return meta;
    });
    return placeholder;
  }

  list(): McpServerMeta[] {
    // 返回副本，避免调用方直接篡改内部状态。
    return [...this.servers];
  }

  /** 返回开箱预设的远端 MCP 清单（用于前端「预设市场 / 一键接入」）。 */
  presets(): McpPreset[] {
    return listPresets();
  }

  /**
   * 一键接入一个预设 MCP 服务。
   * @param id 预设 id（见 MCP_PRESETS）
   * @param token 可选鉴权令牌（GitHub PAT / Composio ck_ / Context7 key 等）；
   *             按预设的 authType 拼装请求头或环境变量，无 token 时不注入。
   */
  async connectPreset(id: string, token?: string): Promise<McpServerMeta> {
    const preset = getPreset(id);
    if (!preset) {
      throw new Error(`[mcp-manager] 未知预设: ${id}`);
    }
    const headers = headersForPreset(preset, token);
    const env = envForPreset(preset, token);
    // HTTP 预设用 serverUrl + headers；stdio 预设用 command + args + env。
    const cfg: McpServerConfig = {
      name: preset.id,
      serverUrl: preset.url,
      command: preset.command,
      args: preset.args,
      env: env ?? preset.env,
      headers,
      transportType: preset.transportType,
    };
    // 使用非阻塞接入：返回「connecting」占位状态，连接异步执行。
    // addServerBackground 内部通过 withLock 串行化异步连接。
    return this.addServerBackground(cfg);
  }

  /** 当前所有 MCP 工具所在的共享注册表（供 Agent 运行合并）。 */
  liveRegistry(): ToolRegistry {
    return this.registry;
  }

  /**
   * 手动触发某 MCP 服务的重连（远端 server 重启 / 网络抖动后运维介入）。
   * 调用 core 的 reconnectMcpServer，重连后状态原地写回共享 meta，
   * list() 即刻反映最新状态。返回重连后的元数据；服务未知时抛错。
   */
  async reconnect(name: string): Promise<McpServerMeta> {
    return this.withLock(async () => {
      // 优先走 core 的 live-connection 重连（已连上过、探测失活的服务）。
      const coreMeta = await reconnectMcpServer(name);
      if (coreMeta) {
        const idx = this.servers.findIndex((s) => s.name === name);
        if (idx >= 0) this.servers[idx] = coreMeta;
        else this.servers.push(coreMeta);
        return coreMeta;
      }
      // 兜底：引导期从未连上（不在 liveClients 中）的服务，用保存的配置重新发起连接。
      const cfg = this.configs.get(name);
      if (!cfg) {
        throw new Error(`[mcp-manager] 未知 MCP 服务: ${name}`);
      }
      return await this.addServerUnguarded(cfg);
    });
  }

  /** 关闭所有已接入的 MCP 连接（进程退出时调用）。 */
  async shutdown(): Promise<void> {
    await this.withLock(async () => {
      // 等待可能的启动/接入流程结束，避免并发修改共享 registry / servers。
      await this.initPromise?.catch(() => {});
      await disconnectAllMcp().catch(() => {});
      this.servers = [];
      // 重置初始化标记，使单例在后续可重新 init（如测试或重启场景）。
      this.initialized = false;
      this.initPromise = null;
    });
  }

  /**
   * 不加锁的连接写入（仅内部调用）：供 connectPreset 在已加锁的上下文里复用 addServer 逻辑，
   * 避免 withLock 嵌套。
   */
  private async addServerUnguarded(config: McpServerConfig): Promise<McpServerMeta> {
    if (!config.serverUrl && !config.command) {
      throw new Error(
        `[mcp-manager] addServer 需要至少一个连接目标 (serverUrl 或 command)，收到: ${JSON.stringify(config)}`
      );
    }
    const clean = (config.name ?? '').trim() || this.slug(config.serverUrl ?? config.command ?? '');
    const meta = await connectMcpServer(this.registry, {
      name: clean,
      serverUrl: config.serverUrl,
      command: config.command,
      args: config.args,
      env: config.env,
      headers: config.headers,
      transportType: config.transportType,
    });
    const idx = this.servers.findIndex((s) => s.name === clean);
    if (idx >= 0) this.servers[idx] = meta;
    else this.servers.push(meta);
    return meta;
  }

  // 环境变量的解析已统一到 core 的 parseMcpServersEnv()，本类不再重复实现。

  private slug(url: string): string {
    try {
      const u = new URL(url);
      return u.hostname.replace(/[^a-zA-Z0-9]/g, '_');
    } catch {
      return 'mcp';
    }
  }
}

export const mcpManager = new McpManager();
