'use strict';
// 启发式上下文压缩摘要（CONTEXT_COMPRESSION=heuristic）测试。
//   1) createHeuristicSummarizer 抽取 user/assistant/tool 事实
//   2) 与 previous 增量合并
//   3) 跳过 system 摘要节点
//   4) 超长截断到有界长度
//   5) 空 evicted 返回 previous
//   6) Memory 配 summarizer：窗口溢出产生【历史摘要】节点
//   7) Memory 无 summarizer：溢出直接丢弃不产生摘要节点
//   8) harness 默认开启启发式摘要（长对话超窗后产生【历史摘要】）
//   9) CONTEXT_COMPRESSION=off 退回直接丢弃
// 零依赖（node:test + node:assert），直接 require 编译产物。
const test = require('node:test');
const assert = require('node:assert');

const { Memory, createHeuristicSummarizer, MAX_SUMMARY_CHARS } = require('../dist/memory.js');
const { AgentHarness } = require('../dist/harness.js');

// env 沙箱：保存/恢复，避免测试间串扰。
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

function hasSummaryNode(msgs) {
  return msgs.some(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('【历史摘要】')
  );
}

// ---------------------------------------------------------------------------
// createHeuristicSummarizer 单元测试
// ---------------------------------------------------------------------------
test('启发式摘要：抽取 user/assistant/tool 事实', () => {
  const sum = createHeuristicSummarizer();
  const evicted = [
    { role: 'user', content: '帮我查一下天气' },
    { role: 'assistant', content: '好的，我来查' },
    { role: 'tool', name: 'weather', content: '北京晴 25度' },
    { role: 'assistant', content: '北京今天晴，25度' },
  ];
  const out = sum({ previous: null, evicted });
  assert.match(out, /用户: 帮我查一下天气/);
  assert.match(out, /助手: 好的，我来查/);
  assert.match(out, /工具weather: 北京晴 25度/);
  assert.match(out, /助手: 北京今天晴，25度/);
});

test('启发式摘要：与 previous 增量合并', () => {
  const sum = createHeuristicSummarizer();
  const out = sum({
    previous: '用户: 之前问过A',
    evicted: [{ role: 'user', content: '现在问B' }],
  });
  assert.match(out, /之前问过A/);
  assert.match(out, /现在问B/);
});

test('启发式摘要：跳过 system 摘要节点', () => {
  const sum = createHeuristicSummarizer();
  const out = sum({ previous: null, evicted: [{ role: 'system', content: '【历史摘要】旧的' }] });
  assert.equal(out, '', 'system 摘要节点应跳过');
});

test('启发式摘要：超长截断到有界长度', () => {
  const sum = createHeuristicSummarizer();
  const evicted = [];
  for (let i = 0; i < 20; i++) evicted.push({ role: 'user', content: '很长的内容'.repeat(50) });
  const out = sum({ previous: null, evicted });
  assert.ok(out.length <= MAX_SUMMARY_CHARS, `摘要长度应 <= ${MAX_SUMMARY_CHARS}，实际 ${out.length}`);
});

test('启发式摘要：空 evicted 返回 previous', () => {
  const sum = createHeuristicSummarizer();
  assert.equal(sum({ previous: '保留', evicted: [] }), '保留');
  assert.equal(sum({ previous: null, evicted: [] }), '');
});

// ---------------------------------------------------------------------------
// Memory 集成测试
// ---------------------------------------------------------------------------
test('Memory 配 summarizer：窗口溢出产生【历史摘要】节点', () => {
  const m = new Memory({ maxWindow: 4, summarizer: createHeuristicSummarizer() });
  for (let i = 0; i < 6; i++) m.add({ role: 'user', content: `问题${i}` });
  assert.ok(hasSummaryNode(m.history()), '窗口溢出应产生历史摘要节点');
});

test('Memory 无 summarizer：溢出直接丢弃不产生摘要节点', () => {
  const m = new Memory({ maxWindow: 4 });
  for (let i = 0; i < 6; i++) m.add({ role: 'user', content: `问题${i}` });
  assert.ok(!hasSummaryNode(m.history()), '未配 summarizer 不应产生摘要节点');
});

// ---------------------------------------------------------------------------
// harness 接线测试（行为方式）
// ---------------------------------------------------------------------------
function makeCaptureLLM(captured) {
  return async (messages) => {
    captured.push(messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '[blocks]' })));
    return { content: '好的', tool_calls: [] };
  };
}

test('harness 默认开启启发式摘要：长对话超窗后产生【历史摘要】', async () => {
  await withEnv({ CONTEXT_COMPRESSION: undefined }, async () => {
    const captured = [];
    const h = new AgentHarness({ llm: makeCaptureLLM(captured), tools: new (require('../dist/tools.js').ToolRegistry)() });
    // 默认 maxWindow=20，每轮加 user+assistant=2 条，约第 11 轮溢出触发压缩。
    for (let i = 0; i < 13; i++) {
      await h.run(`问题${i}`);
    }
    const seen = captured.some(hasSummaryNode);
    assert.ok(seen, '默认应产生历史摘要节点');
  });
});

test('CONTEXT_COMPRESSION=off 退回直接丢弃：不产生摘要节点', async () => {
  await withEnv({ CONTEXT_COMPRESSION: 'off' }, async () => {
    const captured = [];
    const h = new AgentHarness({ llm: makeCaptureLLM(captured), tools: new (require('../dist/tools.js').ToolRegistry)() });
    for (let i = 0; i < 13; i++) {
      await h.run(`问题${i}`);
    }
    const seen = captured.some(hasSummaryNode);
    assert.ok(!seen, '关闭时不应产生摘要节点');
  });
});

test('CONTEXT_COMPRESSION 任意非 true/1 值关闭：与特性开关单一真相源对齐', async () => {
  await withEnv({ CONTEXT_COMPRESSION: 'banana' }, async () => {
    const captured = [];
    const h = new AgentHarness({ llm: makeCaptureLLM(captured), tools: new (require('../dist/tools.js').ToolRegistry)() });
    for (let i = 0; i < 13; i++) {
      await h.run(`问题${i}`);
    }
    const seen = captured.some(hasSummaryNode);
    assert.ok(!seen, '非 true/1 值应关闭摘要（与 isEnabled 对齐）');
  });
});
