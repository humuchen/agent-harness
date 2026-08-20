'use strict';
// Token 缓存命中率统计模块单元测试（零依赖，require 编译后的叶子模块）。
// 本文件仅覆盖「实时计数 + 命中率计算」；周期性聚合见 token-cache-agg.test.cjs（独立进程，避免模块级状态互相污染）。
const test = require('node:test');
const assert = require('node:assert');
const mod = require('../dist/llm/token-cache-metrics.js');

test('recordTokenCacheQuery 实时累计与命中率计算', () => {
  const before = mod.getTokenCacheStats().queries;
  // 7 次查询：5 命中 / 2 未命中，分两个模型。
  for (let i = 0; i < 5; i++) {
    mod.recordTokenCacheQuery({ hit: true, cachedTokens: 100 * (i + 1), promptTokens: 1000, model: 'm1' });
  }
  for (let i = 0; i < 2; i++) {
    mod.recordTokenCacheQuery({ hit: false, cachedTokens: 0, promptTokens: 1000, model: 'm2' });
  }
  const s = mod.getTokenCacheStats();
  assert.strictEqual(s.queries, before + 7);
  assert.strictEqual(s.hits, 5);
  assert.ok(Math.abs(s.hitRate - 5 / 7) < 1e-9, `hitRate=${s.hitRate}`);
  // token 级命中率：累计缓存 1500 / 累计 prompt 7000
  assert.strictEqual(s.cachedTokens, 1500);
  assert.strictEqual(s.promptTokens, 7000);
  assert.ok(Math.abs(s.tokenHitRate - 1500 / 7000) < 1e-9);
  // 按模型维度
  assert.strictEqual(s.byModel.m1.queries, 5);
  assert.strictEqual(s.byModel.m1.hits, 5);
  assert.strictEqual(s.byModel.m2.queries, 2);
  assert.strictEqual(s.byModel.m2.hits, 0);
});

test('空统计时命中率为 0（不除零）', () => {
  const s = mod.getTokenCacheStats();
  if (s.queries === 0) {
    assert.strictEqual(s.hitRate, 0);
    assert.strictEqual(s.tokenHitRate, 0);
  }
});
