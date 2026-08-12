'use strict';
// 运行队列持久化后端测试（业务层，零依赖）：覆盖 Memory / File 后端的
// append/list/ack/clear 语义，以及 RunQueue + File 后端的启动重放。
// 仅依赖 node 内置模块；运行前需 `pnpm --filter @agent-harness/ui run build` 产 dist。
//
// 用「dist 不存在则跳过并显式 fail」的方式，避免静默跳过掩盖构建缺失。

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BACKEND_JS = path.join(__dirname, '..', 'dist', 'queue-backend.js');
const RUNQUEUE_JS = path.join(__dirname, '..', 'dist', 'run-queue.js');
const RUN = fs.existsSync(BACKEND_JS);

function loadBackend() {
  return require(BACKEND_JS);
}
function tmpDir() {
  const dir = path.join(os.tmpdir(), `qb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('MemoryQueueBackend: append/list/ack/clear', { skip: !RUN }, async () => {
  const { MemoryQueueBackend } = loadBackend();
  const b = new MemoryQueueBackend();
  assert.strictEqual(b.kind, 'memory');
  await b.append({ id: 'a', mode: 'mock', prompt: 'p1', enqueuedAt: 1 });
  await b.append({ id: 'b', mode: 'real', prompt: 'p2', sessionKey: 's1', enqueuedAt: 2 });
  let all = await b.list();
  assert.strictEqual(all.length, 2);
  await b.ack('a');
  all = await b.list();
  assert.deepStrictEqual(all.map((d) => d.id), ['b']);
  await b.clear();
  assert.strictEqual((await b.list()).length, 0);
});

test('FileQueueBackend: 追加写持久化 + ack 移除 + 坏行鲁棒', { skip: !RUN }, async () => {
  const { FileQueueBackend } = loadBackend();
  const file = path.join(tmpDir(), 'run-queue.jsonl');
  const b = new FileQueueBackend({ file });
  assert.strictEqual(b.kind, 'file');
  await b.append({ id: 'a', mode: 'mock', prompt: 'p1', enqueuedAt: 1 });
  await b.append({ id: 'b', mode: 'real', prompt: 'p2', sessionKey: 's', enqueuedAt: 2 });

  // 新实例从同一文件加载 → 持久化跨进程（重启）有效
  const b2 = new FileQueueBackend({ file });
  let all = await b2.list();
  assert.strictEqual(all.length, 2);
  assert.deepStrictEqual(all.map((d) => d.id).sort(), ['a', 'b']);

  // ack 后重写文件，b2 再列应只剩 a
  await b2.ack('b');
  const b3 = new FileQueueBackend({ file });
  all = await b3.list();
  assert.deepStrictEqual(all.map((d) => d.id), ['a']);

  // 坏行/半截行：手动追加一行非法 JSON，加载时应当丢弃而不报错（崩溃安全）
  fs.appendFileSync(file, 'this is not json\n');
  const b4 = new FileQueueBackend({ file });
  all = await b4.list();
  assert.deepStrictEqual(all.map((d) => d.id), ['a']);
});

test('RunQueue + FileQueueBackend: 启动重放未开始任务并清空持久层', { skip: !RUN }, async () => {
  const { FileQueueBackend } = loadBackend();
  const { RunQueue } = require(RUNQUEUE_JS);
  const file = path.join(tmpDir(), 'run-queue.jsonl');
  // 预置一条未开始任务到持久层（模拟「上次进程崩溃遗留」）
  const b = new FileQueueBackend({ file });
  await b.append({ id: 'old1', mode: 'mock', prompt: 'replay-me', sessionKey: 'sX', enqueuedAt: 100 });

  // 构造 RunQueue 时传入同一后端 → 应自动重放
  const q = new RunQueue(b);
  // 重放是异步的（读文件 → 入队 → 清空），等一小段时间
  await new Promise((r) => setTimeout(r, 80));
  const jobs = q.list();
  // list() 出于隐私脱敏只暴露 promptLen / sessionKey，不直接回显 prompt 原文。
  assert.ok(
    jobs.some((j) => j.sessionKey === 'sX' && j.promptLen === 'replay-me'.length),
    '重放后队列应包含持久化的未开始任务'
  );

  // 持久层应被清空，避免下次重启重复执行
  const remaining = await b.list();
  assert.strictEqual(remaining.length, 0, '重放后持久层应清空');
});

// dist 未构建时给出明确失败提示，而非静默跳过整个套件。
test('dist 未构建时显式提示', { skip: RUN }, () => {
  assert.fail('packages/ui/dist/queue-backend.js 不存在：请先 `pnpm --filter @agent-harness/ui run build` 再跑本测试');
});

// ─────────────────────────────────────────────────────────────────────────────
// Redis 后端（共享、多实例）：用进程内 FakeRedis 实现 RedisClient 契约，无需真实 Redis 服务。
// ─────────────────────────────────────────────────────────────────────────────

// 最小内存版 Redis，存储 + pub/sub 在「同一 store」上共享（duplicate 共享 store），
// 从而模拟「一个连接 publish、另一个连接 subscribe」的跨实例事件路由。
class FakeStore {
  constructor() {
    this.lists = new Map();
    this.hashes = new Map();
    this.subs = new Map(); // channel -> Set<(msg)=>void>
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
  async rpoplpush(src, dst) {
    const s = this.store.lists.get(src) || [];
    if (s.length === 0) return null;
    const v = s.pop();
    const d = this.store.lists.get(dst) || [];
    d.unshift(v);
    this.store.lists.set(dst, d);
    this.store.lists.set(src, s);
    return v;
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
  async publish(channel, message) {
    const set = this.store.subs.get(channel);
    if (!set) return 0;
    let n = 0;
    for (const fn of [...set]) {
      fn(message);
      n += 1;
    }
    return n;
  }
  subscribe(channel) {
    if (this.subWrappers.has(channel)) return;
    const wrapper = (msg) => {
      if (this.messageHandler) this.messageHandler(channel, msg);
    };
    this.subWrappers.set(channel, wrapper);
    let set = this.store.subs.get(channel);
    if (!set) {
      set = new Set();
      this.store.subs.set(channel, set);
    }
    set.add(wrapper);
  }
  on(event, cb) {
    if (event === 'message') this.messageHandler = cb;
  }
  unsubscribe(channel) {
    this.subWrappers.delete(channel);
    const set = this.store.subs.get(channel);
    if (set) {
      for (const fn of [...set]) set.delete(fn);
    }
  }
  async quit() {}
}

test('RedisQueueBackend: append/list/claim FIFO/ack/clear', { skip: !RUN }, async () => {
  const { RedisQueueBackend } = loadBackend();
  const b = new RedisQueueBackend(new FakeRedis());
  assert.strictEqual(b.kind, 'redis');

  await b.append({ id: 'a', mode: 'mock', prompt: 'p1', enqueuedAt: 1 });
  await b.append({ id: 'b', mode: 'real', prompt: 'p2', sessionKey: 's1', enqueuedAt: 2 });
  await b.append({ id: 'c', mode: 'mock', prompt: 'p3', enqueuedAt: 3 });

  // list 应含全部 3 条（pending + processing 合并）
  assert.strictEqual((await b.list()).length, 3);

  // claim 严格 FIFO：最旧先出
  const first = await b.claim();
  assert.strictEqual(first.id, 'a');
  // 领取后 a 进入 processing，list 仍可见（但归在 processing）
  assert.ok((await b.list()).some((d) => d.id === 'a'));

  // ack 后 a 彻底消失
  await b.ack('a');
  assert.ok(!(await b.list()).some((d) => d.id === 'a'));
  assert.deepStrictEqual((await b.list()).map((d) => d.id).sort(), ['b', 'c']);

  await b.clear();
  assert.strictEqual((await b.list()).length, 0);
});

test('RedisQueueBackend: claim 原子——每条任务仅被领取一次（多实例无重复执行）', { skip: !RUN }, async () => {
  const { RedisQueueBackend } = loadBackend();
  const store = new FakeStore();
  const b = new RedisQueueBackend(new FakeRedis(store));
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(`t${i}`);
  for (const id of ids) {
    await b.append({ id, mode: 'mock', prompt: 'x', enqueuedAt: Number(id.slice(1)) });
  }
  // 模拟「3 个实例并发领取」：对同一共享后端连续 claim，直到无任务。
  const claimed = [];
  for (let i = 0; i < ids.length; i++) {
    const d = await b.claim();
    if (!d) break;
    claimed.push(d.id);
  }
  // 5 条全部被领取、且互不相同（原子 rpoplpush 保证无重复/无遗漏）
  assert.strictEqual(claimed.length, 5);
  assert.deepStrictEqual([...new Set(claimed)].sort(), [...ids].sort());
  // 领取后再 claim 应为 null（无残留 → 不会出现「两个实例各跑一遍」）
  assert.strictEqual(await b.claim(), null);
});

test('RedisQueueBackend: reclaimStale 回收崩溃实例占住的任务', { skip: !RUN }, async () => {
  const { RedisQueueBackend } = loadBackend();
  const b = new RedisQueueBackend(new FakeRedis());
  await b.append({ id: 'a', mode: 'mock', prompt: 'p1', enqueuedAt: 1 });
  await b.append({ id: 'b', mode: 'mock', prompt: 'p2', enqueuedAt: 2 });
  // 模拟两个实例正在执行：全部领取进 processing
  await b.claim();
  await b.claim();
  assert.strictEqual((await b.list()).length, 2, '领取后仍在 list（归在 processing）');

  // 假设实例崩溃：以 0ms 租约调用 reclaimStale → 所有 processing 任务视为超期，迁回 pending
  const moved = await b.reclaimStale(0);
  assert.strictEqual(moved, 2, '超租约任务应全部迁回 pending');
  // 回收后任务按原始提交 FIFO 重新入队（a 先 b 后）；领完后再 claim 为 null。
  const again = await b.claim();
  assert.strictEqual(again.id, 'a', '回收后应按原始 FIFO（a 先）重新领取');
  assert.strictEqual((await b.claim()).id, 'b');
  assert.strictEqual(await b.claim(), null);
});

test('RedisQueueBackend: pub/sub 事件桥（跨实例 SSE）', { skip: !RUN }, async () => {
  const { RedisQueueBackend } = loadBackend();
  // 两个 backend 共享同一 store（如同两个实例连同一 Redis）
  const store = new FakeStore();
  const execInstance = new RedisQueueBackend(new FakeRedis(store)); // 执行实例
  const subInstance = new RedisQueueBackend(new FakeRedis(store)); // 持有 SSE 订阅的实例

  const received = [];
  const unsub = await subInstance.subscribeEvents('jobX', (e) => received.push(e));
  // 执行实例发出事件 → 订阅实例应收到（解析后的对象）
  await execInstance.publishEvent('jobX', { type: 'run:meta', ok: true });
  await execInstance.publishEvent('jobX', { type: 'run:end', final: 'done' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(received, [
    { type: 'run:meta', ok: true },
    { type: 'run:end', final: 'done' },
  ]);
  // 退订后不再接收
  unsub();
  await execInstance.publishEvent('jobX', { type: 'after-unsub' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(received.length, 2, '退订后不应再收到事件');
});

test('RunQueue 共享模式（redis）：submit 走 claim 驱动、不落本地 queue', { skip: !RUN }, async () => {
  const { RedisQueueBackend, MemoryQueueBackend } = loadBackend();
  const { RunQueue } = require(RUNQUEUE_JS);
  const b = new RedisQueueBackend(new FakeRedis());
  const q = new RunQueue(b);
  const q2 = new RunQueue(new MemoryQueueBackend());
  try {
    // 共享模式：本地 RunJob 立即存在（供 SSE 缓冲），但不压入本地 queue——
    // 执行完全由 claim 轮询驱动，故任意空闲实例都可领取，实现水平扩展。
    const job = q.submit({ mode: 'mock', prompt: 'shared-task', sessionKey: 's1', maxSteps: 3 });
    assert.ok(q.get(job.id), '提交后本地 RunJob 应存在（供 SSE 缓冲）');
    // 共享模式不把任务压入本地 queue——执行完全由 claim 轮询驱动（queued 恒为 0）；
    // 对照的非共享模式则由 pump 立即取出执行，二者都不应残留于 queued。
    assert.strictEqual(q.stats().queued, 0, '共享模式不应把任务压入本地 queue');

    const j2 = q2.submit({ mode: 'mock', prompt: 'local-task' });
    assert.ok(q2.get(j2.id), '内存后端 submit 应建立本地 RunJob');

    // 等待 claim 驱动（q）与 pump 驱动（q2）的执行各自到达终态，证明两种模式都能真正跑起来
    // （把 fire-and-forget 的执行纳入测试跟踪范围，避免 node --test 因事件循环未排空而超时）。
    const deadline = Date.now() + 20000;
    const waitDone = async (rq, id) => {
      while (Date.now() < deadline) {
        const st = rq.get(id)?.status;
        if (st === 'done' || st === 'failed') return st;
        await new Promise((r) => setTimeout(r, 50));
      }
      return rq.get(id)?.status;
    };
    const s1 = await waitDone(q, job.id);
    const s2 = await waitDone(q2, j2.id);
    assert.ok(s1 === 'done' || s1 === 'failed', '共享模式任务应被 claim 驱动执行至终态');
    assert.ok(s2 === 'done' || s2 === 'failed', '非共享模式任务应被 pump 驱动执行至终态');
  } finally {
    q.stop();
    q2.stop();
  }
});
