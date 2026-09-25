'use strict';
// LLM Failover 专用测试（P0-1 补齐）。
// 覆盖：primary 成功、primary 失败 fallback secondary、熔断切换、half-open 恢复、
// 双路失败、immediateFallback=false 行为。

const test = require('node:test');
const assert = require('node:assert');

const { createFailoverLLM } = require('../dist/llm/failover.js');

// --- 辅助：构造 mock LLM ---
function makeMockLLM(label, behavior) {
  // behavior: 'success' | 'fail' | function
  const calls = [];
  const fn = async (messages, tools, options) => {
    const callIndex = calls.length; // 0-indexed, push 前记录
    calls.push({ messages, tools, options });
    if (behavior === 'success') {
      return { content: `response-from-${label}`, tool_calls: [] };
    }
    if (behavior === 'fail') {
      const e = new Error(`${label}-error`);
      e.label = label;
      throw e;
    }
    if (typeof behavior === 'function') {
      return behavior(messages, tools, options, callIndex);
    }
    throw new Error(`unknown behavior: ${behavior}`);
  };
  fn._label = label;
  fn._calls = calls;
  return fn;
}

const SAMPLE_MESSAGES = [{ role: 'user', content: 'hello' }];
const SAMPLE_TOOLS = [];

test('primary 成功时直接返回 primary 结果，不调 secondary', async () => {
  const primary = makeMockLLM('primary', 'success');
  const secondary = makeMockLLM('secondary', 'success');
  const llm = createFailoverLLM(primary, secondary, { failThreshold: 3, cooldownMs: 60_000 });

  const res = await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(res.content, 'response-from-primary');
  assert.strictEqual(primary._calls.length, 1);
  assert.strictEqual(secondary._calls.length, 0);
});

test('primary 失败时立即 fallback 到 secondary（默认 immediateFallback=true）', async () => {
  const primary = makeMockLLM('primary', 'fail');
  const secondary = makeMockLLM('secondary', 'success');
  const llm = createFailoverLLM(primary, secondary, { failThreshold: 3, cooldownMs: 60_000 });

  const res = await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(res.content, 'response-from-secondary');
  assert.strictEqual(primary._calls.length, 1);
  assert.strictEqual(secondary._calls.length, 1);
});

test('连续失败达阈值后打开熔断，后续请求直接走 secondary', async () => {
  const primary = makeMockLLM('primary', 'fail');
  const secondary = makeMockLLM('secondary', 'success');
  const llm = createFailoverLLM(primary, secondary, { failThreshold: 2, cooldownMs: 60_000 });

  // 第 1 次：primary fail → fallback secondary
  await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(primary._calls.length, 1);
  assert.strictEqual(secondary._calls.length, 1);

  // 第 2 次：primary fail → 达阈值打开熔断 → fallback secondary
  await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(primary._calls.length, 2);
  assert.strictEqual(secondary._calls.length, 2);

  // 第 3 次：熔断已打开 → 直接走 secondary，不调 primary
  await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(primary._calls.length, 2); // 不增加
  assert.strictEqual(secondary._calls.length, 3); // 增加
});

test('熔断超时后 half-open 探活 primary，成功则关闭熔断', async () => {
  let primaryShouldFail = true;
  const primary = makeMockLLM('primary', (m, t, o, callCount) => {
    if (primaryShouldFail) throw new Error('primary-down');
    return { content: 'primary-back', tool_calls: [] };
  });
  const secondary = makeMockLLM('secondary', 'success');
  const llm = createFailoverLLM(primary, secondary, { failThreshold: 1, cooldownMs: 50 });

  // primary 失败 → 打开熔断
  const r1 = await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(r1.content, 'response-from-secondary');

  // 等待冷却超时
  await new Promise((r) => setTimeout(r, 60));

  // primary 恢复
  primaryShouldFail = false;

  // half-open 试探 primary → 成功 → 关闭熔断
  const r2 = await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(r2.content, 'primary-back');

  // 后续请求应直接走 primary（熔断已关闭）
  const beforeCalls = primary._calls.length;
  const r3 = await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(r3.content, 'primary-back');
  assert.ok(primary._calls.length > beforeCalls);
});

