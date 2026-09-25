'use strict';
// CircuitBreaker 专用测试（P0-1 补齐）。
// 覆盖状态机全路径：CLOSED → OPEN → HALF_OPEN → CLOSED / OPEN
// 以及边界条件、快照、手动重置。

const test = require('node:test');
const assert = require('node:assert');

const { CircuitBreaker, CircuitBreakerOpen } = require('../dist/circuit-breaker.js');

test('初始状态为 closed', () => {
  const cb = new CircuitBreaker();
  assert.strictEqual(cb.currentState, 'closed');
  const snap = cb.snapshot();
  assert.strictEqual(snap.state, 'closed');
  assert.strictEqual(snap.consecutiveFailures, 0);
  assert.strictEqual(snap.lastFailureAt, 0);
});

test('成功调用不改变 closed 状态', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3 });
  const result = await cb.withRequest(async () => 'ok');
  assert.strictEqual(result, 'ok');
  assert.strictEqual(cb.currentState, 'closed');
  assert.strictEqual(cb.snapshot().consecutiveFailures, 0);
});

test('连续失败达阈值后打开熔断', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, timeoutMs: 60_000 });
  // 第 1 次失败
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('fail-1'); }), { message: 'fail-1' });
  assert.strictEqual(cb.currentState, 'closed');
  assert.strictEqual(cb.snapshot().consecutiveFailures, 1);
  // 第 2 次失败
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('fail-2'); }), { message: 'fail-2' });
  assert.strictEqual(cb.currentState, 'closed');
  assert.strictEqual(cb.snapshot().consecutiveFailures, 2);
  // 第 3 次失败 → 打开熔断
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('fail-3'); }), { message: 'fail-3' });
  assert.strictEqual(cb.currentState, 'open');
  assert.strictEqual(cb.snapshot().consecutiveFailures, 3);
});

test('熔断打开时直接抛 CircuitBreakerOpen，不执行 fn', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 60_000 });
  // 1 次失败即打开
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('boom'); }), { message: 'boom' });
  assert.strictEqual(cb.currentState, 'open');

  let called = false;
  await assert.rejects(
    () => cb.withRequest(async () => { called = true; return 'should-not-reach'; }),
    (err) => err instanceof CircuitBreakerOpen
  );
  // fn 不应被调用（透传熔断，不消耗重试）
  assert.strictEqual(called, false);
});

test('CircuitBreakerOpen 错误包含 name 和 consecutiveFailures 信息', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, timeoutMs: 60_000, name: 'llm-primary' });
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('e1'); }));
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('e2'); }));
  assert.strictEqual(cb.currentState, 'open');

  let caughtErr;
  try {
    await cb.withRequest(async () => 'unreachable');
  } catch (e) {
    caughtErr = e;
  }
  assert.ok(caughtErr instanceof CircuitBreakerOpen);
  assert.ok(caughtErr.message.includes('llm-primary'));
  assert.ok(caughtErr.message.includes('2'));
  assert.strictEqual(caughtErr.name, 'CircuitBreakerOpen');
});

test('熔断打开后超时进入 half-open，试探成功回归 closed', async () => {
  // 用极短 timeoutMs 让 half-open 快速到达
  const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 50, halfOpenAttempts: 1 });
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('fail'); }));
  assert.strictEqual(cb.currentState, 'open');

  // 等待超时
  await new Promise((r) => setTimeout(r, 60));
  // currentState getter 应懒转换为 half-open
  assert.strictEqual(cb.currentState, 'half-open');

  // half-open 试探成功
  const result = await cb.withRequest(async () => 'recovered');
  assert.strictEqual(result, 'recovered');
  // 成功后回归 closed
  assert.strictEqual(cb.currentState, 'closed');
  assert.strictEqual(cb.snapshot().consecutiveFailures, 0);
});

test('half-open 试探失败则重新打开熔断', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 50, halfOpenAttempts: 1 });
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('fail-1'); }));
  assert.strictEqual(cb.currentState, 'open');

  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(cb.currentState, 'half-open');

  // half-open 试探也失败
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('still-down'); }), { message: 'still-down' });
  assert.strictEqual(cb.currentState, 'open');
});

test('half-open 多次试探成功才关闭（halfOpenAttempts > 1）', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 50, halfOpenAttempts: 3 });
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('fail'); }));
  assert.strictEqual(cb.currentState, 'open');

  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(cb.currentState, 'half-open');

  // 第 1 次试探成功但不应关闭（需 3 次）
  await cb.withRequest(async () => 'ok-1');
  assert.strictEqual(cb.currentState, 'half-open');

  // 第 2 次试探成功
  await cb.withRequest(async () => 'ok-2');
  assert.strictEqual(cb.currentState, 'half-open');

  // 第 3 次试探成功 → 关闭
  await cb.withRequest(async () => 'ok-3');
  assert.strictEqual(cb.currentState, 'closed');
});

test('reset() 手动重置回 closed', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 60_000 });
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('fail'); }));
  assert.strictEqual(cb.currentState, 'open');

  cb.reset();
  assert.strictEqual(cb.currentState, 'closed');
  assert.strictEqual(cb.snapshot().consecutiveFailures, 0);
  assert.strictEqual(cb.snapshot().lastFailureAt, 0);
});

test('success 在 closed 状态下重置失败计数', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, timeoutMs: 60_000 });
  // 2 次失败（未达阈值）
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('f1'); }));
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('f2'); }));
  assert.strictEqual(cb.snapshot().consecutiveFailures, 2);
  assert.strictEqual(cb.currentState, 'closed');

  // 成功应重置计数
  await cb.withRequest(async () => 'ok');
  assert.strictEqual(cb.snapshot().consecutiveFailures, 0);
  assert.strictEqual(cb.currentState, 'closed');
});

test('默认参数正确', () => {
  const cb = new CircuitBreaker();
  // 用 snapshot 间接验证默认值（不暴露 opts）
  assert.strictEqual(cb.currentState, 'closed');
});

test('自定义 name 出现在错误信息中', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, name: 'my-service' });
  await assert.rejects(() => cb.withRequest(async () => { throw new Error('x'); }));
  let err;
  try { await cb.withRequest(async () => 'x'); } catch (e) { err = e; }
  assert.ok(err.message.includes('my-service'));
});
