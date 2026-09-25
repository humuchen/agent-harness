'use strict';
// P0-C：web_fetch 出网域名白名单（WEB_FETCH_ALLOWED_DOMAINS / options.webAllowedDomains）。
// 直接调用 dist/builtins/webfetch.js 的 registerWebFetch，用本地 mock fetch 断言
// 白名单命中/不命中的行为（不发真实网络请求）。

const test = require('node:test');
const assert = require('node:assert');

const { ToolRegistry } = require('../dist/tools.js');
const { registerWebFetch } = require('../dist/builtins/webfetch.js');

// 用本地 mock fetch 捕获发出的 URL，避免真实网络调用。
function withMockFetch(mockFetch) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  return () => { globalThis.fetch = origFetch; };
}

test('web_fetch 白名单：命中精确 host 放行', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {
    allowedDomains: ['example.com'],
  });
  const restore = withMockFetch(async () => ({
    ok: true, status: 200,
    headers: new Map([['content-type', 'text/plain']]),
    text: async () => 'ok',
  }));
  // 给 mock 的 headers 补 .get
  const res = await reg.call('builtin__web_fetch', { url: 'https://example.com/page' });
  assert.ok(res.includes('"ok":true'), '命中白名单应正常返回，实际：' + res);
  restore();
});

test('web_fetch 白名单：*.example.com 通配命中子域', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, { allowedDomains: ['*.example.com'] });
  const mock = async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/plain']]), text: async () => 'ok' });
  const restore = withMockFetch(mock);
  const res = await reg.call('builtin__web_fetch', { url: 'https://sub.example.com/x' });
  assert.ok(!res.startsWith('error: host not in allowlist'), '子域应命中 *.example.com，实际：' + res);
  restore();
});

test('web_fetch 白名单：未命中 host 直接拒绝（不发请求）', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, { allowedDomains: ['example.com'] });
  let called = 0;
  const mock = async () => { called++; return { ok: true, status: 200, headers: new Map([['content-type', 'text/plain']]), text: async () => 'x' }; };
  const restore = withMockFetch(mock);
  const res = await reg.call('builtin__web_fetch', { url: 'https://evil.com/x' });
  assert.ok(res.startsWith('error: host not in allowlist'), '未命中应直接拒绝，实际：' + res);
  assert.strictEqual(called, 0, '未命中时不应发出任何 fetch 请求');
  restore();
});

test('web_fetch 白名单：空白名单 = 全放行（向后兼容）', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  let called = 0;
  const mock = async () => { called++; return { ok: true, status: 200, headers: new Map([['content-type', 'text/plain']]), text: async () => 'ok' }; };
  const restore = withMockFetch(mock);
  const res = await reg.call('builtin__web_fetch', { url: 'https://anywhere.example.org/x' });
  assert.ok(called === 1, '空白名单应放行请求，实际：' + res);
  assert.ok(!res.startsWith('error: host not in allowlist'));
  restore();
});

test('web_fetch 白名单：env WEB_FETCH_ALLOWED_DOMAINS 生效', async () => {
  const oldEnv = process.env.WEB_FETCH_ALLOWED_DOMAINS;
  process.env.WEB_FETCH_ALLOWED_DOMAINS = 'a.com, b.com';
  const reg = new ToolRegistry();
  registerWebFetch(reg, {}); // 不传 allowedDomains，应读 env
  const mock = async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/plain']]), text: async () => 'ok' });
  const restore = withMockFetch(mock);
  const hit = await reg.call('builtin__web_fetch', { url: 'https://a.com/x' });
  const miss = await reg.call('builtin__web_fetch', { url: 'https://c.com/x' });
  assert.ok(!hit.startsWith('error: host not in allowlist'), 'env 白名单内应放行');
  assert.ok(miss.startsWith('error: host not in allowlist'), 'env 白名单外应拒绝');
  restore();
  if (oldEnv === undefined) delete process.env.WEB_FETCH_ALLOWED_DOMAINS; else process.env.WEB_FETCH_ALLOWED_DOMAINS = oldEnv;
});

// ---------------------------------------------------------------------------
// P0 安全修复（secure by default）：私网/链路本地地址缺省拒绝。
// 无策略（ctx.networkPolicy 缺省 undefined）时工具级兜底校验生效；
// WEB_FETCH_ALLOW_PRIVATE_NETWORK=on 为内网互访部署的显式逃生舱。
// ---------------------------------------------------------------------------

test('web_fetch 私网：缺省（无策略）拒绝 127.0.0.1，不发请求', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  let called = 0;
  const mock = async () => { called++; return { ok: true, status: 200, headers: new Map([['content-type', 'text/plain']]), text: async () => 'x' }; };
  const restore = withMockFetch(mock);
  const res = await reg.call('builtin__web_fetch', { url: 'http://127.0.0.1:8080/actuator' });
  assert.ok(res.startsWith('error: egress denied'), 'loopback 应被缺省拒绝，实际：' + res);
  assert.strictEqual(called, 0, '拒绝时不应发出 fetch');
  restore();
});

test('web_fetch 私网：无策略时 WEB_FETCH_ALLOW_PRIVATE_NETWORK=on 放行（逃生舱）', async () => {
  const oldEnv = process.env.WEB_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.WEB_FETCH_ALLOW_PRIVATE_NETWORK = 'on';
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  let called = 0;
  const mock = async () => { called++; return { ok: true, status: 200, headers: new Map([['content-type', 'text/plain']]), text: async () => 'ok' }; };
  const restore = withMockFetch(mock);
  const res = await reg.call('builtin__web_fetch', { url: 'http://127.0.0.1:8080/x' });
  assert.strictEqual(called, 1, '显式放行后应发出请求，实际：' + res);
  assert.ok(!res.startsWith('error: egress denied'));
  restore();
  if (oldEnv === undefined) delete process.env.WEB_FETCH_ALLOW_PRIVATE_NETWORK; else process.env.WEB_FETCH_ALLOW_PRIVATE_NETWORK = oldEnv;
});

test('web_fetch 私网：策略 allowPrivateNetwork=false 时拒绝；未指定按 false 收紧', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  let called = 0;
  const mock = async () => { called++; return { ok: true, status: 200, headers: new Map([['content-type', 'text/plain']]), text: async () => 'x' }; };
  const restore = withMockFetch(mock);
  const denied = await reg.call(
    'builtin__web_fetch',
    { url: 'http://10.9.8.7/x' },
    { networkPolicy: { mode: 'open', allowPrivateNetwork: false } }
  );
  assert.ok(denied.startsWith('error: egress denied'), '策略 false 应拒绝，实际：' + denied);
  // 策略存在但未指定 allowPrivateNetwork → 缺省 false 收紧
  const denied2 = await reg.call(
    'builtin__web_fetch',
    { url: 'http://169.254.169.254/latest/meta-data' },
    { networkPolicy: { mode: 'open' } }
  );
  assert.ok(denied2.startsWith('error: egress denied'), '策略未指定时应按 false 收紧（云元数据），实际：' + denied2);
  assert.strictEqual(called, 0, '两例均不应发出 fetch');
  restore();
});
