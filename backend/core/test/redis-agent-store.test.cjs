// 零依赖测试（node:test + node:assert）：覆盖 P2 投产 Gap 1 —— RedisAgentStore 后端
// 与 createAgentStoreFromEnv 工厂。用内存 FakeRedis 注入最小 AgentStoreRedis 契约，
// 不依赖真实 Redis 服务即可验证「多副本共享 + 重启不丢」的后端逻辑。
//
// 直接 require 编译后的叶子模块（../dist/agents/index.js），避免引入额外运行时依赖。

const test = require('node:test');
const assert = require('node:assert');

const agents = require('../dist/agents/index.js');
const {
  RedisAgentStore,
  createAgentStoreFromEnv,
  VolatileAgentStore,
} = agents;

/**
 * 最小内存版 AgentStoreRedis（契合 ioredis 行为：hgetall 空 hash 返回 {}）。
 * 仅实现 store.ts 契约要求的 hset / hget / hdel / hgetall 四个 Hash 命令。
 */
class FakeRedis {
  constructor() {
    /** @type {Map<string, Map<string, string>>} */
    this.hash = new Map();
  }
  async hset(key, field, value) {
    if (!this.hash.has(key)) this.hash.set(key, new Map());
    this.hash.get(key).set(field, value);
    return 1;
  }
  async hget(key, field) {
    const m = this.hash.get(key);
    if (!m || !m.has(field)) return null;
    return m.get(field);
  }
  async hdel(key, ...fields) {
    const m = this.hash.get(key);
    if (!m) return 0;
    let n = 0;
    for (const f of fields) if (m.delete(f)) n += 1;
    return n;
  }
  async hgetall(key) {
    const m = this.hash.get(key);
    if (!m) return {};
    const out = {};
    for (const [f, v] of m) out[f] = v;
    return out;
  }
}

function makeCard(over = {}) {
  return {
    id: over.id || 'r1',
    name: over.name || 'Redis Agent',
    domain: over.domain || 'finance',
    capabilities: over.capabilities || [{ id: 'risk' }],
    transport: 'local',
    version: '1.0.0',
    health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
    ...over,
  };
}

test('RedisAgentStore：register/get/list 往返一致', async () => {
  const redis = new FakeRedis();
  const store = new RedisAgentStore({ client: redis });
  assert.strictEqual(store.kind, 'redis');

  await store.register(makeCard({ id: 'fin1', domain: 'finance', capabilities: [{ id: 'risk' }] }));
  await store.register(makeCard({ id: 'med1', domain: 'healthcare', capabilities: [{ id: 'triage' }] }));

  const got = await store.get('fin1');
  assert.ok(got);
  assert.strictEqual(got.id, 'fin1');
  assert.strictEqual(got.domain, 'finance');

  const all = await store.list();
  assert.strictEqual(all.length, 2);

  // 底层落到单个 hash key（默认 agent-harness:agents），多副本共享同一 Redis 即一致。
  const raw = await redis.hget('agent-harness:agents', 'fin1');
  assert.ok(raw && JSON.parse(raw).id === 'fin1');
});

test('RedisAgentStore：heartbeat 刷新健康度并持久化', async () => {
  const store = new RedisAgentStore({ client: new FakeRedis() });
  await store.register(makeCard({ id: 'fin1' }));
  const before = (await store.get('fin1')).health.lastHeartbeat;
  await new Promise((r) => setTimeout(r, 5));
  await store.heartbeat('fin1', { status: 'degraded', load: 0.5 });
  const after = (await store.get('fin1')).health;
  assert.ok(after.lastHeartbeat >= before);
  assert.strictEqual(after.status, 'degraded');
  assert.strictEqual(after.load, 0.5);
});

test('RedisAgentStore：deregister 移除记录（HDEL）', async () => {
  const redis = new FakeRedis();
  const store = new RedisAgentStore({ client: redis });
  await store.register(makeCard({ id: 'fin1' }));
  await store.deregister('fin1');
  assert.strictEqual(await store.get('fin1'), null);
  assert.strictEqual(Object.keys(await redis.hgetall('agent-harness:agents')).length, 0);
});

test('RedisAgentStore：query 按 domain / capability 过滤', async () => {
  const store = new RedisAgentStore({ client: new FakeRedis() });
  await store.register(makeCard({ id: 'fin1', domain: 'finance', capabilities: [{ id: 'risk' }, { id: 'report' }] }));
  await store.register(makeCard({ id: 'med1', domain: 'healthcare', capabilities: [{ id: 'triage' }] }));

  const finance = await store.query({ domain: 'finance' });
  assert.strictEqual(finance.length, 1);
  assert.strictEqual(finance[0].id, 'fin1');

  const riskOnly = await store.query({ capability: 'risk' });
  assert.strictEqual(riskOnly.length, 1);
  assert.strictEqual(riskOnly[0].id, 'fin1');

  const none = await store.query({ domain: 'healthcare', capability: 'risk' });
  assert.strictEqual(none.length, 0);
});

test('createAgentStoreFromEnv：AGENT_STORE=redis 注入 client → RedisAgentStore', () => {
  const store = createAgentStoreFromEnv({ AGENT_STORE: 'redis' }, new FakeRedis());
  assert.strictEqual(store.kind, 'redis');
});

test('createAgentStoreFromEnv：声明 redis 却未注入 client → 降级 Volatile（一切降级可用）', () => {
  const store = createAgentStoreFromEnv({ AGENT_STORE: 'redis' }, null);
  assert.strictEqual(store.kind, 'volatile');
});

test('createAgentStoreFromEnv：缺省 / 无法识别 → Volatile（内存态，向后兼容）', () => {
  assert.strictEqual(createAgentStoreFromEnv({}, null).kind, 'volatile');
  assert.strictEqual(createAgentStoreFromEnv({ AGENT_STORE: 'bogus' }, null).kind, 'volatile');
});

test('createAgentStoreFromEnv：AGENT_STORE=sqlite / file 优先于注入的 redis', () => {
  const sqlite = createAgentStoreFromEnv(
    { AGENT_STORE: 'sqlite', AGENT_STORE_SQLITE_FILE: './.tmp-store-test/agents.sqlite' },
    new FakeRedis()
  );
  assert.strictEqual(sqlite.kind, 'sqlite');
  const file = createAgentStoreFromEnv(
    { AGENT_STORE: 'file', AGENT_STORE_DIR: './.tmp-store-test' },
    new FakeRedis()
  );
  assert.strictEqual(file.kind, 'file');
});

test('FakeRedis 可跨两个 store 实例共享（模拟多副本共享同一 Redis）', async () => {
  const shared = new FakeRedis();
  const a = new RedisAgentStore({ client: shared });
  const b = new RedisAgentStore({ client: shared });
  await a.register(makeCard({ id: 'shared1', domain: 'finance' }));
  // 第二个实例（模拟另一个副本）立即可见 → 多副本共享 + 重启不丢的语义。
  const seen = await b.get('shared1');
  assert.ok(seen && seen.id === 'shared1');
});

void VolatileAgentStore;
