'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry, objectParams } = require('../dist/tools.js');
const { Memory } = require('../dist/memory.js');

// 一次性返回最终文本（无工具调用）的 Mock LLM
function singleTurnLLM(text) {
  return async () => ({ content: text, tool_calls: [] });
}

// 第一轮返回工具调用、第二轮返回最终文本的 Mock LLM
function toolLoopLLM(toolName, finalText) {
  let n = 0;
  return async () => {
    n += 1;
    if (n === 1) {
      return { content: '', tool_calls: [{ id: 'c1', name: toolName, arguments: { x: 1 } }] };
    }
    return { content: finalText, tool_calls: [] };
  };
}

// 永不 settle 的 LLM（用于超时 / 取消测试）
function hangingLLM() {
  return async () => new Promise(() => {});
}

test('单次对话：直接返回最终文本', async () => {
  const h = new AgentHarness({ llm: singleTurnLLM('你好'), tools: new ToolRegistry() });
  const out = await h.run('hi');
  assert.equal(out, '你好');
});

// P1 并发修复：同一实例并发 run 默认串行排队（防 Memory 窗口/预算字段互相覆盖）
test('并发 run：同一实例默认串行排队，结果互不干扰', async () => {
  const order = [];
  const slowLLM = async (messages) => {
    // 记录 LLM 实际开始执行的时间序（排队应保证串行：a 完成后 b 才开始）
    order.push(`start:${messages[0].content ?? ''}`);
    await new Promise((r) => setTimeout(r, 20));
    order.push('end');
    return { content: 'ok', tool_calls: [] };
  };
  const h = new AgentHarness({ llm: slowLLM, tools: new ToolRegistry() });
  const [a, b] = await Promise.all([h.run('a'), h.run('b')]);
  assert.equal(a, 'ok');
  assert.equal(b, 'ok');
  // 串行语义：第二个 run 的 LLM 调用必须在第一个 run 结束（end）之后才开始。
  const startIdxs = order.reduce((acc, x, i) => (x.startsWith('start:') ? (acc.push(i), acc) : acc), []);
  const endIdxs = order.reduce((acc, x, i) => (x === 'end' ? (acc.push(i), acc) : acc), []);
  assert.ok(
    startIdxs.length === 2 && endIdxs.length === 2 && endIdxs[0] < startIdxs[1],
    `第二个 run 应在第一个结束后才进入主循环（实际时序：${order.join(' ')}）`
  );
});

// P1 并发修复：HARNESS_CONCURRENT_RUN=fail 时并发 run 显式拒绝
test('并发 run：fail-fast 模式显式拒绝并发', async () => {
  process.env.HARNESS_CONCURRENT_RUN = 'fail';
  try {
    const h = new AgentHarness({ llm: hangingLLM(), tools: new ToolRegistry() });
    const first = h.run('first');
    await assert.rejects(
      h.run('second'),
      /并发 run 被拒绝/
    );
    // 清理挂起的第一个 run（abort 语义由测试进程退出兜底，这里仅保证断言）
    void first;
  } finally {
    delete process.env.HARNESS_CONCURRENT_RUN;
  }
});

test('工具循环：工具结果回灌后再产出最终文本', async () => {
  const tools = new ToolRegistry();
  tools.register('double', '翻倍', objectParams({ x: { type: 'number' } }, ['x']), (a) => Number(a.x) * 2);
  const h = new AgentHarness({ llm: toolLoopLLM('double', 'done'), tools });
  const out = await h.run('go');
  assert.equal(out, 'done');
});

test('输入护栏命中：直接拦截并返回优雅兜底文案（不暴露内部 blocked 文本）', async () => {
  const h = new AgentHarness({ llm: singleTurnLLM('x'), tools: new ToolRegistry() });
  const out = await h.run('AKIAIOSFODNN7EXAMPLE');
  // 对外契约：护栏命中后返回优雅兜底文案，且不把内部原因（[guardrail] blocked ...）透给用户。
  assert.match(out, /内容安全策略/);
  assert.doesNotMatch(out, /guardrail\]?\s*blocked/i);
});

test('remember 注入系统提示词（长期记忆可见）', async () => {
  let captured;
  const captureLLM = async (messages) => {
    captured = messages;
    return { content: 'ok', tool_calls: [] };
  };
  const h = new AgentHarness({ llm: captureLLM, tools: new ToolRegistry(), systemPrompt: 'SYS' });
  h.remember('长期笔记：偏好 A');
  await h.run('hi');
  assert.equal(captured[0].role, 'system');
  assert.match(captured[0].content, /SYS/);
  assert.match(captured[0].content, /长期笔记：偏好 A/);
});

test('超时：永不返回的 LLM 在 timeoutMs 后中止', async () => {
  const h = new AgentHarness({ llm: hangingLLM(), tools: new ToolRegistry(), timeoutMs: 50 });
  const out = await h.run('hi');
  assert.match(out, /timeout/);
});

test('外部取消：外部 signal abort 后中止', async () => {
  const ac = new AbortController();
  const h = new AgentHarness({ llm: hangingLLM(), tools: new ToolRegistry(), signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  const out = await h.run('hi');
  assert.match(out, /abort/);
});

test('事件流：发出 run:start / step:start / run:end', async () => {
  const events = [];
  const h = new AgentHarness({
    llm: singleTurnLLM('ok'),
    tools: new ToolRegistry(),
    onEvent: (e) => events.push(e.type),
  });
  await h.run('hi');
  assert.ok(events.includes('run:start'));
  assert.ok(events.includes('step:start'));
  assert.ok(events.includes('run:end'));
});
