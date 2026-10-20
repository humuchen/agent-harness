'use strict';
// env-guard 单测：平台鉴权凭证的环境边界收口（插件 worker 沙箱·第一阶段）。
const test = require('node:test');
const assert = require('node:assert');

const {
  scrubSensitiveEnv,
  getSecret,
  resetEnvGuardForTest,
  isEnvScrubbedForTest
} = require('../dist/env-guard.js');

test('scrub 后 process.env 不再持有敏感键，getSecret 从受保护副本取值', () => {
  resetEnvGuardForTest();
  process.env.UI_TOKENS = '{"tok":"admin"}';
  process.env.UI_JWT_SECRET = 'jwt-secret-value';
  scrubSensitiveEnv();
  assert.ok(isEnvScrubbedForTest());
  // 环境里已摘除（同进程插件直读拿不到）
  assert.strictEqual(process.env.UI_TOKENS, undefined);
  assert.strictEqual(process.env.UI_JWT_SECRET, undefined);
  // 宿主经 getSecret 仍能取到
  assert.strictEqual(getSecret('UI_TOKENS'), '{"tok":"admin"}');
  assert.strictEqual(getSecret('UI_JWT_SECRET'), 'jwt-secret-value');
  delete process.env.UI_TOKENS;
  delete process.env.UI_JWT_SECRET;
});

test('scrub 幂等：重复调用不报错不丢值', () => {
  resetEnvGuardForTest();
  process.env.UI_SESSION_SECRET = 'sess';
  scrubSensitiveEnv();
  scrubSensitiveEnv();
  assert.strictEqual(getSecret('UI_SESSION_SECRET'), 'sess');
  delete process.env.UI_SESSION_SECRET;
});

test('getSecret 对非敏感键回落 process.env 直读（行为等价）', () => {
  resetEnvGuardForTest();
  process.env.AH_ENV_GUARD_PROBE = 'plain-value';
  assert.strictEqual(getSecret('AH_ENV_GUARD_PROBE'), 'plain-value');
  delete process.env.AH_ENV_GUARD_PROBE;
});

test('getSecret 对未设置的敏感键返回 undefined（不误造值）', () => {
  resetEnvGuardForTest();
  assert.strictEqual(getSecret('UI_ROLE_PERMISSIONS'), undefined);
});

test('authz：scrub 后 createAuthorizer 仍能读到 UI_TOKENS（getSecret 接线）', () => {
  resetEnvGuardForTest();
  process.env.UI_TOKENS = '{"scrub-tok":"admin"}';
  const { createAuthorizer } = require('../dist/authz.js');
  scrubSensitiveEnv();
  // 模拟真实时序：先 scrub 再创建 authorizer（bootstrap 顺序）。
  const az = createAuthorizer(true);
  const authed = az.authenticate({
    headers: { authorization: 'Bearer scrub-tok' }
  });
  assert.ok(authed, 'scrub 后静态令牌鉴权必须仍然可用（经受保护副本）');
  delete process.env.UI_TOKENS;
});
