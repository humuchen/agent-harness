'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry, objectParams } = require('../dist/tools.js');

// 构造一个贴近真实场景的注册表：18 个工具 + 一个明显与“打招呼”无关的代码类工具。
function buildRegistry() {
  const r = new ToolRegistry();
  const names = [
    'send_message', 'read_file', 'write_code', 'run_tests', 'query_database',
    'search_web', 'translate_text', 'summarize_doc', 'create_issue', 'close_issue',
    'schedule_meeting', 'send_email', 'fetch_url', 'parse_pdf', 'generate_image',
    'transcribe_audio', 'deploy_service', 'list_agents',
  ];
  for (const n of names) {
    r.register(n, `工具 ${n} 的较长描述用于模拟真实 agent 的高固定 prompt 开销，description 超过一百字以便验证 compactToolSchema 的截断逻辑是否生效并降低发送给模型的 token 数量`, objectParams({}), () => 'ok', 'harness');
  }
  return r;
}

test('打招呼仅发送极小工具子集（动态工具选择生效）', async () => {
  const registry = buildRegistry();
  const seenToolCounts = [];
  const seenCost = [];
  const mockLlm = async (messages, tools) => {
    seenToolCounts.push(tools.length);
    return {
      content: '你好！有什么可以帮你？',
      tool_calls: [],
      usage: { prompt_tokens: 800, completion_tokens: 20, total_tokens: 820 },
      model: 'mock-model',
    };
  };
  const harness = new AgentHarness({
    llm: mockLlm,
    tools: registry,
    systemPrompt: '你是助手。' + 'x'.repeat(400), // 模拟较长系统提示
    onEvent: (e) => {
      if (e.type === 'run:cost') seenCost.push(e);
    },
    model: 'mock-model',
  });
  process.env.DYNAMIC_TOOLS = 'true';
  process.env.DYNAMIC_TOOL_TOPK = '8';
  try {
    await harness.run('你好');
  } finally {
    delete process.env.DYNAMIC_TOOLS;
    delete process.env.DYNAMIC_TOOL_TOPK;
  }
  // 问候类输入不应把 18 个工具全量发给 LLM。
  assert.ok(seenToolCounts.length >= 1, '至少发生一次 LLM 调用');
  assert.ok(
    seenToolCounts[0] < registry.schemas().length,
    `首呼工具数应小于全量 ${registry.schemas().length}，实际 ${seenToolCounts[0]}`
  );
  // 成本事件应携带四项拆解，且工具项占比明显小于全量。
  assert.ok(seenCost.length >= 1, '应发出 run:cost');
  const est = seenCost[0].estTokens;
  assert.ok(est, 'estTokens 存在');
  assert.ok(est.tools < estimateFullTools(registry), '工具 token 应小于全量');
  assert.ok(est.system > 0 && est.completion > 0, '系统与输出项应大于 0');
});

function estimateFullTools(registry) {
  // 粗略对照：全量工具描述文本长度（用于断言子集更小）。
  return registry.schemas().reduce((a, s) => a + (s.name.length + s.description.length), 0);
}

test('真实任务输入发送相关子集（含代码类工具），而非全量', async () => {
  const registry = buildRegistry();
  const seenToolNames = [];
  const mockLlm = async (messages, tools) => {
    seenToolNames.push(tools.map((t) => t.name));
    return { content: '已完成', tool_calls: [], usage: { total_tokens: 100 }, model: 'mock-model' };
  };
  const harness = new AgentHarness({
    llm: mockLlm,
    tools: registry,
    onEvent: () => {},
    model: 'mock-model',
  });
  process.env.DYNAMIC_TOOLS = 'true';
  try {
    await harness.run('请帮我写一段代码并运行测试，验证是否通过？');
  } finally {
    delete process.env.DYNAMIC_TOOLS;
  }
  const first = seenToolNames[0];
  assert.ok(first.length > 0 && first.length < registry.schemas().length, `应发送相关子集而非全量 ${registry.schemas().length}，实际 ${first.length}`);
  assert.ok(first.includes('write_code'), `应含 write_code，实际 ${JSON.stringify(first)}`);
  assert.ok(first.includes('run_tests'), `应含 run_tests，实际 ${JSON.stringify(first)}`);
});

test('零匹配的真实任务回退全量工具（安全网，避免漏发）', async () => {
  const registry = buildRegistry();
  const seenToolCounts = [];
  const mockLlm = async (messages, tools) => {
    seenToolCounts.push(tools.length);
    return { content: 'ok', tool_calls: [], usage: { total_tokens: 100 }, model: 'mock-model' };
  };
  const harness = new AgentHarness({
    llm: mockLlm,
    tools: registry,
    onEvent: () => {},
    model: 'mock-model',
  });
  process.env.DYNAMIC_TOOLS = 'true';
  try {
    // 长且无任何工具关键词的输入（纯随机拉丁，不与中文工具描述重叠）：
    // 子集为空，触发“看起来像真实任务”的安全网回退全量。
    await harness.run('zxqwvbnm lkjhgfdsa poiuytrewq mnbvcxzlkjh asdfg qwertyuiop');
  } finally {
    delete process.env.DYNAMIC_TOOLS;
  }
  assert.ok(seenToolCounts[0] === registry.schemas().length, `应回退全量 ${registry.schemas().length}，实际 ${seenToolCounts[0]}`);
});
