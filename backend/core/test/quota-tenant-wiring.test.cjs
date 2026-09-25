'use strict';
/**
 * 配额接线测试（DB tenant 表 + admitAsync 分布式路径 + 结算冲销闭环）。
 *
 * Redis 部分用「脚本化 FakeRedis」验证引擎编排语义（预留透传 / 拒绝传递 /
 * 故障降级 fail-open）；Lua 脚本本身的原子性需真实 Redis 集成环境验证
 * （本仓库测试不依赖 Redis 服务）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  QuotaEngine,
  TenantQuotaStore,
} = require('../dist/index.js');

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `ah-quota-test-${tag}-${process.pid}-${Date.now()}.db`);
}

// ---------------------------------------------------------------------------
// TenantQuotaStore：建表 / upsert / 读取 / 删除 / 继承语义
// ---------------------------------------------------------------------------

test('TenantQuotaStore：upsert 后可读回，remove 后回退无配置', async () => {
  const file = tmpDbFile('basic');
  try {
    const store = new TenantQuotaStore({ file, ttlMs: 60_000 });
    await store.init();

    await store.upsert('acme', { qps: 5, maxCostPerWindow: 2.5, windowMs: 60_000 });
    const row = await store.get('acme');
    assert.ok(row, '应读到配置行');
    assert.strictEqual(row.tenantId, 'acme');
    assert.strictEqual(row.qps, 5);
    assert.ok(Math.abs(row.maxCostPerWindow - 2.5) < 1e-9);

    // 同步缓存热路径
    const cached = store.getCached('acme');
    assert.ok(cached && cached.qps === 5, 'getCached 应命中缓存');

    await store.upsert('acme', { qps: 9 });
    const updated = await store.get('acme');
    assert.strictEqual(updated.qps, 9, 'upsert 应覆盖');

    const list = await store.list();
    assert.strictEqual(list.length, 1);

    await store.remove('acme');
    assert.strictEqual(await store.get('acme'), null, 'remove 后应读不到');
    assert.strictEqual(store.getCached('acme'), null, '缓存应同步失效');
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
});

test('QuotaEngine.getQuota：tenant 行仅覆盖显式字段，其余继承 default', () => {
  const engine = new QuotaEngine({ maxCostPerWindow: 10, windowMs: 60_000 });
  const fake = {
    getCached(id) {
      if (id === 'acme') return { tenantId: 'acme', qps: 5, updatedAt: 1 };
      return null;
    },
  };
  engine.setTenantStore(fake);

  const acme = engine.getQuota('acme');
  assert.strictEqual(acme.qps, 5, '显式字段覆盖 default');
  assert.strictEqual(acme.maxCostPerWindow, 10, '未配置字段继承 default');
  assert.strictEqual(acme.windowMs, 60_000);

  const anon = engine.getQuota('anonymous');
  assert.strictEqual(anon.qps, undefined, 'anonymous 回退 default 不走 store');
  assert.strictEqual(anon.maxCostPerWindow, 10);
});

// ---------------------------------------------------------------------------
// admitAsync / settleUsage / releaseAsync：无 Redis 时等价同步路径
// ---------------------------------------------------------------------------

test('admitAsync（无 Redis）：与 admit 语义一致（成本硬上限拒绝 / 并发拒绝 / 预留返回）', async () => {
  const engine = new QuotaEngine();
  engine.setDefault({ maxCostPerWindow: 1, windowMs: 60_000 });

  const d1 = await engine.admitAsync('t1', { cost: 0.5 }, true);
  assert.strictEqual(d1.allowed, true);
  assert.ok(d1.reservation && Math.abs(d1.reservation.cost - 0.5) < 1e-9);

  const d2 = await engine.admitAsync('t1', { cost: 0.8 }, true);
  assert.strictEqual(d2.allowed, false, '0.5+0.8 > 1 应拒绝');
  assert.match(d2.reason, /cost/);
  await engine.releaseAsync('t1');

  const c1 = await engine.admitAsync('t2');
  assert.strictEqual(c1.allowed, true);
  const c2 = await engine.admitAsync('t2');
  const d3 = await engine.admitAsync('t3'); // 独立租户做并发上限对照
  assert.strictEqual(d3.allowed, true);
  engine.releaseAsync('t3');
  await engine.releaseAsync('t2');
});

test('settleUsage（无 Redis）：实际替换预留，窗口不双重计费', async () => {
  const engine = new QuotaEngine();
  engine.setDefault({ maxCostPerWindow: 1, windowMs: 60_000 });
  const d = await engine.admitAsync('t', { cost: 0.5 }, true);
  await engine.settleUsage('t', { tokens: 100, cost: 0.3 }, d.reservation);
  const u = engine.getUsage('t');
  assert.strictEqual(u.tokensUsed, 100, '预留 token=0，实际 100 应全记');
  assert.ok(Math.abs(u.costUsed - 0.3) < 1e-9, '0.5 预留被 0.3 实际冲销');
  await engine.releaseAsync('t');
});

// ---------------------------------------------------------------------------
// Redis 后端：脚本化 FakeRedis 验证编排（预留透传 / 拒绝传递 / 故障 fail-open）
// ---------------------------------------------------------------------------

class FakeRedisOk {
  async eval() { return [1]; }
}
class FakeRedisDeny {
  async eval() { return [0, 'concurrency_limit', 500]; }
}
class FakeRedisDown {
  async eval() { throw new Error('ECONNRESET'); }
}

test('admitAsync（Redis）：走分布式后端，预留量原样透传', async () => {
  const engine = new QuotaEngine();
  engine.setRedisBackend(new FakeRedisOk());
  const d = await engine.admitAsync('t', { tokens: 10, cost: 0.2 }, true);
  assert.strictEqual(d.allowed, true);
  assert.strictEqual(d.reservation.tokens, 10);
  assert.ok(Math.abs(d.reservation.cost - 0.2) < 1e-9);
  assert.strictEqual(engine.getUsage('t').concurrency, 0, 'Redis 模式不写进程内桶');
});

test('admitAsync（Redis）：脚本拒绝原样传递 reason / retryAfterMs', async () => {
  const engine = new QuotaEngine();
  engine.setRedisBackend(new FakeRedisDeny());
  const d = await engine.admitAsync('t', {}, true);
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.reason, 'concurrency_limit');
  assert.strictEqual(d.retryAfterMs, 500);
});

test('admitAsync（Redis 故障）：fail-open 降级进程内 admit（可用性优先）', async () => {
  const engine = new QuotaEngine();
  engine.setDefault({ maxConcurrency: 1 });
  engine.setRedisBackend(new FakeRedisDown());
  const d1 = await engine.admitAsync('t');
  assert.strictEqual(d1.allowed, true, '降级后仍可准入');
  const d2 = await engine.admitAsync('t');
  assert.strictEqual(d2.allowed, false, '降级路径进程内并发闸仍生效');
  assert.match(d2.reason, /concurrency/);
  await engine.releaseAsync('t'); // 降级 release 走进程内
  const d3 = await engine.admitAsync('t');
  assert.strictEqual(d3.allowed, true, '进程内槽已归还');
  await engine.releaseAsync('t');
});

test('settleUsage（Redis 故障）：降级进程内 recordUsage 冲销语义', async () => {
  const engine = new QuotaEngine();
  engine.setRedisBackend(new FakeRedisDown());
  const d = await engine.admitAsync('t', { cost: 0.5 }, true);
  await engine.settleUsage('t', { tokens: 40, cost: 0.3 }, d.reservation);
  const u = engine.getUsage('t');
  assert.ok(Math.abs(u.costUsed - 0.3) < 1e-9);
  assert.strictEqual(u.tokensUsed, 40);
  await engine.releaseAsync('t');
});
