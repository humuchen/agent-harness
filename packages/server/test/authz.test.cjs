// RBAC + 审批工作流 单元测试（业务层，零依赖 node:test）。
// 需在 pnpm --filter @agent-harness/server build 之后运行：node --test test/*.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const { RoleBasedAuthorizer, createAuthorizer } = require('../dist/authz.js');
const { InMemoryApprovalPolicy, createApprovalPolicy } = require('../dist/approval.js');

function fakeReq(headers = {}, url = '/x') {
  return { headers, url };
}

test('RoleBasedAuthorizer: 令牌映射到角色 + 权限矩阵', () => {
  const az = new RoleBasedAuthorizer({
    tokens: { adminTok: 'admin', opTok: 'operator' },
    fallbackToken: 'legacy', fallbackRole: 'operator',
  });
  const admin = az.authenticate(fakeReq({ authorization: 'Bearer adminTok' }));
  assert.ok(admin);
  assert.strictEqual(admin.role, 'admin');
  assert.strictEqual(az.can(admin, 'env:create'), true);
  assert.strictEqual(az.can(admin, 'memory:clear'), true);

  const op = az.authenticate(fakeReq({ authorization: 'Bearer opTok' }));
  assert.strictEqual(op.role, 'operator');
  assert.strictEqual(az.can(op, 'env:create'), true);
  assert.strictEqual(az.can(op, 'memory:clear'), false); // operator 不能清记忆

  const legacy = az.authenticate(fakeReq({ authorization: 'Bearer legacy' }));
  assert.strictEqual(legacy.role, 'operator');

  // 错误令牌 / 缺头 → null
  assert.strictEqual(az.authenticate(fakeReq({ authorization: 'Bearer nope' })), null);
  assert.strictEqual(az.authenticate(fakeReq({})), null);
  // ?token= 兼容旧用法
  assert.strictEqual(az.authenticate(fakeReq({}, '/x?token=opTok')).role, 'operator');
});

test('createAuthorizer: 关闭鉴权时全放行', () => {
  const az = createAuthorizer(false);
  const ctx = az.authenticate(fakeReq({}));
  assert.strictEqual(ctx.role, 'admin');
  assert.strictEqual(az.can(ctx, 'env:destroy'), true);
  assert.strictEqual(az.describe().mode, 'off');
});

test('InMemoryApprovalPolicy: 敏感动作需审批，admin 绕过', () => {
  const pol = new InMemoryApprovalPolicy({ bypassRoles: ['admin'] });
  const adminCtx = { token: 't', sub: 'a', role: 'admin' };
  const opCtx = { token: 't', sub: 'o', role: 'operator' };

  assert.strictEqual(pol.requiresApproval('env:create', opCtx), true);
  assert.strictEqual(pol.requiresApproval('env:create', adminCtx), false); // 绕过
  assert.strictEqual(pol.requiresApproval('metrics:read', opCtx), false); // 只读免审批

  // 创建工单 → 未带票据消费失败 → 审批后消费成功
  const ticket = pol.create('env:create', opCtx, 'env:create · by o/operator');
  assert.strictEqual(pol.consume(ticket.id, 'env:create', opCtx), null); // pending 不可消费
  assert.strictEqual(pol.consume('wrong', 'env:create', opCtx), null); // 不存在
  assert.strictEqual(pol.consume(ticket.id, 'env:destroy', opCtx), null); // 动作不一致拒绝越权复用

  const decided = pol.decide(ticket.id, 'approve', 'a');
  assert.strictEqual(decided.status, 'approved');
  assert.strictEqual(pol.consume(ticket.id, 'env:create', opCtx).id, ticket.id);

  // 已决工单不能再裁决
  assert.strictEqual(pol.decide(ticket.id, 'reject', 'a'), null);
  // 列表过滤
  assert.strictEqual(pol.list({ status: 'approved' }).length, 1);
  assert.strictEqual(pol.list({ status: 'pending' }).length, 0);
});

test('createApprovalPolicy: 从环境变量读取 bypass 角色', () => {
  process.env.UI_APPROVAL_BYPASS_ROLES = 'admin,operator';
  const pol = createApprovalPolicy();
  assert.strictEqual(pol.requiresApproval('env:create', { token: 't', sub: 'o', role: 'operator' }), false);
  delete process.env.UI_APPROVAL_BYPASS_ROLES;
});
