'use strict';
/**
 * PlanStore 单测（P2-3）。
 * 覆盖：
 * - FilePlanStore.save / read / list / diff / remove
 * - PlanNode 状态枚举
 * - 版本递增 + 审计字段
 *
 * 运行：pnpm --filter @agent-harness/server run build && node --test access/server/test/plan-store.test.cjs
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test } = require('node:test');

// 加载构建产物
const mod = require('../dist/plan-store.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-store-test-'));
}

function makePlan(id = 'p1', title = 'Test Plan', nodes = []) {
  return {
    id,
    title,
    nodes,
    version: 1,
    updatedBy: 'admin',
    updatedAt: new Date().toISOString()
  };
}

let store;
let tmpDir;

// 每个测试前创建新的 FilePlanStore 实例
test.beforeEach(() => {
  tmpDir = makeTmpDir();
  mod.setPlanStore(null); // 重置单例
  store = new mod.FilePlanStore(tmpDir);
});

test.afterEach(() => {
  // 清理
  mod.setPlanStore(null);
});

// ── save + read ──
test('save + read: 保存计划并读取返回值', async () => {
  const plan = makePlan();
  const saved = await store.save(plan);
  assert.strictEqual(saved.id, 'p1');
  assert.strictEqual(saved.title, 'Test Plan');

  const read = await store.read('p1');
  assert.ok(read);
  assert.strictEqual(read.id, 'p1');
  assert.strictEqual(read.title, 'Test Plan');
  assert.strictEqual(read.version, 1);
  assert.strictEqual(read.updatedBy, 'admin');
});

// ── list ──
test('list: 返回用户拥有的计划', async () => {
  await store.save(makePlan('p1', 'Plan 1'));
  await store.save(makePlan('p2', 'Plan 2'));

  const plans = await store.list('admin');
  assert.strictEqual(plans.length, 2);
  const ids = plans.map(p => p.id).sort();
  assert.deepStrictEqual(ids, ['p1', 'p2']);
});

// ── diff ──
test('diff: 比较两个版本的计划', async () => {
  const plan1 = makePlan('p1', 'Plan 1');
  const plan2 = { ...makePlan('p2', 'Plan 1 Modified'), version: 2 };
  await store.save(plan1);
  await store.save(plan2);

  const result = await store.diff('p1', 'p2');
  assert.strictEqual(result.fromVersion, 1);
  assert.strictEqual(result.toVersion, 1);
  // p2 修改了标题，但节点相同 → changed 为空（标题不在 diff 比较范围）
});

// ── remove ──
test('remove: 删除计划', async () => {
  await store.save(makePlan('p1'));
  const ok = await store.remove('p1');
  assert.strictEqual(ok, true);

  const read = await store.read('p1');
  assert.strictEqual(read, null);
});

test('remove: 不存在的计划返回 false', async () => {
  const ok = await store.remove('nonexistent');
  assert.strictEqual(ok, false);
});

// ── version 递增 ──
test('save: version 自动递增', async () => {
  await store.save(makePlan('p1', 'Title', [{ id: 'n1', title: 'Node 1', status: 'todo', dependsOn: [] }], 1));
  const saved2 = await store.save(makePlan('p1', 'Title Modified', [{ id: 'n1', title: 'Node 1', status: 'done', dependsOn: [] }], 2));
  assert.strictEqual(saved2.version, 2);
});

// ── 节点状态枚举 ──
test('PlanNode 状态枚举: todo / doing / done / blocked', async () => {
  const nodes = [
    { id: 'n1', title: 'Todo', status: 'todo', dependsOn: [] },
    { id: 'n2', title: 'Doing', status: 'doing', dependsOn: [] },
    { id: 'n3', title: 'Done', status: 'done', dependsOn: ['n1', 'n2'] },
    { id: 'n4', title: 'Blocked', status: 'blocked', dependsOn: ['n1'], assignee: 'user1' }
  ];
  const plan = makePlan('p1', 'Test', nodes);
  const saved = await store.save(plan);
  assert.strictEqual(saved.nodes.length, 4);
  assert.strictEqual(saved.nodes[3].status, 'blocked');
  assert.strictEqual(saved.nodes[3].assignee, 'user1');
});

// ── getPlanStore 单例 ──
test('getPlanStore: 返回单例', () => {
  mod.setPlanStore(null);
  const a = mod.getPlanStore();
  const b = mod.getPlanStore();
  assert.strictEqual(a, b);
});

test('getPlanStore: 多次 read 不影响 version', async () => {
  const plan = makePlan('p1', 'Test');
  await store.save(plan);

  const r1 = await store.read('p1');
  const r2 = await store.read('p1');
  assert.strictEqual(r1?.version, r2?.version);
});

// ── SQLite 实现（默认后端） ──
test('SqlitePlanStore: save / read / list / diff / remove（PLAN_STORE_BACKEND=sqlite）', async () => {
  process.env.PLAN_STORE_BACKEND = 'sqlite';
  process.env.PLAN_DB_FILE = path.join(tmpDir, 'plans.db');
  const fsP = require('fs/promises');
  await fsP.mkdir(tmpDir, { recursive: true });

  mod.setPlanStore(null);
  const store = mod.getPlanStore();

  // save + read
  const saved = await store.save(makePlan('s1', 'Sqlite Plan'));
  assert.strictEqual(saved.version, 1);
  const read = await store.read('s1');
  assert.ok(read);
  assert.strictEqual(read.title, 'Sqlite Plan');
  assert.strictEqual(read.nodes.length, 0);

  // version 递增
  const saved2 = await store.save(makePlan('s1', 'Sqlite Plan v2'));
  assert.strictEqual(saved2.version, 2);

  // list（owner 过滤）
  await store.save(makePlan('s2', 'Other Plan'));
  const listAll = await store.list();
  assert.strictEqual(listAll.length, 2);
  const listOwner = await store.list('admin');
  assert.strictEqual(listOwner.length, 2);

  // diff
  const p3 = makePlan('s3', 'Diff B');
  await store.save(p3);
  const d = await store.diff('s1', 's3');
  assert.strictEqual(d.fromVersion, 2);
  assert.strictEqual(d.toVersion, 1);

  // remove
  const ok = await store.remove('s1');
  assert.strictEqual(ok, true);
  assert.strictEqual(await store.read('s1'), null);

  // 清理
  mod.setPlanStore(null);
  delete process.env.PLAN_STORE_BACKEND;
  delete process.env.PLAN_DB_FILE;
});

test('SqlitePlanStore: 节点状态持久化（status 字段往返）', async () => {
  process.env.PLAN_STORE_BACKEND = 'sqlite';
  process.env.PLAN_DB_FILE = path.join(tmpDir, 'plans2.db');
  mod.setPlanStore(null);
  const store = mod.getPlanStore();

  const plan = makePlan('n1', 'Node Status Roundtrip', [
    mod.makePlanNode('a', 'Alpha', 'todo'),
    mod.makePlanNode('b', 'Beta', 'doing', { dependsOn: ['a'] }),
    mod.makePlanNode('c', 'Gamma', 'done', { dependsOn: ['a', 'b'] })
  ]);
  const saved = await store.save(plan);
  const read = await store.read('n1');
  assert.strictEqual(read.nodes.length, 3);
  assert.strictEqual(read.nodes[1].status, 'doing');
  assert.deepStrictEqual(read.nodes[2].dependsOn, ['a', 'b']);

  // 模拟 DAG 同步：改状态后 save，再读回
  read.nodes = read.nodes.map((n) =>
    n.id === 'b' ? { ...n, status: 'blocked' } : n
  );
  await store.save(read);
  const r2 = await store.read('n1');
  assert.strictEqual(r2.nodes.find((n) => n.id === 'b').status, 'blocked');
  assert.strictEqual(r2.version, 2);

  mod.setPlanStore(null);
  delete process.env.PLAN_STORE_BACKEND;
  delete process.env.PLAN_DB_FILE;
});
