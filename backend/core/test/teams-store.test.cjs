// 零依赖测试（node:test + node:assert）：覆盖评审 R5 —— TeamStore 双后端
// （Memory / Redis）与 createTeamStoreFromEnv 工厂。用内存 FakeRedis 注入最小
// TeamStoreRedis 契约，不依赖真实 Redis 服务即可验证「多副本共享 + 重启不丢」。
//
// 直接 require 编译后的叶子模块（../dist/teams/...），与 redis-agent-store.test.cjs 同范式。

const test = require('node:test');
const assert = require('node:assert');

const {
  MemoryTeamStore,
  RedisTeamStore,
  createTeamStoreFromEnv,
  TeamManager
} = require('../dist/teams/index.js');

/** 最小内存版 TeamStoreRedis（Hash + INCR，契合 ioredis 行为）。 */
class FakeRedis {
  constructor() {
    this.hash = new Map();
    this.counters = new Map();
  }
  async hset(key, field, value) {
    if (!this.hash.has(key)) this.hash.set(key, new Map());
    this.hash.get(key).set(field, value);
    return 1;
  }
  async hget(key, field) {
    const m = this.hash.get(key);
    return m && m.has(field) ? m.get(field) : null;
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
  async incr(key) {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }
}

function makeCard(id) {
  return {
    id,
    name: id,
    domain: 'generic',
    capabilities: [],
    transport: 'local',
    version: '1.0.0',
    health: 'healthy'
  };
}

function fakeRegistry(cards) {
  const map = new Map(cards.map((c) => [c.id, c]));
  return { get: async (id) => map.get(id) ?? null };
}

function makeTeam(id, over = {}) {
  return {
    id,
    name: `T-${id}`,
    members: ['a', 'b'],
    mode: 'round-robin',
    ...over
  };
}

// ── MemoryTeamStore ──

test('MemoryTeamStore：save/get/list/remove 与计数器基本语义', async () => {
  const s = new MemoryTeamStore();
  assert.strictEqual(await s.get('t1'), null);
  await s.save(makeTeam('t1', { onMemberJoin: () => {} }));
  const got = await s.get('t1');
  assert.strictEqual(got.id, 't1');
  // 内存实现保存原始引用（含钩子）；持久化语义由 Redis 实现负责剥离。
  assert.strictEqual(typeof got.onMemberJoin, 'function');
  await s.save(makeTeam('t2'));
  assert.deepStrictEqual((await s.list()).map((t) => t.id).sort(), ['t1', 't2']);
  await s.remove('t1');
  assert.strictEqual(await s.get('t1'), null);
  assert.deepStrictEqual((await s.list()).map((t) => t.id), ['t2']);
});

test('MemoryTeamStore：计数器自增 1,2,3；remove 后计数归零', async () => {
  const s = new MemoryTeamStore();
  assert.strictEqual(await s.incrCounter('t'), 1);
  assert.strictEqual(await s.incrCounter('t'), 2);
  assert.strictEqual(await s.incrCounter('t'), 3);
  await s.remove('t');
  assert.strictEqual(await s.incrCounter('t'), 1);
});

// ── RedisTeamStore（FakeRedis 注入） ──

test('RedisTeamStore：save/get 往返——生命周期钩子被剥离（不可序列化），数据字段完整', async () => {
  const redis = new FakeRedis();
  const s = new RedisTeamStore({ client: redis });
  let joined = [];
  await s.save(
    makeTeam('t1', {
      leader: 'a',
      weights: { a: 2 },
      onMemberJoin: (id) => joined.push(id)
    })
  );
  const got = await s.get('t1');
  assert.strictEqual(got.id, 't1');
  assert.strictEqual(got.leader, 'a');
  assert.deepStrictEqual(got.weights, { a: 2 });
  assert.strictEqual(got.onMemberJoin, undefined, '钩子经 JSON 往返必须消失');
  assert.deepStrictEqual(joined, [], 'save 本身不触发钩子（钩子属 register 行为）');
});

test('RedisTeamStore：list / remove；损坏条目跳过不拖垮整表', async () => {
  const redis = new FakeRedis();
  const s = new RedisTeamStore({ client: redis });
  await s.save(makeTeam('t1'));
  await s.save(makeTeam('t2'));
  // 手工塞入坏 JSON（模拟脏数据 / 部分写）。
  await redis.hset('agent-harness:teams', 'bad', '{not-json');
  const list = await s.list();
  assert.deepStrictEqual(list.map((t) => t.id).sort(), ['t1', 't2'], '坏条目必须被跳过');
  assert.strictEqual(await s.get('bad'), null);
  await s.remove('t1');
  assert.deepStrictEqual((await s.list()).map((t) => t.id), ['t2']);
});

test('RedisTeamStore：计数器 INCR 原子自增（1,2,3…）', async () => {
  const redis = new FakeRedis();
  const s = new RedisTeamStore({ client: redis });
  assert.strictEqual(await s.incrCounter('t'), 1);
  assert.strictEqual(await s.incrCounter('t'), 2);
  assert.strictEqual(await s.incrCounter('t'), 3);
});

// ── createTeamStoreFromEnv 工厂 ──

test('createTeamStoreFromEnv：五条分支语义', () => {
  const redis = new FakeRedis();
  // 显式 redis + client → redis
  assert.strictEqual(
    createTeamStoreFromEnv({ TEAM_STORE: 'redis' }, redis).kind,
    'redis'
  );
  // 显式 redis 无 client → 回退内存
  assert.strictEqual(
    createTeamStoreFromEnv({ TEAM_STORE: 'redis' }, null).kind,
    'memory'
  );
  // 缺省跟随 AGENT_STORE=redis + client → redis（多副本零配置即正确）
  assert.strictEqual(
    createTeamStoreFromEnv({ AGENT_STORE: 'redis' }, redis).kind,
    'redis'
  );
  // 缺省 + AGENT_STORE 非 redis → memory
  assert.strictEqual(
    createTeamStoreFromEnv({ AGENT_STORE: 'sqlite' }, redis).kind,
    'memory'
  );
  // 显式 memory 优先于 AGENT_STORE=redis
  assert.strictEqual(
    createTeamStoreFromEnv({ TEAM_STORE: 'memory', AGENT_STORE: 'redis' }, redis).kind,
    'memory'
  );
});

// ── 跨实例共享语义（TeamManager × RedisTeamStore） ──

test('TeamManager × RedisTeamStore：两个实例共享注册表与轮次计数器（多副本/重启语义）', async () => {
  const redis = new FakeRedis();
  const store = new RedisTeamStore({ client: redis });
  const reg = fakeRegistry([makeCard('a'), makeCard('b')]);

  // 实例 A 注册团队（走成员校验 + 持久化）。
  const managerA = new TeamManager(reg, store);
  await managerA.register(makeTeam('t1'));

  // 实例 B（全新 manager，同一 store——等价「另一副本 / 重启后」）直接可见。
  const managerB = new TeamManager(reg, store);
  const got = await managerB.get('t1');
  assert.strictEqual(got.id, 't1', 'B 必须读到 A 注册的团队');
  assert.deepStrictEqual((await managerB.list()).map((t) => t.id), ['t1']);

  // round-robin 轮转跨实例共享：A 首轮选 a（计数 1 → 下标 0），B 次轮选 b（计数 2 → 下标 1）。
  const pickA = [];
  const pickB = [];
  await managerA.executeTask('t1', 'q', async (c) => {
    pickA.push(c.id);
    return c.id;
  });
  await managerB.executeTask('t1', 'q', async (c) => {
    pickB.push(c.id);
    return c.id;
  });
  assert.deepStrictEqual(pickA, ['a'], '计数 1 → 下标 0（与旧内存实现轮转次序一致）');
  assert.deepStrictEqual(pickB, ['b'], '计数 2 → 下标 1（跨实例共享轮转）');

  // B 注销后 A 同步不可见（共享存储单向写、双向可见）。
  await managerB.deregister('t1');
  assert.strictEqual(await managerA.get('t1'), null);
});

test('TeamManager：缺省构造仍是内存后端（零配置单实例行为不变）', async () => {
  const tm = new TeamManager(fakeRegistry([makeCard('a')]));
  await tm.register(makeTeam('mem1', { members: ['a'] }));
  const got = await tm.get('mem1');
  assert.strictEqual(got.id, 'mem1');
  assert.strictEqual(typeof got.onMemberJoin, 'undefined');
  await assert.rejects(() => tm.executeTask('ghost', 'q', async () => ''), /TeamNotFound/);
});
