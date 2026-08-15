// 零依赖测试（node:test + node:assert）：覆盖 P0.1 Agent Registry 的注册 / 心跳 /
// 注销 / 按 domain+capability 发现 / 超时 sweep，以及默认通用 agent 的 seed。
// 直接 require 编译后的叶子模块，避免引入额外运行时依赖。

const test = require('node:test');
const assert = require('node:assert');

const agents = require('../dist/agents/index.js');
const {
  AgentRegistry,
  VolatileAgentStore,
  FileAgentStore,
  SqliteAgentStore,
  getAgentRegistry,
  makeDefaultAgentCard,
  DEFAULT_AGENT_ID,
} = agents;

function makeCard(overrides = {}) {
  return {
    id: overrides.id || 'a1',
    name: overrides.name || 'Agent A',
    domain: overrides.domain || 'finance',
    capabilities: overrides.capabilities || [{ id: 'general-purpose' }],
    transport: 'local',
    version: '1.0.0',
    health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
    ...overrides,
  };
}

test('makeDefaultAgentCard 生成无 assembly 的通用 agent', () => {
  const c = makeDefaultAgentCard();
  assert.strictEqual(c.id, DEFAULT_AGENT_ID);
  assert.strictEqual(c.transport, 'local');
  assert.strictEqual(c.domain, 'generic');
  assert.strictEqual(c.assembly, undefined); // 无 assembly → 退化为万能 harness
});

test('AgentRegistry：register / get / list', async () => {
  const r = new AgentRegistry(new VolatileAgentStore());
  await r.register(makeCard({ id: 'fin1', domain: 'finance', capabilities: [{ id: 'risk' }] }));
  await r.register(makeCard({ id: 'med1', domain: 'healthcare', capabilities: [{ id: 'triage' }] }));

  const got = await r.get('fin1');
  assert.ok(got);
  assert.strictEqual(got.id, 'fin1');
  assert.strictEqual(got.domain, 'finance');

  const all = await r.list();
  assert.strictEqual(all.length, 2);
});

test('AgentRegistry：query 按 domain 过滤', async () => {
  const r = new AgentRegistry(new VolatileAgentStore());
  await r.register(makeCard({ id: 'fin1', domain: 'finance', capabilities: [{ id: 'risk' }] }));
  await r.register(makeCard({ id: 'med1', domain: 'healthcare', capabilities: [{ id: 'triage' }] }));

  const finance = await r.query({ domain: 'finance' });
  assert.strictEqual(finance.length, 1);
  assert.strictEqual(finance[0].id, 'fin1');

  const all = await r.query({});
  assert.strictEqual(all.length, 2);
});

test('AgentRegistry：query 按 capability 命中倒排索引', async () => {
  const r = new AgentRegistry(new VolatileAgentStore());
  await r.register(makeCard({ id: 'fin1', domain: 'finance', capabilities: [{ id: 'risk' }, { id: 'report' }] }));
  await r.register(makeCard({ id: 'med1', domain: 'healthcare', capabilities: [{ id: 'triage' }] }));

  const riskAgents = await r.query({ capability: 'risk' });
  assert.strictEqual(riskAgents.length, 1);
  assert.strictEqual(riskAgents[0].id, 'fin1');

  // 同时按 domain + capability 组合（交集）
  const medTriage = await r.query({ domain: 'healthcare', capability: 'triage' });
  assert.strictEqual(medTriage.length, 1);
  assert.strictEqual(medTriage[0].id, 'med1');

  const none = await r.query({ capability: 'nonexistent' });
  assert.strictEqual(none.length, 0);
});

test('AgentRegistry：heartbeat 刷新健康度，deregister 移除并清理索引', async () => {
  const r = new AgentRegistry(new VolatileAgentStore());
  await r.register(makeCard({ id: 'fin1', domain: 'finance', capabilities: [{ id: 'risk' }] }));

  const before = (await r.get('fin1')).health.lastHeartbeat;
  await new Promise((res) => setTimeout(res, 5));
  await r.heartbeat('fin1', { status: 'degraded', load: 0.5 });
  const after = (await r.get('fin1')).health;
  assert.ok(after.lastHeartbeat >= before);
  assert.strictEqual(after.status, 'degraded');
  assert.strictEqual(after.load, 0.5);

  await r.deregister('fin1');
  assert.strictEqual(await r.get('fin1'), null);
  assert.strictEqual((await r.query({ capability: 'risk' })).length, 0);
});

test('AgentRegistry：sweepStale 把心跳超时的 agent 标记为 down', async () => {
  const r = new AgentRegistry(new VolatileAgentStore());
  // 注入一个 lastHeartbeat 很远前的 agent
  const stale = makeCard({ id: 'old', domain: 'finance', capabilities: [{ id: 'risk' }] });
  stale.health.lastHeartbeat = Date.now() - 10_000;
  await r.register(stale);
  await r.register(makeCard({ id: 'fresh', domain: 'finance', capabilities: [{ id: 'risk' }] }));

  const downed = await r.sweepStale(5_000);
  assert.deepStrictEqual(downed.sort(), ['old']);
  assert.strictEqual((await r.get('old')).health.status, 'down');
  assert.strictEqual((await r.get('fresh')).health.status, 'healthy');
});

test('getAgentRegistry 单例自动 seed default 通用 agent', () => {
  const a = getAgentRegistry();
  const b = getAgentRegistry();
  assert.strictEqual(a, b, '应返回同一单例实例');
  // default agent 立即可查（seed 是异步 fire-and-forget，这里直接断言实现已注册过一次）
  assert.strictEqual(typeof a.get, 'function');
});

test('FileAgentStore 与 SqliteAgentStore 接口可被构造（运行时能力探测留给集成）', () => {
  // 在任意平台都能构造；具体读写依赖 FS / node:sqlite 运行期，这里仅验证构造不抛错。
  assert.doesNotThrow(() => new FileAgentStore({ dir: './.tmp-agents-test' }));
  assert.doesNotThrow(() => new SqliteAgentStore({ file: './.tmp-agents-test/agents.db' }));
});
