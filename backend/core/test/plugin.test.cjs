// 零依赖测试（node:test + node:assert）：覆盖 P1.③ 插件框架骨架。
// - install → 默认 disabled，不注册进 Registry
// - enable → capabilities 转 AgentCard 注册进 Registry（可被 get 查到）
// - disable → 从 Registry 注销
// - upgrade → 按原启用态重注册，版本更新
// - 依赖解析：缺失依赖的 install 直接抛错
// - 隔离钩子：启用前调用注入的 sandbox（P2 真实加载点）

const test = require('node:test');
const assert = require('node:assert');

const plugin = require('../dist/plugin/index.js');
const { PluginLoader } = plugin;
const { AgentRegistry } = require('../dist/agents/registry.js');
const { VolatileAgentStore } = require('../dist/agents/store.js');

function freshLoader(opts = {}) {
  return new PluginLoader({ registry: new AgentRegistry(new VolatileAgentStore()), ...opts });
}

const manifest = (over = {}) => ({
  id: 'plugin-a',
  version: '1.0.0',
  name: 'Plugin A',
  capabilities: [{ id: 'cap-x' }, { id: 'cap-y', inputSchema: { type: 'object' } }],
  ...over,
});

test('install 默认 disabled，且无 agent 注册进 registry', async () => {
  const loader = freshLoader();
  const rec = await loader.install(manifest());
  assert.strictEqual(rec.state, 'disabled');
  assert.strictEqual(loader.get('plugin-a').state, 'disabled');
  // 尚未 enable，registry 里不应有该 agent。
  assert.strictEqual(await loader.registry.get('plugin-a'), null);
});

test('enable → manifest.capabilities 转成 AgentCard 注册进 Registry', async () => {
  const loader = freshLoader();
  const reg = loader.registry;
  await loader.install(manifest());
  const rec = await loader.enable('plugin-a');
  assert.strictEqual(rec.state, 'enabled');
  const card = await reg.get('plugin-a');
  assert.ok(card, 'AgentCard 应已注册');
  assert.strictEqual(card.id, 'plugin-a');
  assert.strictEqual(card.name, 'Plugin A');
  assert.strictEqual(card.capabilities.length, 2);
  assert.strictEqual(card.transport, 'local');
});

test('disable → 从 Registry 注销，退出路由候选', async () => {
  const loader = freshLoader();
  const reg = loader.registry;
  await loader.install(manifest());
  await loader.enable('plugin-a');
  assert.ok(await reg.get('plugin-a'));
  await loader.disable('plugin-a');
  assert.strictEqual(loader.get('plugin-a').state, 'disabled');
  assert.strictEqual(await reg.get('plugin-a'), null);
});

test('upgrade → 版本更新并按原启用态重注册', async () => {
  const loader = freshLoader();
  const reg = loader.registry;
  await loader.install(manifest());
  await loader.enable('plugin-a');
  const rec = await loader.upgrade('plugin-a', manifest({ version: '2.0.0', capabilities: [{ id: 'cap-z' }] }));
  assert.strictEqual(rec.manifest.version, '2.0.0');
  assert.strictEqual(rec.state, 'enabled');
  const card = await reg.get('plugin-a');
  assert.strictEqual(card.version, '2.0.0');
  assert.strictEqual(card.capabilities.length, 1);
  assert.strictEqual(card.capabilities[0].id, 'cap-z');
});

test('依赖解析：缺失依赖的 install 直接抛错', async () => {
  const loader = freshLoader();
  await assert.rejects(
    () => loader.install(manifest({ id: 'plugin-b', dependencies: ['plugin-missing'] })),
    /depends on missing plugin/,
  );
});

test('依赖解析：依赖已安装时 install 成功', async () => {
  const loader = freshLoader();
  await loader.install(manifest({ id: 'plugin-base' }));
  const rec = await loader.install(manifest({ id: 'plugin-b', dependencies: ['plugin-base'] }));
  assert.strictEqual(rec.manifest.id, 'plugin-b');
});

test('隔离钩子：启用前调用注入的 sandbox（P2 真实加载点）', async () => {
  const loaded = [];
  const loader = freshLoader({ sandbox: (m) => { loaded.push(m.id); } });
  await loader.install(manifest());
  await loader.enable('plugin-a');
  assert.deepStrictEqual(loaded, ['plugin-a']);
});
