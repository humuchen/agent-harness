import {
  AgentHarness,
  ToolRegistry,
  Memory,
  objectParams,
} from '../src/index';
import type { LLM, ToolCall } from '../src/index';

// --- 1. 注册工具 -----------------------------------------------------------
const tools = new ToolRegistry();

tools.register(
  'add',
  'Add two numbers and return the sum.',
  objectParams(
    {
      a: { type: 'number', description: 'first operand' },
      b: { type: 'number', description: 'second operand' },
    },
    ['a', 'b']
  ),
  async ({ a, b }) => ({ sum: Number(a) + Number(b) })
);

tools.register(
  'echo',
  'Echo back the provided text.',
  objectParams({ text: { type: 'string' } }, ['text']),
  async ({ text }) => ({ text })
);

// --- 2. 极简 Mock LLM（无需 API 密钥）--------------------------------------
// 仅用于演示契约。请替换为真实提供商。
const mockLLM: LLM = async (messages) => {
  const last = messages[messages.length - 1];
  const userText = last?.content ?? '';

  const addMatch = userText.match(/(\d+)\s*(加|\+|plus)\s*(\d+)/i);
  if (addMatch) {
    const a = Number(addMatch[1]);
    const b = Number(addMatch[3]);
    const call: ToolCall = {
      id: 'call_' + Date.now(),
      name: 'add',
      arguments: { a, b },
    };
    return { content: '', tool_calls: [call] };
  }

  return { content: `你说了：${userText}（这是 mock 回复）`, tool_calls: [] };
};

// --- 3. 组装 Harness 并运行 -----------------------------------------------
async function main(): Promise<void> {
  const memory = new Memory();
  const agent = new AgentHarness({
    llm: mockLLM,
    tools,
    memory,
    systemPrompt: '你是一个示例助手，会使用工具来回答问题。',
  });

  const r1 = await agent.run('帮我算一下 3 加 5 是多少');
  console.log('>> 帮我算一下 3 加 5 是多少');
  console.log('<<', r1, '\n');

  const r2 = await agent.run('我的 AKIA1234567890ABCDEF 密码别泄露');
  console.log('>> 我的 AKIA1234567890ABCDEF 密码别泄露');
  console.log('<<', r2, '\n');

  const r3 = await agent.run('随便说点什么');
  console.log('>> 随便说点什么');
  console.log('<<', r3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
