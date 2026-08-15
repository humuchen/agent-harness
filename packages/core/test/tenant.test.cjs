// 零依赖测试（node:test + node:assert）：覆盖 P0.3 租户上下文 tenant.ts。
// 关注：认证身份优先、匿名回退、复合记忆 key 分区（互不串档）。

const test = require('node:test');
const assert = require('node:assert');

const tenant = require('../dist/tenant.js');
const { resolveTenantContext, tenantSessionKey } = tenant;

test('resolveTenantContext：认证身份优先于请求体声明', () => {
  // 认证身份（SSO）权威，客户端声明被忽略，杜绝伪造越界。
  const ctx = resolveTenantContext({ authenticatedTenantId: 'acme', tenantId: 'evil' });
  assert.strictEqual(ctx.id, 'acme');
  assert.strictEqual(ctx.name, undefined);
});

test('resolveTenantContext：无认证时回落到请求体声明', () => {
  const ctx = resolveTenantContext({ tenantId: 'acme-corp' });
  assert.strictEqual(ctx.id, 'acme-corp');
});

test('resolveTenantContext：没有租户 / 归一化为 anonymous 时返回 null（退化为通用默认策略）', () => {
  assert.strictEqual(resolveTenantContext({}), null);
  assert.strictEqual(resolveTenantContext({ tenantId: '', authenticatedTenantId: '' }), null);
  assert.strictEqual(resolveTenantContext({ tenantId: 'anonymous' }), null);
  assert.strictEqual(resolveTenantContext({ authenticatedTenantId: 'anonymous' }), null);
});

test('resolveTenantContext：归一化拒绝路径穿越 / 注入（sanitizeKey）', () => {
  const ctx = resolveTenantContext({ authenticatedTenantId: '../跨租户/../x' });
  // sanitizeKey 把分隔符替换为 '_'、去空格；结果仍是单段安全标识。
  assert.ok(ctx.id);
  assert.strictEqual(ctx.id.includes('/'), false);
  assert.strictEqual(ctx.id.includes('..'), false);
});

test('tenantSessionKey：构造复合 key tenant::session，实现物理隔离', () => {
  const ctx = resolveTenantContext({ authenticatedTenantId: 'acme' });
  assert.strictEqual(tenantSessionKey(ctx, 'sess-1'), 'acme::sess-1');
  assert.strictEqual(tenantSessionKey(ctx, 'sess-2'), 'acme::sess-2');
});

test('tenantSessionKey：无租户时退化为原始 sessionKey（与今天一致）', () => {
  assert.strictEqual(tenantSessionKey(null, 'sess-1'), 'sess-1');
  assert.strictEqual(tenantSessionKey(undefined, 'sess-1'), 'sess-1');
});

test('tenantSessionKey：不同租户同 session 映射到不同 key（互不可见）', () => {
  const a = resolveTenantContext({ authenticatedTenantId: 'acme' });
  const b = resolveTenantContext({ authenticatedTenantId: 'globex' });
  assert.notStrictEqual(tenantSessionKey(a, 'shared'), tenantSessionKey(b, 'shared'));
});
