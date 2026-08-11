import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolRegistry } from '../../tools';

export type McpTransportType = 'auto' | 'sse' | 'streamable-http';

/**
 * 已连接 MCP 客户端的存活注册表。
 * 之前 connectMcpServer / registerMcpTools 创建 Client 后从不关闭，会泄漏连接
 *（尤其是 stdio 子进程与 SSE 长连接）。这里按服务名将 client + 其注册的工具名
 * 记录下来，供 disconnectMcpServer / disconnectAllMcp 在关闭或进程退出时清理。
 */
interface LiveMcp {
  client: Client;
  registry: ToolRegistry;
  names: string[];
}
const liveClients = new Map<string, LiveMcp>();

function storeClient(key: string, client: Client, registry: ToolRegistry, names: string[]): void {
  const prev = liveClients.get(key);
  if (prev) {
    // 同名重连：先 best-effort 关闭旧连接，避免残留。
    prev.client.close().catch(() => {});
  }
  liveClients.set(key, { client, registry, names });
}

/** 关闭指定 MCP 服务：移除其工具并断开底层传输。返回是否真的有关闭动作。 */
export async function disconnectMcpServer(name: string): Promise<boolean> {
  const entry = liveClients.get(name);
  if (!entry) return false;
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
  status: 'connecting' | 'connected' | 'error';
  tools: { registeredName: string; originalName: string; description: string }[];
  error?: string;
  transportType?: McpTransportType;
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

  const client = new Client({
    name: opts.name ?? 'agent-harness-ts',
    version: opts.version ?? '0.1.0',
  });

  try {
    const { client: connected, tools } = await connectMcpClient({
      serverUrl,
      command,
      useStdio,
      headers,
      transport: opts.transport,
      transportType: opts.transportType,
      client,
    });
    for (const tool of tools) {
      const name = tool.name;
      const description = tool.description ?? '';
      const parameters = (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>;
      registry.register(name, description, parameters, async (args) => {
        const res = await connected.callTool({ name, arguments: args });
        if ((res as any).isError) {
          throw new Error('MCP tool error: ' + JSON.stringify(res.content));
        }
        return mcpContentToString(res.content);
      }, 'mcp');
    }
    console.log(`[mcp] registered ${tools.length} tool(s) from MCP server`);
    storeClient('__default__', connected, registry, tools.map((t) => t.name));
  } catch (e) {
    console.error(`[mcp] failed to connect to MCP server: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * 接入一个具名 MCP 服务，并将其工具注册到共享 ToolRegistry。
 * 工具名会加上 `<serverName>__` 前缀以避免多服务之间的命名冲突。
 * 返回元数据（状态、工具列表），不抛异常 —— 由调用方决定如何处理失败。
 */
export async function connectMcpServer(
  registry: ToolRegistry,
  opts: { name: string; serverUrl?: string; command?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string>; transportType?: McpTransportType; transport?: Transport }
): Promise<McpServerMeta> {
  const meta: McpServerMeta = {
    name: opts.name,
    url: opts.serverUrl,
    command: opts.command,
    status: 'connecting',
    tools: [],
    transportType: opts.transportType ?? 'auto',
  };
  const serverUrl = opts.serverUrl;
  const command = opts.command;
  const useStdio = !serverUrl && !opts.transport && !!command;
  try {
    const client = new Client({ name: 'agent-harness-ts', version: '0.1.0' });
    const { client: connected, tools } = await connectMcpClient({
      serverUrl,
      command,
      useStdio,
      headers: opts.headers,
      transport: opts.transport,
      transportType: opts.transportType,
      client,
    });
    for (const tool of tools) {
      const registeredName = `${opts.name}__${tool.name}`;
      const description = tool.description ?? '';
      const parameters = (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>;
      registry.register(
        registeredName,
        `[${opts.name}] ${description}`,
        parameters,
        async (args) => {
          const res = await connected.callTool({ name: tool.name, arguments: args });
          if ((res as any).isError) {
            throw new Error('MCP tool error: ' + JSON.stringify(res.content));
          }
          return mcpContentToString(res.content);
        },
        `mcp:${opts.name}`
      );
      meta.tools.push({ registeredName, originalName: tool.name, description });
    }
    meta.status = 'connected';
    storeClient(opts.name, connected, registry, meta.tools.map((t) => t.registeredName));
    console.log(`[mcp] server '${opts.name}' connected with ${meta.tools.length} tool(s)`);
  } catch (e: any) {
    meta.status = 'error';
    meta.error = e?.message ?? String(e);
    console.error(`[mcp] server '${opts.name}' failed: ${meta.error}`);
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
}): Promise<{ client: Client; tools: any[] }> {
  const { serverUrl, command, useStdio, headers, transport, transportType, args: cmdArgs, env, client } = args;
  if (transport) {
    await client.connect(transport);
  } else if (serverUrl) {
    const url = new URL(serverUrl);
    const tt = transportType ?? 'auto';
    const useSse = tt === 'sse' || (tt === 'auto' && url.pathname.endsWith('/sse'));
    const requestInit = headers ? { requestInit: { headers } } : undefined;
    if (useSse) {
      await client.connect(new SSEClientTransport(url, requestInit));
    } else {
      await client.connect(new StreamableHTTPClientTransport(url, requestInit));
    }
  } else if (useStdio && command) {
    await client.connect(new StdioClientTransport({ command, args: cmdArgs, env }));
  } else {
    throw new Error('未提供 MCP serverUrl / command / transport');
  }
  const list = await client.listTools();
  return { client, tools: list.tools };
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
