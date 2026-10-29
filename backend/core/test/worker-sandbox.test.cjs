// 长期：插件 worker 沙箱（tools-only）测试 —— 真实 worker_threads + RPC。
// 覆盖：注册/调用往返、缓存一致性、超时看门狗、load-error fail-fast、loader 集成
//（entry + isolation → 自动沙箱 + 前缀合并 + disable 终止）、env 白名单纪律。
const { test, after } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const plugin = require('../dist/plugin/index.js');
const { WorkerToolsSandbox, shouldUseWorkerSandbox } = require('../dist/plugin/worker-sandbox.js');
const { PluginLoader, getPluginToolRegistry } = plugin;
const { AgentRegistry } = require('../dist/agents/registry.js');
const { VolatileAgentStore } = require('../dist/agents/store.js');

const dir = mkdtempSync(join(tmpdir(), 'worker-sandbox-'));

/** 生成一个入口插件文件：注册 echo / slow / leak 工具。 */
function writeEntry(name, extraTool) {
  const file = join(dir, `${name}.cjs`);
  const code = `
exports.setup = async function setup(ctx) {
  ctx.tools.register('echo', '回显工具', { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    (args) => ({ echoed: String(args.text).toUpperCase(), worker: true }));
  ctx.tools.register('leak', 'env 探测', { type: 'object', properties: {} },
    () => ({ pluginWEnv: process.env.PLUGIN_WENV ?? null, admin: process.env.ADMIN_API_KEY ?? null }));
  ${extraTool || ''}
};`;
  writeFileSync(file, code, 'utf8');
  return file;
}

test('shouldUseWorkerSandbox：entry + 非 none 隔离才启用；none/无 entry 走进程内', () => {
  const base = { id: 'x', version: '1.0.0', capabilities: [] };
  assert.equal(shouldUseWorkerSandbox({ ...base, entry: '/a/b.js', isolation: 'local' }), true);
  assert.equal(shouldUseWorkerSandbox({ ...base, entry: '/a/b.js', isolation: 'os' }), true);
  assert.equal(shouldUseWorkerSandbox({ ...base, entry: '/a/b.js', isolation: 'none' }), false);
  assert.equal(shouldUseWorkerSandbox({ ...base, entry: '/a/b.js' }), false, '未声明隔离不启用');
  assert.equal(shouldUseWorkerSandbox({ ...base, isolation: 'local' }), false, '无 entry 不启用');
});

test('WorkerToolsSandbox：注册经 RPC 到主线程 + 调用往返 + env 白名单', async () => {
  process.env.PLUGIN_WENV = 'worker-visible';
  process.env.ADMIN_API_KEY = 'sk-should-not-leak';
  const entry = writeEntry('basic');
  const sandbox = new WorkerToolsSandbox({
    manifest: { id: 'wp', version: '1.0.0', capabilities: [] },
    entry,
  });
  try {
    await sandbox.start();
    assert.equal(sandbox.getTools().has('echo'), true, 'worker 注册的工具应出现在主线程门面');
    const out = (await sandbox.getTools().call('echo', { text: 'hi' }));
    assert.deepEqual(out, { echoed: 'HI', worker: true }, '调用应经 RPC 在 worker 内执行');
    const leak = (await sandbox.getTools().call('leak', {}));
    assert.equal(leak.pluginWEnv, 'worker-visible', '白名单 env 应进入 worker');
    assert.equal(leak.admin, null, '密钥类 env 绝不进入 worker');
  } finally {
    sandbox.stop();
    delete process.env.PLUGIN_WENV;
    delete process.env.ADMIN_API_KEY;
  }
});

test('超时看门狗：慢工具调用按 timeoutMs 拒绝（不拖垮宿主）', async () => {
  const file = join(dir, 'slow.cjs');
  writeFileSync(file, `
exports.setup = async function setup(ctx) {
  ctx.tools.register('slow', '慢工具', { type: 'object', properties: {} },
    () => new Promise((r) => setTimeout(() => r('done'), 5000)));
};`, 'utf8');
  const sandbox = new WorkerToolsSandbox({
    manifest: { id: 'wp-slow', version: '1.0.0', capabilities: [] },
    entry: file,
    timeoutMs: 300,
  });
  try {
    await sandbox.start();
    await assert.rejects(() => sandbox.getTools().call('slow', {}), /超时/, '慢工具应在 300ms 被看门狗拒绝');
  } finally {
    sandbox.stop();
  }
});

