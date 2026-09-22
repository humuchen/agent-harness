/**
 * P2 回归：延迟直方图分桶（telemetry.recordLatency / getMetricsSnapshot）。
 *
 * 语义约定（与 server.ts 的 Prometheus 端点对齐）：
 *  - snapshot.latency[name].buckets 为**非累计**的每桶计数，边界与 LATENCY_BUCKETS_MS 对齐；
 *  - Prometheus 暴露时由调用方转 cumulative（histogram 规范），本测试锁定存储层语义；
 *  - 恢复（restoreMetricsSnapshot）后桶数据保真；旧快照（无桶字段）以零桶兼容回填。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../dist/index.js');

const BUCKETS = core.LATENCY_BUCKETS_MS;

test('recordLatency：样本落入正确桶边界（非累计口径）', () => {
  // 用独立指标名避免并行测试文件的计数串扰。
  const name = 'unit.hist.' + Date.now();
  core.recordLatency(name, 80);   // <=100  → idx2
  core.recordLatency(name, 3000); // <=5000 → idx7
  const h = core.getMetricsSnapshot().latency[name];
  assert.equal(h.count, 2);
  assert.equal(h.sumMs, 3080);
  const expect = BUCKETS.map(() => 0);
  expect[2] = 1;
  expect[7] = 1;
  assert.deepEqual(h.buckets, expect);
});

test('recordLatency：超最大边界的样本不进任何桶（由 +Inf 桶承载）', () => {
  const name = 'unit.hist.inf.' + Date.now();
  core.recordLatency(name, 600_000);
  const h = core.getMetricsSnapshot().latency[name];
  assert.equal(h.count, 1);
  assert.deepEqual(h.buckets, BUCKETS.map(() => 0));
});

test('restoreMetricsSnapshot：桶数据往返保真；旧快照零桶兼容', () => {
  const name = 'unit.hist.restore.' + Date.now();
  core.recordLatency(name, 60);
  const snap = core.getMetricsSnapshot();
  // 模拟进程重启回填
  core.restoreMetricsSnapshot(snap);
  const after = core.getMetricsSnapshot().latency[name];
  assert.deepEqual(after.buckets, snap.latency[name].buckets);
  assert.equal(after.count, snap.latency[name].count);

  // 旧版本快照（latency 无 buckets 字段）→ 零桶回填，不抛错。
  const legacy = JSON.parse(JSON.stringify(snap));
  for (const v of Object.values(legacy.latency)) delete v.buckets;
  core.restoreMetricsSnapshot(legacy);
  const compat = core.getMetricsSnapshot().latency[name];
  assert.deepEqual(compat.buckets, BUCKETS.map(() => 0));
});
