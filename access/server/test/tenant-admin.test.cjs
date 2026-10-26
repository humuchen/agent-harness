// 长期：租户管理 API（/api/admin/tenants/*）+ 用量账本（usage_daily）测试。
// 路由经真实 http server 驱动（stub guard 注入 admin 身份），存储落临时 sqlite。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const dir = mkdtempSync(join(tmpdir(), 'tenant-admin-'));
process.env.TENANT_REGISTRY_DB_FILE = join(dir, 'tenants.db');

const { TenantQuotaStore, getTenantRegistry } = require('@agent-harness/core');
const { UsageLedger, configureUsageLedger, getUsageLedger } = require('../dist/usage-ledger.js');
const { handleTenantRoutes } = require('../dist/routes/tenant-routes.js');

const adminCtx = { token: 't', sub: 'root', role: 'admin' };

function startApp(deps) {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const handled = await handleTenantRoutes(req, res, url, url.pathname, deps);
      if (!handled) {
        res.statusCode = 404;
        res.end('{"error":"not found"}');
      }
    });
    srv.listen(0, () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

describe('UsageLedger（(tenant, UTC日) 聚合账本）', () => {
  const file = join(dir, 'usage.db');
  const ledger = new UsageLedger({ file });

  test('record/recordRun 缓冲聚合 + flush 落库 + 区间查询', async () => {
    await ledger.init();
    ledger.record('acme', 100, 0.01);
    ledger.record('acme', 250, 0.02);
    ledger.recordRun('acme');
    ledger.recordRun('acme');
    ledger.recordRun('acme');
    ledger.record('other', 5, 0.001);
    await ledger.flush();
    const today = UsageLedger.dayOf();
    const rows = await ledger.query('acme', today, today);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokens, 350);
    assert.ok(Math.abs(rows[0].cost - 0.03) < 1e-9);
    assert.equal(rows[0].runs, 3);
    // 区间过滤：未来日期查不到
    const none = await ledger.query('acme', '2999-01-01');
    assert.equal(none.length, 0);
    // 累加语义：同日再记一笔
    ledger.record('acme', 50, 0.01);
    await ledger.flush();
    const rows2 = await ledger.query('acme', today, today);
    assert.equal(rows2[0].tokens, 400);
  });

  test('close 后缓冲不丢（优雅 flush）', async () => {
    ledger.record('acme', 10, 0.001);
    await ledger.close();
    const today = UsageLedger.dayOf();
    const rows = await ledger.query('acme', today, today);
    assert.equal(rows[0].tokens, 410);
  });
});

