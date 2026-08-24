import {
  AgentHarness,
  ToolRegistry,
  Memory,
  createOpenRouterLLM,
  HarnessClient,
  registerHarnessTools,
  registerMcpTools,
  loadEnv,
  messageText,
} from '@agent-harness/core';
import type { LLM, ToolCall } from '@agent-harness/core';

loadEnv(); // load .env (git-ignored) if present; explicit env wins

// --- 1. 接入 Harness 自助环境工具 -------------------------------------------
const tools = new ToolRegistry();
const harness = new HarnessClient(); // reads env; dryRun when no HARNESS_API_KEY
registerHarnessTools(tools, harness);

// --- 2. 运行闭环 -----------------------------------------------------------
async function main(): Promise<void> {
  // 预留 MCP 插槽（在提供 MCP 服务器之前为空操作）。
  await registerMcpTools(tools);

  // 若已配置 OpenRouter API 密钥则使用真实 LLM，否则使用内置 Mock 驱动闭环。
  const llm: LLM = process.env.OPENROUTER_API_KEY
    ? createOpenRouterLLM()
    : makeMockEnvLLM();

  if (!process.env.OPENROUTER_API_KEY) {
    console.log(
      '[self-serve-env] No OPENROUTER_API_KEY — running with the built-in mock LLM.\n' +
        '  Set OPENROUTER_API_KEY to drive the loop with a real model: npm run chat\n'
    );
  }

  const agent = new AgentHarness({
    llm,
    tools,
    systemPrompt:
      '你是基础设施助手。用户需要临时/预览环境时，调用 create_ephemeral_environment；' +
      '环境用完后务必调用 destroy_environment 清理，避免资源浪费。',
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

// 一个极简的 Mock LLM，无需 API 密钥即可驱动 创建 ->（使用）-> 销毁 闭环。
// 获得密钥后请替换为 createOpenRouterLLM()。
function makeMockEnvLLM(): LLM {
  return async (messages) => {
    const last = messages[messages.length - 1];

    // destroy 工具执行完毕后，总结并结束。
    if (last?.role === 'tool' && last.name === 'destroy_environment') {
      const h = safeParse(messageText(last));
      return {
        content: `已完成闭环：临时环境 ${h.envId} 已创建并销毁，无残留资源。`,
        tool_calls: [],
      };
    }

    // create 工具执行完毕后，继续执行 destroy（模拟"回归已完成"）。
    if (last?.role === 'tool' && last.name === 'create_ephemeral_environment') {
      const h = safeParse(messageText(last));
      const call: ToolCall = {
        id: 'call_' + Date.now(),
        name: 'destroy_environment',
        arguments: { env_id: h.envId },
      };
      return { content: '', tool_calls: [call] };
    }

    // 首轮用户输入：解析意图并调用创建。
    const text = messageText(last);
    const branchMatch = text.match(/基于\s*([^\s,，]+)\s*分支/);
    const branch = branchMatch ? branchMatch[1] : 'main';
    const call: ToolCall = {
      id: 'call_' + Date.now(),
      name: 'create_ephemeral_environment',
      arguments: { env_type: 'ephemeral', branch, ttl_hours: 8 },
    };
    return { content: '', tool_calls: [call] };
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}
