// 零依赖测试（node:test + node:assert）：覆盖 P2 插件资源配额（进程内形态）。
// - maxCallsPerRun：超限调用被拒绝
// - callTimeoutMs：单次调用超时被拒绝
// - enable 重置配额窗口（disable → enable 后计数清零）
// - manifest 校验：非法配额字段被拒绝

const test = require('node:test');
const assert = require('node:assert');

const plugin = require('../dist/plugin/index.js');
const { PluginLoader, getPluginToolRegistry } = plugin;
const { AgentRegistry } = require('../dist/agents/registry.js');
const { VolatileAgentStore } = require('../dist/agents/store.js');

function freshLoader(opts = {}) {
  return new PluginLoader({ registry: new AgentRegistry(new VolatileAgentStore()), ...opts });
}

const manifest = (over = {}) => ({
  id: 'plugin-q',
  version: '1.0.0',
  name: 'Plugin Q',
  capabilities: [{ id: 'cap-x' }],
  ...over,
});

test('P2 插件配额：maxCallsPerRun 超限拒绝，窗口内调用成功', async () => {
  const loader = freshLoader();
  await loader.installModule({
    manifest: manifest({ quota: { maxCallsPerRun: 2 } }),
    setup(ctx) {
      ctx.tools.register('ping', 'ping 工具', {}, () => 'pong');
    },
  });
  await loader.enable('plugin-q');
  const shared = getPluginToolRegistry();
  assert.strictEqual(await shared.call('plugin-q__ping', {}), 'pong');
  assert.strictEqual(await shared.call('plugin-q__ping', {}), 'pong');
  // 第 3 次超限拒绝。
  await assert.rejects(() => shared.call('plugin-q__ping', {}), /调用次数超限/);
});

test('P2 插件配额：callTimeoutMs 超时拒绝', async () => {
  const loader = freshLoader();
  await loader.installModule({
    manifest: manifest({ quota: { callTimeoutMs: 50 } }),
    setup(ctx) {
      ctx.tools.register('slow', '慢工具', {}, () => new Promise((r) => setTimeout(() => r('done'), 500)));
    },
  });
  await loader.enable('plugin-q');
  const shared = getPluginToolRegistry();
  await assert.rejects(() => shared.call('plugin-q__slow', {}), /调用超时/);
});

test('P2 插件配额：disable → enable 重置配额窗口', async () => {
  const loader = freshLoader();
  await loader.installModule({
    manifest: manifest({ quota: { maxCallsPerRun: 1 } }),
    setup(ctx) {
      ctx.tools.register('ping', 'ping 工具', {}, () => 'pong');
    },
  });
  await loader.enable('plugin-q');
  const shared = getPluginToolRegistry();
  assert.strictEqual(await shared.call('plugin-q__ping', {}), 'pong');
  await assert.rejects(() => shared.call('plugin-q__ping', {}), /调用次数超限/);
  // 停用再启用 → 配额窗口重置，可再次调用。
  await loader.disable('plugin-q');
  await loader.enable('plugin-q');
  assert.strictEqual(await shared.call('plugin-q__ping', {}), 'pong');
});

test('P2 插件配额：无配额声明时零开销直通', async () => {
  const loader = freshLoader();
  await loader.installModule({
    manifest: manifest(),
    setup(ctx) {
      ctx.tools.register('ping', 'ping 工具', {}, () => 'pong');
    },
  });
  await loader.enable('plugin-q');
  const shared = getPluginToolRegistry();
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(await shared.call('plugin-q__ping', {}), 'pong');
  }
});

test('P2 插件配额：manifest 校验拒绝非法配额字段', async () => {
  const loader = freshLoader();
  await assert.rejects(
    () => loader.installModule({ manifest: manifest({ quota: { maxCallsPerRun: 0 } }) }),
    /quota\.maxCallsPerRun/,
  );
  await assert.rejects(
    () => loader.installModule({ manifest: manifest({ quota: { callTimeoutMs: -5 } }) }),
    /quota\.callTimeoutMs/,
  );
  await assert.rejects(
    () => loader.installModule({ manifest: manifest({ quota: 'nope' }) }),
    /quota/,
  );
});
