// 零依赖测试（node:test + node:assert）：覆盖 P2.a 配额/计费引擎 quota/engine.ts。
// 关注：缺省不限、QPS 令牌桶、并发信号量、token/cost 窗口硬限、release、按租户隔离。

const test = require('node:test');
const assert = require('node:assert');

const { QuotaEngine } = require('../dist/quota/engine.js');

test('QuotaEngine：缺省不限（无注册租户 admit 永远通过）', () => {
  const q = new QuotaEngine();
  for (let i = 0; i < 10; i++) {
    const d = q.admit('anon');
    assert.strictEqual(d.allowed, true);
    q.release('anon');
  }
});

test('QuotaEngine：QPS 令牌桶按容量限流', () => {
  const q = new QuotaEngine();
  q.setQuota('t', { qps: 2 });
  assert.strictEqual(q.admit('t').allowed, true); // 第 1 次（桶=2→1）
  assert.strictEqual(q.admit('t').allowed, true); // 第 2 次（桶=1→0）
  const third = q.admit('t'); // 桶空
  assert.strictEqual(third.allowed, false);
  assert.strictEqual(third.reason, 'qps rate limit exceeded');
  assert.ok(typeof third.retryAfterMs === 'number' && third.retryAfterMs >= 0);
});

test('QuotaEngine：并发信号量 maxConcurrency', () => {
  const q = new QuotaEngine();
  q.setQuota('t', { maxConcurrency: 1 });
  assert.strictEqual(q.admit('t').allowed, true); // 占用唯一槽位
  const second = q.admit('t');
  assert.strictEqual(second.allowed, false);
  assert.strictEqual(second.reason, 'concurrency limit exceeded');
  q.release('t'); // 归还
  assert.strictEqual(q.admit('t').allowed, true); // 再获槽位
});

test('QuotaEngine：token/cost 窗口硬上限', () => {
  const q = new QuotaEngine();
  q.setQuota('t', { maxTokensPerWindow: 100, windowMs: 60000 });
  assert.strictEqual(q.admit('t', { tokens: 60 }, true).allowed, true); // 60/100
  const over = q.admit('t', { tokens: 60 }, true); // 120 > 100
  assert.strictEqual(over.allowed, false);
  assert.strictEqual(over.reason, 'token window limit exceeded');
  assert.strictEqual(q.admit('t', { tokens: 30 }, true).allowed, true); // 90/100
});

test('QuotaEngine：cost 窗口硬上限（计费熔断）', () => {
  const q = new QuotaEngine();
  q.setQuota('t', { maxCostPerWindow: 1.0, windowMs: 60000 });
  assert.strictEqual(q.admit('t', { cost: 0.6 }, true).allowed, true);
  const over = q.admit('t', { cost: 0.6 }, true); // 1.2 > 1.0
  assert.strictEqual(over.allowed, false);
  assert.strictEqual(over.reason, 'cost window limit exceeded');
});

test('QuotaEngine：recordUsage 累计且被窗口滚动清零（getUsage 观测）', () => {
  const q = new QuotaEngine();
  q.setQuota('t', { windowMs: 50 });
  q.admit('t', { tokens: 10, cost: 0.1 }, false); // 触发 bucket 创建
  q.recordUsage('t', { tokens: 5, cost: 0.05 });
  let u = q.getUsage('t');
  assert.strictEqual(u.tokensUsed, 15);
  assert.ok(Math.abs(u.costUsed - 0.15) < 1e-9);
  // 超过窗口后滚动清零
  return new Promise((resolve) => {
    setTimeout(() => {
      q.recordUsage('t', { tokens: 1, cost: 0 }); // 触发 rollWindow
      const u2 = q.getUsage('t');
      assert.strictEqual(u2.tokensUsed, 1);
      q.release('t');
      resolve();
    }, 70);
  });
});

test('QuotaEngine：getQuota 缺省合并 default（未注册字段回退）', () => {
  const q = new QuotaEngine({ qps: 5 });
  const merged = q.getQuota('unregistered');
  assert.strictEqual(merged.qps, 5);
  q.setQuota('t', { maxConcurrency: 3 });
  assert.strictEqual(q.getQuota('t').qps, 5); // default 合并
  assert.strictEqual(q.getQuota('t').maxConcurrency, 3);
});
