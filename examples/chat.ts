/**
 * @file chat.ts - 多轮对话示例
 * @description 展示如何实现带上下文的连续对话
 * @difficulty 🟢 入门级
 *
 * 使用场景:
 * - 多轮对话交互
 * - 上下文保持
 * - 对话历史管理
 *
 * 运行方式:
 *   npx tsx chat.ts
 *
 * 核心概念:
 * 1. 创建对话会话
 * 2. 发送多条消息
 * 3. 保持上下文连贯性
 */

import {
  AgentHarness,
  ToolRegistry,
  createOpenRouterLLM,
  HarnessClient,
  registerHarnessTools,
  registerMcpTools,
  loadEnv
} from '@agent-harness/core';
import type { LLM } from '@agent-harness/core';

loadEnv(); // load .env (git-ignored) if present; explicit env wins

// 使用 OpenRouter + Harness 自助环境闭环的端到端真实运行。
// 运行：npm run chat
// 需要在环境中设置 OPENROUTER_API_KEY（参见 .env.example）。

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      '\n[chat] OPENROUTER_API_KEY is not set — cannot run a real LLM turn.\n' +
        '  1. Get a key at https://openrouter.ai/keys\n' +
        '  2. Export it:  export OPENROUTER_API_KEY=sk-or-...\n' +
        '     (or copy .env.example to .env and fill it in)\n' +
        '  3. Re-run:     npm run chat\n'
    );
    process.exit(2);
  }

  const tools = new ToolRegistry();
  const harness = new HarnessClient(); // dry-run unless HARNESS_API_KEY set
  registerHarnessTools(tools, harness);
  await registerMcpTools(tools); // no-op until MCP_SERVERS / MCP_SERVER_URL is configured

  const llm: LLM = createOpenRouterLLM();

  const agent = new AgentHarness({
    llm,
    tools,
    systemPrompt:
      '你是基础设施助手。用户需要临时/预览环境时，调用 create_ephemeral_environment；' +
      '环境用完后务必调用 destroy_environment 清理，避免资源浪费。'
  });

  const result = await agent.run(
    '帮我在测试环境基于 feature/login 分支拉起一个临时环境，跑完回归后帮我销毁'
  );
  console.log('\n=== AGENT FINAL ===\n' + result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
