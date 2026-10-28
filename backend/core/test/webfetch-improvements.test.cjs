'use strict';
// webfetch 六项改进（2026-09-25）的行为回归测试：
//   改进1 浏览器化默认请求头（UA/Accept/Accept-Language，LLM 可覆盖）
//   改进2 429/5xx/瞬时网络错误退避重试（尊重 Retry-After）
//   改进3 403 二级回退代理（WEB_FETCH_FALLBACK_PROXY / options.fallbackProxy）
//   改进4 进程级 cookie jar（同 host 会话保持）
//   改进5 Readability-lite 正文提取（title/段落结构/噪音剔除/实体还原）
//   改进6 状态码分类观测（getWebFetchStats）
// 全部使用 mock fetch，不发真实网络请求。

const test = require('node:test');
const assert = require('node:assert');

const { ToolRegistry } = require('../dist/tools.js');
const { registerWebFetch, getWebFetchStats, resetWebFetchStats } = require('../dist/builtins/webfetch.js');

const origFetch = globalThis.fetch;
function useMock(mock) { globalThis.fetch = mock; }
test.after(() => { globalThis.fetch = origFetch; });

function mkResp(status, body, headers) {
  const h = new Map((headers ?? []).map(([k, v]) => [String(k).toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null, getSetCookie: undefined },
    text: async () => body,
  };
}

test('改进2：5xx 退避重试后成功', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, { maxRetries: 2 });
  let calls = 0;
  useMock(async () => {
    calls++;
    return calls < 3 ? mkResp(500, 'boom') : mkResp(200, 'hello', [['content-type', 'text/plain']]);
  });
  const r = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://flaky.example.com/x' }));
  assert.strictEqual(calls, 3, '应重试到第 3 次成功');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body, 'hello');
});

test('改进2：429 尊重 Retry-After 后重试成功', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, { maxRetries: 2 });
  let calls = 0;
  useMock(async () => {
    calls++;
    return calls === 1 ? mkResp(429, 'slow down', [['retry-after', '0']]) : mkResp(200, 'ok', [['content-type', 'text/plain']]);
  });
  const r = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://rl.example.com/x' }));
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.status, 200);
});

test('改进3：403 走回退代理抓取成功（{url} 模板替换）', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, { fallbackProxy: 'https://reader.example/?target={url}' });
  let direct = 0, proxiedUrl = '';
  useMock(async (url) => {
    if (url.startsWith('https://waf.example.com')) { direct++; return mkResp(403, 'blocked'); }
    proxiedUrl = url;
    return mkResp(200, 'proxied content', [['content-type', 'text/plain']]);
  });
  const r = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://waf.example.com/page' }));
  assert.strictEqual(direct, 1, '主路径只请求一次');
  assert.ok(proxiedUrl.includes(encodeURIComponent('https://waf.example.com/page')), '代理 URL 模板应替换目标地址');
  assert.strictEqual(r.via, 'fallback-proxy');
  assert.strictEqual(r.body, 'proxied content');
});

test('改进3：未配置回退代理时 403 行为不变', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  let calls = 0;
  useMock(async () => { calls++; return mkResp(403, 'blocked'); });
  const r = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://waf2.example.com/page' }));
  assert.strictEqual(calls, 1);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.ok, false);
});

test('改进4：cookie jar——同 host 第二次请求携带 set-cookie', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  let seenCookie = 'none';
  useMock(async (url, init) => {
    if (init && init.headers && init.headers['cookie']) seenCookie = init.headers['cookie'];
    return mkResp(200, 'x', [['content-type', 'text/plain'], ['set-cookie', 'sid=abc123; Path=/; Max-Age=3600']]);
  });
  await reg.call('builtin__web_fetch', { url: 'https://session.example.com/a' });
  await reg.call('builtin__web_fetch', { url: 'https://session.example.com/b' });
  assert.strictEqual(seenCookie, 'sid=abc123');
});

