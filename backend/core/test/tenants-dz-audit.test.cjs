// 长期首片测试：TenantRegistry（档案/准入/缓存）+ enforceDataZone + 护栏命中审计 sink。
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  TenantRegistry,
  enforceDataZone,
  resolveTenantContext,
  registerGuardrailAuditSink,
  registerInputRule,
  checkInput,
} = require('../dist/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('TenantRegistry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tenant-reg-'));
  const file = join(dir, 'tenants.db');
  const reg = new TenantRegistry({ file, ttlMs: 50 });

  test('upsert + get + list（持久化语义）', async () => {
    await reg.init();
    const r = await reg.upsert('acme', { name: 'Acme 医美', dataZone: 'medical', plan: 'pro' });
    assert.equal(r.status, 'active');
    assert.equal(r.dataZone, 'medical');
    const got = await reg.get('acme');
    assert.equal(got?.name, 'Acme 医美');
    // patch 语义：仅覆盖显式字段
    await reg.upsert('acme', { plan: 'enterprise' });
    const got2 = await reg.get('acme');
    assert.equal(got2?.plan, 'enterprise');
    assert.equal(got2?.dataZone, 'medical', 'patch 不应清掉未提及字段');
    const list = await reg.list();
    assert.ok(list.some((t) => t.tenantId === 'acme'));
  });

  test('checkAdmission：未建档放行 / active 放行 / suspended 拒绝', async () => {
    assert.equal((await reg.checkAdmission('ghost')).ok, true, '未建档租户按现行隐式语义放行');
    assert.equal((await reg.checkAdmission('acme')).ok, true);
    await reg.upsert('acme', { status: 'suspended' });
    const deny = await reg.checkAdmission('acme');
    assert.equal(deny.ok, false);
    if (!deny.ok) assert.ok(deny.reason.includes('suspended'));
    await reg.upsert('acme', { status: 'active' });
    assert.equal((await reg.checkAdmission('acme')).ok, true);
  });

  test('TTL 缓存生效（写路径即时刷缓存）', async () => {
    await reg.upsert('cached', { name: 'a' });
    assert.equal((await reg.get('cached'))?.name, 'a');
    await reg.upsert('cached', { name: 'b' });
    assert.equal((await reg.get('cached'))?.name, 'b', '写后缓存应立即反映新值');
  });

  test('持久化：重建实例（模拟重启）后档案仍在', async () => {
    const reg2 = new TenantRegistry({ file, ttlMs: 50 });
    await reg2.init();
    assert.equal((await reg2.get('acme'))?.plan, 'enterprise');
  });
});

describe('enforceDataZone（长期首片）', () => {
  test('无租户 / 未声明分区 / 一致 → 放行', () => {
    assert.equal(enforceDataZone({ tenant: null, declaredZone: 'medical' }), null);
    const t = resolveTenantContext({ tenantId: 't1' });
    assert.equal(enforceDataZone({ tenant: t, declaredZone: 'medical' }), null, '租户未绑定 zone 时不判定');
    const mz = { id: 't1', dataZone: 'medical' };
    assert.equal(enforceDataZone({ tenant: mz, declaredZone: null }), null, '请求未声明不误伤');
    assert.equal(enforceDataZone({ tenant: mz, declaredZone: 'medical' }), null, '一致放行');
  });

  test('不一致 → 拒绝（附双端 zone）', () => {
    const mz = { id: 't1', dataZone: 'medical' };
    const d = enforceDataZone({ tenant: mz, declaredZone: 'general' });
    assert.ok(d && d.denied);
    if (d) {
      assert.ok(d.reason.includes('medical'));
      assert.ok(d.reason.includes('general'));
    }
  });
});

describe('护栏命中审计 sink（中期补全）', () => {
  test('自定义规则命中时广播 hit（含 scope/matched/reason），异常隔离', () => {
    const hits = [];
    let boom = false;
    const off1 = registerGuardrailAuditSink((h) => hits.push(h));
    const off2 = registerGuardrailAuditSink(() => {
      if (boom) throw new Error('sink down');
    });
    const unreg = registerInputRule(/SECRET_MARK_ABC/, '测试规则：命中即拦', 'test-audit-scope');
    try {
      boom = true;
      const r = checkInput('here is SECRET_MARK_ABC in text', { scopes: ['test-audit-scope'] });
      assert.equal(r.ok, false, '规则应命中');
      assert.equal(hits.length, 1, 'sink 抛异常不影响判定与其它 sink');
      assert.equal(hits[0].side, 'input');
      assert.equal(hits[0].scope, 'test-audit-scope');
      assert.equal(hits[0].matched, 'SECRET_MARK_ABC');
      assert.ok(hits[0].reason.includes('测试规则'));
      assert.ok(typeof hits[0].hitAt === 'number');
      // 注销后不再广播
      off1();
      off2();
      unreg();
      checkInput('no match here', { scopes: ['test-audit-scope'] });
      assert.equal(hits.length, 1);
    } finally {
      off1();
      off2();
      unreg();
    }
  });

  test('scope 不匹配的规则不产生命中广播', () => {
    const hits = [];
    const off = registerGuardrailAuditSink((h) => hits.push(h));
    const unreg = registerInputRule(/SCOPE_MISS_XYZ/, 'scope miss rule', 'scope-a');
    try {
      checkInput('contains SCOPE_MISS_XYZ but wrong scope', { scopes: ['scope-b'] });
      assert.equal(hits.length, 0, 'scope 外规则不应广播');
    } finally {
      off();
      unreg();
    }
  });
});