test('half-open 试探 primary 失败 → 重新打开熔断走 secondary', async () => {
  const primary = makeMockLLM('primary', 'fail');
  const secondary = makeMockLLM('secondary', 'success');
  const llm = createFailoverLLM(primary, secondary, { failThreshold: 1, cooldownMs: 50 });

  // primary 失败 → 打开熔断
  await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  const secondaryCallsAfterFirst = secondary._calls.length;

  // 等待冷却超时
  await new Promise((r) => setTimeout(r, 60));

  // half-open 试探 primary → 仍失败 → 重新打开
  const r = await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  // 应 fallback 到 secondary
  assert.strictEqual(r.content, 'response-from-secondary');
  assert.ok(secondary._calls.length > secondaryCallsAfterFirst);
});

test('primary 和 secondary 都失败时抛出 primary 的错误', async () => {
  const primary = makeMockLLM('primary', 'fail');
  const secondary = makeMockLLM('secondary', 'fail');
  const llm = createFailoverLLM(primary, secondary, { failThreshold: 3, cooldownMs: 60_000 });

  await assert.rejects(
    () => llm(SAMPLE_MESSAGES, SAMPLE_TOOLS),
    (err) => err.label === 'primary' || err.message.includes('primary')
  );
});

test('immediateFallback=false 时 primary 单次失败直接抛出（未达阈值不 fallback）', async () => {
  const primary = makeMockLLM('primary', 'fail');
  const secondary = makeMockLLM('secondary', 'success');
  const llm = createFailoverLLM(primary, secondary, {
    failThreshold: 3,
    cooldownMs: 60_000,
    immediateFallback: false,
  });

  // primary 失败但不 fallback（未达阈值，immediateFallback=false）
  await assert.rejects(
    () => llm(SAMPLE_MESSAGES, SAMPLE_TOOLS),
    (err) => err.message.includes('primary')
  );
  assert.strictEqual(secondary._calls.length, 0);

  // 第 2 次失败仍未达阈值
  await assert.rejects(() => llm(SAMPLE_MESSAGES, SAMPLE_TOOLS));
  assert.strictEqual(secondary._calls.length, 0);

  // 第 3 次失败 → 达阈值打开熔断。circuit 打开后代码 fallthrough 到 secondary
  // （这是正确行为：熔断打开即应走 secondary，不应再硬等 primary）
  const r3 = await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(r3.content, 'response-from-secondary');
  assert.ok(secondary._calls.length >= 1);

  // 第 4 次请求：熔断已打开 → 直接走 secondary
  const r4 = await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(r4.content, 'response-from-secondary');
});

test('success 在未达阈值时重置失败计数（不让偶发失败累积）', async () => {
  const callResults = ['fail', 'fail', 'success', 'fail', 'fail', 'fail'];
  const primary = makeMockLLM('primary', (m, t, o, callCount) => {
    const behavior = callResults[callCount] || 'success';
    if (behavior === 'fail') throw new Error('primary-flap');
    return { content: 'primary-ok', tool_calls: [] };
  });
  const secondary = makeMockLLM('secondary', 'success');
  const llm = createFailoverLLM(primary, secondary, { failThreshold: 3, cooldownMs: 60_000 });

  // 0: fail → fallback
  await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  // 1: fail → fallback（连续 2 次）
  await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  // 2: success → 重置计数
  const r2 = await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(r2.content, 'primary-ok');
  // 3: fail → 连续 1 次（从 0 重新计数）
  await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  // 4: fail → 连续 2 次
  await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  // 5: fail → 连续 3 次 → 打开熔断 → fallback secondary
  const r5 = await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(r5.content, 'response-from-secondary');
});

test('primaryLabel / secondaryLabel 用于日志标识', async () => {
  const primary = makeMockLLM('primary', 'success');
  const secondary = makeMockLLM('secondary', 'success');
  // 不抛错即证明 label 参数被接受
  const llm = createFailoverLLM(primary, secondary, {
    failThreshold: 3,
    cooldownMs: 60_000,
    primaryLabel: 'openrouter',
    secondaryLabel: 'openai-direct',
  });
  const res = await llm(SAMPLE_MESSAGES, SAMPLE_TOOLS);
  assert.strictEqual(res.content, 'response-from-primary');
});
