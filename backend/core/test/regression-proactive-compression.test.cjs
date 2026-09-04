'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry } = require('../dist/tools.js');
const { Memory } = require('../dist/memory.js');

// 模拟「窗口超限」错误：免费模型真实窗口远小于配置/回退值 128K 时常见。
function overflowError() {
  const e = new Error('This model\'s maximum context length is 8192 tokens. However, you requested 40000.');
  e.status = 400;
  return e;
}

test('fitToBudget 主动压缩：历史 token 真正落回预算内', () => {
  const m = new Memory({ maxWindow: 200 });
  for (let i = 0; i < 50; i++) m.add({ role: 'user', content: 'y'.repeat(3000) });
  const before = m.historyTokens();
  assert.ok(before > 1000, 'precondition: history is large');
  const budget = Math.floor(before * 0.5);
  const changed = m.fitToBudget(budget);
  assert.ok(changed, 'should report that it changed something');
  assert.ok(m.historyTokens() <= budget + 1, `history should be within budget (got ${m.historyTokens()} <= ${budget})`);
});

test('fitToBudget 设置 per-report 压缩标记，读取即清零', () => {
  const m = new Memory({ maxWindow: 200 });
  for (let i = 0; i < 50; i++) m.add({ role: 'user', content: 'z'.repeat(3000) });
  const changed = m.fitToBudget(Math.floor(m.historyTokens() * 0.5));
  assert.ok(changed);
  assert.equal(m.consumeCompressed(), true, 'compressed flag should be lit after a real compression');
  assert.equal(m.consumeCompressed(), false, 'flag should clear after being read (per-report semantics)');
});

test('上下文溢出自愈：LLM 报窗口超限时压缩历史并重试直到成功', async () => {
  // 预置爆量历史，使首次调用必然"超出窗口"。
  const memory = new Memory({ maxWindow: 200 });
  for (let i = 0; i < 40; i++) {
    memory.add({ role: 'user', content: 'x'.repeat(4000) });
  }
  let calls = 0;
  const llm = async () => {
    calls += 1;
    if (calls <= 2) throw overflowError(); // 前两次模拟窗口超限
    return { content: 'recovered', tool_calls: [] };
  };
  const h = new AgentHarness({ llm, tools: new ToolRegistry(), memory });
  const out = await h.run('hi');
  assert.equal(out, 'recovered', 'run should eventually succeed after shrinking');
  assert.ok(calls >= 3, `should have retried after overflow (calls=${calls})`);
});

test('上下文溢出自愈：无限超限最终抛错而非死循环', async () => {
  const memory = new Memory({ maxWindow: 200 });
  for (let i = 0; i < 40; i++) memory.add({ role: 'user', content: 'x'.repeat(4000) });
  const llm = async () => { throw overflowError(); }; // 永远超限
  const h = new AgentHarness({ llm, tools: new ToolRegistry(), memory });
  const out = await h.run('hi');
  assert.match(out, /error|overflow/i, 'should fail loudly, not hang forever');
});
