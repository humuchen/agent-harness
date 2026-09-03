'use strict';
/**
 * 回归测试（对应 Bug 1 上下文压缩 / Bug 2 tool id 未找到）：
 *  - 长无空格串 token 估算不再记为 1 token（压缩护栏据此才能正确触发）；
 *  - normalizeToolCallIds 补齐缺失/重复 id；
 *  - sanitizeToolPairing 丢弃孤儿 tool 结果、清理缺 id 的 tool_call 与末步截断的孤儿 tool_call；
 *  - Memory 历史淘汰按「原子组」对齐，绝不从 assistant(tool_calls) 与其 tool 结果之间切断；
 *  - Memory.compressed 为 per-report 语义（消费即清零，不再 sticky 误报）。
 */
const test = require('node:test');
const assert = require('node:assert');

const { Memory, groupIndexOf } = require('../dist/memory.js');
const { normalizeToolCallIds } = require('../dist/llm/shared.js');
const { sanitizeToolPairing } = require('../dist/harness.js');
const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry, objectParams } = require('../dist/tools.js');
const { estimateTokens } = require('../dist/llm/token-estimator.js');

// 校验整段消息配对完整性：每个 tool 结果都能回溯到一个 tool_call，且无悬挂 tool_call。
function assertPairingOk(messages, label) {
  const pending = new Map();
  let toolCalls = 0;
  let toolResults = 0;
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        assert.ok(tc.id, `${label}: 存在缺 id 的 tool_call`);
        assert.ok(!pending.has(tc.id), `${label}: 重复 tool_call id ${tc.id}`);
        pending.set(tc.id, true);
        toolCalls += 1;
      }
    } else if (m.role === 'tool') {
      assert.ok(pending.has(m.tool_call_id), `${label}: 孤儿 tool 结果 ${m.tool_call_id}`);
      pending.delete(m.tool_call_id);
      toolResults += 1;
    }
  }
  assert.strictEqual(pending.size, 0, `${label}: 存在 ${pending.size} 个未配对 tool_call`);
  if (toolCalls > 0) assert.strictEqual(toolCalls, toolResults, `${label}: tool_call 与 tool 结果数量不等`);
}

// ---------------------------------------------------------------------------
// Bug 1：token 估算修正
// ---------------------------------------------------------------------------
test('estimateTokens 长无空格串按长度计数（不再记为 1 token）', () => {
  const long = 'x'.repeat(20000); // base64 / 长 JSON 场景
  const t = estimateTokens(long);
  assert.ok(t > 100, `期望 >100 token，实际 ${t}`);
  assert.ok(Math.abs(t - 20000 / 4) < 3000, `期望≈5000，实际 ${t}`);
});

test('estimateTokens 短词仍按近似 1 token 计', () => {
  const t = estimateTokens('hello world foo bar baz');
  assert.ok(t >= 4 && t <= 8, `期望 4~8，实际 ${t}`);
});

// ---------------------------------------------------------------------------
// Bug 2：id 规范化 + 配对清洗
// ---------------------------------------------------------------------------
test('normalizeToolCallIds 补齐缺失/重复 id', () => {
  const calls = [
    { id: '', name: 'f', arguments: {} },
    { id: 'call_a', name: 'g', arguments: {} },
    { id: 'call_a', name: 'h', arguments: {} }, // 重复
    { name: 'i', arguments: {} } // 缺失 id
  ];
  const out = normalizeToolCallIds(calls);
  const ids = out.map((c) => c.id);
  assert.strictEqual(ids.length, 4);
  assert.strictEqual(new Set(ids).size, 4, 'id 应全部非空且唯一');
  assert.ok(ids[0].length > 0);
  assert.ok(ids[2] !== 'call_a', '重复 id 应被重命名');
  assert.ok(ids[3].length > 0);
});

