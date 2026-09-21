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

test('createAuthorizer: 关闭鉴权时全放行', async () => {
  const az = createAuthorizer(false);
  const ctx = await az.authenticate(fakeReq({}));
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

// ── AccountAuthorizer：cookie 来源（浏览器直接导航）跳过 x-ah-username 双因子 ──
// 背景：<a> 直连下载/预览（如 GET /api/artifacts/:id?preview=1）是浏览器顶级导航，
// 物理上只自动携带 HttpOnly cookie，带不了 x-ah-username 自定义头 → 一直 401
//（「unauthorized: missing or invalid token」）。cookie 为 HttpOnly（JS 不可读、无法在
// 会话外重放），本身即会话凭据，跳过双因子头校验不扩大攻击面；Authorization / ?token=
// 来源维持双因子不变。
test('AccountAuthorizer: cookie 来源放行浏览器直接导航，header/query 来源维持双因子', async (t) => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-authz-acct-'));
  process.env.ACCOUNT_DB_FILE = path.join(dir, 'accounts.db');
  t.after(() => {
    delete process.env.ACCOUNT_DB_FILE;
    // Windows 上 DB 文件句柄可能延迟释放（EBUSY）——清理尽力而为，Temp 目录残留无害。
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  const { issueTokens } = require('../dist/accounts.js');
  const { AccountAuthorizer } = require('../dist/authz.js');
  const { accessToken } = await issueTokens('navuser');
  const az = new AccountAuthorizer(new RoleBasedAuthorizer({ tokens: {} }));

  // 1) 浏览器直接导航（<a> 点击 / window.open）：只有 cookie、无 x-ah-username 头 → 放行。
  const nav = await az.authenticate(
    fakeReq({ cookie: `ah_auth=${accessToken}` }, '/api/artifacts/x?preview=1')
  );
  assert.ok(nav, 'cookie-only 导航应放行（本次修复的核心行为）');
  assert.strictEqual(nav.sub, 'navuser');
  assert.strictEqual(nav.role, 'viewer');

  // 2) Authorization 来源缺 x-ah-username 头 → 仍拒绝（双因子不放宽）。
  assert.strictEqual(
    await az.authenticate(fakeReq({ authorization: `Bearer ${accessToken}` })),
    null,
    'header 来源缺 username 头必须拒绝'
  );

  // 3) Authorization 来源带正确 username 头 → 放行（原行为保持）。
  const withHeader = await az.authenticate(
    fakeReq({ authorization: `Bearer ${accessToken}`, 'x-ah-username': 'navuser' })
  );
  assert.ok(withHeader && withHeader.sub === 'navuser');

  // 4) Authorization 来源 username 头与 token 签名不一致 → 拒绝（防冒用）。
  assert.strictEqual(
    await az.authenticate(
      fakeReq({ authorization: `Bearer ${accessToken}`, 'x-ah-username': 'someone-else' })
    ),
    null
  );

  // 5) ?token= 来源同样维持双因子（缺头拒绝）。
  assert.strictEqual(
    await az.authenticate(fakeReq({}, `/x?token=${encodeURIComponent(accessToken)}`)),
    null
  );

  // 6) 无任何凭据 → null。
  assert.strictEqual(await az.authenticate(fakeReq({})), null);

  // 7) 篡改 cookie（坏签名）→ null。
  assert.strictEqual(
    await az.authenticate(fakeReq({ cookie: `ah_auth=${accessToken.slice(0, -2)}zz` })),
    null
  );
});
