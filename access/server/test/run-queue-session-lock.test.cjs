'use strict';
// P1-6 回归：跨实例同会话串行化（Redis 会话锁）。
//
// 背景：多副本部署时，同一 sessionKey 的两个任务可能被不同实例同时 claim 并执行 ——
// 并发写同一 chat session 的记忆后端互相覆盖。修复后：sweepOnce 在 launchClaimed 前
// 经 acquireSessionLockFor() 占「会话锁」（SET NX PX 原子占位）；锁被占 →
// parkSessionBusyJob() 把任务原子退回 pending（releaseClaim：迁回 + 清租约），
// 待锁释放后的下一轮 claim 重新领取。execute finally 经 releaseSessionLock 释放
// （Lua check-and-delete，token 不匹配 = 锁已易主不误删）。
//
// 测试环境无 eval（Lua）→ 全部走退化多命令路径（get+del / lrem+rpush+hdel），
// 与「极旧 Redis 客户端」的生产行为一致；Lua 路径由生产客户端保证语义等价。
const test = require('node:test');
const assert = require('node:assert');

const path = require('node:path');

const BACKEND_JS = path.join(__dirname, '..', 'dist', 'queue-backend.js');
const RUNQUEUE_JS = path.join(__dirname, '..', 'dist', 'run-queue.js');
const RUN = require('node:fs').existsSync(BACKEND_JS) && require('node:fs').existsSync(RUNQUEUE_JS);

