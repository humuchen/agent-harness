// 零依赖测试（node:test + node:assert）：覆盖接入层 replica-picker 负载均衡选择器。
// 直接 require 编译后的 dist 叶子模块。
const test = require('node:test');
const assert = require('node:assert');

const { ReplicaPicker } = require('../dist/replica-picker.js');

const REPLICAS = [
  { id: 'r1', baseUrl: 'http://10.0.0.1:4173' },
  { id: 'r2', baseUrl: 'http://10.0.0.2:4173' },
  { id: 'r3', baseUrl: 'http://10.0.0.3:4173' },
];

test('round-robin：三个健康副本轮询且循环', () => {
  const p = new ReplicaPicker({ replicas: REPLICAS, strategy: 'round-robin' });
  const seen = [p.pick(), p.pick(), p.pick()].map((r) => r.id);
  assert.deepStrictEqual(seen, ['r1', 'r2', 'r3']);
  assert.strictEqual(p.pick().id, 'r1'); // 绕回
  assert.strictEqual(p.healthyCount(), 3);
});

test('round-robin：跳过不健康副本', () => {
  const p = new ReplicaPicker({
    replicas: [
      { id: 'r1', baseUrl: 'http://a', healthy: false },
      { id: 'r2', baseUrl: 'http://b' },
      { id: 'r3', baseUrl: 'http://c' },
    ],
  });
  const ids = new Set([p.pick().id, p.pick().id, p.pick().id]);
  assert.deepStrictEqual([...ids].sort(), ['r2', 'r3']);
});

test('round-robin：加权轮询按 weight 分配', () => {
  const p = new ReplicaPicker({
    replicas: [
      { id: 'heavy', baseUrl: 'http://a', weight: 3 },
      { id: 'light', baseUrl: 'http://b', weight: 1 },
    ],
  });
  const counts = { heavy: 0, light: 0 };
  for (let i = 0; i < 8; i++) counts[p.pick().id]++;
  assert.strictEqual(counts.heavy, 6); // 8 次中 6 次命中权重 3 的副本
  assert.strictEqual(counts.light, 2);
});

test('least-load：选负载最低的副本，并列时按 id 稳定', () => {
  const p = new ReplicaPicker({
    strategy: 'least-load',
    replicas: [
      { id: 'r1', baseUrl: 'http://a', load: 5 },
      { id: 'r2', baseUrl: 'http://b', load: 1 },
      { id: 'r3', baseUrl: 'http://c', load: 3 },
    ],
  });
  assert.strictEqual(p.pick().id, 'r2');
  // 并列负载 → 稳定取 id 较小者
  const tie = new ReplicaPicker({
    strategy: 'least-load',
    replicas: [
      { id: 'z', baseUrl: 'http://a', load: 2 },
      { id: 'a', baseUrl: 'http://b', load: 2 },
    ],
  });
  assert.strictEqual(tie.pick().id, 'a');
});

test('sticky-hash：同一 key 稳定命中同一副本', () => {
  const p = new ReplicaPicker({ replicas: REPLICAS, strategy: 'sticky-hash' });
  const first = p.pick('tenant-42').id;
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(p.pick('tenant-42').id, first);
  }
});

test('sticky-hash：不同 key 打散到全部副本（虚拟节点环）', () => {
  const p = new ReplicaPicker({ replicas: REPLICAS, strategy: 'sticky-hash' });
  const buckets = new Set();
  for (let i = 0; i < 60; i++) buckets.add(p.pick(`tenant-${i}-session-abc`).id);
  assert.strictEqual(buckets.size, 3);
});

test('sticky-hash：缺失 key 退化为轮询', () => {
  const p = new ReplicaPicker({ replicas: REPLICAS, strategy: 'sticky-hash' });
  assert.strictEqual(p.pick().id, 'r1');
  assert.strictEqual(p.pick().id, 'r2');
});

test('没有健康副本时返回 null（不抛错）', () => {
  const p = new ReplicaPicker({
    replicas: [
      { id: 'r1', baseUrl: 'http://a', healthy: false },
      { id: 'r2', baseUrl: 'http://b', healthy: false },
    ],
  });
  assert.strictEqual(p.pick(), null);
  assert.strictEqual(p.healthyCount(), 0);
});

test('非法输入抛错：重复 id / 非法 baseUrl / 非法 weight / 未知策略', () => {
  assert.throws(() => new ReplicaPicker({ replicas: [
    { id: 'r1', baseUrl: 'http://a' },
    { id: 'r1', baseUrl: 'http://b' },
  ]}));
  assert.throws(() => new ReplicaPicker({ replicas: [{ id: 'r1', baseUrl: 'ftp://a' }] }));
  assert.throws(() => new ReplicaPicker({ replicas: [{ id: 'r1', baseUrl: 'http://a', weight: 0 }] }));
  assert.throws(() => new ReplicaPicker({ replicas: [], strategy: 'magic' }));
});

test('upsert：同 id 覆盖、新 id 追加', () => {
  const p = new ReplicaPicker({ replicas: [{ id: 'r1', baseUrl: 'http://old' }] });
  p.upsert({ id: 'r1', baseUrl: 'http://new' });
  p.upsert({ id: 'r2', baseUrl: 'http://b' });
  assert.strictEqual(p.size(), 2);
  assert.strictEqual(p.snapshot().replicas.find((r) => r.id === 'r1').baseUrl, 'http://new');
});
