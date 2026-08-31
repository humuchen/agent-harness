/**
 * OAuth 回调链路端到端测试（沙箱内、无外部凭证）。
 *
 * 思路：在进程内 require 已构建的 dist/server.js（其 import 即自动 listen），
 * 再 patch globalThis.fetch，把 GitHub 的 token / user / user/emails 三个接口
 * 全部 mock 掉，从而在不依赖真实 GitHub OAuth App 与网络的前提下，验证：
 *   1) GET /api/account/oauth/github  → 302 到 GitHub 授权页 +
 *      写入 ah_oauth_state CSRF cookie（redirect_uri 协议自适应为 http://127.0.0.1:PORT/...）
 *   2) GET /api/account/oauth/github/callback?code&state → 校验 state、
 *      走 mock 换 token + 拉 user/email、upsertGithubUser、下发 ah_auth cookie、回过渡页
 *   3) GET /api/account/me（带 ah_auth cookie）→ 200 + username=octocat（回填成功）
 *
 * 不修改任何业务代码，纯验证。
 */
'use strict';

const http = require('http');

const PORT = process.env.OAUTH_TEST_PORT || '4573';
const HOST = '127.0.0.1';

// 保持 cwd 为 access/server（与 acctest 一致），服务按 cwd 相对路径加载
// 数据目录(./data)与插件，chdir 到临时区会导致初始化失败、连接被拒。
process.env.AH_CRYPTO_KEY = '0'.repeat(64);
process.env.AUTH_PROVIDER = 'token';
process.env.PORT = PORT;
process.env.UI_CORS_ORIGIN = '';
// 假装已配置 GitHub OAuth（用假凭证即可，因为 fetch 被 mock）
process.env.GITHUB_CLIENT_ID = 'test_client_id';
process.env.GITHUB_CLIENT_SECRET = 'test_client_secret';

// ── mock GitHub 接口（仅拦截 OAuth 链路用到的三个 URL）────────────
// 其余请求回退到真实 fetch，避免干扰 bootstrap 启动期间的内部探测。
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('github.com/login/oauth/access_token')) {
    return { ok: true, json: async () => ({ access_token: 'tok_abc_123' }) };
  }
  if (u === 'https://api.github.com/user') {
    return { ok: true, json: async () => ({ login: 'octocat', id: 1, email: null }) };
  }
  if (u === 'https://api.github.com/user/emails') {
    return {
      ok: true,
      json: async () => [
        { email: 'octo@github.com', primary: true, verified: true },
        { email: 'other@github.com', primary: false, verified: true }
      ]
    };
  }
  return realFetch(url, opts);
};

// 在进程内启动服务（import 即自动 listen）。mock 已在 require 前就绪。
require('./dist/server.js');

// ── 简易 HTTP 客户端 ─────────────────────────────────────────────
function req(method, p, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: HOST, port: PORT, path: p, method, headers: headers || {} },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            setCookie: res.headers['set-cookie'] || [],
            location: res.headers['location'] || '',
            body: buf
          })
        );
      }
    );
    r.on('error', reject);
    r.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieVal = (setCookieArr, name) => {
  for (const c of setCookieArr) {
    const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    if (m) return m[1];
  }
  return null;
};
function assert(cond, msg) {
  if (!cond) {
    console.log('  ✗ FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('  ✓', msg);
  }
}

(async () => {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      await req('GET', '/api/auth/config');
      up = true;
      break;
    } catch {
      await wait(250);
    }
  }
  if (!up) {
    console.log('server did not start');
    process.exit(1);
  }
  console.log('\n[1] GET /api/account/oauth/github（发起授权）');
  const start = await req('GET', '/api/account/oauth/github');
  assert(start.status === 302, `302 跳转（实际 ${start.status}）`);
  assert(/github\.com\/login\/oauth\/authorize/.test(start.location), 'Location 指向 GitHub 授权页');
  assert(/redirect_uri=/.test(start.location), '授权 URL 带 redirect_uri');
  assert(/127\.0\.0\.1%3A/.test(start.location), 'redirect_uri 回指本地回调（协议自适应 http）');
  const state = cookieVal(start.setCookie, 'ah_oauth_state');
  assert(!!state, '写入 ah_oauth_state CSRF cookie');

  console.log('\n[2] GET /api/account/oauth/github/callback（回调换 token + upsert）');
  const cb = await req(
    'GET',
    `/api/account/oauth/github/callback?code=abc123&state=${encodeURIComponent(state)}`,
    { cookie: `ah_oauth_state=${state}` }
  );
  assert(cb.status === 200, `200 过渡页（实际 ${cb.status}）`);
  assert(/oauth=success/.test(cb.body), '过渡页带 ?oauth=success 跳转');
  assert(/登录成功/.test(cb.body), '过渡页展示「登录成功」');
  const authCookie = cookieVal(cb.setCookie, 'ah_auth');
  assert(!!authCookie, '下发 ah_auth 登录 cookie');

  console.log('\n[3] GET /api/account/me（带 ah_auth 回填会话）');
  const me = await req('GET', '/api/account/me', { cookie: `ah_auth=${authCookie}` });
  assert(me.status === 200, `200（实际 ${me.status}）`);
  let username = null;
  try {
    username = JSON.parse(me.body).username;
  } catch {}
  assert(username === 'octocat', `username=octocat（实际 ${username}）`);

  console.log('\n[4] 反向用例：state 不匹配应被拒');
  const bad = await req(
    'GET',
    `/api/account/oauth/github/callback?code=abc123&state=${encodeURIComponent('forged')}`,
    { cookie: `ah_oauth_state=${state}` }
  );
  assert(!/oauth=success/.test(bad.body), '伪造 state 不会下发 oauth=success');

  console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
