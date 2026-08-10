/**
 * 让 agent 通过真实 LLM 驱动已接入的 Context7 MCP 工具。
 *
 * 演示「LLM ↔ MCP 工具」闭环：用户问一个库相关的问题，
 * agent 自己决定调用 resolve-library-id（来自 Context7 MCP），
 * 拿到真实返回后用中文总结——全程护栏/记忆/追踪自动生效。
 *
 * 运行：npm run use:context7（需要 OPENROUTER_API_KEY；无 key 退回 mock）
 */
import {
  AgentHarness,
  ToolRegistry,
  createOpenRouterLLM,
  registerMcpTools,
  loadEnv,
} from '../src/index';
import type { LLM } from '../src/index';

loadEnv();

async function main(): Promise<void> {
  const tools = new ToolRegistry();

  // 接入 Context7（MCP_SERVER_URL 已在 .env 指向 mcp.context7.com/mcp）
  try {
    await registerMcpTools(tools);
  } catch (e) {
    console.error('[use:context7] MCP not available (best-effort):', (e as Error).message);
  }

  const llm: LLM = process.env.OPENROUTER_API_KEY
    ? createOpenRouterLLM()
    : (async (_m, _t) => ({
        content:
          '（mock）已连上 Context7，工具列表见上方[mcp]日志；填入 OPENROUTER_API_KEY 即由真实模型调用。',
        tool_calls: [],
      }));

  const agent = new AgentHarness({
    llm,
    tools,
    systemPrompt:
      '你是文档助手。当用户询问某个库/框架时，优先调用 Context7 的 resolve-library-id 解析库 ID，' +
      '并据此用中文给出准确的库说明。',
  });

  const answer = await agent.run('帮我查一下 typescript 这个库的 Context7 库 ID 是什么？');
  console.log('\n=== 最终回复 ===\n' + answer);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
