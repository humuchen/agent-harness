import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolRegistry } from '../../tools';
import { incCounter, structLog } from '../../telemetry';

export type McpTransportType = 'auto' | 'sse' | 'streamable-http';

/** MCP 服务健康状态（供 UI 可视化与运行时决策）。 */
export type McpHealth = 'unknown' | 'healthy' | 'unhealthy';

/**
 * 已连接 MCP 客户端的存活注册表。
 * 之前 connectMcpServer / registerMcpTools 创建 Client 后从不关闭，会泄漏连接
 *（尤其是 stdio 子进程与 SSE 长连接）。这里按服务名将 client + 其注册的工具名
 * 记录下来，供 disconnectMcpServer / disconnectAllMcp 在关闭或进程退出时清理。
 *
 * 升级：除连接生命周期外，这里还承载 **自动重连与健康探测**——
 * 远端 server 重启 / 网络抖动导致的静默失败会被自愈：工具调用失败时懒重连一次并重试，
 * 后台周期 ping 探测到失活则按指数退避自动重连，状态实时回写到 meta。
 */
interface ToolInfo {
  registeredName: string;
  originalName: string;
  description: string;
}

interface McpConnectionConfig {
  name: string;
  serverUrl?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  transportType?: McpTransportType;
  /** 是否由调用方提供现成 transport（如内存传输测试）。此情形下不可重连，仅保活。 */
  transportProvided: boolean;
}

interface LiveMcp {
  client: Client;
  registry: ToolRegistry;
  names: string[];
  tools: ToolInfo[];
  config: McpConnectionConfig;
  /** 与调用方（UI）共享的元数据对象，状态变更原地写回即被 UI 读取到。 */
  meta: McpServerMeta;
  /** 运行时连接状态（与 meta.status 同步写回）。 */
  status: 'connecting' | 'connected' | 'reconnecting' | 'error';
  /** 最近一次健康探测结果。 */
  health: McpHealth;
  /** 最近一次探测到健康的 Unix 毫秒时间戳。 */
  lastHealthyAt?: number | null;
  /** 最近一次错误信息。 */
  lastError?: string;
  reconnectAttempts: number;
  reconnecting: boolean;
  closed: boolean;
  probeTimer?: ReturnType<typeof setInterval>;
  /** 连续健康探测失败次数（达到阈值后才触发重连，避免单次探测抖动误伤） */
  consecutiveProbeFailures: number;
}

const liveClients = new Map<string, LiveMcp>();

// ---- 重连 / 健康探测的环境配置（企业可按需收紧） ----
const RECONNECT_ENABLED = (process.env.MCP_RECONNECT ?? 'true').toLowerCase() !== 'false';
const RECONNECT_MAX = Math.max(0, Number(process.env.MCP_RECONNECT_MAX ?? '5') || 0);
const RECONNECT_DELAY_MS = Math.max(200, Number(process.env.MCP_RECONNECT_DELAY_MS ?? '2000') || 200);
const HEALTH_INTERVAL_MS = Math.max(0, Number(process.env.MCP_HEALTH_INTERVAL_MS ?? '60000') || 0);
const HEALTH_TIMEOUT_MS = Math.max(500, Number(process.env.MCP_HEALTH_TIMEOUT_MS ?? '5000') || 500);

function storeEntry(key: string, entry: LiveMcp): void {
  const prev = liveClients.get(key);
  if (prev) {
    // 同名重连：先 best-effort 关闭旧连接与探测，避免残留。
    stopProbe(prev);
    prev.client.close().catch(() => {});
  }
  liveClients.set(key, entry);
}

/** 关闭指定 MCP 服务：移除其工具、停止探测并断开底层传输。返回是否真的有关闭动作。 */
export async function disconnectMcpServer(name: string): Promise<boolean> {
  const entry = liveClients.get(name);
  if (!entry) return false;
  entry.closed = true;
  stopProbe(entry);
  for (const n of entry.names) entry.registry.unregister(n);
  liveClients.delete(name);
  try {
    await entry.client.close();
  } catch {
    /* 关闭失败不应抛出 */
  }
  return true;
}

/** 关闭所有已接入的 MCP 服务（进程退出时调用）。 */
export async function disconnectAllMcp(): Promise<void> {
  const names = [...liveClients.keys()];
  for (const n of names) {
    await disconnectMcpServer(n).catch(() => {});
  }
}

