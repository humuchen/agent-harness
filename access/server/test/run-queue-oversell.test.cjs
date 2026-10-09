'use strict';
// P0-2 回归：Redis 共享模式下 sweepOnce 的并发超卖竞态。
//
// 背景：sweepOnce 在 `await this.backend.claim()` 之前检查 `running >= concurrency`，
// 旧代码在 claim 返回后不复查直接 `running += 1`。sweepOnce 的触发源有三个
// （claimTimer 每 3s + submit 触发 + execute finally 触发），多路在飞时各自领取一单
// → 实际并发短暂超过 RUN_CONCURRENCY（超卖）。修复后：claim 返回 → 复查并发 →
// 超限进入本地延期缓冲（deferred），槽位释放时优先消化。
//
// 测试用桩 execute（挂起）制造「并发已满」场景，8 路并发 sweep 断言 running 不越界。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND_JS = path.join(__dirname, '..', 'dist', 'queue-backend.js');
const RUNQUEUE_JS = path.join(__dirname, '..', 'dist', 'run-queue.js');
const RUN = fs.existsSync(BACKEND_JS) && fs.existsSync(RUNQUEUE_JS);

// 最小 FakeRedis（同 queue-backend.test.cjs 契约：claim 走 lmove 退化路径即可）
class FakeStore {
  constructor() {
    this.lists = new Map();
    this.hashes = new Map();
    this.subs = new Map();
  }
}
class FakeRedis {
  constructor(store) {
    this.store = store || new FakeStore();
    this.messageHandler = null;
    this.subWrappers = new Map();
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
  async hmget(key, ...fields) {
    const h = this.store.hashes.get(key);
    return fields.map((f) => (h ? h.get(f) ?? null : null));
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

test('P0-2：多路并发 sweepOnce 不超过 RUN_CONCURRENCY，超限任务进入延期缓冲', { skip: !RUN }, async () => {
  const { RedisQueueBackend } = require(BACKEND_JS);
  const { RunQueue } = require(RUNQUEUE_JS);
  const store = new FakeStore();
  const b = new RedisQueueBackend(new FakeRedis(store));
  const q = new RunQueue(b);
  try {
    // 等 startShared 的启动回收 + 首次 sweep 跑完（此时 pending 为空，claim 返回 null），
    // 保证后续只有测试自己触发的 sweep 在领取——时序确定性。
    await new Promise((r) => setTimeout(r, 30));
    const TOTAL = 10; // > RUN_CONCURRENCY(4)，制造必然超限
    for (let i = 0; i < TOTAL; i++) {
      await b.append({ id: `ov${i}`, mode: 'mock', prompt: 'p', enqueuedAt: i });
    }
    // 桩掉 execute：挂起不结束 → running 稳定占据槽位，便于断言调度不变量。
    // launchClaimed 的 running 记账与 finally 释放逻辑照常生效。
    let releaseExec;
    const execGate = new Promise((r) => (releaseExec = r));
    q.execute = async () => {
      await execGate;
    };
    // 模拟「12 路 sweep 同时在飞」（旧实现下各自领一单 → running 冲到 10+）。
    // 每次 sweep 最多领取一单：12 路 ≥ TOTAL，保证全部任务被领取。
    await Promise.all(
      Array.from({ length: 12 }, () => q.sweepOnce())
    );
    const stats = q.stats();
    assert.ok(
      stats.running <= stats.concurrency,
      `running=${stats.running} 不得超过 concurrency=${stats.concurrency}（超卖竞态回归）`
    );
    assert.strictEqual(
      q.deferred.length,
      TOTAL - stats.concurrency,
      '超限任务应全部进入本地延期缓冲（已持有跨实例 claim，不丢失）'
    );
    // 释放挂起的 execute → finally 逐个释放槽位并消化延期缓冲
    releaseExec();
    for (let i = 0; i < 30 && q.deferred.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await q.sweepOnce();
    }
    assert.strictEqual(q.deferred.length, 0, '槽位释放后延期缓冲应被全部消化');
    assert.ok(q.stats().running <= stats.concurrency, '消化全程 running 不得越界');
  } finally {
    q.stop();
  }
});
