// 零依赖测试（node:test + node:assert）：覆盖 P0.3 策略引擎 policy/engine.ts。
// 关注：per-tenant 策略覆盖 default、行业画像（医疗强脱敏 / 金融禁出境 / 教育放宽）、
// 租户间策略互不串档、以及出网管控接入 guardrails.checkToolArgs（web_fetch）。

const test = require('node:test');
const assert = require('node:assert');

const { PolicyEngine, INDUSTRY_PROFILES, policyEngine } = require('../dist/policy/index.js');
const guardrails = require('../dist/guardrails.js');
const { checkToolArgs, checkEgress, redactOutput } = guardrails;

test('PolicyEngine：无注册租户时回退 default（绝不让校验裸奔）', () => {
  const eng = new PolicyEngine();
  const p = eng.getPolicy('unknown-tenant');
  assert.strictEqual(p.enableSecretScan, true);
  assert.strictEqual(p.enablePiiRedaction, true);
  assert.strictEqual(p.network, undefined); // open
});

test('PolicyEngine：registerTenantPolicy 覆盖 default 且租户间互不串档', () => {
  const eng = new PolicyEngine();
  eng.registerTenantPolicy('acme', { enablePiiRedaction: false, maxInputLength: 5000 });
  const acme = eng.getPolicy('acme');
  assert.strictEqual(acme.enablePiiRedaction, false);
  assert.strictEqual(acme.maxInputLength, 5000);
  // 其它租户不受影响，仍用 default。
  assert.strictEqual(eng.getPolicy('globex').enablePiiRedaction, true);
});

test('行业画像 finance：默认禁止一切外部出网（denylist + *）', () => {
  const eng = new PolicyEngine();
  eng.applyIndustryProfile('bank', 'finance');
  const p = eng.getPolicy('bank');
  assert.ok(p.network && p.network.mode === 'denylist');
  // 任意外部 URL 被拒。
  assert.ok(checkEgress('https://api.openai.com/v1', p.network) !== null);
  assert.ok(checkEgress('http://internal-host', p.network) !== null);
});

test('行业画像 medical-aesthetics：高敏注入检测 + 强制 PII 脱敏', () => {
  const eng = new PolicyEngine();
  eng.applyIndustryProfile('clinic', 'medical-aesthetics');
  const p = eng.getPolicy('clinic');
  assert.strictEqual(p.injectionSensitivity, 'high');
  assert.strictEqual(p.enablePiiRedaction, true);
  // 脱敏生效：邮箱被打码。
  assert.ok(redactOutput('联系 john@example.com', p).includes('***[email]'));
});

test('行业画像 education：放宽（长输入、低敏、关脱敏）', () => {
  const eng = new PolicyEngine();
  eng.applyIndustryProfile('school', 'education');
  const p = eng.getPolicy('school');
  assert.strictEqual(p.maxInputLength, 60000);
  assert.strictEqual(p.injectionSensitivity, 'low');
  assert.strictEqual(p.enablePiiRedaction, false);
  assert.strictEqual(redactOutput('联系 john@example.com', p).includes('john@example.com'), true);
});

test('出网管控接入 checkToolArgs：finance 租户 web_fetch 外部地址被拦截', () => {
  const eng = new PolicyEngine();
  eng.applyIndustryProfile('bank', 'finance');
  const p = eng.getPolicy('bank');
  const blocked = checkToolArgs('builtin__web_fetch', { url: 'https://example.com' }, p);
  assert.strictEqual(blocked.ok, false);
  assert.ok(blocked.reason.includes('network egress blocked'));
});

test('出网管控接入 checkToolArgs：默认策略（open）放行 web_fetch', () => {
  const eng = new PolicyEngine();
  const p = eng.getPolicy(undefined); // default = open
  const ok = checkToolArgs('builtin__web_fetch', { url: 'https://example.com' }, p);
  assert.strictEqual(ok.ok, true);
});

test('全局单例 policyEngine 可用（非默认导出，按实例导出）', () => {
  // 校验导出形态：policyEngine 是 PolicyEngine 实例；INDUSTRY_PROFILES 含 finance/medical。
  assert.ok(policyEngine instanceof PolicyEngine);
  assert.ok(INDUSTRY_PROFILES.finance);
  assert.ok(INDUSTRY_PROFILES['medical-aesthetics']);
});