export interface McpOptions {
  // 远程 MCP 服务器（SSE / Streamable HTTP）。优先级高于 `command`。
  serverUrl?: string;
  // 远程服务器的可选认证请求头。
  headers?: Record<string, string>;
  // 显式选择传输协议；默认 'auto'（URL 以 /sse 结尾走 SSE，否则走 Streamable HTTP）。
  transportType?: McpTransportType;
  // 以子进程方式启动的本地 MCP 服务器（stdio 传输）。
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // 已就绪的传输层（例如用于测试的内存传输）。
  // 提供后跳过新建连接，直接在此传输上连接客户端。
  transport?: Transport;
  // 向服务器报告的客户身份。
  name?: string;
  version?: string;
}

/** 单个 MCP 服务的连接元数据（用于 UI 可视化与运行时管理）。 */
export interface McpServerMeta {
  name: string;
  url?: string;
  command?: string;
  status: 'connecting' | 'connected' | 'reconnecting' | 'error';
  tools: { registeredName: string; originalName: string; description: string }[];
  error?: string;
  transportType?: McpTransportType;
  /** 最近一次健康探测结果（unknown=尚未探测）。 */
  health?: McpHealth;
  /** 最近一次探测到健康的 Unix 毫秒时间戳，未探测过为 null。 */
  lastHealthyAt?: number | null;
  /** 累计自动重连尝试次数。 */
  reconnectAttempts?: number;
}

/**
 * 预留 → 激活 MCP 插槽。
 *
 * 当配置了 MCP 服务器（通过 `serverUrl`、`command` 或环境变量
 * `MCP_SERVER_URL`）时，本函数会连接服务器，拉取其工具列表，并将
 * 每个工具注册到 Agent 的 ToolRegistry。由于每个 MCP 工具都会变成
 * 普通的 ToolRegistry 条目，因此已有的防护栏/记忆/追踪机制无需额外
 * 代码即可覆盖 MCP 来源的工具。
 *
 * 未配置服务器时为空操作 —— 集成点保持预留但永远不会抛出异常，
 * 因此即使尚未接入 MCP，Harness 也能正常运行。
 */
/**
 * 单个 MCP 服务的声明式配置（来自环境变量或调用方）。
 * 支持远程（serverUrl + 可选 headers/transportType）与本地 stdio
 * （command + args + env）两种形态，每个 server 独立携带自己的传输选项。
 */
export interface McpServerConfig {
  name: string;
  serverUrl?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  transportType?: McpTransportType;
}

/**
 * 从环境变量解析 MCP 服务清单，供 UI 与示例共用同一份解析逻辑。
 *
 * 优先级：
 *   1. `MCP_SERVERS`：JSON 数组，每项形如
 *      {"name":"context7","serverUrl":"https://mcp.context7.com/mcp","headers":{"X":"Y"},
 *       "transportType":"streamable-http"}
 *      或本地 stdio：
 *      {"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/data"]}
 *   2. `MCP_SERVER_URL`：单服务快捷配置，默认命名 "context7"（保持向后兼容）。
 *
 * 传 `env` 可避免污染 process.env，便于单元测试。
 */
export function parseMcpServersEnv(env: Record<string, string | undefined> = process.env): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  const raw = env.MCP_SERVERS?.trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const s of arr) {
          if (!s || (typeof s.serverUrl !== 'string' && typeof s.command !== 'string')) continue;
          const serverUrl = typeof s.serverUrl === 'string' ? s.serverUrl : undefined;
          const command = typeof s.command === 'string' ? s.command : undefined;
          out.push({
            name: typeof s.name === 'string' && s.name ? s.name : slugFromUrl(serverUrl ?? command ?? ''),
            serverUrl,
            command,
            args: Array.isArray(s.args) ? s.args.map(String) : undefined,
            env: s.env,
            headers: s.headers,
            transportType: (typeof s.transportType === 'string' ? s.transportType : undefined) as McpTransportType | undefined,
          });
        }
      }
    } catch {
      /* 损坏的 JSON 忽略，继续走单 URL 兜底 */
    }
  }
  const single = env.MCP_SERVER_URL?.trim();
  if (single && !out.some((c) => c.serverUrl === single)) {
    out.push({ name: 'context7', serverUrl: single });
  }
  return out;
}

