// 零依赖测试（node:test + node:assert）：覆盖 P2.c 行业合规画像强化 policy/engine.ts。
// 关注：预置画像含合规元数据（框架/数据驻留/审计）+ 最低隔离级别；applyIndustryProfile 叠加；
// registerIndustryProfiles / listIndustryProfiles 引导注册。

const test = require('node:test');
const assert = require('node:assert');

const { PolicyEngine, INDUSTRY_PROFILES } = require('../dist/policy/index.js');

test('INDUSTRY_PROFILES：金融 —— 禁出网 + 国内驻留 + 强制审计 + 最低 os 隔离', () => {
  const fin = INDUSTRY_PROFILES['finance'];
  assert.ok(fin.network && fin.network.mode === 'denylist' && fin.network.deniedDomains.includes('*'));
  assert.strictEqual(fin.compliance.dataResidency, 'domestic');
  assert.strictEqual(fin.compliance.auditRequired, true);
  assert.strictEqual(fin.isolation, 'os');
});

test('INDUSTRY_PROFILES：医疗美容 —— 高敏注入 + 强 PII 脱敏 + 等保 + os 隔离', () => {
  const med = INDUSTRY_PROFILES['medical-aesthetics'];
  assert.strictEqual(med.injectionSensitivity, 'high');
  assert.strictEqual(med.enablePiiRedaction, true);
  assert.ok(med.compliance.framework.includes('等保'));
  assert.strictEqual(med.compliance.dataResidency, 'domestic');
  assert.strictEqual(med.isolation, 'os');
});

test('INDUSTRY_PROFILES：教育 —— 放宽（关脱敏、长输入、local 隔离）', () => {
  const edu = INDUSTRY_PROFILES['education'];
  assert.strictEqual(edu.enablePiiRedaction, false);
  assert.ok((edu.maxInputLength ?? 0) > 20000);
  assert.strictEqual(edu.isolation, 'local');
});

test('PolicyEngine.applyIndustryProfile：叠加到租户策略', () => {
  const eng = new PolicyEngine();
  eng.applyIndustryProfile('tenant-fin', 'finance');
  const p = eng.getPolicy('tenant-fin');
  assert.ok(p.network && p.network.deniedDomains.includes('*'));
  assert.strictEqual(p.compliance.dataResidency, 'domestic');
  assert.strictEqual(p.isolation, 'os');
});

test('registerIndustryProfiles / listIndustryProfiles：引导注册全部预置画像', () => {
  const eng = new PolicyEngine();
  const domains = eng.registerIndustryProfiles();
  assert.ok(domains.includes('finance'));
  assert.ok(domains.includes('medical-aesthetics'));
  assert.ok(domains.includes('healthcare'));
  assert.ok(domains.includes('education'));
  const listed = eng.listIndustryProfiles();
  assert.strictEqual(listed.length, 4);
  const fin = listed.find((x) => x.domain === 'finance');
  assert.ok(fin.profile.compliance.auditRequired);
});