test('改进4：LLM 显式传 cookie 头覆盖 jar', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  let seenCookie = 'none';
  useMock(async (url, init) => {
    if (init && init.headers && init.headers['cookie']) seenCookie = init.headers['cookie'];
    return mkResp(200, 'x', [['content-type', 'text/plain']]);
  });
  await reg.call('builtin__web_fetch', {
    url: 'https://override.example.com/a',
    headers: { cookie: 'sid=manual' },
  });
  assert.strictEqual(seenCookie, 'sid=manual', 'LLM 显式 cookie 应原样覆盖 jar');
});

test('改进5：正文提取——title/段落结构/噪音剔除/实体还原', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  const html = `<!doctype html><html><head><title>测试页面</title><style>.x{color:red}</style></head>
<body><nav>菜单 首页 关于</nav><header>站点横幅</header>
<main><h1>大标题</h1><p>第一段 &amp; 符号 &#x4e2d; 实体。</p><p>第二段内容</p></main>
<footer>版权所有 备案号</footer><script>var x=1;</script></body></html>`;
  useMock(async () => mkResp(200, html, [['content-type', 'text/html; charset=utf-8']]));
  const r = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://page.example.com/doc' }));
  assert.ok(r.body.includes('标题: 测试页面'), '应提取 title');
  assert.ok(r.body.includes('大标题') && r.body.includes('第二段内容'), '应保留正文段落');
  assert.ok(r.body.includes('第一段 & 符号 中 实体。'), '应还原命名/数字实体');
  assert.ok(!r.body.includes('菜单'), '应剔除 nav');
  assert.ok(!r.body.includes('版权所有'), '应剔除 footer');
  assert.ok(!r.body.includes('var x'), '应剔除 script');
  assert.ok(!/测试页面\n/.test(r.body.split('\n')[1] ?? ''), 'title 不应在正文重复出现');
});

test('改进1：默认 UA 浏览器化且补齐 Accept/Accept-Language；LLM 可覆盖', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  let seen = {};
  useMock(async (url, init) => { seen = init.headers; return mkResp(200, 'ok', [['content-type', 'text/plain']]); });
  await reg.call('builtin__web_fetch', { url: 'https://hdr.example.com/x' });
  assert.ok(!seen['user-agent'].includes('agent-harness'), '默认 UA 不再是 bot 指纹');
  assert.ok(seen['accept'] && seen['accept'].startsWith('text/html'), '应带 Accept 头');
  assert.strictEqual(seen['accept-language'], 'zh-CN,zh;q=0.9,en;q=0.8', '应带 Accept-Language 头');
  await reg.call('builtin__web_fetch', { url: 'https://hdr.example.com/y', headers: { 'User-Agent': 'my-custom-agent/2.0' } });
  assert.strictEqual(seen['user-agent'], 'my-custom-agent/2.0', 'LLM 传 headers 应覆盖默认 UA');
});

test('改进2：超时不重试，返回明确错误文案', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, { timeoutMs: 50 });
  useMock(async (url, init) => new Promise((resolve) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      resolve(Promise.reject(e));
    });
  }));
  const r = await reg.call('builtin__web_fetch', { url: 'https://slow.example.com/x' });
  assert.match(String(r), /^error: request timed out/);
});

test('改进6：状态码分类统计正确', async () => {
  resetWebFetchStats();
  const reg = new ToolRegistry();
  registerWebFetch(reg, { maxRetries: 2, fallbackProxy: 'https://reader.example/?target={url}' });
  let phase = 0, calls429 = 0;
  useMock(async (url) => {
    if (url.startsWith('https://a5xx.example.com')) {
      phase++;
      return phase < 3 ? mkResp(500, 'x') : mkResp(200, 'ok', [['content-type', 'text/plain']]);
    }
    if (url.startsWith('https://b429.example.com')) {
      calls429++;
      return calls429 === 1 ? mkResp(429, 'x', [['retry-after', '0']]) : mkResp(200, 'ok', [['content-type', 'text/plain']]);
    }
    if (url.startsWith('https://c403.example.com')) return mkResp(403, 'x');
    return mkResp(200, 'proxied', [['content-type', 'text/plain']]); // 回退代理路径
  });
  await reg.call('builtin__web_fetch', { url: 'https://a5xx.example.com/x' });
  await reg.call('builtin__web_fetch', { url: 'https://b429.example.com/x' });
  await reg.call('builtin__web_fetch', { url: 'https://c403.example.com/x' });
  const s = getWebFetchStats();
  assert.ok(s.total >= 3);
  assert.strictEqual(s.server5xx, 2, '两次 500 都应计入');
  assert.strictEqual(s.rateLimited429, 1);
  assert.strictEqual(s.blocked403, 1);
  assert.strictEqual(s.fallbackUsed, 1, '403 后回退代理应成功');
  resetWebFetchStats();
  assert.strictEqual(getWebFetchStats().total, 0, 'reset 后应清零');
});

