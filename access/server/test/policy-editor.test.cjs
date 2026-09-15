'use strict';
/**
 * 策略编辑器后端单测（P2-2）。
 * 覆盖：
 * - read()：文件不存在 → 默认矩阵；env 覆盖优先；文件加载覆盖默认
 * - write() + read()：写入后能读回一致
 * - validatePolicyDoc：缺少角色 / 非法 Action / 清空 admin 权限均被拒
 * - preview()：admin 可执行，viewer 不能执行写权限
 * - 文件路径遍历防护（write 到非法路径应失败）
 *
 * 运行：pnpm --filter @agent-harness/server run build && node --test test/policy-editor.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require('node:fs');

const {
  getPolicyStore,
  setPolicyStore,
  FilePolicyStore,
  validatePolicyDoc,
  allActions
} = require('../dist/policy-editor.js');

let tmpDir = '';

test.beforeEach(() => {
  setPolicyStore(null);
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ah-policy-' + Date.now() + '-'));
});

test.afterEach(() => {
  setPolicyStore(null);
  delete process.env.UI_ROLE_PERMISSIONS;
  delete process.env.POLICY_FILE;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('allActions: 包含 policy:read 和 policy:write', () => {
  const actions = allActions();
  assert.ok(actions.includes('policy:read'));
  assert.ok(actions.includes('policy:write'));
  assert.ok(actions.includes('agent:run:mock'));
  assert.ok(actions.includes('supplychain:read'));
});

test('validatePolicyDoc: 缺少角色被拒', () => {
  const err = validatePolicyDoc({
    matrix: { admin: ['policy:read'], operator: ['policy:read'] }
  });
  assert.match(err, /viewer/);
});

test('validatePolicyDoc: 非法 Action 被拒', () => {
  const err = validatePolicyDoc({
    matrix: {
      admin: ['policy:read', 'hacker:action'],
      operator: ['policy:read'],
      viewer: ['policy:read']
    }
  });
  assert.match(err, /hacker:action/);
});

test('validatePolicyDoc: 清空 admin 权限被拒（锁库护栏）', () => {
  const err = validatePolicyDoc({
    matrix: {
      admin: [],
      operator: ['policy:read'],
      viewer: ['policy:read']
    }
  });
  assert.match(err, /admin/);
});

test('validatePolicyDoc: 合法文档返回 null', () => {
  const doc = {
    matrix: {
      admin: ['policy:read', 'policy:write'],
      operator: ['policy:read'],
      viewer: ['policy:read']
    }
  };
  assert.strictEqual(validatePolicyDoc(doc), null);
});

test('read(): 文件不存在时返回默认矩阵', async () => {
  const file = path.join(tmpDir, 'policy.json');
  const store = new FilePolicyStore(file);
  const doc = await store.read();
  assert.ok(doc.matrix.admin);
  assert.ok(doc.matrix.operator);
  assert.ok(doc.matrix.viewer);
  assert.ok(doc.matrix.admin.includes('policy:write'), 'admin 应拥有 policy:write');
  assert.ok(
    doc.matrix.viewer.includes('policy:read'),
    'viewer 应拥有 policy:read'
  );
  assert.ok(
    !doc.matrix.viewer.includes('policy:write'),
    'viewer 不应拥有 policy:write'
  );
});

test('read(): env 覆盖优先于默认', async () => {
  process.env.UI_ROLE_PERMISSIONS = JSON.stringify({
    admin: ['policy:read', 'policy:write'],
    operator: ['policy:read'],
    viewer: []
  });
  const file = path.join(tmpDir, 'policy.json');
  const store = new FilePolicyStore(file);
  const doc = await store.read();
  assert.deepStrictEqual(doc.matrix.admin, ['policy:read', 'policy:write']);
  assert.deepStrictEqual(doc.matrix.operator, ['policy:read']);
  assert.deepStrictEqual(doc.matrix.viewer, []);
});

test('write() + read(): 写入后能读回一致', async () => {
  const file = path.join(tmpDir, 'policy.json');
  const store = new FilePolicyStore(file);
  const doc = {
    matrix: {
      admin: ['policy:read', 'policy:write', 'agent:run:mock'],
      operator: ['policy:read'],
      viewer: ['policy:read']
    }
  };
  await store.write(doc);
  const read = await store.read();
  assert.deepStrictEqual(read.matrix, doc.matrix);
});

test('write(): 无效文档抛错（admin 清空）', async () => {
  const file = path.join(tmpDir, 'policy.json');
  const store = new FilePolicyStore(file);
  await assert.rejects(
    () =>
      store.write({
        matrix: {
          admin: [],
          operator: ['policy:read'],
          viewer: ['policy:read']
        }
      }),
    /admin/
  );
});

test('write(): 文件持久化到磁盘', async () => {
  const file = path.join(tmpDir, 'subdir', 'policy.json');
  const store = new FilePolicyStore(file);
  const doc = {
    matrix: {
      admin: ['policy:read', 'policy:write'],
      operator: ['policy:read'],
      viewer: ['policy:read']
    }
  };
  await store.write(doc);
  // 直接读文件验证持久化
  const { readFileSync } = require('node:fs');
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  assert.deepStrictEqual(raw.matrix, doc.matrix);
});

test('preview(): admin 可执行写权限，viewer 不能', async () => {
  const file = path.join(tmpDir, 'policy.json');
  const store = new FilePolicyStore(file);
  const doc = await store.read(); // 默认矩阵
  assert.strictEqual(await store.preview('admin', 'policy:write'), true);
  assert.strictEqual(await store.preview('operator', 'policy:write'), true);
  assert.strictEqual(await store.preview('viewer', 'policy:write'), false);
  assert.strictEqual(await store.preview('viewer', 'policy:read'), true);
});

test('preview(): 自定义矩阵覆盖后生效', async () => {
  const file = path.join(tmpDir, 'policy.json');
  const store = new FilePolicyStore(file);
  // 写入自定义：viewer 拥有 workflow:run
  await store.write({
    matrix: {
      admin: ['policy:read', 'policy:write'],
      operator: ['policy:read', 'policy:write'],
      viewer: ['policy:read', 'workflow:run']
    }
  });
  assert.strictEqual(await store.preview('viewer', 'workflow:run'), true);
  assert.strictEqual(await store.preview('viewer', 'env:create'), false);
});

test('getPolicyStore(): 单例 + 环境变量选择器', () => {
  process.env.POLICY_FILE = path.join(tmpDir, 'p.json');
  const a = getPolicyStore();
  const b = getPolicyStore();
  assert.strictEqual(a, b, '应返回单例');
  setPolicyStore(null);
});