test('sanitizeToolPairing 丢弃孤儿 tool 结果', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'f', arguments: {} }] },
    { role: 'tool', tool_call_id: 'c1', name: 'f', content: 'r1' },
    { role: 'tool', tool_call_id: 'ghost', name: 'f', content: 'orphan' } // 无对应 tool_call
  ];
  const out = sanitizeToolPairing(msgs);
  const tools = out.filter((m) => m.role === 'tool');
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].tool_call_id, 'c1');
  assertPairingOk(out, '丢弃孤儿结果');
});

test('sanitizeToolPairing 清理缺 id 的 tool_call 及其悬挂结果', () => {
  const msgs = [
    { role: 'assistant', content: '', tool_calls: [{ id: '', name: 'f', arguments: {} }] },
    { role: 'tool', tool_call_id: '', name: 'f', content: 'r' }
  ];
  const out = sanitizeToolPairing(msgs);
  assert.strictEqual(out.filter((m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length).length, 0);
  assert.strictEqual(out.filter((m) => m.role === 'tool').length, 0);
});

test('sanitizeToolPairing 末步截断的孤儿 tool_call 被剥离', () => {
  const msgs = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'f', arguments: {} }] },
    { role: 'tool', tool_call_id: 'c1', name: 'f', content: 'r1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', name: 'g', arguments: {} }] } // 无结果
  ];
  const out = sanitizeToolPairing(msgs);
  const last = out[out.length - 1];
  assert.strictEqual(last.role, 'assistant');
  assert.strictEqual(last.tool_calls.length, 0, '孤儿 tool_call 应被剥离');
  assert.strictEqual(out.filter((m) => m.role === 'tool').length, 1);
});

// ---------------------------------------------------------------------------
// Bug 1+2：历史淘汰按原子组对齐（不破坏配对）
// ---------------------------------------------------------------------------
test('Memory 淘汰按原子组对齐，不产生孤儿 tool 配对', () => {
  const mem = new Memory({ maxWindow: 6 });
  function addGroup(i) {
    mem.add({ role: 'user', content: `u${i}` });
    mem.add({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: 'f', arguments: {} }] });
    mem.add({ role: 'tool', tool_call_id: `c${i}`, name: 'f', content: `r${i}` });
  }
  for (let i = 0; i < 10; i++) addGroup(i); // 远超 maxWindow → 触发淘汰
  const hist = mem.history();
  assertPairingOk(hist, '淘汰后配对完整');
  // 当前（最后）组必须整体保留
  const groups = groupIndexOf(hist);
  const lastG = groups[groups.length - 1];
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === lastG) {
      const m = hist[i];
      if (m.role === 'assistant') assert.ok(Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
    }
  }
  assert.ok(hist.length <= 6 + 1, `窗口应被压缩，实际 ${hist.length}`);
  assert.ok(mem.compactCount > 0, '应发生压缩');
});

test('Memory 当前轮次（最后组）永不被切断', () => {
  const mem = new Memory({ maxWindow: 3 });
  for (let i = 0; i < 8; i++) {
    mem.add({ role: 'user', content: `u${i}` });
    mem.add({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: 'f', arguments: {} }] });
    mem.add({ role: 'tool', tool_call_id: `c${i}`, name: 'f', content: `r${i}` });
  }
  const hist = mem.history();
  assertPairingOk(hist, '最后轮次配对完整');
});

// ---------------------------------------------------------------------------
// Bug 1：compressed 为 per-report 语义（消费即清零）
// ---------------------------------------------------------------------------
test('常规 maxWindow 滑动淘汰（无 token 压力）不点亮「已压缩」', () => {
  // 未调用 setContextUsage → overTokens 恒为 false → 仅 FIFO 轮转，不算压缩。
  const mem = new Memory({ maxWindow: 4 });
  function addGroup(i) {
    mem.add({ role: 'user', content: `u${i}` });
    mem.add({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: 'f', arguments: {} }] });
    mem.add({ role: 'tool', tool_call_id: `c${i}`, name: 'f', content: `r${i}` });
  }
  for (let i = 0; i < 8; i++) addGroup(i); // 远超 maxWindow → 触发常规淘汰
  assert.ok(mem.compactCount > 0, '应发生（条数）淘汰');
  // 关键：常规滑动不代表「已压缩」，徽标不应被点亮。
  assert.strictEqual(mem.consumeCompressed(), false, '仅 FIFO 滑动不应点亮「已压缩」');
});

