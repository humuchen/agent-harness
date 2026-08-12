// 数据留存/出境策略 + OpenAPI 单元测试（业务层，零依赖 node:test）。
// 需在 pnpm --filter @agent-harness/ui build 之后运行：node --test test/*.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const { DefaultRetentionPolicy, createRetentionPolicy } = require('../dist/retention.js');
const { buildOpenApiSpec } = require('../dist/openapi.js');

test('DefaultRetentionPolicy: 留存窗口来自默认值与环境变量', () => {
  const p = new DefaultRetentionPolicy({ auditDays: 10, memoryDays: 0, recipeDays: 200 });
  assert.strictEqual(p.maxAgeMs('audit'), 10 * 24 * 60 * 60 * 1000);
  assert.strictEqual(p.maxAgeMs('memory'), -1); // 0 = 永久
  assert.strictEqual(p.maxAgeMs('recipe'), 200 * 24 * 60 * 60 * 1000);
  assert.strictEqual(p.describe().scrubPII, true);
});

test('DefaultRetentionPolicy: scrubForExport 出境前脱敏 PII', () => {
  const p = new DefaultRetentionPolicy();
  const out = p.scrubForExport('audit', {
    msg: '用户 a@b.com 手机号 13800138000 已注册',
    nested: { id: '身份证 11010119900307123X' },
    keep: '普通文本保留',
  });
  assert.ok(out.msg.includes('[email]'));
  assert.ok(out.msg.includes('[phone]'));
  // 身份证被脱敏
  const json = JSON.stringify(out);
  assert.ok(!json.includes('11010119900307123X'));
  assert.ok(json.includes('普通文本保留'));
});

test('createRetentionPolicy: 从环境变量读取窗口', () => {
  process.env.RETENTION_DAYS_AUDIT = '7';
  const p = createRetentionPolicy();
  assert.strictEqual(p.maxAgeMs('audit'), 7 * 24 * 60 * 60 * 1000);
  delete process.env.RETENTION_DAYS_AUDIT;
});

test('buildOpenApiSpec: 覆盖版本化 JSON/SSE 端点', () => {
  const spec = buildOpenApiSpec();
  assert.strictEqual(spec.openapi, '3.0.3');
  const paths = spec.paths;
  for (const p of ['/api/v1/state', '/api/v1/metrics', '/api/v1/approvals/{id}', '/api/v1/eval', '/api/v1/run']) {
    assert.ok(paths[p], '缺少路径 ' + p);
  }
  assert.strictEqual(spec.components.securitySchemes.bearerAuth.type, 'http');
});
