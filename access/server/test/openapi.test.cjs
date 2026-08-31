'use strict';
// OpenAPI 契约一致性测试：确保对外「契约」不会无声漂移。
// 运行于已编译产物（dist），与 server.test.cjs 同约定（先 build 再 test）。
const test = require('node:test');
const assert = require('node:assert');
const { buildOpenApiSpec } = require('../dist/openapi');

// 这些端点是「对外契约 / 健康检查 / 鉴权元信息」的硬底线，删除任一都会破坏
// 网关 / 监控 / 前端 SSO 流程，必须在 OpenAPI 中始终存在且具备 200 响应。
const REQUIRED_PATHS = [
  '/api/v1/state',
  '/api/v1/metrics',
  '/api/v1/jobs',
  '/api/v1/auth/config',
  '/api/v1/errors'
];

test('buildOpenApiSpec: 必需公开/运维端点全部在契约中', () => {
  const spec = buildOpenApiSpec();
  const paths = spec.paths || {};
  for (const p of REQUIRED_PATHS) {
    assert.ok(paths[p], `OpenAPI 缺失必需路径 ${p}`);
    const ops = Object.keys(paths[p]).filter((m) => m !== 'parameters');
    assert.ok(ops.length > 0, `路径 ${p} 未声明任何操作`);
    const has200 = ops.some((m) => paths[p][m] && paths[p][m].responses && paths[p][m].responses['200']);
    assert.ok(has200, `路径 ${p} 缺少 200 响应描述`);
  }
});

test('buildOpenApiSpec: 非 /v1 前缀的旧路径不应泄漏进契约', () => {
  const spec = buildOpenApiSpec();
  const paths = spec.paths || {};
  for (const p of Object.keys(paths)) {
    assert.ok(
      p.startsWith('/api/v1/'),
      `契约路径应统一以 /api/v1/ 前缀（发现非版本化路径 ${p}）`
    );
  }
});

test('buildOpenApiSpec: 包含 info + openapi 版本字段', () => {
  const spec = buildOpenApiSpec();
  assert.ok(spec.openapi, '应声明 openapi 版本');
  assert.ok(spec.info && spec.info.title, '应声明 info.title');
});
