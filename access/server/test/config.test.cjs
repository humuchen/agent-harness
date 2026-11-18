// P1-6 配置快照门面回归测试（node:test + node:assert）。
// 覆盖：默认值、env 覆盖、NaN 守卫（非法数值回落默认）、CORS 解析、requireAuth 派生、冻结。

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadServerConfig } = require('../dist/config.js');

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('ServerConfig: 默认值正确（PORT/UI_HOST/MAX_BODY_BYTES）', () => {
  withEnv({ PORT: undefined, UI_PORT: undefined, MAX_BODY_BYTES: undefined, UI_HOST: undefined }, () => {
    const c = loadServerConfig();
    // DEFAULTS.PORT = 4173, UI_HOST = '0.0.0.0', MAX_BODY_BYTES = 10MB
    assert.strictEqual(c.port, 4173);
    assert.strictEqual(c.host, '0.0.0.0');
    assert.strictEqual(c.maxBodyBytes, 10 * 1024 * 1024);
  });
});

test('ServerConfig: env 覆盖默认（PORT > UI_PORT > DEFAULTS）', () => {
  withEnv({ PORT: '9090', UI_PORT: undefined }, () => {
    assert.strictEqual(loadServerConfig().port, 9090);
  });
  withEnv({ PORT: undefined, UI_PORT: '7070' }, () => {
    assert.strictEqual(loadServerConfig().port, 7070);
  });
});

test('ServerConfig: 非法数值 env 回落默认（NaN 守卫，闭合静默 misconfig）', () => {
  withEnv({ MAX_BODY_BYTES: 'abc' }, () => {
    // 关键：旧实现 Number("abc")=NaN → 上限失效；快照经 cfgNum 回落 DEFAULTS（10MB）
    assert.strictEqual(loadServerConfig().maxBodyBytes, 10 * 1024 * 1024);
  });
  withEnv({ RATE_LIMIT: 'not-a-number' }, () => {
    assert.strictEqual(loadServerConfig().rateLimit, 120);
  });
});

test('ServerConfig: CORS 白名单解析（split + trim + 去空）', () => {
  withEnv({ UI_CORS_ORIGIN: 'https://a.com , https://b.com ,  ' }, () => {
    assert.deepStrictEqual(loadServerConfig().uiCorsOrigin, ['https://a.com', 'https://b.com']);
  });
  withEnv({ UI_CORS_ORIGIN: '' }, () => {
    assert.deepStrictEqual(loadServerConfig().uiCorsOrigin, []);
  });
});

test('ServerConfig: requireAuth 派生（token 模式 + 无 UI_TOKENS → false；非 token → true）', () => {
  withEnv({ AUTH_PROVIDER: 'token', ACCOUNT_AUTH: 'off', UI_TOKENS: undefined }, () => {
    assert.strictEqual(loadServerConfig().requireAuth, false);
  });
  withEnv({ AUTH_PROVIDER: 'oidc', ACCOUNT_AUTH: 'off' }, () => {
    assert.strictEqual(loadServerConfig().requireAuth, true);
  });
  withEnv({ AUTH_PROVIDER: 'token', ACCOUNT_AUTH: 'on' }, () => {
    assert.strictEqual(loadServerConfig().requireAuth, true);
  });
  withEnv({ AUTH_PROVIDER: 'token', ACCOUNT_AUTH: 'off', UI_TOKENS: 't1,t2' }, () => {
    assert.strictEqual(loadServerConfig().requireAuth, true);
  });
});

test('ServerConfig: 快照冻结（不可变）', () => {
  withEnv({ PORT: '8080' }, () => {
    const c = loadServerConfig();
    assert.ok(Object.isFrozen(c), 'config snapshot must be frozen');
    assert.throws(() => { c.port = 9999; }, /not extensible|read only|cannot assign/i);
  });
});

test('ServerConfig: A2A_ALLOW_PRIVATE_NETWORK 默认 false（SSRF 防护默认收紧）', () => {
  withEnv({ A2A_ALLOW_PRIVATE_NETWORK: undefined }, () => {
    assert.strictEqual(loadServerConfig().a2aAllowPrivateNetwork, false);
  });
  withEnv({ A2A_ALLOW_PRIVATE_NETWORK: 'true' }, () => {
    assert.strictEqual(loadServerConfig().a2aAllowPrivateNetwork, true);
  });
});
