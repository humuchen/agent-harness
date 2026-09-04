'use strict';
const test = require('node:test');
const assert = require('node:assert');

// 覆盖 P2 config/defaults 集中化：
// - DEFAULTS 与 config-schema 的 SCHEMA 键集合一致性（防「默认值与校验清单」漂移）
// - cfgStr / cfgNum / cfgBool 的 env 优先 + 默认值回退语义

const { DEFAULTS, cfgStr, cfgNum, cfgBool } = require('../dist/config-defaults.js');
const { SCHEMA } = require('../dist/config-schema.js');

test('DEFAULTS 与 SCHEMA 键集合一致（双向漂移守卫）', () => {
  const schemaKeys = new Set(SCHEMA.map((f) => f.key));
  const defaultKeys = Object.keys(DEFAULTS);

  // 方向一：有默认值但无校验项 —— 配置项游离于启动期校验之外，写错不会告警。
  const withoutSchema = defaultKeys.filter((k) => !schemaKeys.has(k));
  assert.deepStrictEqual(
    withoutSchema,
    [],
    `DEFAULTS 中存在 SCHEMA 未覆盖的键（有默认值但无校验）: ${withoutSchema.join(', ')}`
  );

  // 方向二：有校验项但无集中默认值 —— 默认值散落回行内字面量，易与校验清单分叉。
  const withoutDefaults = [...schemaKeys].filter((k) => !defaultKeys.includes(k));
  assert.deepStrictEqual(
    withoutDefaults,
    [],
    `SCHEMA 中存在 DEFAULTS 未定义的键（有校验但无集中默认值）: ${withoutDefaults.join(', ')}`
  );
});

test('核心默认值与既有文档行为一致', () => {
  assert.strictEqual(DEFAULTS.PORT, 4173);
  assert.strictEqual(DEFAULTS.UI_HOST, '0.0.0.0');
  assert.strictEqual(DEFAULTS.MAX_BODY_BYTES, 1_048_576);
  assert.strictEqual(DEFAULTS.HISTORY_MAX_BYTES, 512 * 1024);
  assert.strictEqual(DEFAULTS.RATE_LIMIT, 120);
  assert.strictEqual(DEFAULTS.RATE_LIMIT_WINDOW_MS, 60_000);
  assert.strictEqual(DEFAULTS.AUTH_PROVIDER, 'token');
  assert.strictEqual(DEFAULTS.ACCOUNT_AUTH, 'on');
  // P1-9/10: 路径已改为绝对路径（不再依赖 cwd）
  assert.strictEqual(DEFAULTS.MEMORY_DIR, '/var/lib/agent-harness/memory');
  assert.strictEqual(DEFAULTS.MEMORY_SQLITE_FILE, '/var/lib/agent-harness/memory.db');
  assert.strictEqual(DEFAULTS.HISTORY_DB_FILE, '/var/lib/agent-harness/chat-history.db');
  assert.strictEqual(DEFAULTS.MCP_SERVERS_DB_FILE, '/var/lib/agent-harness/mcp-servers.db');
  assert.strictEqual(DEFAULTS.CUSTOM_MODELS_DB_FILE, '/var/lib/agent-harness/custom-models.db');
  assert.strictEqual(DEFAULTS.RAG_DATA_FILE, '/var/lib/agent-harness/rag-store.json');
});

test('cfgStr: env 优先，回退 DEFAULTS', () => {
  const prev = process.env.MY_STR;
  delete process.env.MY_STR;
  assert.strictEqual(cfgStr('MY_STR'), ''); // 无 DEFAULTS 项 → fallback ''
  assert.strictEqual(cfgStr('MY_STR', 'fb'), 'fb');
  assert.strictEqual(cfgStr('UI_CORS_ORIGIN'), DEFAULTS.UI_CORS_ORIGIN);
  process.env.MY_STR = 'envval';
  assert.strictEqual(cfgStr('MY_STR'), 'envval');
  if (prev === undefined) delete process.env.MY_STR; else process.env.MY_STR = prev;
});

test('cfgNum: env 优先（须有限数），回退 DEFAULTS', () => {
  const prev = process.env.MY_NUM;
  delete process.env.MY_NUM;
  assert.strictEqual(cfgNum('MY_NUM'), 0);
  assert.strictEqual(cfgNum('PORT'), DEFAULTS.PORT);
  process.env.MY_NUM = '42';
  assert.strictEqual(cfgNum('MY_NUM'), 42);
  process.env.MY_NUM = 'not-a-number';
  assert.strictEqual(cfgNum('MY_NUM'), DEFAULTS.MY_NUM ?? 0); // 非法 env → 回退默认
  if (prev === undefined) delete process.env.MY_NUM; else process.env.MY_NUM = prev;
});

test('cfgBool: env 优先（true/1/on），回退 DEFAULTS', () => {
  const prev = process.env.MY_BOOL;
  delete process.env.MY_BOOL;
  assert.strictEqual(cfgBool('MY_BOOL'), false);
  assert.strictEqual(cfgBool('ACCOUNT_AUTH'), DEFAULTS.ACCOUNT_AUTH === 'on' ? true : false);
  process.env.MY_BOOL = 'on';
  assert.strictEqual(cfgBool('MY_BOOL'), true);
  process.env.MY_BOOL = 'off';
  assert.strictEqual(cfgBool('MY_BOOL'), false);
  if (prev === undefined) delete process.env.MY_BOOL; else process.env.MY_BOOL = prev;
});