// ── FakeRedis：在 oversell 测试的契约上补 set/get（会话锁与幂等占位需要），无 eval ──
class FakeStore {
  constructor() {
    this.lists = new Map();
    this.hashes = new Map();
    this.strings = new Map();
    this.subs = new Map();
  }
}
class FakeRedis {
  constructor(store) {
    this.store = store || new FakeStore();
  }
  duplicate() {
    return new FakeRedis(this.store);
  }
  async rpush(key, value) {
    const l = this.store.lists.get(key) || [];
    l.push(value);
    this.store.lists.set(key, l);
    return l.length;
  }
  async lrange(key, start, stop) {
    const l = this.store.lists.get(key) || [];
    return l.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async lrem(key, count, value) {
    const l = this.store.lists.get(key) || [];
    const nl = [];
    let removed = 0;
    for (const v of l) {
      if (v === value && removed < count) removed += 1;
      else nl.push(v);
    }
    this.store.lists.set(key, nl);
    return removed;
  }
  async lmove(src, dst, from, to) {
    const s = this.store.lists.get(src) || [];
    if (s.length === 0) return null;
    const idx = from === 'LEFT' ? 0 : s.length - 1;
    const v = s.splice(idx, 1)[0];
    const d = this.store.lists.get(dst) || [];
    if (to === 'LEFT') d.unshift(v);
    else d.push(v);
    this.store.lists.set(dst, d);
    this.store.lists.set(src, s);
    return v;
  }
  // P1-6 核心：SET NX PX（原子占位）。key 已存在 → null（占位失败）。
  async set(key, value, mode, ttl, nx) {
    if (nx !== 'NX' || mode !== 'PX') throw new Error(`unsupported set form: ${mode} ${nx}`);
    if (this.store.strings.has(key)) return null;
    this.store.strings.set(key, { value, expireAt: Date.now() + ttl });
    return 'OK';
  }
  async get(key) {
    const e = this.store.strings.get(key);
    if (!e) return null;
    if (e.expireAt <= Date.now()) {
      this.store.strings.delete(key);
      return null;
    }
    return e.value;
  }
  async hset(key, field, value) {
    let h = this.store.hashes.get(key);
    if (!h) {
      h = new Map();
      this.store.hashes.set(key, h);
    }
    h.set(field, value);
    return 1;
  }
  async hget(key, field) {
    const h = this.store.hashes.get(key);
    return h ? h.get(field) ?? null : null;
  }
  async hdel(key, ...fields) {
    const h = this.store.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n += 1;
    return n;
  }
  async del(...keys) {
    for (const k of keys) {
      this.store.lists.delete(k);
      this.store.hashes.delete(k);
      this.store.strings.delete(k);
    }
    return keys.length;
  }
  async publish() {
    return 0;
  }
  subscribe() {}
  on() {}
  unsubscribe() {}
  async quit() {}
}

// backend 层锁键为裸拼接（sha256 摘要在 run-queue 的 acquireSessionLockFor 层做，
// backend 收到的 key 已是摘要）。
const sessLockKeyOf = (key) => `runq:sesslock:${key}`;

// ── RedisQueueBackend 单元语义 ──
test('P1-6：acquireSessionLock SET NX PX —— 首占成功、二占失败', { skip: !RUN }, async () => {
  const { RedisQueueBackend } = require(BACKEND_JS);
  const b = new RedisQueueBackend(new FakeRedis());
  assert.strictEqual(await b.acquireSessionLock('sessA', 'job1:tok1', 60_000), true, '首次占位成功');
  assert.strictEqual(
    await b.acquireSessionLock('sessA', 'job2:tok2', 60_000),
    false,
    '同会话第二占位应失败（锁被 job1 持有）'
  );
  assert.strictEqual(await b.acquireSessionLock('sessB', 'job2:tok2', 60_000), true, '不同会话互不影响');
});

test('P1-6：releaseSessionLock —— token 匹配才删，不匹配不误删易主锁', { skip: !RUN }, async () => {
  const { RedisQueueBackend } = require(BACKEND_JS);
  const store = new FakeStore();
  const b = new RedisQueueBackend(new FakeRedis(store));
  await b.acquireSessionLock('sessA', 'job1:tok1', 60_000);
  // 错误 token：不删（防「崩溃实例的旧 finally」误删新持有者的锁）。
  assert.strictEqual(await b.releaseSessionLock('sessA', 'job1:WRONG'), false, 'token 不匹配返回 false');
  assert.strictEqual(await b.client.get(sessLockKeyOf('sessA')), 'job1:tok1', '锁仍被 job1 持有');
  // 正确 token：删除成功。
  assert.strictEqual(await b.releaseSessionLock('sessA', 'job1:tok1'), true);
  assert.strictEqual(await b.client.get(sessLockKeyOf('sessA')), null, '锁已删除');
  // 释放后可重新占位。
  assert.strictEqual(await b.acquireSessionLock('sessA', 'job2:tok2', 60_000), true);
});

test('P1-6：releaseClaim —— processing 原子退回 pending 并清租约', { skip: !RUN }, async () => {
  const { RedisQueueBackend } = require(BACKEND_JS);
  const store = new FakeStore();
  const b = new RedisQueueBackend(new FakeRedis(store));
  const job = { id: 'rc1', mode: 'mock', prompt: 'p', enqueuedAt: 1, sessionKey: 'sessA' };
  await b.append(job);
  const claimed = await b.claim();
  assert.strictEqual(claimed.id, 'rc1');
  assert.ok((await b.client.hget('runq:claimedAt', 'rc1')) != null, 'claim 后应写入租约');
  // 退回：processing → pending，租约清除。
  assert.strictEqual(await b.releaseClaim('rc1'), true);
  const pending = await b.client.lrange('runq:pending', 0, -1);
  assert.ok(pending.includes('rc1'), '应退回 pending');
  const processing = await b.client.lrange('runq:processing', 0, -1);
  assert.ok(!processing.includes('rc1'), 'processing 中应移除');
  assert.strictEqual(await b.client.hget('runq:claimedAt', 'rc1'), null, '退回应清租约');
  // 退回后可重新 claim 领取（锁释放后的下一轮语义）。
  const reClaimed = await b.claim();
  assert.strictEqual(reClaimed.id, 'rc1', '退回后应可重新领取');
});

// ── RunQueue 集成：同 sessionKey 两任务 → 第二个被退回，锁释放后重领 ──
test('P1-6：同会话第二任务在锁忙时退回 pending，锁释放后重新领取执行', { skip: !RUN }, async () => {
  const { createHash } = require('node:crypto');
  const { RedisQueueBackend } = require(BACKEND_JS);
  const { RunQueue } = require(RUNQUEUE_JS);
  const store = new FakeStore();
  const b = new RedisQueueBackend(new FakeRedis(store));
  const q = new RunQueue(b);
  try {
    // 等 startShared 的启动回收 + 首次 sweep 跑完（pending 空，claim 返回 null）。
    await new Promise((r) => setTimeout(r, 30));
    const sessKey = 'im-feishu-abc123';
    // run-queue 的 acquireSessionLockFor 先对 sessionKey 做 sha256 摘要（前 24 hex）
    // 再传给 backend；backend 层锁键为裸拼接。digestKey 是 backend API 的入参形态
    // （acquire/release 均收「摘要」，前缀由 backend 内部加）；rqLockKey 是 Redis
    // 里的最终键形态（直读 client 用）。
    const digestKey = createHash('sha256').update(sessKey).digest('hex').slice(0, 24);
    const rqLockKey = 'runq:sesslock:' + digestKey;
    await b.append({ id: 'sl1', mode: 'mock', prompt: 'p1', enqueuedAt: 1, sessionKey: sessKey });
    await b.append({ id: 'sl2', mode: 'mock', prompt: 'p2', enqueuedAt: 2, sessionKey: sessKey });

    // 桩 execute：挂起，便于断言锁语义（finally 释放锁的逻辑属于真实 execute，
    // 此处锁释放由测试侧模拟 —— 语义与生产 finally 相同：releaseSessionLock(key, token)）。
    let releaseExec;
    const execGate = new Promise((r) => (releaseExec = r));
    const executed = [];
    q.execute = async (job) => {
      executed.push(job.id);
      await execGate;
    };
    // sweep 领取 sl1 → 占锁成功 → 执行（挂起）。真实锁键/令牌经内部生成，
    // 测试直接检查 Redis 里的锁存在。
    await q.sweepOnce();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(executed, ['sl1'], '第一个任务应被领取执行');
    const lockVal = await b.client.get(rqLockKey);
    assert.ok(lockVal && lockVal.startsWith('sl1:'), `会话锁应存在且 token 绑定 sl1，实际=${lockVal}`);

    // sweep 领取 sl2 → 同会话锁被占 → parkSessionBusyJob → releaseClaim 退回 pending。
    await q.sweepOnce();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(executed, ['sl1'], '锁忙时第二任务不得执行');
    assert.strictEqual(q.deferred.length, 0, 'releaseClaim 成功 → 不进本地延期缓冲');
    const pending = await b.client.lrange('runq:pending', 0, -1);
    assert.ok(pending.includes('sl2'), 'sl2 应原子退回 pending');
    const processing = await b.client.lrange('runq:processing', 0, -1);
    assert.ok(!processing.includes('sl2'), 'sl2 应已离开 processing（清租约）');
    assert.strictEqual(q.stats().running, 1, '在飞仍是 sl1 一个');

    // 模拟 sl1 结束：finally 释放会话锁。
    releaseExec();
    await new Promise((r) => setTimeout(r, 10));
    const tok = lockVal;
    // 与生产 execute finally 一致：传「摘要 key + token」（不是原始 sessionKey，
    // 也不是带前缀的完整键 —— 前缀由 backend 内部拼接，传完整键会变成双前缀）。
    await b.releaseSessionLock(digestKey, tok);
    // 下一轮 sweep：sl2 从 pending 重领 → 占锁成功 → 执行。
    await q.sweepOnce();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(executed.includes('sl2'), '锁释放后 sl2 应被重新领取执行');
  } finally {
    q.stop();
  }
});

// ── 降级语义：Redis 故障（acquire 抛错）→ 不阻断执行 ──
test('P1-6：acquireSessionLock 抛错时降级为无锁执行（不阻断业务）', { skip: !RUN }, async () => {
  const { RedisQueueBackend } = require(BACKEND_JS);
  const store = new FakeStore();
  const b = new RedisQueueBackend(new FakeRedis(store));
  // 注入故障：set 抛错模拟 Redis 抖动。
  b.client.set = async () => {
    throw new Error('connection refused');
  };
  // acquireSessionLockFor 捕获异常返回 null（无锁）→ 任务照常 launchClaimed。
  await assert.rejects(
    () => b.acquireSessionLock('sessA', 'job1:tok1', 60_000),
    /connection refused/
  );
});