// ---------------------------------------------------------------------------
// 质量与性能改进（2026-10-28）：
//   质量A 字符集解码（Content-Type / <meta charset> 嗅探，GBK/latin1 等）
//   质量B 正文提取 Markdown 化（h#/li/a/pre + meta description）
//   效率C TTL 响应缓存 + 在途请求合并 + refresh 逃生参数
//   稳定D 408 重试 + Retry-After HTTP-date
// ---------------------------------------------------------------------------

const { clearWebFetchCache } = require('../dist/builtins/webfetch.js');

/** 带字节流 body 的 mock 响应（触发真实的流式读取 + 字符集解码路径）。 */
function mkByteResp(status, bytes, headers) {
  const h = new Map((headers ?? []).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  const stream = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null, getSetCookie: undefined },
    body: stream,
    text: async () => new TextDecoder('utf-8').decode(bytes),
  };
}

test('质量A：Content-Type 声明 iso-8859-1 时按 latin1 解码（UTF-8 误解码乱码修复）', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  clearWebFetchCache();
  const bytes = Buffer.from('caf\xe9 menu', 'latin1'); // 0xE9 = é
  useMock(async () => mkByteResp(200, bytes, [['content-type', 'text/html; charset=iso-8859-1']]));
  const r = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://cs-ct.example.com/x' }));
  assert.ok(r.body.includes('café menu'), 'latin1 字节应正确解码，实际：' + r.body);
});

test('质量A：Content-Type 无 charset 时从 <meta charset> 嗅探 GBK', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  clearWebFetchCache();
  // "测试" 的 GBK 字节：测=0xB2 0xE2，试=0xCA 0xD4（ASCII 结构之外用 \x 转义注入字节）
  const html = '<html><head><meta charset="gbk"></head><body><p>\xb2\xe2\xca\xd4</p></body></html>';
  useMock(async () => mkByteResp(200, Buffer.from(html, 'latin1'), [['content-type', 'text/html']]));
  const r = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://cs-meta.example.com/x' }));
  assert.ok(r.body.includes('测试'), 'meta charset=gbk 应生效，实际：' + r.body);
});

test('质量B：Markdown 化提取——标题/列表/链接/代码块/meta description', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  clearWebFetchCache();
  const html = `<!doctype html><html><head><title>MD 页</title>
<meta name="description" content="页面摘要 ABC">
<style>.s{}</style></head><body>
<h1>主标题</h1><p>介绍 <a href="/docs/guide.html">使用指南</a> 与 <a href="#top">锚点</a>。</p>
<ul><li>第一项</li><li>第二项</li></ul>
<pre><code>const a = 1;   // 保留缩进</code></pre>
<footer>页脚噪音</footer></body></html>`;
  useMock(async () => mkResp(200, html, [['content-type', 'text/html; charset=utf-8']]));
  const r = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://md.example.com/x' }));
  assert.ok(r.body.includes('标题: MD 页'), '应提取 title');
  assert.ok(r.body.includes('描述: 页面摘要 ABC'), '应输出 meta description');
  assert.ok(r.body.includes('# 主标题'), 'h1 → # 前缀');
  assert.ok(r.body.includes('[使用指南](/docs/guide.html)'), '链接 → [text](href)');
  assert.ok(r.body.includes('锚点') && !r.body.includes('[锚点]('), '锚点/脚本链接降级为纯文本');
  assert.ok(r.body.includes('- 第一项') && r.body.includes('- 第二项'), 'li → - 前缀');
  assert.ok(r.body.includes('const a = 1;   // 保留缩进'), 'pre 代码块保留原始空白');
  assert.ok(!r.body.includes('页脚噪音'), 'footer 噪音剔除');
});

