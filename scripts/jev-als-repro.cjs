#!/usr/bin/env node
/**
 * 最小复现：harness 之外直接验证「checkInputAsync（注入门禁）→ jevDecide → emitRunEvent
 * → runWithEventSink sink」这条 ALS 旁路是否真的把 jev:call 事件发出来。
 * 不依赖 access/server，mock fetch，纯 core 层验证。
 */
'use strict';
const path = require('node:path');
const CORE_DIST = path.resolve(__dirname, '..', 'backend', 'core', 'dist');
const {
  checkInputAsync,
  enableJevInjection,
  resolveDefaultPolicy,
  resetJevStats,
  getJevStats,
} = require(path.join(CORE_DIST, 'index.js'));
const { runWithEventSink } = require(path.join(CORE_DIST, 'run-events.js'));

// mock 全局 fetch：拦下对 /systemone 的调用，返回合法决策响应。
let jevFetchCount = 0;
global.fetch = async (url, init) => {
  if (String(url).includes('/systemone')) {
    jevFetchCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          is_injection: { type: 'noul', noul: 0.01, confidence: 0.9 },
        },
      }),
    };
  }
  return { ok: false, status: 404, json: async () => ({}) , text: async () => '' };
};

process.env.TYPESAFE_API_KEY = 'ts_test_key';
enableJevInjection();

const events = [];
const sink = (e) => events.push(e);

(async () => {
  resetJevStats();
  const pol = resolveDefaultPolicy();
  // 关闭 allowlist/短语基线干扰，确保走到语义打分器（Jev）
  const testPol = { ...pol, enableInjectionScan: true, allowlist: [] };
  const result = await runWithEventSink(sink, () =>
    checkInputAsync('你好，请帮我写一份行业研究报告', testPol, false, false)
  );
  console.log('checkInputAsync result:', JSON.stringify(result));
  console.log('jev fetch count:', jevFetchCount);
  console.log('jev stats:', JSON.stringify(getJevStats()));
  console.log('sink events:', JSON.stringify(events.map((e) => ({ type: e.type, caller: e.caller, ok: e.ok }))));
  const jevCall = events.find((e) => e.type === 'jev:call');
  console.log(jevCall ? '[PASS] ALS 链路正常：jev:call 已进入事件汇' : '[FAIL] jev:call 未进入事件汇 —— ALS 断链');
  process.exit(jevCall ? 0 : 1);
})();
