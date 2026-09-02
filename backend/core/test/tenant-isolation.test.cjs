// 零依赖测试（node:test + node:assert）：覆盖 P2 投产 Gap 3 —— 跨行业数据隔离强制门禁。
// 关注：REQUIRE_TENANT 解析、enforceTenantIsolation 在「强制 + 行业 agent + 无租户」时拦截、
// generic / 有租户 / 未强制 时放行（向后兼容默认关闭）。
//
// 直接 require 编译后的叶子模块（../dist/tenant.js）。

const test = require('node:test');
const assert = require('node:assert');

const tenant = require('../dist/tenant.js');
const { isTenantRequired, enforceTenantIsolation, resolveTenantContext } = tenant;

test('isTenantRequired：接受 1/true/yes/on（大小写不敏感）', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'On']) {
    assert.strictEqual(isTenantRequired({ REQUIRE_TENANT: v }), true, `REQUIRE_TENANT=${v} 应为 true`);
  }
});

test('isTenantRequired：缺省 / 其它值 / 空 → false（向后兼容默认关闭）', () => {
  assert.strictEqual(isTenantRequired({}), false);
  assert.strictEqual(isTenantRequired({ REQUIRE_TENANT: '' }), false);
  assert.strictEqual(isTenantRequired({ REQUIRE_TENANT: 'false' }), false);
  assert.strictEqual(isTenantRequired({ REQUIRE_TENANT: 'off' }), false);
  assert.strictEqual(isTenantRequired({ REQUIRE_TENANT: '0' }), false);
  assert.strictEqual(isTenantRequired({ REQUIRE_TENANT: 'nope' }), false);
});

test('enforceTenantIsolation：未强制 → 行业 agent 无租户也放行', () => {
  const res = enforceTenantIsolation({ agentDomain: 'finance', tenant: null, requireTenant: false });
  assert.strictEqual(res, null);
});

test('enforceTenantIsolation：强制 + 行业 agent + 无租户 → 拒绝（denied）', () => {
  const res = enforceTenantIsolation({ agentDomain: 'finance', tenant: null, requireTenant: true });
  assert.ok(res && res.denied === true);
  assert.ok(res.reason.includes('finance'));
});

test('enforceTenantIsolation：强制但 generic 域 → 放行（通用任务不受影响）', () => {
  const res = enforceTenantIsolation({ agentDomain: 'generic', tenant: null, requireTenant: true });
  assert.strictEqual(res, null);
});

test('enforceTenantIsolation：强制 + 行业 agent + 有租户 → 放行', () => {
  const tenantCtx = resolveTenantContext({ authenticatedTenantId: 'acme' });
  const res = enforceTenantIsolation({ agentDomain: 'finance', tenant: tenantCtx, requireTenant: true });
  assert.strictEqual(res, null);
});

test('enforceTenantIsolation：未传 domain 视为 generic → 放行', () => {
  const res = enforceTenantIsolation({ agentDomain: undefined, tenant: null, requireTenant: true });
  assert.strictEqual(res, null);
});

test('enforceTenantIsolation：requireTenant 缺省时回退 env REQUIRE_TENANT', () => {
  const prev = process.env.REQUIRE_TENANT;
  process.env.REQUIRE_TENANT = 'on';
  try {
    const deny = enforceTenantIsolation({ agentDomain: 'healthcare', tenant: null });
    assert.ok(deny && deny.denied === true);
    const allow = enforceTenantIsolation({ agentDomain: 'generic', tenant: null });
    assert.strictEqual(allow, null);
  } finally {
    if (prev === undefined) delete process.env.REQUIRE_TENANT;
    else process.env.REQUIRE_TENANT = prev;
  }
});
