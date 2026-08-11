import { ToolRegistry } from '@agent-harness/core';
import {
  connectMcpServer,
  disconnectAllMcp,
  parseMcpServersEnv,
  getPreset,
  listPresets,
  headersForPreset,
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
  private initialized = false;
  /** 防止 shutdown 与 init 并发造成状态错乱的互斥锁。 */
  private initPromise: Promise<void> | null = null;

  /** 启动连接：从环境变量加载并接入所有已配置服务（不阻塞调用方）。 */
  init(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    // 共用 core 的解析入口（MCP_SERVERS JSON 与 MCP_SERVER_URL 兜底），
    // 每个 server 可独立携带 transport / command / args / headers。
    const list = parseMcpServersEnv();
    this.initialized = true;
    // 顺序连接，避免并发握手压垮免费服务；连接进度实时反映到 servers 列表。
    this.initPromise = (async () => {
      for (const s of list) {
        const meta = await connectMcpServer(this.registry, {
          name: s.name,
          serverUrl: s.serverUrl,
          command: s.command,
          args: s.args,
          env: s.env,
          headers: s.headers,
          transportType: s.transportType,
        });
        this.servers.push(meta);
      }
    })().catch((e) => console.error('[mcp-manager] init error:', e));
    return this.initPromise;
  }

  /**
   * 运行时新增一个 MCP 服务，返回其连接元数据。
   * 入参与 `parseMcpServersEnv` 同构（McpServerConfig），完整透传
   * serverUrl / command / args / env / headers / transportType，
   * 与启动期从环境变量加载的服务保持一致的配置能力。
   */
  async addServer(config: McpServerConfig): Promise<McpServerMeta> {
    // 先等待启动期连接完成，避免并发 push 与共享 registry 重复注册。
    await this.init();
    // 必填项校验：至少需要一个可识别的连接目标。
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
    // 同名服务则覆盖旧条目。
    const idx = this.servers.findIndex((s) => s.name === clean);
    if (idx >= 0) this.servers[idx] = meta;
    else this.servers.push(meta);
    return meta;
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
   *             按预设的 authType 拼装请求头，无 token 时返回空头（由服务决定是否可连）。
   */
  async connectPreset(id: string, token?: string): Promise<McpServerMeta> {
    await this.init();
    const preset = getPreset(id);
    if (!preset) {
      throw new Error(`[mcp-manager] 未知预设: ${id}`);
    }
    const headers = headersForPreset(preset, token);
    // 复用与 addServer 完全一致的连接路径（connectMcpServer），保持工具前缀等行为统一。
    return this.addServer({
      name: preset.id,
      serverUrl: preset.url,
      headers,
      transportType: preset.transportType,
    });
  }

  /** 当前所有 MCP 工具所在的共享注册表（供 Agent 运行合并）。 */
  liveRegistry(): ToolRegistry {
    return this.registry;
  }

  /** 关闭所有已接入的 MCP 连接（进程退出时调用）。 */
  async shutdown(): Promise<void> {
    // 等待可能的启动/接入流程结束，避免并发修改共享 registry / servers。
    await this.initPromise?.catch(() => {});
    await disconnectAllMcp().catch(() => {});
    this.servers = [];
    // 重置初始化标记，使单例在后续可重新 init（如测试或重启场景）。
    this.initialized = false;
    this.initPromise = null;
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
