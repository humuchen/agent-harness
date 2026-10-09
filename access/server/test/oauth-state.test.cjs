'use strict';
// P1-1 回归：OpenRouter OAuth 的服务端签发 state（login-CSRF / 账号固定防护）。
//
// 背景：旧实现 state 即前端生成的 code_verifier，服务端不签发也不校验 —— 攻击者可
// 诱导已登录受害者完成「绑定攻击者 OpenRouter 账号」的授权流。修复后：
//  - GET /api/account/oauth/start 由服务端生成 verifier + AES-GCM 签名 state（10 分钟 TTL）；
//  - POST /exchange 凭 state 反解 verifier，state 无效/过期 → 400；
//  - 旧前端直传 codeVerifier 的兼容路径保留。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.AH_CRYPTO_KEY = 'cd'.repeat(32);
process.env.OPENROUTER_OAUTH_CLIENT_ID = 'test-client-id';

const OAUTH_JS = path.join(__dirname, '..', 'dist', 'oauth.js');
const RUN = fs.existsSync(OAUTH_JS);

test('issueOAuthState / verifyOAuthState：签发→校验往返，verifier 完整还原', { skip: !RUN }, () => {
  const { issueOAuthState, verifyOAuthState } = require(OAUTH_JS);
  const verifier = 'x'.repeat(64);
  const state = issueOAuthState(verifier);
  assert.ok(state.startsWith('ah1.'), 'state 应带版本前缀');
  assert.strictEqual(verifyOAuthState(state), verifier);
});

test('verifyOAuthState：篡改/伪造/过期/无前缀 一律拒绝', { skip: !RUN }, () => {
  const { issueOAuthState, verifyOAuthState } = require(OAUTH_JS);
  const state = issueOAuthState('y'.repeat(64));

  // 篡改载荷（翻转 base64url 尾部字符）→ GCM 认证标签校验失败
  const tampered = state.slice(0, -4) + (state.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.strictEqual(verifyOAuthState(tampered), null, '篡改的 state 必须被拒绝');

  // 无前缀（旧实现：裸 code_verifier 直接当 state）→ 拒绝
  assert.strictEqual(verifyOAuthState('y'.repeat(64)), null, '旧格式裸 verifier 不得通过校验');

  // 过期：把时钟拨过 TTL（10 分钟）
  const origNow = Date.now;
  Date.now = () => origNow() + 11 * 60_000;
  try {
    assert.strictEqual(verifyOAuthState(state), null, '过期的 state 必须被拒绝');
  } finally {
    Date.now = origNow;
  }
});

test('GET /oauth/start：返回完整授权 URL（含 code_challenge 与签名 state）', { skip: !RUN }, async () => {
  const { registerOAuthRoutes } = require(OAUTH_JS);
  const req = { url: '/api/account/oauth/start?provider=openrouter', headers: { host: 'localhost:4173' } };
  let statusCode = 0;
  let body = '';
  const res = {
    writeHead(code, headers) {
      statusCode = code;
      void headers;
      return this;
    },
    end(payload) {
      body = payload ?? '';
    }
  };
  const handled = await registerOAuthRoutes(req, res, '/api/account/oauth/start', 'GET');
  assert.ok(handled, '/oauth/start 应由 registerOAuthRoutes 处理');
  assert.strictEqual(statusCode, 200);
  const data = JSON.parse(body);
  assert.ok(data.authorizeUrl, '应返回 authorizeUrl');
  const url = new URL(data.authorizeUrl);
  assert.strictEqual(url.searchParams.get('client_id'), 'test-client-id');
  assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
  const challenge = url.searchParams.get('code_challenge');
  const state = url.searchParams.get('state');
  assert.ok(challenge && challenge.length === 43, 'S256 challenge 应为 43 字符 base64url');
  // URL 中的 state 可被服务端校验并还原 verifier（verifier 不在 URL/前端出现）
  const { verifyOAuthState } = require(OAUTH_JS);
  const verifier = verifyOAuthState(state);
  assert.ok(verifier && verifier.length === 64, 'state 应能反解出 64 字符 verifier');
  assert.ok(!data.authorizeUrl.includes(`state=${verifier}`), 'verifier 本体不得出现在授权 URL');
});

test('POST /oauth/exchange：无效 state 被 400 拒绝（不发起换票）', { skip: !RUN }, async () => {
  const { registerOAuthRoutes } = require(OAUTH_JS);
  const req = {
    url: '/api/account/oauth/exchange',
    headers: {},
    ahOwner: 'alice',
    on(event, cb) {
      if (event === 'data') setImmediate(() => cb(JSON.stringify({ code: 'authcode', state: 'forged-state' })));
      if (event === 'end') setImmediate(cb);
    }
  };
  let statusCode = 0;
  let body = '';
  const res = {
    writeHead(code) {
      statusCode = code;
      return this;
    },
    end(payload) {
      body = payload ?? '';
    }
  };
  const handled = await registerOAuthRoutes(req, res, '/api/account/oauth/exchange', 'POST');
  assert.ok(handled);
  assert.strictEqual(statusCode, 400, '伪造 state 必须被拒绝');
  assert.match(body, /state/);
});
