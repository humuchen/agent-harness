/**
 * 验证 #3：把 agent 接上真实的 Context7 远程 MCP 服务器。
 *
 * Context7 官方端点 https://mcp.context7.com/mcp 使用 Streamable HTTP 协议，
 * 基础使用无需 key（高配额才需要 CONTEXT7_API_KEY）。本脚本：
 *   1. 连接 context7 的 streamable-http 端点
 *   2. 列出其工具并注册进 ToolRegistry
 *   3. 真实调用一次 resolve-library-id，证明端到端打通
 *
 * 运行：npm run verify:context7
 */
import { ToolRegistry, registerMcpTools } from '../src/index';

const CONTEXT7_URL = 'https://mcp.context7.com/mcp';

async function main(): Promise<void> {
  const registry = new ToolRegistry();

  const headers = process.env.CONTEXT7_API_KEY
    ? { CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY }
    : undefined;

  console.log(`[context7] connecting to ${CONTEXT7_URL} (transport: streamable-http)...`);
  await registerMcpTools(registry, {
    serverUrl: CONTEXT7_URL,
    headers,
  });

  const names = registry.schemas().map((t) => t.name);
  console.log('[context7] registered tools:', names);

  if (!registry.has('resolve-library-id')) {
    throw new Error('resolve-library-id tool missing — connection may be partial');
  }

  console.log('\n[context7] calling resolve-library-id(libraryName="typescript") ...');
  const result = await registry.call('resolve-library-id', {
    libraryName: 'typescript',
    query: 'compile ts to js with tsc',
  });
  console.log('result:\n', result);

  console.log('\n[context7] OK — MCP integration verified end-to-end.');
}

main().catch((e) => {
  console.error('[context7] FAILED:', e);
  process.exit(1);
});
