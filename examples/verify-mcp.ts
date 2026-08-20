/**
 * 自包含验证 #3：MCP 工具接入。
 *
 * 不依赖任何外部 MCP 服务器 —— 我们用 SDK 的 InMemoryTransport 在同一进程内
 * 起一个真实的 MCP Server（暴露 echo_tool），再把它的客户端传输注入
 * `registerMcpTools`，证明：
 *   1) 能连接并 listTools
 *   2) 每个工具被注册进 ToolRegistry
 *   3) 通过 Registry 调用工具会真正打到 MCP Server 并拿回结果
 * 这正是 registerMcpTools 通过解析（MCP_SERVERS / MCP_SERVER_URL 兜底）自动接入 MCP 的同一代码路径。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerMcpTools, ToolRegistry } from '@agent-harness/core';

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('❌ FAIL:', msg);
    process.exit(1);
  }
  console.log('✅', msg);
}

async function main() {
  console.log('\n=== 验证 #3: MCP 工具接入（进程内真实 MCP Server）===');

  // 1) 在进程内起一个 MCP Server，注册一个 echo_tool
  const server = new Server(
    { name: 'demo-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo_tool',
        description: '回显传入的消息',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const args = (req.params.arguments ?? {}) as { message?: string };
    return { content: [{ type: 'text', text: `echo: ${args.message ?? ''}` }] };
  });

  // 2) 建立内存传输对：server 端 + client 端
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  // 3) 复用真实的 registerMcpTools，注入 client 端传输（与外部 server 同一条代码路径）
  const registry = new ToolRegistry();
  await registerMcpTools(registry, { transport: clientTransport });

  // 4) 验证工具被注册
  assert(registry.has('echo_tool'), 'echo_tool 已注册进 ToolRegistry');
  assert(registry.schemas().length === 1, `ToolRegistry 含 ${registry.schemas().length} 个工具`);

  // 5) 通过 Registry 调用，确认真正打通到 MCP Server
  const out = (await registry.call('echo_tool', { message: 'hello-mcp' })) as string;
  assert(
    typeof out === 'string' && out.includes('hello-mcp'),
    `调用 MCP 工具返回预期结果 (实际: ${out})`
  );

  console.log('\n🎉 #3 验证通过：MCP 接入链路（连接→list→注册→调用）完全打通。');
}

main().catch((e) => {
  console.error('验证异常:', e);
  process.exit(1);
});
