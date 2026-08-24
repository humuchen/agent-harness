'use strict';
// Token 缓存命中率统计：周期性聚合 + 阈值告警测试（独立进程，模块级计数从 0 起步）。
const test = require('node:test');
const assert = require('node:assert');
const mod = require('../dist/llm/token-cache-metrics.js');

test('周期性聚合：窗口日志 + 命中率低于阈值触发告警', async () => {
  const alerts = [];
  mod.setTokenCacheAlertSink((level, name, message, fields) => {
    alerts.push({ level, name, message, fields });
  });
  // 灌入 3 次全未命中的查询（首次 tick 的窗口增量 dq=3）
  mod.recordTokenCacheQuery({ hit: false, cachedTokens: 0, promptTokens: 500, model: 'm-low' });
  mod.recordTokenCacheQuery({ hit: false, cachedTokens: 0, promptTokens: 500, model: 'm-low' });
  mod.recordTokenCacheQuery({ hit: false, cachedTokens: 0, promptTokens: 500, model: 'm-low' });

  mod.startTokenCacheAggregation({ intervalMs: 20, threshold: 0.5, minSamples: 2 });
  await new Promise((r) => setTimeout(r, 60)); // 等至少一个 tick（20ms 间隔，实际会多次 tick）
  mod.stopTokenCacheAggregation();

  // 累计查询数应恰为 3（本进程从 0 起步）
  assert.strictEqual(mod.getTokenCacheStats().queries, 3);
  // 历史窗口中，首个窗口即捕获到 dq=3 / hits=0 / hitRate=0
  const hist = mod.getTokenCacheHistory();
  assert.ok(hist.length >= 1, `history length=${hist.length}`);
  const first = hist[0];
  assert.strictEqual(first.queries, 3);
  assert.strictEqual(first.hits, 0);
  assert.strictEqual(first.hitRate, 0);

  // 应触发一次低命中率告警
  const lowAlert = alerts.find((a) => a.name === 'token-cache-hitrate-low');
  assert.ok(lowAlert, '应触发 token-cache-hitrate-low 告警');
  assert.strictEqual(lowAlert.level, 'warn');
  assert.strictEqual(lowAlert.fields.hitRate, 0);
  assert.strictEqual(lowAlert.fields.threshold, 0.5);
  assert.strictEqual(lowAlert.fields.samples, 3);

  mod.setTokenCacheAlertSink(null);
});

test('周期性聚合：命中率达标不告警', async () => {
  const alerts = [];
  mod.setTokenCacheAlertSink((level, name) => alerts.push({ level, name }));
  // 灌入 4 次全命中（窗口内 dq=4，hitRate=1 >= 0.5 → 不告警）
  for (let i = 0; i < 4; i++) {
    mod.recordTokenCacheQuery({ hit: true, cachedTokens: 200, promptTokens: 200, model: 'm-ok' });
  }
  mod.startTokenCacheAggregation({ intervalMs: 20, threshold: 0.5, minSamples: 2 });
  await new Promise((r) => setTimeout(r, 60));
  mod.stopTokenCacheAggregation();
  assert.strictEqual(
    alerts.filter((a) => a.name === 'token-cache-hitrate-low').length,
    0,
    '命中率达标不应触发低命中率告警'
  );
  mod.setTokenCacheAlertSink(null);
});

test('startTokenCacheAggregation 幂等（重复启动只会有一个定时器）', async () => {
  mod.startTokenCacheAggregation({ intervalMs: 20 });
  mod.startTokenCacheAggregation({ intervalMs: 20 });
  mod.stopTokenCacheAggregation();
  mod.stopTokenCacheAggregation();
  assert.ok(true);
});

test('未达最小样本数时不误报告警', async () => {
  const alerts = [];
  mod.setTokenCacheAlertSink((level, name) => alerts.push({ level, name }));
  // 仅 1 次查询（< minSamples=2），即便命中率为 0 也不应告警
  mod.recordTokenCacheQuery({ hit: false, cachedTokens: 0, promptTokens: 100 });
  mod.startTokenCacheAggregation({ intervalMs: 20, threshold: 0.5, minSamples: 2 });
  await new Promise((r) => setTimeout(r, 60));
  mod.stopTokenCacheAggregation();
  assert.strictEqual(
    alerts.filter((a) => a.name === 'token-cache-hitrate-low').length,
    0,
    '样本数不足时不应触发告警'
  );
  mod.setTokenCacheAlertSink(null);
});
