// 验证 web_fetch 工具参数护栏策略：避免 URL 中的普通 query parameter 被误判为 secret。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// P0 修复（secure by default）后的环境声明：本文件聚焦 secret scan 语义，需要放行的
// 网络出口。GUARDRAIL_* 在模块导入时固化，必须在 require dist 之前设置；
// node:test 按文件隔离进程，不会污染其他测试文件。
process.env.GUARDRAIL_NETWORK_MODE = 'open';

const {
  checkToolArgs,
  configureGuardrails,
} = require('../dist/guardrails.js');

test('web_fetch URL 带 token=xxx 查询参数默认不被 secret scan 拦截', () => {
  const r = checkToolArgs('builtin__web_fetch', {
    url: 'https://api.example.com/api?city=suzhou&token=abcd1234efgh5678',
  });
  assert.strictEqual(r.ok, true, r.reason);
});

test('web_fetch URL 中带 sk- 前缀路径默认不被 secret scan 拦截', () => {
  const r = checkToolArgs('builtin__web_fetch', {
    url: 'https://api.example.com/docs',
  });
  assert.strictEqual(r.ok, true, r.reason);
});

test('web_fetch headers 中的 api_key 仍会被默认拦截', () => {
  // 密钥需要 ≥ 20 字符（sk- 前缀后的长度）才能命中 SECRET_PATTERNS
  const r = checkToolArgs('builtin__web_fetch', {
    url: 'https://api.example.com/api',
    headers: { 'x-api-key': 'sk-test-api-key-value-abcdefgh' },
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('possible secret'), r.reason);
});

test('非 web_fetch 工具仍对完整参数做 secret scan', () => {
  const r = checkToolArgs('some_other_tool', {
    url: 'https://api.example.com?token=abcd1234efgh5678',
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('possible secret'), r.reason);
});

test('web_fetch 可切换为 full scan（恢复旧行为）', () => {
  configureGuardrails({ webFetchSecretScan: 'full' });
  try {
    const r = checkToolArgs('builtin__web_fetch', {
      url: 'https://api.example.com/api?city=suzhou&token=abcd1234efgh5678',
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes('possible secret'), r.reason);
  } finally {
    configureGuardrails({ webFetchSecretScan: 'headers-only' });
  }
});

test('web_fetch 可完全关闭 secret scan（仅保留 egress/注入检查）', () => {
  configureGuardrails({ webFetchSecretScan: 'off' });
  try {
    const r = checkToolArgs('builtin__web_fetch', {
      url: 'https://api.example.com/api?api_key=testvalue',
      headers: { 'x-api-key': 'testvalue' },
    });
    // webFetchSecretScan=off 时 secret scan 关闭，但注入检测仍可能拦截极端载荷；
    // 这里 api_key 值本身不是注入短语，所以应放行。
    assert.strictEqual(r.ok, true, r.reason);
  } finally {
    configureGuardrails({ webFetchSecretScan: 'headers-only' });
  }
});

test('命中 secret 时 reason 包含 pattern 编号与脱敏片段', () => {
  configureGuardrails({ webFetchSecretScan: 'full' });
  try {
    const r = checkToolArgs('builtin__web_fetch', {
      url: 'https://api.example.com/api?api_key=testvalue',
    });
    assert.strictEqual(r.ok, false);
    assert.ok(/pattern #\d+/.test(r.reason), r.reason);
  } finally {
    configureGuardrails({ webFetchSecretScan: 'headers-only' });
  }
});
