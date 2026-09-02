// 零依赖测试（node:test + node:assert）：覆盖 P2 指标持久化往返。
// - setTelemetryFile + saveMetricsSnapshot 落盘（原子写 .tmp→rename）
// - 重置内存态后 loadMetricsSnapshot 能从文件回填（覆盖语义，不重复累加）
// - setTelemetryFile(null) 关闭后 save/load 为 no-op
// - 文件缺失 / 解析失败不抛异常（静默跳过）

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tel = require('../dist/telemetry.js');

function tmpFile(name) {
  return path.join(os.tmpdir(), `ah-telemetry-${name}-${process.pid}.json`);
}

function emptySnapshot() {
  return {
    since: 0,
    uptimeMs: 0,
    counters: {},
    latency: {},
    tokens: { prompt: 0, completion: 0, total: 0 },
    cost: 0,
    costByModel: {},
    byTenant: {}
  };
}

function resetMemory() {
  tel.restoreMetricsSnapshot(emptySnapshot());
}

test('setTelemetryFile(null) 时 save/load 为 no-op（不抛、不写文件）', () => {
  const f = tmpFile('noop');
  if (fs.existsSync(f)) fs.unlinkSync(f);
  tel.setTelemetryFile(null);
  tel.saveMetricsSnapshot(); // 不应写文件
  assert.strictEqual(fs.existsSync(f), false);
  resetMemory();
});

test('保存 → 重置内存 → 从文件回填，关键指标一致', () => {
  const f = tmpFile('roundtrip');
  if (fs.existsSync(f)) fs.unlinkSync(f);

  tel.setTelemetryFile(f);
  resetMemory(); // 清掉可能残留的跨测试单例态

  // 构造可观测状态（租户计数器会同时 roll-up 到全局，故全局与租户用不同计数器名，避免混淆）
  tel.incCounter('runs', 3);
  tel.recordLatency('llm', 50);
  tel.recordTokens({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  tel.recordCost(0.005, 'gpt-x');
  tel.incCounterTenant('tenant_runs', 't1', 2);
  tel.recordTokensTenant({ prompt_tokens: 5 }, 't1');

  tel.saveMetricsSnapshot();
  assert.strictEqual(fs.existsSync(f), true, '应落盘');

  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(onDisk.counters.runs, 3);
  assert.strictEqual(onDisk.latency.llm.count, 1);
  assert.strictEqual(onDisk.latency.llm.sumMs, 50);
  // 注意 recordTokensTenant 会把 5 prompt token 同时 roll-up 到全局，故全局 total = 30 + 5 = 35
  assert.strictEqual(onDisk.tokens.total, 35);
  assert.strictEqual(onDisk.costByModel['gpt-x'], 0.005);
  assert.strictEqual(onDisk.byTenant.t1.counters.tenant_runs, 2);

  // 模拟重启：清空内存态
  resetMemory();
  let snap = tel.getMetricsSnapshot();
  assert.strictEqual(snap.counters.runs, undefined, '重置后全局 runs 应为空');
  assert.strictEqual(snap.byTenant.t1, undefined, '重置后租户态应为空');

  // 从文件回填
  tel.loadMetricsSnapshot();
  snap = tel.getMetricsSnapshot();

  assert.strictEqual(snap.counters.runs, 3, '回填后 runs 应为 3');
  assert.strictEqual(snap.latency.llm.count, 1);
  assert.strictEqual(snap.latency.llm.sumMs, 50);
  assert.strictEqual(snap.tokens.total, 35);
  assert.strictEqual(snap.costByModel['gpt-x'], 0.005);
  assert.strictEqual(snap.byTenant.t1.counters.tenant_runs, 2);
  assert.strictEqual(snap.byTenant.t1.tokens.prompt, 5);

  // 覆盖语义：重启后再次累加不应在落盘值上翻倍
  tel.incCounter('runs', 1);
  assert.strictEqual(tel.getMetricsSnapshot().counters.runs, 4);

  if (fs.existsSync(f)) fs.unlinkSync(f);
  tel.setTelemetryFile(null);
});

test('文件缺失时 loadMetricsSnapshot 静默跳过（不抛）', () => {
  const f = tmpFile('missing');
  if (fs.existsSync(f)) fs.unlinkSync(f);
  tel.setTelemetryFile(f);
  resetMemory();
  assert.doesNotThrow(() => tel.loadMetricsSnapshot());
  assert.strictEqual(Object.keys(tel.getMetricsSnapshot().counters).length, 0, '缺失文件不应灌入任何计数');
  tel.setTelemetryFile(null);
});

test('损坏文件时 loadMetricsSnapshot 静默跳过（不抛）', () => {
  const f = tmpFile('corrupt');
  fs.writeFileSync(f, '{ not valid json', 'utf8');
  tel.setTelemetryFile(f);
  resetMemory();
  assert.doesNotThrow(() => tel.loadMetricsSnapshot());
  assert.strictEqual(Object.keys(tel.getMetricsSnapshot().counters).length, 0, '损坏文件不应灌入任何计数');
  if (fs.existsSync(f)) fs.unlinkSync(f);
  tel.setTelemetryFile(null);
});
