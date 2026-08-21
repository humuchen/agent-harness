/**
 * 业务层 · RBAC 鉴权 + 审批工作流 + 队列后端 单元测试。
 *
 * 覆盖核心业务契约：
 * - RoleBasedAuthorizer：角色权限矩阵 / 认证提取 / 多令牌 / 降级模式
 * - InMemoryApprovalPolicy：敏感动作审批 / 票据生命周期 / 绕过角色
 * - MemoryQueueBackend / FileQueueBackend：持久化 / 原子领取 / 崩溃恢复
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// 被测模块(相对路径指向 server/dist)
const { RoleBasedAuthorizer, createAuthorizer } = require('../dist/authz');
const { InMemoryApprovalPolicy } = require('../dist/approval');
const {
  MemoryQueueBackend,
  FileQueueBackend
} = require('../dist/queue-backend');

// ===========================================================================
// RBAC 鉴权测试
// ===========================================================================

describe('RoleBasedAuthorizer', () => {
  test('admin 拥有全部权限', () => {
    const authz = new RoleBasedAuthorizer({
      tokens: { 'admin-token': 'admin' }
    });
    const ctx = authz.authenticate({
      headers: { authorization: 'Bearer admin-token' }
    });
    assert.ok(ctx);
    assert.strictEqual(ctx.role, 'admin');
    // admin 应能执行所有动作
    const actions = [
      'agent:run:real',
      'env:create',
      'mcp:add',
      'memory:clear',
      'plugin:manage'
    ];
    for (const action of actions) {
      assert.ok(authz.can(ctx, action), `admin 应能执行 ${action}`);
    }
  });

  test('operator 可运行 agent 且也能管理插件', () => {
    const authz = new RoleBasedAuthorizer({
      tokens: { 'op-token': 'operator' }
    });
    const ctx = authz.authenticate({
      headers: { authorization: 'Bearer op-token' }
    });
    assert.ok(ctx);
    assert.strictEqual(ctx.role, 'operator');
    assert.ok(authz.can(ctx, 'agent:run:real'));
    assert.ok(authz.can(ctx, 'env:create'));
    // operator 也有插件管理权限
    assert.ok(authz.can(ctx, 'plugin:manage'));
  });

  test('viewer 只能读取', () => {
    const authz = new RoleBasedAuthorizer({
      tokens: { 'view-token': 'viewer' }
    });
    const ctx = authz.authenticate({
      headers: { authorization: 'Bearer view-token' }
    });
    assert.ok(ctx);
    assert.strictEqual(ctx.role, 'viewer');
    // viewer 可读 metrics/sessions
    assert.ok(authz.can(ctx, 'metrics:read'));
    assert.ok(authz.can(ctx, 'sessions:read'));
    // viewer 不能运行 agent 或创建环境
    assert.ok(!authz.can(ctx, 'agent:run:real'));
    assert.ok(!authz.can(ctx, 'env:create'));
  });

  test('无效令牌返回 null', () => {
    const authz = new RoleBasedAuthorizer({
      tokens: { 'valid-token': 'operator' }
    });
    const ctx = authz.authenticate({
      headers: { authorization: 'Bearer invalid-token' }
    });
    assert.strictEqual(ctx, null);
  });

  test('缺少 Authorization 头返回 null', () => {
    const authz = new RoleBasedAuthorizer({
      tokens: { token: 'operator' }
    });
    const ctx = authz.authenticate({ headers: {} });
    assert.strictEqual(ctx, null);
  });

  test('多令牌多角色映射', () => {
    const authz = new RoleBasedAuthorizer({
      tokens: {
        'admin-tok': 'admin',
        'op-tok': 'operator',
        'view-tok': 'viewer'
      }
    });
    assert.strictEqual(
      authz.authenticate({ headers: { authorization: 'Bearer admin-tok' } })
        ?.role,
      'admin'
    );
    assert.strictEqual(
      authz.authenticate({ headers: { authorization: 'Bearer op-tok' } })?.role,
      'operator'
    );
    assert.strictEqual(
      authz.authenticate({ headers: { authorization: 'Bearer view-tok' } })
        ?.role,
      'viewer'
    );
  });

  test('describe 返回配置概览且不泄露令牌', () => {
    const authz = new RoleBasedAuthorizer({
      tokens: { secret: 'admin' }
    });
    const desc = authz.describe();
    assert.strictEqual(desc.mode, 'on');
    assert.strictEqual(desc.provider, 'token');
    assert.ok(desc.roles.includes('admin'));
    // 不应包含令牌明文
    assert.ok(!JSON.stringify(desc).includes('secret'));
  });

  test('无令牌时 mode 为 off', () => {
    const authz = new RoleBasedAuthorizer({});
    const desc = authz.describe();
    assert.strictEqual(desc.mode, 'off');
    // degraded 默认为 false
    assert.strictEqual(desc.degraded, false);
  });
});

// ===========================================================================
// 审批工作流测试
// ===========================================================================

describe('InMemoryApprovalPolicy', () => {
  test('敏感动作需要审批（非 admin）', () => {
    const policy = new InMemoryApprovalPolicy();
    const ctx = { role: 'operator', sub: 'user1', token: 'tok' };
    assert.ok(policy.requiresApproval('agent:run:real', ctx));
    assert.ok(policy.requiresApproval('env:create', ctx));
    assert.ok(policy.requiresApproval('memory:clear', ctx));
  });

  test('admin 角色绕过审批', () => {
    const policy = new InMemoryApprovalPolicy({ bypassRoles: ['admin'] });
    const ctx = { role: 'admin', sub: 'admin1', token: 'tok' };
    assert.ok(!policy.requiresApproval('agent:run:real', ctx));
    assert.ok(!policy.requiresApproval('env:destroy', ctx));
  });

  test('非敏感动作不需要审批', () => {
    const policy = new InMemoryApprovalPolicy();
    const ctx = { role: 'operator', sub: 'user1', token: 'tok' };
    assert.ok(!policy.requiresApproval('metrics:read', ctx));
    assert.ok(!policy.requiresApproval('mcp:read', ctx));
  });

  test('票据生命周期：创建 → 批准 → 消费', () => {
    const policy = new InMemoryApprovalPolicy();
    const ctx = { role: 'operator', sub: 'user1', token: 'tok' };

    // 创建票据
    const ticket = policy.create('agent:run:real', ctx, '运行真实模型');
    assert.ok(ticket.id);
    assert.strictEqual(ticket.status, 'pending');
    assert.strictEqual(ticket.action, 'agent:run:real');

    // 未批准时消费失败
    assert.strictEqual(policy.consume(ticket.id, 'agent:run:real', ctx), null);

    // 审批人批准
    const updated = policy.decide(ticket.id, 'approve', 'admin1');
    assert.ok(updated);
    assert.strictEqual(updated.status, 'approved');

    // 消费成功
    const consumed = policy.consume(ticket.id, 'agent:run:real', ctx);
    assert.ok(consumed);
    assert.strictEqual(consumed.status, 'approved');
  });

  test('票据与动作不匹配时消费失败', () => {
    const policy = new InMemoryApprovalPolicy();
    const ctx = { role: 'operator', sub: 'user1', token: 'tok' };
    const ticket = policy.create('agent:run:real', ctx, '运行');
    policy.decide(ticket.id, 'approve', 'admin1');

    // 用 agent:run:real 的票据去消费 env:create
    assert.strictEqual(policy.consume(ticket.id, 'env:create', ctx), null);
  });

  test('拒绝后消费失败', () => {
    const policy = new InMemoryApprovalPolicy();
    const ctx = { role: 'operator', sub: 'user1', token: 'tok' };
    const ticket = policy.create('env:create', ctx, '创建环境');
    policy.decide(ticket.id, 'reject', 'admin1');

    assert.strictEqual(policy.consume(ticket.id, 'env:create', ctx), null);
  });

  test('list 按 createdAt 倒序返回票据', () => {
    const policy = new InMemoryApprovalPolicy();
    const ctx = { role: 'operator', sub: 'user1', token: 'tok' };

    // 确保有时间差
    const t1 = policy.create('agent:run:real', ctx, '第一个');
    // 手动修改 createdAt 确保顺序
    const t2 = policy.create('env:create', ctx, '第二个');

    // 如果创建太快,手动调整时间戳
    if (t1.createdAt === t2.createdAt) {
      t2.createdAt = t1.createdAt + 1;
    }

    const list = policy.list();
    assert.strictEqual(list.length, 2);
    // 新的在前(createdAt 大的在前)
    assert.ok(list[0].createdAt >= list[1].createdAt, '应按时间倒序');
  });

  test('list 支持按状态过滤', () => {
    const policy = new InMemoryApprovalPolicy();
    const ctx = { role: 'operator', sub: 'user1', token: 'tok' };
    const t1 = policy.create('agent:run:real', ctx, '待审');
    const t2 = policy.create('env:create', ctx, '已批');
    policy.decide(t2.id, 'approve', 'admin1');

    const pending = policy.list({ status: 'pending' });
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].id, t1.id);

    const approved = policy.list({ status: 'approved' });
    assert.strictEqual(approved.length, 1);
    assert.strictEqual(approved[0].id, t2.id);
  });
});

// ===========================================================================
// 队列后端测试
// ===========================================================================

describe('MemoryQueueBackend', () => {
  test('append → claim → ack 完整流程', async () => {
    const backend = new MemoryQueueBackend();
    const job = {
      id: 'j1',
      mode: 'mock',
      prompt: 'test',
      enqueuedAt: Date.now()
    };

    await backend.append(job);
    const list = await backend.list();
    assert.strictEqual(list.length, 1);

    const claimed = await backend.claim();
    assert.ok(claimed);
    assert.strictEqual(claimed.id, 'j1');

    // claim 后 list 应为空
    assert.strictEqual((await backend.list()).length, 0);

    await backend.ack('j1');
  });

  test('空队列 claim 返回 null', async () => {
    const backend = new MemoryQueueBackend();
    const claimed = await backend.claim();
    assert.strictEqual(claimed, null);
  });

  test('clear 清空队列', async () => {
    const backend = new MemoryQueueBackend();
    await backend.append({
      id: 'j1',
      mode: 'mock',
      prompt: 't1',
      enqueuedAt: Date.now()
    });
    await backend.append({
      id: 'j2',
      mode: 'mock',
      prompt: 't2',
      enqueuedAt: Date.now()
    });

    await backend.clear();
    assert.strictEqual((await backend.list()).length, 0);
  });
});

describe('FileQueueBackend', () => {
  let tmpDir;
  let tmpFile;

  test.beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-test-'));
    tmpFile = path.join(tmpDir, 'queue.jsonl');
  });

  test.afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('append → claim → ack 完整流程（含持久化）', async () => {
    const backend = new FileQueueBackend({ file: tmpFile });
    const job = {
      id: 'j1',
      mode: 'mock',
      prompt: 'test',
      enqueuedAt: Date.now()
    };

    await backend.append(job);

    // 验证文件已写入
    const raw = await fs.readFile(tmpFile, 'utf-8');
    assert.ok(raw.includes('"j1"'));

    const claimed = await backend.claim();
    assert.ok(claimed);
    assert.strictEqual(claimed.id, 'j1');

    await backend.ack('j1');

    // ack 后文件应不再包含该 job
    const afterAck = await fs.readFile(tmpFile, 'utf-8');
    assert.ok(!afterAck.includes('"j1"'));
  });

  test('崩溃恢复：坏行被跳过', async () => {
    // 模拟崩溃产生的半截文件
    await fs.writeFile(
      tmpFile,
      '{"id":"j1","mode":"mock","prompt":"ok","enqueuedAt":123}\n{bad json\n'
    );

    const backend = new FileQueueBackend({ file: tmpFile });
    const list = await backend.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'j1');
  });

  test('clear 清空文件', async () => {
    const backend = new FileQueueBackend({ file: tmpFile });
    await backend.append({
      id: 'j1',
      mode: 'mock',
      prompt: 't1',
      enqueuedAt: Date.now()
    });
    await backend.append({
      id: 'j2',
      mode: 'mock',
      prompt: 't2',
      enqueuedAt: Date.now()
    });

    await backend.clear();
    const content = await fs.readFile(tmpFile, 'utf-8');
    assert.strictEqual(content.trim(), '');
  });
});
