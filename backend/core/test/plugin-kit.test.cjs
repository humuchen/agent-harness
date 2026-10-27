'use strict';
/** plugin-kit 单元测试（P1#25 共享基线）。需先构建：node --test test/plugin-kit.test.cjs */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const {
  escapeHtml,
  simpleErrorResult,
  readJsonBody,
  createPluginCtxHolder,
  safeEqual,
} = require('../dist/plugin-kit/index.js');

// ── escapeHtml ──

test('escapeHtml 转义全部五个实体（含单引号——ma 版历史 XSS 缺口）', () => {
  assert.equal(escapeHtml('<a href="x" \'onmouseover\'> & </a>'), '&lt;a href=&quot;x&quot; &#39;onmouseover&#39;&gt; &amp; &lt;/a&gt;');
});

test('escapeHtml：null/undefined → 空串；数字/对象 → String 化后转义', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(123), '123');
  // 与既有插件 esc 语义一致：String(s ?? '')，对象为 '[object Object]'（不做 JSON 化）
  assert.equal(escapeHtml({ a: 1 }), '[object Object]');
});

// ── simpleErrorResult ──

test('simpleErrorResult：Error / 字符串 / 其他形态归一', () => {
  assert.deepEqual(simpleErrorResult(new Error('boom')), { error: true, message: 'boom' });
  assert.deepEqual(simpleErrorResult('plain'), { error: true, message: 'plain' });
  assert.deepEqual(simpleErrorResult(42), { error: true, message: 'unknown error' });
  assert.deepEqual(simpleErrorResult(undefined), { error: true, message: 'unknown error' });
});

// ── readJsonBody ──

function fakeReq(chunks) {
  const req = new EventEmitter();
  req.destroy = () => {};
  process.nextTick(() => {
    for (const c of chunks) req.emit('data', Buffer.from(c));
    req.emit('end');
  });
  return req;
}

test('readJsonBody：合法 JSON / 空 body / 非法 JSON 容错', async () => {
  assert.deepEqual(await readJsonBody(fakeReq(['{"a":1}'])), { a: 1 });
  assert.deepEqual(await readJsonBody(fakeReq([])), {});
  assert.deepEqual(await readJsonBody(fakeReq(['not-json'])), {});
});

test('readJsonBody：超限断开并返回空对象（P1 资源基线，默认 1MB）', async () => {
  let destroyed = false;
  const req = new EventEmitter();
  req.destroy = () => { destroyed = true; };
  process.nextTick(() => {
    req.emit('data', Buffer.from('x'.repeat(1024)));
    req.emit('data', Buffer.from('y'.repeat(2 * 1024 * 1024)));
    req.emit('end');
  });
  const body = await readJsonBody(req);
  assert.deepEqual(body, {});
  assert.equal(destroyed, true, '超限应断开连接');
});

test('readJsonBody：自定义 maxBytes 生效', async () => {
  const body = await readJsonBody(fakeReq(['{"k":"' + 'v'.repeat(100) + '"}']), { maxBytes: 16 });
  assert.deepEqual(body, {});
});

// ── createPluginCtxHolder ──

test('plugin-ctx：set/get/clear 生命周期（clear 后不残留旧引用）', () => {
  const h = createPluginCtxHolder();
  assert.equal(h.get(), null);
  const ctx = { pluginId: 'x' };
  h.set(ctx);
  assert.equal(h.get(), ctx);
  h.clear();
  assert.equal(h.get(), null);
  // 每个插件独立实例（工厂语义），互不串扰
  const h2 = createPluginCtxHolder();
  assert.equal(h2.get(), null);
});

// ── safeEqual ──

test('safeEqual：等长等值 true；长度不等 false（不抛错）；非常量时间规避', () => {
  assert.equal(safeEqual('token-a', 'token-a'), true);
  assert.equal(safeEqual('token-a', 'token-b'), false);
  assert.equal(safeEqual('short', 'a-much-longer-token'), false);
  assert.equal(safeEqual('', ''), true);
});
