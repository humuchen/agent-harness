import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolRegistry } from '../../tools';

export interface McpOptions {
  // 远程 MCP 服务器（SSE / HTTP）。优先级高于 `command`。
  serverUrl?: string;
  // 远程服务器的可选认证请求头。
  headers?: Record<string, string>;
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

  if (!serverUrl && !useStdio && !opts.transport) {
    console.log('[mcp] no MCP server configured (set MCP_SERVER_URL or pass serverUrl) — skipping');
    return;
  }

  const client = new Client({
    name: opts.name ?? 'agent-harness-ts',
    version: opts.version ?? '0.1.0',
  });

  try {
    if (opts.transport) {
      // 已就绪的传输层（测试/注入用）—直接在其上连接。
      await client.connect(opts.transport);
    } else if (serverUrl) {
      const url = new URL(serverUrl);
      await client.connect(
        new SSEClientTransport(url, opts.headers ? { requestInit: { headers: opts.headers } } : undefined)
      );
    } else {
      await client.connect(
        new StdioClientTransport({
          command: command!,
          args: opts.args,
          env: opts.env,
        })
      );
    }

    const list = await client.listTools();
    for (const tool of list.tools) {
      const name = tool.name;
      const description = tool.description ?? '';
      const parameters = (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>;
      registry.register(name, description, parameters, async (args) => {
        const res = await client.callTool({ name, arguments: args });
        if ((res as any).isError) {
          throw new Error('MCP tool error: ' + JSON.stringify(res.content));
        }
        return mcpContentToString(res.content);
      });
    }
    console.log(`[mcp] registered ${list.tools.length} tool(s) from MCP server`);
  } catch (e) {
    console.error(`[mcp] failed to connect to MCP server: ${(e as Error).message}`);
    throw e;
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