test('配额 callTimeoutMs：manifest.quota.callTimeoutMs 作为默认超时（无显式 timeoutMs 时）', async () => {
  const file = join(dir, 'quota-slow.cjs');
  writeFileSync(file, `
exports.setup = async function setup(ctx) {
  ctx.tools.register('slow', '慢工具', { type: 'object', properties: {} },
    () => new Promise((r) => setTimeout(() => r('done'), 5000)));
};`, 'utf8');
  // 不传 timeoutMs —— 应回退到 manifest.quota.callTimeoutMs。
  const sandbox = new WorkerToolsSandbox({
    manifest: { id: 'wp-quota', version: '1.0.0', capabilities: [], quota: { callTimeoutMs: 300 } },
    entry: file,
  });
  try {
    await sandbox.start();
    await assert.rejects(() => sandbox.getTools().call('slow', {}), /超时/, '慢工具应按 manifest.quota.callTimeoutMs 被拒绝');
  } finally {
    sandbox.stop();
  }
});

test('配额 maxCallsPerRun：沙箱调用计数超限拒绝（worker 形态）', async () => {
  const file = join(dir, 'quota-calls.cjs');
  writeFileSync(file, `
exports.setup = async function setup(ctx) {
  ctx.tools.register('ping', 'ping 工具', { type: 'object', properties: {} }, () => 'pong');
};`, 'utf8');
  const sandbox = new WorkerToolsSandbox({
    manifest: { id: 'wp-quota2', version: '1.0.0', capabilities: [], quota: { maxCallsPerRun: 2 } },
    entry: file,
  });
  try {
    await sandbox.start();
    assert.strictEqual(await sandbox.getTools().call('ping', {}), 'pong', '第 1 次调用应成功');
    assert.strictEqual(await sandbox.getTools().call('ping', {}), 'pong', '第 2 次调用应成功');
    await assert.rejects(() => sandbox.getTools().call('ping', {}), /调用次数超限/, '第 3 次应被配额拒绝');
  } finally {
    sandbox.stop();
  }
});

test('load-error fail-fast：入口缺 setup → start() 抛错', async () => {
  const file = join(dir, 'bad.cjs');
  writeFileSync(file, 'exports.nothing = 1;', 'utf8');
  const sandbox = new WorkerToolsSandbox({
    manifest: { id: 'wp-bad', version: '1.0.0', capabilities: [] },
    entry: file,
  });
  await assert.rejects(() => sandbox.start(), /setup|加载失败/);
  sandbox.stop();
});

test('loader 集成：entry + isolation=local → enable 自动沙箱 + 前缀合并 + disable 终止', async () => {
  const entry = writeEntry('loader-plug');
  const loader = new PluginLoader({ registry: new AgentRegistry(new VolatileAgentStore()) });
  await loader.install({
    id: 'wp-plug',
    version: '1.0.0',
    name: 'Worker Plugin',
    capabilities: [{ id: 'echo', inputSchema: { type: 'object' } }],
    entry,
    isolation: 'local',
  });
  await loader.enable('wp-plug');
  // 合并进进程共享插件工具表（wp-plug__echo）
  const shared = getPluginToolRegistry();
  assert.equal(shared.has('wp-plug__echo'), true, '沙箱工具应按前缀合并进共享表');
  const out = (await shared.call('wp-plug__echo', { text: 'yo' }));
  assert.equal(out.echoed, 'YO');
  // disable → worker 终止 → 调用拒绝
  await loader.disable('wp-plug');
  await assert.rejects(() => shared.call('wp-plug__echo', { text: 'x' }), /worker|Unknown tool|已停止/);
});

after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows worker 句柄延迟释放 */ }
});
