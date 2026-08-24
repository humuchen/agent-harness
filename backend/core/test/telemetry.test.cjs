'use strict';
const test = require('node:test');
const assert = require('node:assert');
const t = require('../dist/telemetry.js');

// 用随机后缀的计数器/直方图名，避免与其他测试文件的全局状态相互污染。
const R = String(Math.floor(Math.random() * 1e9));
const COUNTER = 'test.counter.' + R;
const HIST = 'test.latency.' + R;
const MODEL = 'test-model-' + R;

test('getMetricsSnapshot 返回完整结构', () => {
  const snap = t.getMetricsSnapshot();
  assert.ok(typeof snap.since === 'number');
  assert.ok(typeof snap.uptimeMs === 'number');
  assert.ok(snap.counters && typeof snap.counters === 'object');
  assert.ok(snap.latency && typeof snap.latency === 'object');
  assert.ok(snap.tokens && typeof snap.tokens.total === 'number');
  assert.ok(typeof snap.cost === 'number');
  assert.ok(snap.costByModel && typeof snap.costByModel === 'object');
});

test('incCounter 累加', () => {
  const before = t.getMetricsSnapshot().counters[COUNTER] ?? 0;
  t.incCounter(COUNTER);
  t.incCounter(COUNTER, 4);
  const after = t.getMetricsSnapshot().counters[COUNTER] ?? 0;
  assert.equal(after - before, 5);
});

test('recordTokens 累加 prompt/completion/total', () => {
  const before = t.getMetricsSnapshot().tokens;
  t.recordTokens({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  const after = t.getMetricsSnapshot().tokens;
  assert.equal(after.prompt - before.prompt, 100);
  assert.equal(after.completion - before.completion, 50);
  assert.equal(after.total - before.total, 150);
});

test('recordCost 累加全局成本与按模型明细', () => {
  const before = t.getMetricsSnapshot();
  const beforeCost = before.cost;
  const beforeModelCost = before.costByModel[MODEL] ?? 0;
  t.recordCost(1.23, MODEL);
  t.recordCost(0.77, MODEL);
  const after = t.getMetricsSnapshot();
  assert.ok(after.cost - beforeCost >= 2.0, `cost delta ${after.cost - beforeCost}`);
  assert.ok(after.costByModel[MODEL] - beforeModelCost >= 2.0);
});

test('recordLatency 更新直方图（count/sum/min/max）', () => {
  t.recordLatency(HIST, 10);
  t.recordLatency(HIST, 30);
  const h = t.getMetricsSnapshot().latency[HIST];
  assert.ok(h, 'histogram should exist');
  assert.equal(h.count, 2);
  assert.equal(h.sumMs, 40);
  assert.equal(h.minMs, 10);
  assert.equal(h.maxMs, 30);
  assert.equal(h.avgMs, 20);
});

test('recordError 累加 error.<name> 与全局 errors', () => {
  const before = t.getMetricsSnapshot().counters;
  const beforeErrors = before['errors'] ?? 0;
  const beforeName = before['error.test.' + R] ?? 0;
  t.recordError('test.' + R);
  t.recordError('test.' + R);
  const after = t.getMetricsSnapshot().counters;
  assert.equal(after['error.test.' + R] - beforeName, 2);
  assert.ok(after['errors'] - beforeErrors >= 2);
});

test('structLog 不抛错', () => {
  assert.doesNotThrow(() => t.structLog('info', 'test message', { foo: 'bar' }));
  assert.doesNotThrow(() => t.structLog('warn', 'warn test'));
  assert.doesNotThrow(() => t.structLog('error', 'error test'));
});

test('withSpan 计时并返回值；抛错时记录 error 并向上抛', async () => {
  const val = await t.withSpan('test.span.' + R, async () => 'ok');
  assert.equal(val, 'ok');
  // 直方图应有记录。
  const h = t.getMetricsSnapshot().latency['test.span.' + R];
  assert.ok(h && h.count >= 1);

  const errName = 'test.span.throw.' + R;
  await assert.rejects(() => t.withSpan(errName, async () => { throw new Error('boom'); }), /boom/);
  const after = t.getMetricsSnapshot().counters;
  assert.ok((after['error.' + errName] ?? 0) >= 1);
});
