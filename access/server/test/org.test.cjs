'use strict';
// 企业组织树（P1-3）后端单测。
// 覆盖：normalize 容错与防环、computeMemberCount 递归计数、
// FileOrgProvider 在「文件缺失 / 损坏 / 未配置」时回落内置 demo 树。
//
// 运行：pnpm --filter @agent-harness/server run build && node --test test/org.test.cjs

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { writeFileSync, unlinkSync, existsSync } = require('node:fs');

const {
  FileOrgProvider,
  getOrgProvider,
  setOrgProvider,
  getOrgTree,
  computeMemberCount
} = require('../dist/org.js');

// 隔离单例：每个用例前重置 provider，避免用例间串扰。
test.beforeEach(() => setOrgProvider(null));

test('normalize: 跳过 id/name 缺失的节点，扁平化非法 children', () => {
  const { normalize } = require('../dist/org.js');
  const input = {
    id: 'root', name: 'R', type: 'dept',
    children: [
      { type: 'dept', children: [{ id: 'x', name: 'X', type: 'user' }] }, // 缺 id → 跳过
      { id: 'y', name: 'Y' }, // 缺 type → 默认 dept
      { id: 'z', name: 'Z', type: 'user', title: 'T', email: 'z@e.co' },
      'not-an-object', // 非法 → 跳过
      { id: 'k', name: 'K', type: 'user', children: 'oops' } // 非法 children 被忽略
    ]
  };
  const out = normalize(input);
  assert.strictEqual(out.id, 'root');
  assert.strictEqual(out.type, 'dept');
  const ids = (out.children ?? []).map((c) => c.id);
  assert.deepStrictEqual(ids.sort(), ['k', 'y', 'z'], '缺 id 节点与非法项应被剔除');
  const z = (out.children ?? []).find((c) => c.id === 'z');
  assert.strictEqual(z.title, 'T');
  assert.strictEqual(z.email, 'z@e.co');
  const k = (out.children ?? []).find((c) => c.id === 'k');
  assert.strictEqual(k.children, undefined, 'user 不应带 children');
});

test('normalize: 环形 / 自引用数据收敛为叶子，不无限递归', () => {
  const { normalize } = require('../dist/org.js');
  const root = { id: 'a', name: 'A', type: 'dept', children: [] };
  const child = { id: 'b', name: 'B', type: 'dept', children: [] };
  root.children.push(child);
  child.children.push(root); // b 引用回 a，形成环
  const out = normalize(root);
  assert.strictEqual(out.id, 'a');
  // 环被打破：a → b → a(叶子，无 children)。关键保证是递归在此终止（无栈溢出 / 死循环），
  // 而非彻底删除节点；b 仍持有一个收敛为叶子的 a。
  const b = out.children[0];
  assert.strictEqual(b.id, 'b');
  assert.strictEqual(b.children[0].id, 'a', '环在 b 的下一层被收敛为叶子');
  assert.strictEqual(b.children[0].children, undefined, '自引用子节点应被收敛为叶子，避免无限递归');
});

test('computeMemberCount: 递归统计含子部门成员数', () => {
  const tree = {
    id: 'r', name: 'R', type: 'dept', children: [
      { id: 'd', name: 'D', type: 'dept', children: [
        { id: 'u1', name: 'U1', type: 'user' },
        { id: 'u2', name: 'U2', type: 'user' }
      ] },
      { id: 'u3', name: 'U3', type: 'user' }
    ]
  };
  const total = computeMemberCount(tree);
  assert.strictEqual(total, 3, '应统计所有层级成员：u1+u2+u3');
  assert.strictEqual(tree.memberCount, 3);
  assert.strictEqual(tree.children[0].memberCount, 2, '部门 D 含 2 名成员');
});

test('FileOrgProvider: 未配置文件 → 回落 demo 树（source=demo）', async () => {
  const p = new FileOrgProvider(undefined);
  const tree = await p.getTree();
  assert.strictEqual(tree.source, 'demo');
  assert.strictEqual(tree.root.name, '示例企业');
  // demo 树：研发部(3) + 业务部(1) = 4 名成员
  assert.strictEqual(tree.root.memberCount, 4);
});

test('FileOrgProvider: 配置不存在的文件 → 回落 demo 树', async () => {
  const p = new FileOrgProvider(path.join(os.tmpdir(), 'does-not-exist-' + Date.now() + '.json'));
  const tree = await p.getTree();
  assert.strictEqual(tree.source, 'demo');
});

test('FileOrgProvider: 文件损坏（非法 JSON）→ 回落 demo 树', async () => {
  const f = path.join(os.tmpdir(), 'org-broken-' + Date.now() + '.json');
  writeFileSync(f, '{ this is not json ', 'utf-8');
  try {
    const p = new FileOrgProvider(f);
    const tree = await p.getTree();
    assert.strictEqual(tree.source, 'demo', '损坏文件必须回落，绝不 5xx');
  } finally {
    if (existsSync(f)) unlinkSync(f);
  }
});

test('FileOrgProvider: 合法文件被解析并标记 source=file:...', async () => {
  const f = path.join(os.tmpdir(), 'org-ok-' + Date.now() + '.json');
  const data = {
    root: { id: 'co', name: 'Acme', type: 'dept', children: [
      { id: 'eng', name: 'Eng', type: 'dept', children: [
        { id: 'e1', name: 'E1', type: 'user', title: 'SWE', email: 'e1@acme.co' }
      ] }
    ] }
  };
  writeFileSync(f, JSON.stringify(data), 'utf-8');
  try {
    const p = new FileOrgProvider(f);
    const tree = await p.getTree();
    assert.ok(tree.source.startsWith('file:'), 'source 应标识为 file:' + tree.source);
    assert.strictEqual(tree.root.name, 'Acme');
    assert.strictEqual(tree.root.memberCount, 1);
  } finally {
    if (existsSync(f)) unlinkSync(f);
  }
});

test('getOrgTree: 通过 getOrgProvider 工厂返回可演示树（默认无 env）', async () => {
  const tree = await getOrgTree({});
  assert.strictEqual(tree.source, 'demo');
  assert.strictEqual(tree.root.memberCount, 4);
});

test('getOrgProvider/setOrgProvider: 注入自定义 provider 生效', async () => {
  setOrgProvider({
    name: 'stub',
    async getTree() {
      return { root: { id: 's', name: 'Stub', type: 'dept', children: [] }, source: 'stub' };
    }
  });
  const p = getOrgProvider({});
  assert.strictEqual(p.name, 'stub');
  const tree = await getOrgTree({});
  assert.strictEqual(tree.source, 'stub');
});
