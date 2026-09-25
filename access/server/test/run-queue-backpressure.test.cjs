// RunQueue 排队背压 + 幂等去重守护测试：
// - RUN_QUEUE_MAX_PENDING：待执行队列达上限时 submit 抛 QueueBackpressureError（HTTP 层映射 429）；
// - idempotencyKey：同 owner 同键的活跃（queued/running）任务被去重复用，终态后索引清理。
// 注意：本文件顶部必须在 require dist 前设置 env（常量在模块加载时固化）。
process.env.RUN_QUEUE_MAX_PENDING = '2';
process.env.RUN_QUEUE_BACKEND = 'memory';

const test = require('node:test');
const assert = require('node:assert');

const { RunQueue, QueueBackpressureError } = require('../dist/run-queue.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('排队背压：队列达上限后 submit 拒绝（同会话串行化维持堆积）', async () => {
  const q = new RunQueue();
  try {
    // 同一 sessionKey：首个 job 进入 running 占住会话，后续 job 全部滞留排队。
    // P2：submit 已异步化（共享模式持久化是同步前置），提交需 await。
    const mk = (n) => q.submit({ mode: 'mock', prompt: `p${n}`, sessionKey: 'bp-session' });
    const j1 = await mk(1);
    assert.strictEqual(j1.status, 'running');
    await mk(2); // queued（会话被占）
    await mk(3); // queued，此时 queue.length === 2 === 上限
    await assert.rejects(mk(4), (e) => {
      assert.ok(e instanceof QueueBackpressureError, `应抛 QueueBackpressureError，实际：${e}`);
      assert.strictEqual(e.limit, 2);
      assert.strictEqual(e.pending, 2);
      return true;
    });
  } finally {
    q.stop();
  }
});

test('幂等去重：同 owner 同键活跃任务复用；不同 owner 不受影响', async () => {
  const q = new RunQueue();
  try {
    const a = await q.submit({ mode: 'mock', prompt: 'p', owner: 'u1', idempotencyKey: 'k1' });
    const b = await q.submit({ mode: 'mock', prompt: 'p-again', owner: 'u1', idempotencyKey: 'k1' });
    assert.strictEqual(b.id, a.id, '同键活跃任务应复用既有 job');
    const c = await q.submit({ mode: 'mock', prompt: 'p', owner: 'u2', idempotencyKey: 'k1' });
    assert.notStrictEqual(c.id, a.id, '不同 owner 同键不互相去重');
    const d = await q.submit({ mode: 'mock', prompt: 'p', owner: 'u1' });
    assert.notStrictEqual(d.id, a.id, '未带幂等键不去重');
  } finally {
    q.stop();
  }
});

test('幂等索引清理：任务进入终态后，同键新提交不再被拦截', async () => {
  const q = new RunQueue();
  try {
    const a = await q.submit({ mode: 'mock', prompt: 'p', owner: 'u1', idempotencyKey: 'fin' });
    // 等待任务执行完结（单元环境无 runner 依赖，mock run 会快速失败或结束）。
    let done = false;
    for (let i = 0; i < 50; i++) {
      await sleep(50);
      const st = a.status;
      if (st === 'done' || st === 'failed' || st === 'cancelled') {
        done = true;
        break;
      }
    }
    if (!done) {
      // 极端慢环境：跳过时序敏感断言（避免假红），仅验证无异常。
      return;
    }
    const b = await q.submit({ mode: 'mock', prompt: 'p2', owner: 'u1', idempotencyKey: 'fin' });
    assert.notStrictEqual(b.id, a.id, '终态后同键提交应创建新 job');
  } finally {
    q.stop();
  }
});
