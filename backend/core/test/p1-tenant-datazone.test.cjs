'use strict';
// P1：租户数据分区 —— resolveTenantDbPath（per-zone 物理分区）+ TenantContext.dataZone/residency 透传。
const test = require('node:test');
const assert = require('node:assert');

const { resolveTenantDbPath } = require('../dist/db-adapter.js');
const { resolveTenantContext, tenantSessionKey } = require('../dist/tenant.js');

test('resolveTenantDbPath: general / 空 / 未传 = 原路径不变（向后兼容）', () => {
  const base = './data/app.db';
  assert.strictEqual(resolveTenantDbPath(base), base);
  assert.strictEqual(resolveTenantDbPath(base, ''), base);
  assert.strictEqual(resolveTenantDbPath(base, 'general'), base);
});

test('resolveTenantDbPath: medical zone 落到子目录', () => {
  // 用 path.normalize 做平台无关断言：实现经 path.join 拼接，Windows 产出反斜杠
  // （曾因硬编码 'data/medical/app.db' 在 Windows 上稳定失败）。
  const path = require('node:path');
  const p = resolveTenantDbPath('./data/app.db', 'medical');
  assert.ok(p.includes(path.normalize('data/medical/app.db')), '应含 medical 子目录，实际：' + p);
});

test('resolveTenantDbPath: 非法 zone（路径穿越）回退原路径', () => {
  const base = './data/app.db';
  assert.strictEqual(resolveTenantDbPath(base, '../etc/passwd'), base);
  assert.strictEqual(resolveTenantDbPath(base, 'a/b'), base);
  assert.strictEqual(resolveTenantDbPath(base, 'x y'), base);
});

test('resolveTenantContext: 透传 dataZone / residency 新字段', () => {
  const ctx = resolveTenantContext({
    tenantId: 't1',
    authenticatedTenantId: 'auth-t1',
    domain: 'healthcare',
    dataZone: 'medical',
    residency: 'cn',
  });
  assert.ok(ctx, '应解析出 tenant ctx');
  assert.strictEqual(ctx.id, 'auth-t1');
  assert.strictEqual(ctx.domain, 'healthcare');
  assert.strictEqual(ctx.dataZone, 'medical');
  assert.strictEqual(ctx.residency, 'cn');
});

test('resolveTenantContext: 无 dataZone 时字段为 undefined（向后兼容）', () => {
  const ctx = resolveTenantContext({ tenantId: 't2' });
  assert.ok(ctx);
  assert.strictEqual(ctx.dataZone, undefined);
  assert.strictEqual(ctx.residency, undefined);
});

test('tenantSessionKey: 含新字段的 ctx 仍按原 id::session 格式隔离', () => {
  const ctx = resolveTenantContext({ tenantId: 't3', dataZone: 'financial' });
  assert.strictEqual(tenantSessionKey(ctx, 's1'), 't3::s1');
  assert.strictEqual(tenantSessionKey(null, 's1'), 's1');
});

test('resolveTenantContext: dataZone 缺省读 TENANT_DATA_ZONE env（部署级基线）', () => {
  const old = process.env.TENANT_DATA_ZONE;
  process.env.TENANT_DATA_ZONE = 'medical';
  try {
    const ctx = resolveTenantContext({ tenantId: 't10' });
    assert.strictEqual(ctx?.dataZone, 'medical', 'env 应自动派生 dataZone');
    // 调用方显式传入应覆盖 env
    const ctx2 = resolveTenantContext({ tenantId: 't11', dataZone: 'financial' });
    assert.strictEqual(ctx2?.dataZone, 'financial', '显式传入应优先于 env');
  } finally {
    if (old === undefined) delete process.env.TENANT_DATA_ZONE; else process.env.TENANT_DATA_ZONE = old;
  }
});

test('resolveTenantContext: TENANT_DATA_ZONE 未设时 dataZone 为 undefined（向后兼容）', () => {
  const old = process.env.TENANT_DATA_ZONE;
  delete process.env.TENANT_DATA_ZONE;
  try {
    const ctx = resolveTenantContext({ tenantId: 't12' });
    assert.strictEqual(ctx?.dataZone, undefined, '未设 env 且未传入时 dataZone 应为 undefined');
  } finally {
    if (old !== undefined) process.env.TENANT_DATA_ZONE = old;
  }
});
