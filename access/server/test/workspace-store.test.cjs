'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// 覆盖工作空间（参考图能力链路 User → Workspace → …）：
// - Volatile / File 两档存储的 CRUD 语义
// - 成员归一化（owner 自动在内 + 去重）与技能白名单归一化（空 → undefined）
// - 可见性过滤（owner 或 members 命中）
// - ensureDefaultWorkspace 的幂等性
// - 组合工厂按 WORKSPACE_FILE 选后端

const {
  VolatileWorkspaceStore,
  FileWorkspaceStore,
  createWorkspaceStore,
  ensureDefaultWorkspace,
  DEFAULT_WORKSPACE_NAME
} = require('../dist/workspace-store.js');

test('VolatileWorkspaceStore: 创建 / 查询 / 更新 / 删除', () => {
  const s = new VolatileWorkspaceStore();
  const ws = s.create({ name: '空间A', owner: 'alice' });
  assert.ok(ws.id.startsWith('ws_'), 'id 应有 ws_ 前缀');
  assert.deepStrictEqual(ws.members, ['alice'], 'owner 应自动成为成员');
  assert.strictEqual(s.get(ws.id).name, '空间A');

  const upd = s.update(ws.id, { name: '空间A2', members: ['bob'] });
  assert.strictEqual(upd.name, '空间A2');
  assert.deepStrictEqual(
    [...upd.members].sort(),
    ['alice', 'bob'],
    '更新成员后 owner 应保留'
  );

  assert.strictEqual(s.remove(ws.id), true);
  assert.strictEqual(s.get(ws.id), null);
  assert.strictEqual(s.remove(ws.id), false, '重复删除应返回 false');
  assert.strictEqual(s.update('not-exist', { name: 'x' }), null);
});

test('VolatileWorkspaceStore: 成员去重 + 技能白名单归一化', () => {
  const s = new VolatileWorkspaceStore();
  const ws = s.create({ name: 'x', owner: 'a', members: ['a', 'b', 'b', '', '  '] });
  assert.deepStrictEqual([...ws.members].sort(), ['a', 'b'], '应去重去空');
  assert.strictEqual(ws.skills, undefined, '未传技能 → undefined（= 不限制）');

  const ws2 = s.create({ name: 'y', owner: 'a', skills: ['math', 'math', ''] });
  assert.deepStrictEqual(ws2.skills, ['math'], '技能应去重去空');
});

test('VolatileWorkspaceStore: list 按 owner / members 过滤', () => {
  const s = new VolatileWorkspaceStore();
  s.create({ name: 'A', owner: 'alice' });
  s.create({ name: 'B', owner: 'bob', members: ['alice'] });
  assert.strictEqual(s.list('alice').length, 2, 'alice = A 的 owner + B 的成员');
  assert.strictEqual(s.list('bob').length, 1);
  assert.strictEqual(s.list('carol').length, 0, '无关用户不可见');
  assert.strictEqual(s.list().length, 2, '不传 owner 返回全部（运维视角）');
});

test('VolatileWorkspaceStore: 配额随创建/更新保存', () => {
  const s = new VolatileWorkspaceStore();
  const ws = s.create({ name: 'q', owner: 'a', quota: { maxRunsPerDay: 100 } });
  assert.strictEqual(ws.quota.maxRunsPerDay, 100);
  const upd = s.update(ws.id, { quota: { maxCostPerDay: 5 } });
  assert.strictEqual(upd.quota.maxCostPerDay, 5);
});

test('ensureDefaultWorkspace: 无空间时自动建默认空间且幂等', () => {
  const s = new VolatileWorkspaceStore();
  const first = ensureDefaultWorkspace(s, 'alice');
  assert.strictEqual(first.length, 1);
  assert.strictEqual(first[0].name, DEFAULT_WORKSPACE_NAME);
  const second = ensureDefaultWorkspace(s, 'alice');
  assert.strictEqual(second.length, 1, '幂等：不应重复创建');
  assert.strictEqual(second[0].id, first[0].id);
  // 已有空间时不再新建
  const s2 = new VolatileWorkspaceStore();
  s2.create({ name: '自有空间', owner: 'bob' });
  const list = ensureDefaultWorkspace(s2, 'bob');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, '自有空间');
});

test('FileWorkspaceStore: 持久化 + 重新加载 + 删除同步', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
  const file = path.join(dir, 'workspaces.json');
  try {
    const s1 = new FileWorkspaceStore({ file });
    const ws = s1.create({ name: '持久空间', owner: 'alice', skills: ['math'] });
    assert.ok(fs.existsSync(file), '创建后应落盘');

    // 新实例应能读回（模拟进程重启）
    const s2 = new FileWorkspaceStore({ file });
    const loaded = s2.get(ws.id);
    assert.ok(loaded, '重启后应能读回');
    assert.strictEqual(loaded.name, '持久空间');
    assert.deepStrictEqual(loaded.skills, ['math']);

    // 更新后落盘同步
    s2.update(ws.id, { name: '改名后' });
    const s3 = new FileWorkspaceStore({ file });
    assert.strictEqual(s3.get(ws.id).name, '改名后');

    // 删除后落盘同步
    s3.remove(ws.id);
    const s4 = new FileWorkspaceStore({ file });
    assert.strictEqual(s4.get(ws.id), null, '删除后重启不应复现');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FileWorkspaceStore: 损坏存档不致命（从空态继续）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bad-'));
  const file = path.join(dir, 'workspaces.json');
  try {
    fs.writeFileSync(file, '{ not valid json', 'utf-8');
    const s = new FileWorkspaceStore({ file });
    assert.deepStrictEqual(s.list(), [], '损坏存档应降级为空态');
    const ws = s.create({ name: 'ok', owner: 'a' });
    assert.ok(s.get(ws.id), '空态后仍可正常创建');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createWorkspaceStore: WORKSPACE_FILE 决定后端', () => {
  assert.strictEqual(createWorkspaceStore({}).kind, 'volatile', '默认内存态');
  assert.strictEqual(
    createWorkspaceStore({ WORKSPACE_FILE: '/tmp/ws.json' }).kind,
    'file',
    '配置了文件路径则走持久化'
  );
});