/** 顺序接入一组 MCP 服务（单个失败不影响其余），返回各自的连接元数据。 */
export async function connectMcpServers(
  registry: ToolRegistry,
  configs: McpServerConfig[]
): Promise<McpServerMeta[]> {
  const metas: McpServerMeta[] = [];
  for (const c of configs) {
    metas.push(
      await connectMcpServer(registry, {
        name: c.name,
        serverUrl: c.serverUrl,
        command: c.command,
        args: c.args,
        env: c.env,
        headers: c.headers,
        transportType: c.transportType,
      })
    );
  }
  return metas;
}

function slugFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-zA-Z0-9]/g, '_');
  } catch {
    return 'mcp';
  }
}

/**
 * 建立一次 MCP 连接并将工具注册到 registry（不含存储 / 探测 / 重连状态）。
 * 注册的工具执行器具备「调用失败懒重连一次并重试」的韧性。
 * 返回重连所需的全部上下文（client / 注册名 / 工具信息）。
 */
async function establishConnection(
  registry: ToolRegistry,
  config: McpConnectionConfig,
  initialTransport?: Transport,
  timeoutMs?: number
): Promise<{ client: Client; names: string[]; toolsInfo: ToolInfo[] }> {
  const client = new Client({ name: 'agent-harness-ts', version: '0.1.0' });
  const conn = await connectMcpClient({
    serverUrl: config.serverUrl,
    command: config.command,
    useStdio: !config.serverUrl && !config.transportProvided && !!config.command,
    headers: config.headers,
    transport: initialTransport,
    transportType: config.transportType,
    args: config.args,
    env: config.env,
    client,
    name: config.name,
    timeoutMs,
  });
  const toolsInfo: ToolInfo[] = [];
  const names: string[] = [];
  for (const tool of conn.tools) {
    // 内存传输（测试）或旧的 registerMcpTools 路径不加前缀；多服务路径统一加 <server>__ 前缀。
    const registeredName = config.transportProvided ? tool.name : `${config.name}__${tool.name}`;
    const description = tool.description ?? '';
    const parameters = (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>;
    registry.register(
      registeredName,
      config.transportProvided ? description : `[${config.name}] ${description}`,
      parameters,
      makeResilientExecutor(config, tool.name),
      `mcp:${config.name}`
    );
    toolsInfo.push({ registeredName, originalName: tool.name, description });
    names.push(registeredName);
  }
  return { client: conn.client, names, toolsInfo };
}

/**
 * 生成 MCP 工具执行器：调用失败时先尝试一次自动重连，成功则重试，
 * 使远端 server 重启 / 连接抖动对运行中的 agent 透明自愈。
 */
function makeResilientExecutor(config: McpConnectionConfig, originalName: string): (args: any) => Promise<string> {
  const key = config.name;
  return async (args) => {
    const live = liveClients.get(key);
    if (!live || live.closed) throw new Error(`MCP server '${key}' not connected`);
    try {
      return await callAndStringify(live.client, originalName, args);
    } catch (e) {
      const recovered = await performReconnect(key);
      if (recovered) {
        const live2 = liveClients.get(key);
        if (live2 && !live2.closed) return await callAndStringify(live2.client, originalName, args);
      }
      throw e;
    }
  };
}

async function callAndStringify(client: Client, originalName: string, args: any): Promise<string> {
  const res = await client.callTool({ name: originalName, arguments: args });
  if ((res as any).isError) {
    throw new Error('MCP tool error: ' + JSON.stringify(res.content));
  }
  return mcpContentToString(res.content);
}

/**
 * 手动触发某 MCP 服务的重连（UI 按钮 / 运维脚本调用）。
 * 返回该服务最新的元数据（含重连后的状态）；服务不存在时返回 null。
 */
export async function reconnectMcpServer(name: string): Promise<McpServerMeta | null> {
  const entry = liveClients.get(name);
  if (!entry) return null;
  await performReconnect(name);
  return entry.meta;
}

/** 实际执行重连：关闭旧连接、重建客户端、重新注册工具、重启探测；失败按指数退避重试。 */
async function performReconnect(key: string): Promise<boolean> {
  const entry = liveClients.get(key);
  if (!entry || entry.closed || entry.reconnecting) return false;
  // 内存传输不可重连（无法重建传输层）。
  if (entry.config.transportProvided) return false;

  entry.reconnecting = true;
  entry.status = 'reconnecting';
  entry.meta.status = 'reconnecting';
  stopProbe(entry);

  try {
    try {
      await entry.client.close().catch(() => {});
    } catch {
      /* 旧连接可能已死，忽略关闭错误 */
    }
    for (const n of entry.names) entry.registry.unregister(n);

    const est = await establishConnection(entry.registry, entry.config);
    entry.client = est.client;
    entry.names = est.names;
    entry.tools = est.toolsInfo;
    entry.meta.tools = est.toolsInfo;
    entry.status = 'connected';
    entry.meta.status = 'connected';
    entry.health = 'healthy';
    entry.meta.health = 'healthy';
    entry.lastHealthyAt = Date.now();
    entry.meta.lastHealthyAt = Date.now();
    entry.lastError = undefined;
    entry.meta.error = undefined;
    entry.reconnectAttempts = 0;
    entry.meta.reconnectAttempts = 0;
    startProbe(entry, key);
    incCounter('mcp.reconnect.success');
    structLog('info', 'mcp server reconnected', { server: key, tools: est.toolsInfo.length });
    return true;
  } catch (e: any) {
    entry.status = 'error';
    entry.meta.status = 'error';
    entry.health = 'unhealthy';
    entry.meta.health = 'unhealthy';
    entry.lastError = e?.message ?? String(e);
    entry.meta.error = entry.lastError;
    entry.reconnectAttempts += 1;
    entry.meta.reconnectAttempts = entry.reconnectAttempts;
    incCounter('mcp.reconnect.fail');
    structLog('warn', 'mcp server reconnect failed', {
      server: key,
      attempt: entry.reconnectAttempts,
      error: entry.lastError,
    });
    // 未达上限则按指数退避（封顶 16x）后台重试。
    if (RECONNECT_ENABLED && entry.reconnectAttempts < RECONNECT_MAX) {
      const delay = RECONNECT_DELAY_MS * Math.pow(2, Math.min(entry.reconnectAttempts, 4));
      setTimeout(() => {
        void performReconnect(key);
      }, delay).unref?.();
    }
    return false;
  } finally {
    entry.reconnecting = false;
  }
}

/** 周期健康探测：ping（或 listTools 兜底）超时即判定失活并触发重连。 */
function startProbe(entry: LiveMcp, key: string): void {
  stopProbe(entry);
  // 内存传输或关闭探测时不挂定时器。
  if (HEALTH_INTERVAL_MS <= 0 || entry.config.transportProvided) return;
  entry.probeTimer = setInterval(() => {
    void probeOnce(entry, key);
  }, HEALTH_INTERVAL_MS);
  entry.probeTimer.unref?.();
}

function stopProbe(entry: LiveMcp): void {
  if (entry.probeTimer) {
    clearInterval(entry.probeTimer);
    entry.probeTimer = undefined;
  }
}

/** 健康探测连续失败 N 次后才触发重连，避免单次探测抖动误伤导致的连接闪断。 */
const PROBE_FAILURE_THRESHOLD = Math.max(1, Number(process.env.MCP_PROBE_FAILURE_THRESHOLD ?? '2') || 1);

async function probeOnce(entry: LiveMcp, key: string): Promise<void> {
  if (entry.closed || entry.reconnecting) return;
  const client = entry.client as any;
  const pingFn = typeof client.ping === 'function' ? client.ping.bind(client) : null;
  const probe = pingFn ? pingFn() : entry.client.listTools();
  try {
    await withTimeout(probe, HEALTH_TIMEOUT_MS);
    entry.health = 'healthy';
    entry.meta.health = 'healthy';
    entry.lastHealthyAt = Date.now();
    entry.meta.lastHealthyAt = entry.lastHealthyAt;
    entry.reconnectAttempts = 0;
    entry.meta.reconnectAttempts = 0;
    entry.consecutiveProbeFailures = 0;
  } catch {
    entry.consecutiveProbeFailures = (entry.consecutiveProbeFailures ?? 0) + 1;
    entry.health = 'unhealthy';
    entry.meta.health = 'unhealthy';
    incCounter('mcp.health.fail');
    // 仅在连续失败达到阈值时才触发重连，避免单次探测超时导致的误伤。
    if (entry.consecutiveProbeFailures >= PROBE_FAILURE_THRESHOLD) {
      structLog('warn', 'mcp health check failed, triggering reconnect', { server: key, failures: entry.consecutiveProbeFailures });
      entry.consecutiveProbeFailures = 0; // 重置，避免重复触发
      await performReconnect(key);
    } else {
      structLog('warn', 'mcp health check failed (will retry before reconnect)', { server: key, failures: entry.consecutiveProbeFailures, threshold: PROBE_FAILURE_THRESHOLD });
    }
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('health check timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * 包装 MCP 连接 / 工具列表请求的超时。
 * 在超时或出错时抛出包含 serverLabel + 操作阶段的明确错误信息，
 * 便于用户在 UI 上快速定位是哪个服务卡住。
 */
async function withMcpTimeout<T>(
  p: Promise<T>,
  ms: number,
  serverLabel: string,
  stage: 'connect' | 'listTools'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Request timed out (>${ms}ms) during ${stage}`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

export async function registerMcpTools(
  registry: ToolRegistry,
  opts: McpOptions = {}
): Promise<void> {
  const serverUrl = opts.serverUrl ?? process.env.MCP_SERVER_URL;
  const command = opts.command ?? process.env.MCP_COMMAND;
  const useStdio = !serverUrl && !opts.transport && !!command;

  // 认证头：显式传入优先，否则解析通用环境变量 MCP_HEADERS（逗号分隔 KEY=VALUE）。
  const headers = opts.headers ?? parseMcpHeaders(process.env.MCP_HEADERS);

  if (!serverUrl && !useStdio && !opts.transport) {
    console.log('[mcp] no MCP server configured (set MCP_SERVER_URL or pass serverUrl) — skipping');
    return;
  }

  const config: McpConnectionConfig = {
    name: '__default__',
    serverUrl,
    command,
    args: opts.args,
    env: opts.env,
    headers,
    transportType: opts.transportType,
    transportProvided: !!opts.transport,
  };

  try {
    const est = await establishConnection(registry, config, opts.transport);
    storeEntry('__default__', {
      client: est.client,
      registry,
      names: est.names,
      tools: est.toolsInfo,
      config,
      meta: {
        name: '__default__',
        url: serverUrl,
        command,
        status: 'connected',
        tools: est.toolsInfo,
        transportType: opts.transportType ?? 'auto',
        health: 'healthy',
        lastHealthyAt: Date.now(),
        reconnectAttempts: 0,
      },
      status: 'connected',
      health: 'healthy',
      lastHealthyAt: Date.now(),
      lastError: undefined,
      reconnectAttempts: 0,
      reconnecting: false,
      closed: false,
      consecutiveProbeFailures: 0,
    });
    // 内存传输（测试）不探测；远端/stdio 挂健康探测以自愈。
    const entry = liveClients.get('__default__');
    if (entry) startProbe(entry, '__default__');
    console.log(`[mcp] registered ${est.toolsInfo.length} tool(s) from MCP server`);
  } catch (e) {
    console.error(`[mcp] failed to connect to MCP server: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * 接入一个具名 MCP 服务，并将其工具注册到共享 ToolRegistry。
 * 工具名会加上 `<serverName>__` 前缀以避免多服务之间的命名冲突。
 * 返回元数据（状态、工具列表），不抛异常 —— 由调用方决定如何处理失败。
 * 接入成功后自动挂载健康探测与自动重连。
 */
export async function connectMcpServer(
  registry: ToolRegistry,
  opts: { name: string; serverUrl?: string; command?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string>; transportType?: McpTransportType; transport?: Transport }
): Promise<McpServerMeta> {
  const config: McpConnectionConfig = {
    name: opts.name,
    serverUrl: opts.serverUrl,
    command: opts.command,
    args: opts.args,
    env: opts.env,
    headers: opts.headers,
    transportType: opts.transportType,
    transportProvided: !!opts.transport,
  };
  const meta: McpServerMeta = {
    name: opts.name,
    url: opts.serverUrl,
    command: opts.command,
    status: 'connecting',
    tools: [],
    transportType: opts.transportType ?? 'auto',
    health: 'unknown',
    lastHealthyAt: null,
    reconnectAttempts: 0,
  };
  try {
    const est = await establishConnection(registry, config, opts.transport);
    storeEntry(opts.name, {
      client: est.client,
      registry,
      names: est.names,
      tools: est.toolsInfo,
      config,
      meta,
      status: 'connecting',
      health: 'unknown',
      lastHealthyAt: null,
      lastError: undefined,
      reconnectAttempts: 0,
      reconnecting: false,
      closed: false,
      consecutiveProbeFailures: 0,
    });
    meta.status = 'connected';
    meta.health = 'healthy';
    meta.lastHealthyAt = Date.now();
    meta.tools = est.toolsInfo;
    const entry = liveClients.get(opts.name);
    if (entry) startProbe(entry, opts.name);
    structLog('info', 'mcp server connected', { server: opts.name, tools: est.toolsInfo.length });
  } catch (e: any) {
    meta.status = 'error';
    meta.health = 'unhealthy';
    meta.error = e?.message ?? String(e);
    structLog('error', 'mcp server connect failed', { server: opts.name, error: meta.error });
  }
  return meta;
}

// 实际建立 MCP 连接并拉取工具列表（供 registerMcpTools / connectMcpServer 共用）。
async function connectMcpClient(args: {
  serverUrl?: string;
  command?: string;
  useStdio: boolean;
  headers?: Record<string, string>;
  transport?: Transport;
  transportType?: McpTransportType;
  args?: string[];
  env?: Record<string, string>;
  client: Client;
  name?: string;
  timeoutMs?: number;
}): Promise<{ client: Client; tools: any[] }> {
  const { serverUrl, command, useStdio, headers, transport, transportType, args: cmdArgs, env, client, name, timeoutMs } = args;
  // 可配置 MCP 连接超时（默认 15s）。过长会导致「添加服务」界面卡顿 —32001 超时误报。
  // 重连路径传入较短的 timeoutMs，避免健康探测周期内二次卡住。
  const MCP_CONNECT_TIMEOUT_MS = timeoutMs ?? Number(process.env.MCP_CONNECT_TIMEOUT_MS ?? 15000);
  const serverLabel = name ?? (serverUrl ? `URL ${serverUrl}` : (command ? `command ${command}` : 'unknown'));
  let connPromise: Promise<void>;
  if (transport) {
    connPromise = client.connect(transport);
  } else if (serverUrl) {
    let url: URL;
    try {
      url = new URL(serverUrl);
    } catch {
      throw new Error(
        `Invalid MCP server URL: "${serverUrl}" — a valid URL must include the protocol (e.g. "https://...")`,
      );
    }
    const tt = transportType ?? 'auto';
    const useSse = tt === 'sse' || (tt === 'auto' && url.pathname.endsWith('/sse'));
    const requestInit = headers ? { requestInit: { headers } } : undefined;
    if (useSse) {
      connPromise = client.connect(new SSEClientTransport(url, requestInit));
    } else {
      connPromise = client.connect(new StreamableHTTPClientTransport(url, requestInit));
    }
  } else if (useStdio && command) {
    // 重要：SDK 1.30 的 StdioClientTransport 在未显式传 env 时只继承「sudo 白名单」环境变量，
    // 自定义顶层 env（如 RAG_TRANSPORT / 各 server 的配置）不会被子进程继承，导致 stdio server
    // 以错误模式启动。此处显式兜底为 process.env（完整继承），确保顶层 env 配置始终生效；
    // 显式 env（MCP_SERVERS 条目 env 字段）仍优先，SDK 按 `{...白名单, ...显式env}` 合并，不丢 PATH。
    const childEnv: Record<string, string> | undefined =
      env ?? Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
    connPromise = client.connect(new StdioClientTransport({ command, args: cmdArgs, env: childEnv }));
  } else {
    throw new Error('未提供 MCP serverUrl / command / transport');
  }
  // 用超时包装 connect + listTools，避免单次卡住 60s 的 SDK 默认超时。
  try {
    await withMcpTimeout(connPromise, MCP_CONNECT_TIMEOUT_MS, serverLabel, 'connect');
    const list = await withMcpTimeout(client.listTools(), MCP_CONNECT_TIMEOUT_MS, serverLabel, 'listTools');
    return { client, tools: list.tools };
  } catch (e: any) {
    // 补充服务器上下文信息，便于排查。
    const detail = e?.message ?? String(e);
    throw new Error(`MCP server "${serverLabel}" ${detail}`);
  }
}

// 将 MCP 工具结果的内容块展平为 LLM 可读取的字符串。
function mcpContentToString(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(content);
}

// 解析 MCP_HEADERS 环境变量：逗号分隔的 KEY=VALUE 对，例如
// "CONTEXT7_API_KEY=abc,ANOTHER=xyz" → { CONTEXT7_API_KEY: "abc", ANOTHER: "xyz" }。
// 用于向远程 MCP 服务器注入认证头，无需改代码。
function parseMcpHeaders(raw?: string): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
