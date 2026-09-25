// 插件环境变量白名单（插件隔离 P2 前置步）守护测试：
// - 默认白名单子集：密钥类变量（ADMIN_API_KEY / *API_KEY / TOKEN 等）不得透传给插件；
// - PLUGIN_* / AH_PLUGIN_* 前缀与 PLUGIN_ENV_EXTRA 显式追加项放行；
// - PLUGIN_ENV_FULL=on 逃逸舱口恢复全量（打 warn 留痕，此处只验证透传语义）。
const test = require('node:test');
const assert = require('node:assert');

const { resolvePluginEnv } = require('../dist/plugin/index.js');

const FAKE_ENV = {
  NODE_ENV: 'test',
  PORT: '4173',
  LOG_LEVEL: 'info',
  ADMIN_API_KEY: 'sk-admin-secret',
  OPENROUTER_API_KEY: 'sk-or-secret',
  LLM_TOKEN: 'tok-secret',
  DATABASE_URL: 'postgres://u:p@h/db',
  PLUGIN_FOO: 'bar',
  AH_PLUGIN_BAZ: 'qux',
  PLUGIN_ENV_EXTRA: 'MY_EXTRA',
  MY_EXTRA: 'extra-value',
  PATH: 'C:\\windows',
};

test('默认白名单：密钥类变量不透传，基础部署元信息放行', () => {
  const env = resolvePluginEnv(FAKE_ENV);
  assert.strictEqual(env.NODE_ENV, 'test');
  assert.strictEqual(env.PORT, '4173');
  assert.strictEqual(env.LOG_LEVEL, 'info');
  // 密钥类必须全部剔除
  assert.strictEqual(env.ADMIN_API_KEY, undefined);
  assert.strictEqual(env.OPENROUTER_API_KEY, undefined);
  assert.strictEqual(env.LLM_TOKEN, undefined);
  assert.strictEqual(env.DATABASE_URL, undefined);
  // 无关变量（PATH）不透传：插件看到的是白名单子集而非全量
  assert.strictEqual(env.PATH, undefined);
});

test('PLUGIN_* / AH_PLUGIN_* 前缀与 PLUGIN_ENV_EXTRA 追加项放行', () => {
  const env = resolvePluginEnv(FAKE_ENV);
  assert.strictEqual(env.PLUGIN_FOO, 'bar');
  assert.strictEqual(env.AH_PLUGIN_BAZ, 'qux');
  assert.strictEqual(env.MY_EXTRA, 'extra-value');
});

test('PLUGIN_ENV_FULL=on 逃逸舱口：恢复全量透传', () => {
  const env = resolvePluginEnv({ ...FAKE_ENV, PLUGIN_ENV_FULL: 'on' });
  assert.strictEqual(env.ADMIN_API_KEY, 'sk-admin-secret');
  assert.strictEqual(env.OPENROUTER_API_KEY, 'sk-or-secret');
  assert.strictEqual(env.PATH, 'C:\\windows', '全量模式下无关变量也透传');
});

test('PLUGIN_ENV_FULL 大小写与 1/true 变体均生效', () => {
  for (const v of ['ON', 'on', '1', 'true', 'True']) {
    const env = resolvePluginEnv({ ...FAKE_ENV, PLUGIN_ENV_FULL: v });
    assert.strictEqual(env.ADMIN_API_KEY, 'sk-admin-secret', `PLUGIN_ENV_FULL=${v}`);
  }
  // off / 空值不触发
  const env = resolvePluginEnv({ ...FAKE_ENV, PLUGIN_ENV_FULL: 'off' });
  assert.strictEqual(env.ADMIN_API_KEY, undefined);
});

test('undefined 值变量不进入白名单结果', () => {
  const env = resolvePluginEnv({ ...FAKE_ENV, NODE_ENV: undefined, PLUGIN_EMPTY: undefined });
  assert.ok(!('NODE_ENV' in env));
  assert.ok(!('PLUGIN_EMPTY' in env));
});
