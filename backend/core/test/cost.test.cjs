'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { estimateCost, registerModelPrice, getPriceForModel } = require('../dist/llm/pricing.js');
const { createFailoverLLM } = require('../dist/llm/failover.js');
const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry } = require('../dist/tools.js');
const { Memory } = require('../dist/memory.js');

// ---- pricing ----

test('pricing：已知模型按单价估算成本', () => {
  // gpt-4o-mini: 0.15 / 1M prompt, 0.6 / 1M completion
  const cost = estimateCost('gpt-4o-mini', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  // 0.15 + 0.6 = 0.75
  assert.ok(Math.abs(cost - 0.75) < 1e-9, `expected 0.75, got ${cost}`);
});

test('pricing：去掉 provider 前缀后匹配（openai/gpt-4o-mini → gpt-4o-mini）', () => {
  const cost = estimateCost('openai/gpt-4o-mini', { prompt_tokens: 1_000_000, completion_tokens: 0 });
  assert.ok(Math.abs(cost - 0.15) < 1e-9, `expected 0.15, got ${cost}`);
});

test('pricing：未知模型默认不计费（0），可用 registerModelPrice 覆盖', () => {
  const before = estimateCost('some-unknown-model', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  assert.equal(before, 0);
  registerModelPrice('some-unknown-model', 1, 2);
  const after = estimateCost('some-unknown-model', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  assert.ok(Math.abs(after - 3) < 1e-9, `expected 3, got ${after}`);
});

test('pricing：前缀包含匹配（gpt-4o-2024-08-06 → gpt-4o）', () => {
  // gpt-4o: 2.5 / 1M prompt
  const cost = estimateCost('gpt-4o-2024-08-06', { prompt_tokens: 1_000_000, completion_tokens: 0 });
  assert.ok(Math.abs(cost - 2.5) < 1e-9, `expected 2.5, got ${cost}`);
});

// ---- failover ----

function makeLLM(impl) {
  return async (messages, tools, options) => impl(messages, tools, options);
}

test('failover：primary 成功时不调用 secondary', async () => {
  let secondaryCalled = 0;
  const primary = makeLLM(async () => ({ content: 'from-primary', tool_calls: [] }));
  const secondary = makeLLM(async () => { secondaryCalled += 1; return { content: 'from-secondary', tool_calls: [] }; });
  const llm = createFailoverLLM(primary, secondary, { failThreshold: 2, cooldownMs: 1000 });
  const res = await llm([], []);
  assert.equal(res.content, 'from-primary');
  assert.equal(secondaryCalled, 0);
});

test('failover：primary 抛错时回落 secondary', async () => {
  let primaryCalls = 0;
  const primary = makeLLM(async () => { primaryCalls += 1; throw new Error('primary down'); });
  const secondary = makeLLM(async () => ({ content: 'from-secondary', tool_calls: [] }));
  const llm = createFailoverLLM(primary, secondary, { failThreshold: 3, cooldownMs: 1000 });
  const res = await llm([], []);
  assert.equal(res.content, 'from-secondary');
  assert.equal(primaryCalls, 1);
});

test('failover：连续失败达阈值后熔断，直接走 secondary', async () => {
  let primaryCalls = 0;
  const primary = makeLLM(async () => { primaryCalls += 1; throw new Error('primary down'); });
  const secondary = makeLLM(async () => ({ content: 'from-secondary', tool_calls: [] }));
  const llm = createFailoverLLM(primary, secondary, { failThreshold: 2, cooldownMs: 100_000 });
  await llm([], []); // fail 1, immediate fallback to secondary
  await llm([], []); // fail 2 → open circuit
  const before = primaryCalls;
  await llm([], []); // circuit open → secondary directly, primary NOT called
  assert.equal(primaryCalls, before, 'primary should not be called while circuit open');
});

test('failover：secondary 也失败时抛出错误', async () => {
  const primary = makeLLM(async () => { throw new Error('primary down'); });
  const secondary = makeLLM(async () => { throw new Error('secondary down'); });
  const llm = createFailoverLLM(primary, secondary, { failThreshold: 3, cooldownMs: 1000 });
  await assert.rejects(() => llm([], []), /primary down/);
});

// ---- budget enforcement ----

test('budget：token 超限即中止并返回预算提示', async () => {
  // 每轮返回 1000 total_tokens，第 3 轮累计 3000 超过 2000。
  let n = 0;
  const llm = async () => {
    n += 1;
    if (n >= 3) return { content: 'final after budget', tool_calls: [], usage: { prompt_tokens: 500, completion_tokens: 500, total_tokens: 1000 } };
    // 前两轮发起工具调用以继续循环
    return { content: '', tool_calls: [{ id: 'c' + n, name: 'noop', arguments: {} }], usage: { prompt_tokens: 500, completion_tokens: 500, total_tokens: 1000 } };
  };
  const tools = new ToolRegistry();
  tools.register('noop', 'no-op', { type: 'object', properties: {} }, async () => 'ok', 'test');
  const events = [];
  const harness = new AgentHarness({
    llm,
    tools,
    memory: new Memory(),
    systemPrompt: '',
    tokenBudget: 2000,
    onEvent: (e) => events.push(e),
  });
  const final = await harness.run('hi');
  assert.match(final, /budget.*tokens.*exceeded/);
  assert.ok(events.some((e) => e.type === 'budget:exceeded' && e.kind === 'tokens'));
});

test('budget：成本超限即中止', async () => {
  // 用 gpt-4o（2.5/1M prompt, 10/1M completion）：1M prompt + 1M completion = 12.5。
  // 设 costBudget=10，单轮即超。
  const llm = async () => ({
    content: '',
    tool_calls: [{ id: 'c1', name: 'noop', arguments: {} }],
    model: 'gpt-4o',
    usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
  });
  const tools = new ToolRegistry();
  tools.register('noop', 'no-op', { type: 'object', properties: {} }, async () => 'ok', 'test');
  const events = [];
  const harness = new AgentHarness({
    llm,
    tools,
    memory: new Memory(),
    systemPrompt: '',
    costBudget: 10,
    onEvent: (e) => events.push(e),
    model: 'gpt-4o',
  });
  const final = await harness.run('hi');
  assert.match(final, /budget.*cost.*exceeded/);
  assert.ok(events.some((e) => e.type === 'budget:exceeded' && e.kind === 'cost'));
  assert.ok(events.some((e) => e.type === 'run:cost'));
});
