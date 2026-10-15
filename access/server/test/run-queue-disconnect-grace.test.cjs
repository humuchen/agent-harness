// 断连宽限中止（P1-1 演进）回归测试。
//
// 背景（用户实测缺陷）：问答模式下对话进行到一半网络不稳定断开，就无法自动
// 恢复继续回答。根因：handleRun 的 res.on('close') 对「最后一个订阅者」立即
// `controller.abort('client disconnected')` —— 网络抖动 / 刷新造成的瞬时断连
// 在客户端凭 jobId+since 重连之前就把 job 打死，重连只能重放到 abortedResult
// 的残缺终态（「本次运行被取消」+ _done）。
//
// 修复：断开不再立即中止，改为宽限中止（RUN_DISCONNECT_GRACE_MS 默认 60s）——
// 宽限期内重订阅即取消，job 续跑供无缝续传；宽限到仍无订阅者才补刀（保留
// P1-1「关浏览器后停止烧 token」的初衷）。本文件钉死以下契约：
//   1) 宽限内不中止、宽限到（无订阅者）才中止；
//   2) 任意订阅者回归（subscribe）或显式 cancel 即取消中止；
//   3) 终态 job 不预约；预约幂等且不顺延窗口；
//   4) delayMs<=0 退化为旧行为（断开即中止）；
//   5) abortAll / stop / 淘汰路径清理定时器，无泄漏；
//   6) 源码锚点：run-routes 不得再「断开即立即 abort」，必须走宽限 + 重连取消。
process.env.RUN_QUEUE_BACKEND = 'memory';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { RunQueue, RUN_DISCONNECT_GRACE_MS } = require('../dist/run-queue.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 仅入表不触发执行的 job（makeJob 为编译期私有，运行时可达——同 force-settle 测试先例）。 */
function makeIdleJob(q, id) {
  const job = q.makeJob({ mode: 'mock', prompt: 'p' }, id);
  assert.strictEqual(job.status, 'queued');
  return job;
}

test('RUN_DISCONNECT_GRACE_MS：缺省 60s（大于前端自动重试预算约 31s）', () => {
  assert.strictEqual(RUN_DISCONNECT_GRACE_MS, 60_000);
});

test('宽限内不中止；宽限到且无订阅者才中止', async () => {
  const q = new RunQueue();
  try {
    const job = makeIdleJob(q, 'job_g1');
    q.scheduleDisconnectAbort(job.id, 60);
    assert.strictEqual(q.stats().disconnectTimers, 1, 'schedule 后应有一个待执行宽限');
    await sleep(20);
    assert.strictEqual(job.controller.signal.aborted, false, '宽限内不得中止');
    await sleep(70);
    assert.strictEqual(job.controller.signal.aborted, true, '宽限到且无订阅者应中止');
    assert.strictEqual(job.controller.signal.reason, 'client disconnected');
    assert.strictEqual(q.stats().disconnectTimers, 0, '触发后定时器应自清');
  } finally {
    q.stop();
  }
});

test('宽限内订阅者回归（subscribe）即取消中止', async () => {
  const q = new RunQueue();
  try {
    const job = makeIdleJob(q, 'job_g2');
    q.scheduleDisconnectAbort(job.id, 40);
    // 客户端凭 jobId 重订阅：subscribe 内部统一取消宽限中止。
    const unsub = q.subscribe(job.id, () => {});
    assert.strictEqual(q.stats().disconnectTimers, 0, '订阅后预约应立即取消');
    await sleep(90);
    assert.strictEqual(job.controller.signal.aborted, false, '已重连的 job 不得被宽限补刀');
    unsub();
  } finally {
    q.stop();
  }
});

test('显式 cancelDisconnectAbort 取消待执行中止；无预约时不抛错', async () => {
  const q = new RunQueue();
  try {
    const job = makeIdleJob(q, 'job_g3');
    q.scheduleDisconnectAbort(job.id, 40);
    q.cancelDisconnectAbort(job.id);
    q.cancelDisconnectAbort(job.id); // 幂等：无预约再调一次不抛错
    await sleep(90);
    assert.strictEqual(job.controller.signal.aborted, false, '取消后不得中止');
  } finally {
    q.stop();
  }
});

test('宽限到点但仍有订阅者 → 不中止（含半开死连接迟到 close 的场景）', async () => {
  const q = new RunQueue();
  try {
    const job = makeIdleJob(q, 'job_g4');
    // 订阅者 A（活跃重连方）一直在；旧连接的 close 只可能走到「还有订阅者」分支。
    q.subscribe(job.id, () => {});
    q.scheduleDisconnectAbort(job.id, 30);
    await sleep(80);
    assert.strictEqual(job.controller.signal.aborted, false, '仍有订阅者时宽限到点也不中止');
  } finally {
    q.stop();
  }
});

test('终态 job 不预约宽限中止', async () => {
  const q = new RunQueue();
  try {
    const job = makeIdleJob(q, 'job_g5');
    job.status = 'done';
    q.scheduleDisconnectAbort(job.id, 30);
    assert.strictEqual(q.stats().disconnectTimers, 0, '终态 job 不应留下定时器');
    await sleep(60);
    assert.strictEqual(job.controller.signal.aborted, false);
  } finally {
    q.stop();
  }
});

test('预约幂等：重复 schedule 不顺延宽限窗口', async () => {
  const q = new RunQueue();
  try {
    const job = makeIdleJob(q, 'job_g6');
    q.scheduleDisconnectAbort(job.id, 50);
    q.scheduleDisconnectAbort(job.id, 5_000); // 断连重试风暴不得顺延窗口
    assert.strictEqual(q.stats().disconnectTimers, 1, '同 job 只保留一个预约');
    await sleep(110);
    assert.strictEqual(job.controller.signal.aborted, true, '应按首个预约的 50ms 触发');
    assert.strictEqual(q.stats().disconnectTimers, 0);
  } finally {
    q.stop();
  }
});

test('delayMs<=0：退化为旧行为（断开即中止）', () => {
  const q = new RunQueue();
  try {
    const job = makeIdleJob(q, 'job_g7');
    q.scheduleDisconnectAbort(job.id, 0);
    assert.strictEqual(job.controller.signal.aborted, true, '0 宽限应立即中止');
    assert.strictEqual(q.stats().disconnectTimers, 0, '立即中止不落定时器');
  } finally {
    q.stop();
  }
});

test('abortAll（优雅停机）清空宽限定时器', async () => {
  const q = new RunQueue();
  try {
    const job = makeIdleJob(q, 'job_g8');
    q.scheduleDisconnectAbort(job.id, 30);
    q.abortAll('shutdown');
    assert.strictEqual(q.stats().disconnectTimers, 0, '停机后不得残留宽限定时器');
    await sleep(70);
    assert.strictEqual(job.controller.signal.aborted, false, '停机已统一处置，无需宽限补刀');
  } finally {
    q.stop();
  }
});

test('stop() 清空宽限定时器', async () => {
  const q = new RunQueue();
  const job = makeIdleJob(q, 'job_g9');
  q.scheduleDisconnectAbort(job.id, 30);
  q.stop();
  assert.strictEqual(q.stats().disconnectTimers, 0);
  await sleep(70);
  assert.strictEqual(job.controller.signal.aborted, false);
});

// 源码锚点：run-routes 的断连处理必须走宽限 + 重连取消，不得回退「断开即立即 abort」。
test('源码守护：handleRun 断连必须走 scheduleDisconnectAbort 且订阅者判定为 0', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'run-routes.ts'),
    'utf8'
  );
  // 1) 不得再出现「断开即立即 abort」的旧实现。
  assert.ok(
    !/controller\?\.abort\('client disconnected'\)/.test(src),
    'run-routes 不得直接 controller.abort——断连中止必须走 RunQueue 宽限机制'
  );
  // 2) close 处理器必须预约宽限中止（常量注入）。
  assert.match(
    src,
    /runQueue\.scheduleDisconnectAbort\(jobId,\s*RUN_DISCONNECT_GRACE_MS\)/
  );
  // 3) 订阅者判定：unsub 后为 0 才预约（旧 `<= 1` 会误杀仍被其他客户端观看的 job）。
  assert.match(src, /remainingSubs\.length === 0/);
  assert.ok(!/remainingSubs\.length <= 1/.test(src), '不得回退到 <= 1 的误杀判定');
  // 4) 重连分支必须取消待执行的宽限中止（targetId 即被重连的 job）。
  assert.match(src, /runQueue\.cancelDisconnectAbort\(targetId\)/);
});

// 源码锚点：RunQueue 宽限机制的关键结构（execute 终态清理 / subscribe 取消不变量）。
test('源码守护：RunQueue 宽限机制的终态清理与订阅取消不变量', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'run-queue.ts'),
    'utf8'
  );
  assert.match(src, /export const RUN_DISCONNECT_GRACE_MS =\s*\n?\s*Number\(process\.env\.RUN_DISCONNECT_GRACE_MS \?\? 60_000\)/);
  assert.match(src, /scheduleDisconnectAbort\(jobId: string, delayMs: number\): void/);
  assert.match(src, /cancelDisconnectAbort\(jobId: string\): void/);
  // execute 的 finally 必须摘除宽限定时器（终态后 abort 无意义，且防泄漏）。
  assert.match(src, /this\.cancelDisconnectAbort\(job\.id\)/);
  // subscribe 必须取消宽限（「有订阅者 ⇒ 不中止」的统一不变量）。
  const subscribeIdx = src.indexOf('subscribe(id: string');
  assert.ok(subscribeIdx > 0);
  const subscribeBody = src.slice(subscribeIdx, subscribeIdx + 600);
  assert.match(subscribeBody, /this\.cancelDisconnectAbort\(id\)/);
});
