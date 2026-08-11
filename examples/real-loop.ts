import {
  AgentHarness,
  ToolRegistry,
  createOpenRouterLLM,
  HarnessClient,
  registerHarnessTools,
  registerMcpTools,
  loadEnv,
} from '@agent-harness/core';
import type { LLM } from '@agent-harness/core';

loadEnv(); // load .env (git-ignored) if present; explicit env wins

// 使用 OpenRouter 的真实多轮闭环（Harness 为干跑模式）：
//   第 1 轮：用户请求创建环境 -> Agent 调用 create_ephemeral_environment
//   第 2 轮：用户表示回归已完成 -> Agent 调用 destroy_environment
// 运行：npm run real-loop（需要 OPENROUTER_API_KEY）

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[real-loop] set OPENROUTER_API_KEY first (see .env.example)');
    process.exit(2);
  }

  const tools = new ToolRegistry();
  const harness = new HarnessClient(); // dry-run unless HARNESS_API_KEY set
  registerHarnessTools(tools, harness);
  // MCP 接入为 best-effort：连不上（如 context7 抖动）也不影响环境闭环。
  try {
    await registerMcpTools(tools);
  } catch (e) {
    console.error('[real-loop] MCP integration skipped (best-effort):', (e as Error).message);
  }

  const llm: LLM = createOpenRouterLLM();
  const agent = new AgentHarness({
    llm,
    tools,
    systemPrompt:
      '你是基础设施助手。用户需要临时/预览环境时，调用 create_ephemeral_environment；' +
      '用户确认回归完成后，调用 destroy_environment 清理，避免资源浪费。',
  });

  const t1 = await agent.run('帮我在测试环境基于 feature/login 分支拉起一个临时环境');
  console.log('\n=== TURN 1 最终回复 ===\n' + t1);

  const t2 = await agent.run('回归已经跑完了，帮我把这个环境销毁掉');
  console.log('\n=== TURN 2 最终回复 ===\n' + t2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
