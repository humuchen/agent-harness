// 增强：ctx.config 落地测试 —— manifest.env 缺省 + 进程 env 白名单同名覆盖。
// 白名单纪律（密钥不透传）已由 plugin-env.test.cjs 守护；本文件验证 ctx.config 的合并装配。
const test = require('node:test');
const assert = require('node:assert');

const plugin = require('../dist/plugin/index.js');
const { PluginLoader } = plugin;
const { AgentRegistry } = require('../dist/agents/registry.js');
const { VolatileAgentStore } = require('../dist/agents/store.js');

const manifest = (over = {}) => ({
  id: 'plugin-cfg',
  version: '1.0.0',
  name: 'Plugin Cfg',
  capabilities: [{ id: 'cap-x' }],
  env: {
    GREETING: '来自 manifest 的缺省问候',
    MAX_RETRIES: '3',
  },
  ...over,
});

test('ctx.config：manifest.env 提供缺省 + 进程 env 白名单同名覆盖 + 密钥不透传', async () => {
  // 注入伪进程 env：PLUGIN_ 前缀放行，密钥类拒绝
  const origEnv = { ...process.env };
  process.env.PLUGIN_GREETING = '来自部署的覆盖问候';
  process.env.MAX_RETRIES = '9'; // 裸名 env：仅对 manifest 显式声明的键生效
  process.env.ADMIN_API_KEY = 'sk-secret-should-not-leak';
  try {
    let captured = null;
    const loader = new PluginLoader({
      registry: new AgentRegistry(new VolatileAgentStore()),
    });
    await loader.installModule({
      manifest: manifest(),
      async setup(ctx) {
        captured = { ...ctx.config };
      },
    });
    await loader.enable('plugin-cfg');
    assert.ok(captured, 'setup 应被调用并捕获 config');
    // 裸名 env 覆盖 manifest 缺省（声明键的部署覆盖路径一）
    assert.strictEqual(captured.MAX_RETRIES, '9', '裸名 env 应覆盖 manifest 声明');
    // PLUGIN_ 前缀覆盖（声明键的部署覆盖路径二）
    assert.strictEqual(captured.GREETING, '来自部署的覆盖问候', 'PLUGIN_GREETING 应覆盖 manifest.env.GREETING');
    // 密钥类绝不进入 config 视图
    assert.strictEqual(captured.ADMIN_API_KEY, undefined);
  } finally {
    for (const k of ['PLUGIN_GREETING', 'PLUGIN_MAX_RETRIES', 'MAX_RETRIES', 'ADMIN_API_KEY']) delete process.env[k];
    void origEnv;
  }
});

test('ctx.config：无 manifest.env 且无 PLUGIN_ env 时为空对象（向后兼容）', async () => {
  const orig = process.env.PLUGIN_X;
  delete process.env.PLUGIN_X;
  try {
    let captured = null;
    const loader = new PluginLoader({
      registry: new AgentRegistry(new VolatileAgentStore()),
    });
    await loader.installModule({
      manifest: manifest({ id: 'plugin-cfg-2', env: undefined }),
      async setup(ctx) {
        captured = { ...ctx.config };
      },
    });
    await loader.enable('plugin-cfg-2');
    assert.deepStrictEqual(captured.PLUGIN_X, undefined);
    assert.strictEqual(typeof captured, 'object');
  } finally {
    if (orig !== undefined) process.env.PLUGIN_X = orig;
  }
});
