// 零依赖测试（node:test + node:assert）：覆盖 P2.b 插件市场（签名校验 + 远程 registry 客户端 + 安装）。
// 关注：HMAC 签名/验签（篡改/错密钥失败）、mock fetch 拉取 index/get、版本解析、
// loader.installFromRegistry 验签通过/失败、autoEnable 带 domain/isolation 注册 AgentCard。

const test = require('node:test');
const assert = require('node:assert');

const sig = require('../dist/plugin/signature.js');
const reg = require('../dist/plugin/registry.js');
const { PluginLoader } = require('../dist/plugin/index.js');
const { AgentRegistry } = require('../dist/agents/registry.js');
const { VolatileAgentStore } = require('../dist/agents/store.js');

const SECRET = 'shared-signing-secret';

function sampleManifest(over = {}) {
  return {
    id: 'weather-plugin',
    version: '1.2.0',
    name: 'Weather Plugin',
    capabilities: [{ id: 'weather.forecast' }],
    dependencies: [],
    permissions: ['net:egress'],
    transport: 'local',
    domain: 'finance',
    isolation: 'os',
    ...over,
  };
}

test('signature：HMAC 签名可被同密钥验签通过', () => {
  const m = sampleManifest();
  const s = sig.signManifest(m, SECRET);
  assert.strictEqual(sig.verifyManifest(m, s, SECRET, 'hmac'), true);
});

test('signature：清单被篡改 / 错密钥 → 验签失败', () => {
  const m = sampleManifest();
  const s = sig.signManifest(m, SECRET);
  const tampered = { ...m, version: '9.9.9' };
  assert.strictEqual(sig.verifyManifest(tampered, s, SECRET, 'hmac'), false);
  assert.strictEqual(sig.verifyManifest(m, s, 'wrong-secret', 'hmac'), false);
  assert.strictEqual(sig.verifyManifest(m, 'deadbeef', SECRET, 'hmac'), false);
});

test('PluginRegistryClient：index / get / resolveVersion（mock fetch）', async () => {
  const entries = [
    { id: 'p', version: '1.0.0', manifest: sampleManifest({ id: 'p', version: '1.0.0' }) },
    { id: 'p', version: '1.5.0', manifest: sampleManifest({ id: 'p', version: '1.5.0' }) },
    { id: 'p', version: '2.0.0', manifest: sampleManifest({ id: 'p', version: '2.0.0' }) },
  ];
  const fetchMock = async (url) => {
    const u = String(url);
    if (u.endsWith('/plugins/p')) return { ok: true, json: async () => entries[2] };
    if (u.endsWith('/plugins/p/1.0.0')) return { ok: true, json: async () => entries[0] };
    return { ok: true, json: async () => ({ plugins: entries }) };
  };
  const client = new reg.PluginRegistryClient(fetchMock);
  const idx = await client.index('https://registry.example.com');
  assert.strictEqual(idx.length, 3);
  const latest = await client.get('https://registry.example.com', 'p');
  assert.strictEqual(latest.version, '2.0.0');
  const specific = await client.get('https://registry.example.com', 'p', '1.0.0');
  assert.strictEqual(specific.version, '1.0.0');
  assert.strictEqual(client.resolveVersion(entries).version, '2.0.0');
  assert.strictEqual(client.resolveVersion(entries, '^1').version, '1.5.0');
  assert.strictEqual(client.resolveVersion(entries, '1.0.0').version, '1.0.0');
});

test('PluginRegistryClient：HTTP 非 2xx → 抛错', async () => {
  const fetchMock = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const client = new reg.PluginRegistryClient(fetchMock);
  await assert.rejects(() => client.index('https://x'));
});

test('PluginLoader.installFromRegistry：验签通过安装 + autoEnable 带 domain/isolation 注册', async () => {
  const m = sampleManifest();
  const entry = { id: m.id, version: m.version, manifest: m, signature: sig.signManifest(m, SECRET) };
  const fetchMock = async () => ({ ok: true, json: async () => entry });
  const client = new reg.PluginRegistryClient(fetchMock);
  const registry = new AgentRegistry(new VolatileAgentStore());
  const loader = new PluginLoader({ registry });
  const rec = await loader.installFromRegistry(client, 'https://registry', m.id, undefined, {
    verifySecret: SECRET,
    autoEnable: true,
  });
  assert.strictEqual(rec.state, 'enabled');
  const card = await registry.get(m.id);
  assert.ok(card, 'agent card should be registered');
  assert.strictEqual(card.domain, 'finance');
  assert.strictEqual(card.isolation, 'os');
});

test('PluginLoader.installFromRegistry：验签失败 → 拒绝安装', async () => {
  const m = sampleManifest();
  const entry = { id: m.id, version: m.version, manifest: m, signature: 'forged-signature' };
  const fetchMock = async () => ({ ok: true, json: async () => entry });
  const client = new reg.PluginRegistryClient(fetchMock);
  const loader = new PluginLoader({ registry: new AgentRegistry(new VolatileAgentStore()) });
  await assert.rejects(
    () => loader.installFromRegistry(client, 'https://registry', m.id, undefined, { verifySecret: SECRET }),
    /signature verification failed/
  );
  assert.strictEqual(loader.get(m.id), undefined);
});