test('效率C：TTL 缓存命中免网络、不同 max_bytes 复用、refresh/自定义头/清缓存绕过', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  clearWebFetchCache();
  resetWebFetchStats();
  let calls = 0;
  useMock(async () => { calls++; return mkResp(200, 'cached body', [['content-type', 'text/plain']]); });
  const r1 = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://cache.example.com/x' }));
  assert.strictEqual(calls, 1);
  const r2 = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://cache.example.com/x', max_bytes: 99999 }));
  assert.strictEqual(calls, 1, '命中缓存不应发网络请求');
  assert.strictEqual(getWebFetchStats().cacheHits, 1, '缓存命中应计数');
  assert.strictEqual(r1.body, r2.body, '不同 max_bytes 复用同一缓存文本');
  await reg.call('builtin__web_fetch', { url: 'https://cache.example.com/x', refresh: true });
  assert.strictEqual(calls, 2, 'refresh=true 应绕过缓存重抓');
  await reg.call('builtin__web_fetch', { url: 'https://cache.example.com/x', headers: { 'x-a': '1' } });
  assert.strictEqual(calls, 3, '带自定义 headers 的请求不读缓存');
  clearWebFetchCache();
  await reg.call('builtin__web_fetch', { url: 'https://cache.example.com/x' });
  assert.strictEqual(calls, 4, 'clearWebFetchCache 后重新抓取');
});

test('效率C：no-store 响应不入缓存；非 2xx 不入缓存', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  clearWebFetchCache();
  let calls = 0;
  useMock(async () => {
    calls++;
    return mkResp(200, 'dynamic', [['content-type', 'text/plain'], ['cache-control', 'no-store']]);
  });
  await reg.call('builtin__web_fetch', { url: 'https://nostore.example.com/x' });
  await reg.call('builtin__web_fetch', { url: 'https://nostore.example.com/x' });
  assert.strictEqual(calls, 2, 'no-store 应每次重新抓取');
  let calls404 = 0;
  useMock(async () => { calls404++; return mkResp(404, 'gone'); });
  await reg.call('builtin__web_fetch', { url: 'https://nf.example.com/x' });
  await reg.call('builtin__web_fetch', { url: 'https://nf.example.com/x' });
  assert.strictEqual(calls404, 2, '404 不入缓存');
});

test('效率C：并发同 URL 请求合并为一次网络抓取', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  clearWebFetchCache();
  let calls = 0;
  let release;
  const gate = new Promise((res) => { release = res; });
  useMock(async () => {
    calls++;
    await gate;
    return mkResp(200, 'shared', [['content-type', 'text/plain']]);
  });
  const [a, b] = await Promise.all([
    reg.call('builtin__web_fetch', { url: 'https://dedupe.example.com/x' }),
    reg.call('builtin__web_fetch', { url: 'https://dedupe.example.com/x' }),
  ]);
  release();
  assert.strictEqual(calls, 1, '并发同 URL 应合并为一次抓取');
  assert.strictEqual(JSON.parse(a).body, 'shared');
  assert.strictEqual(JSON.parse(b).body, 'shared');
});

test('稳定D：408 与 HTTP-date Retry-After 均触发重试', async () => {
  const reg = new ToolRegistry();
  registerWebFetch(reg, { maxRetries: 2 });
  let calls408 = 0, callsDate = 0;
  useMock(async (url) => {
    if (url.startsWith('https://r408.example.com')) {
      calls408++;
      return calls408 === 1 ? mkResp(408, 'late') : mkResp(200, 'ok', [['content-type', 'text/plain']]);
    }
    callsDate++;
    return callsDate === 1
      ? mkResp(429, 'slow', [['retry-after', new Date(Date.now() + 50).toUTCString()]])
      : mkResp(200, 'ok', [['content-type', 'text/plain']]);
  });
  const a = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://r408.example.com/x' }));
  assert.strictEqual(calls408, 2, '408 应重试');
  assert.strictEqual(a.status, 200);
  const b = JSON.parse(await reg.call('builtin__web_fetch', { url: 'https://rdate.example.com/x' }));
  assert.strictEqual(callsDate, 2, 'HTTP-date Retry-After 应解析并重试');
  assert.strictEqual(b.status, 200);
});