describe('租户管理 API（/api/admin/tenants/*）', () => {
  let base, srv;
  const registry = getTenantRegistry();
  const quotaStore = new TenantQuotaStore({ file: join(dir, 'quotas.db') });
  const audits = [];

  before(async () => {
    await registry.init();
    await quotaStore.init();
    // 路由内的 usage 端点读进程单例账本 —— 预配置到临时文件（模拟 server 启动装配）。
    configureUsageLedger({ file: join(dir, 'usage-admin.db') });
    await getUsageLedger().init();
    ({ srv, base } = await startApp({
      guard: async (_req, _res, action) => {
        if (action === 'tenants:read' || action === 'tenants:manage') return adminCtx;
        return null;
      },
      auditAction: (action, fields) => audits.push({ action, fields }),
      quotaStore,
    }));
  });

  after(async () => {
    await getUsageLedger().close();
    srv.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不阻断 */ }
  });

  const j = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: await r.json() };
  };

  test('POST 创建档案 → GET 列表/详情', async () => {
    const c = await j('POST', '/api/admin/tenants', { tenantId: 'acme', name: 'Acme', dataZone: 'medical', plan: 'pro' });
    assert.equal(c.status, 200);
    assert.equal(c.json.tenant.dataZone, 'medical');
    const list = await j('GET', '/api/admin/tenants');
    assert.equal(list.status, 200);
    assert.ok(list.json.tenants.some((t) => t.tenantId === 'acme'));
    const one = await j('GET', '/api/admin/tenants/acme');
    assert.equal(one.json.tenant.plan, 'pro');
    assert.equal((await j('GET', '/api/admin/tenants/ghost')).status, 404);
  });

  test('PUT patch 更新：只覆盖显式字段；status 快改端点', async () => {
    const u = await j('PUT', '/api/admin/tenants/acme', { plan: 'enterprise' });
    assert.equal(u.json.tenant.plan, 'enterprise');
    assert.equal(u.json.tenant.dataZone, 'medical', 'patch 不应清掉未提及字段');
    const s = await j('POST', '/api/admin/tenants/acme/status', { status: 'suspended' });
    assert.equal(s.json.tenant.status, 'suspended');
    assert.ok(audits.some((a) => a.action === 'tenant.status'));
    await j('POST', '/api/admin/tenants/acme/status', { status: 'active' });
  });

  test('配额覆盖：PUT/GET/DELETE（委托 TenantQuotaStore）', async () => {
    const p = await j('PUT', '/api/admin/tenants/acme/quotas', { qps: 5, maxCostPerWindow: 1.5 });
    assert.equal(p.status, 200);
    assert.equal(p.json.quota.qps, 5);
    const g = await j('GET', '/api/admin/tenants/acme/quotas');
    assert.equal(g.json.quota.maxCostPerWindow, 1.5);
    const d = await j('DELETE', '/api/admin/tenants/acme/quotas');
    assert.equal(d.status, 200);
    assert.equal((await j('GET', '/api/admin/tenants/acme/quotas')).json.quota, null);
  });

  test('配额写入校验：无有效字段 → 400', async () => {
    const bad = await j('PUT', '/api/admin/tenants/acme/quotas', { qps: 'abc' });
    assert.equal(bad.status, 400);
  });

  test('usage 账单端点：读前自动 flush + totals 聚合 + model 维度细分', async () => {
    // 记账走进程单例（与路由同源），缓冲未 flush —— 端点读前自动 flush 应可见
    getUsageLedger().record('acme', 1000, 0.5, 'gpt-4o-mini');
    getUsageLedger().record('acme', 200, 0.1, 'claude-3-5-haiku');
    getUsageLedger().recordRun('acme');
    const today = UsageLedger.dayOf();
    const u = await j('GET', `/api/admin/tenants/acme/usage?from=${today}&to=${today}`);
    assert.equal(u.status, 200);
    assert.ok(u.json.daily.length >= 1, '读前 flush 应让缓冲可见');
    assert.equal(u.json.totals.tokens, 1200);
    assert.equal(u.json.totals.runs, 1);
    assert.ok(Math.abs(u.json.totals.cost - 0.6) < 1e-9);
    // model 维度细分
    assert.ok(Array.isArray(u.json.modelDaily), '应返回 modelDaily 细分');
    const gpt = u.json.modelDaily.find((m) => m.model === 'gpt-4o-mini');
    const claude = u.json.modelDaily.find((m) => m.model === 'claude-3-5-haiku');
    assert.ok(gpt && gpt.tokens === 1000 && Math.abs(gpt.cost - 0.5) < 1e-9, 'gpt-4o-mini 细分应正确');
    assert.ok(claude && claude.tokens === 200 && Math.abs(claude.cost - 0.1) < 1e-9, 'claude 细分应正确');
  });

  test('DELETE 档案（运营撤销）', async () => {
    const d = await j('DELETE', '/api/admin/tenants/acme');
    assert.equal(d.status, 200);
    assert.equal((await j('GET', '/api/admin/tenants/acme')).status, 404);
  });

  test('方法不允许 → 405', async () => {
    assert.equal((await j('PUT', '/api/admin/tenants/acme/status', { status: 'active' })).status, 405);
  });
});