test('token 压力驱动的淘汰/瘦身点亮「已压缩」，消费即清零（per-report）', () => {
  const mem = new Memory({ maxWindow: 4 });
  function addGroup(i) {
    mem.add({ role: 'user', content: `u${i}` });
    mem.add({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: 'f', arguments: {} }] });
    mem.add({ role: 'tool', tool_call_id: `c${i}`, name: 'f', content: `r${i}` });
  }
  // 注入真实用量：prompt 占满窗口 → overTokens=true → 触发 token 护栏淘汰/瘦身。
  mem.setContextUsage(120000, 128000);
  for (let i = 0; i < 5; i++) addGroup(i);
  assert.strictEqual(mem.consumeCompressed(), true, 'token 压力驱动的压缩应点亮「已压缩」');
  assert.strictEqual(mem.consumeCompressed(), false, '消费后应清零');
  // 再次发生 token 压力驱动的压缩仍可重新置位
  for (let i = 5; i < 8; i++) addGroup(i);
  assert.strictEqual(mem.consumeCompressed(), true, '再次压缩应重新置位');
});

// ---------------------------------------------------------------------------
// 端到端：并行工具调用 + 窗口溢出，发送历史无孤儿配对（含大结果触发 token 护栏）
// ---------------------------------------------------------------------------
test('harness: 并行工具调用 + 窗口溢出，发送历史无孤儿配对', async () => {
  const registry = new ToolRegistry();
  const big = JSON.stringify({
    items: Array.from({ length: 200 }, (_, i) => ({
      id: i,
      title: `第 ${i} 条检索结果标题`,
      body: `这是第 ${i} 条正文内容，用于把单条工具结果撑到几千 token 的规模以触发 token 护栏压缩。`,
      url: `https://example.com/items/${i}`
    }))
  });
  for (const n of ['search_web', 'read_file', 'query_db']) {
    registry.register(n, `工具 ${n}`, objectParams({ q: { type: 'string' } }, ['q']), (a) => big, 'h');
  }
  const memory = new Memory({ maxWindow: 8, compressThreshold: 0.8 });
  let step = 0;
  const snapshots = [];
  const llm = async (messages) => {
    step += 1;
    snapshots.push(messages.map((m) => ({ ...m }))); // 保留真实 shape 供配对校验
    if (step <= 5) {
      return {
        content: '',
        tool_calls: [
          { id: 'call_function_pohg1r4l0kgm_0', name: 'search_web', arguments: { q: `s${step}` } },
          { id: 'call_function_pohg1r4l0kgm_1', name: 'read_file', arguments: { q: `s${step}` } },
          { id: 'call_function_pohg1r4l0kgm_2', name: 'query_db', arguments: { q: `s${step}` } }
        ],
        usage: { prompt_tokens: 8000, completion_tokens: 40, total_tokens: 8040 },
        model: 'mock'
      };
    }
    return { content: 'done', tool_calls: [], usage: { prompt_tokens: 9000, completion_tokens: 20, total_tokens: 9020 }, model: 'mock' };
  };
  const h = new AgentHarness({
    llm,
    tools: registry,
    memory,
    systemPrompt: '你是助手。',
    maxSteps: 7,
    model: 'mock',
    contextWindow: 128000
  });
  await h.run('请并行检索并汇总');

  for (let i = 0; i < snapshots.length; i++) {
    assertPairingOk(snapshots[i], `step ${i + 1}`);
  }
});
