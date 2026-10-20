'use strict';
// P1-7 回归：看门狗第二层强制结算（forceSettleRun）。
//
// 背景：看门狗（watchdogMs）只 abort 信号 —— 若底层 LLM/工具调用不响应中止，
// execute() 的 await 永不 resolve → worker 槽位 / runningSessions / 会话锁 /
// 配额预留全部泄漏（结构性）。修复：Promise.race 双层结算 —— 宽限期
// （JOB_FORCE_SETTLE_GRACE_MS，默认 30s）后强制 reject，让 execute 走
// catch → finally 完成全部资源回收。
//
// 两个曾经真实犯过的实现错误，由本文件钉死防回归：
// 1) `return Promise.race(...)` 缺 await → finally 提前执行清掉强制结算定时器，
//    强制结算永不触发（源码锚点断言必须 `return await`）；
// 2) race settle 之后底层悬挂 promise 才 reject —— race 的既有 handler 会消化它，
//    不得产生 unhandledRejection（行为断言）。
//
// 注意：必须在 require dist 之前设置 env —— EXECUTE_FORCE_SETTLE_GRACE_MS 是
// 模块加载时读定的常量（node --test 每个测试文件独立子进程，互不影响）。
process.env.JOB_FORCE_SETTLE_GRACE_MS = '40';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RUNQUEUE_JS = path.join(__dirname, '..', 'dist', 'run-queue.js');
const RUN = fs.existsSync(RUNQUEUE_JS);
const { RunQueue, EXECUTE_FORCE_SETTLE_GRACE_MS } = require(RUN ? RUNQUEUE_JS : 'node:assert');

test('EXECUTE_FORCE_SETTLE_GRACE_MS：env 覆盖生效（测试用 40ms）', { skip: !RUN }, () => {
  assert.strictEqual(EXECUTE_FORCE_SETTLE_GRACE_MS, 40);
});

test('P1-7：底层不响应中止 → 宽限后强制 reject（走 finally 语义）', { skip: !RUN }, async () => {
  const q = new RunQueue(); // memory 后端，无共享副作用
  const hung = new Promise(() => {}); // 永不 settle：模拟不响应 abort 的 LLM 调用
  // 保活：hard 定时器被实现 unref()（不阻止进程退出，生产正确），但测试必须
  // 依赖它触发 —— 全量并发跑时事件循环可能空转，unref timer 不保活会导致
  // 测试 promise 永远 pending（ERR_TEST_FAILURE: pending but loop resolved）。
  const keepAlive = setInterval(() => {}, 25);
  try {
    await assert.rejects(
      () => q.forceSettleRun(hung, 30, { id: 'fs1' }),
      /run force-settled: watchdog abort was not honored/,
      'watchdogMs(30) + grace(40) = 70ms 后应强制失败'
    );
  } finally {
    clearInterval(keepAlive);
  }
});

test('P1-7：正常完成 → 结果透传，hard 定时器被 finally 清掉', { skip: !RUN }, async () => {
  const q = new RunQueue();
  const p = new Promise((r) => setTimeout(() => r('ok'), 20)); // 20ms < 70ms 预算
  const out = await q.forceSettleRun(p, 30, { id: 'fs2' });
  assert.strictEqual(out, 'ok');
  // hard 定时器若未被 finally 清掉，70ms 时会 reject 一个已无人监听的 promise
  // → unhandledRejection。等过定时器窗口后断言零触发。
  let unhandled = 0;
  const h = () => {
    unhandled++;
  };
  process.on('unhandledRejection', h);
  await new Promise((r) => setTimeout(r, 120));
  process.removeListener('unhandledRejection', h);
  assert.strictEqual(unhandled, 0, 'hard 定时器应被 finally 清除，不得产生 unhandledRejection');
});

test('P1-7：race settle 后悬挂 promise 才 reject → 不产生 unhandledRejection', { skip: !RUN }, async () => {
  const q = new RunQueue();
  let rejectP;
  const p = new Promise((_, rej) => {
    rejectP = rej;
  });
  // 保活（同前一项：hard 定时器被 unref，测试须自保事件循环不空转）。
  const keepAlive = setInterval(() => {}, 25);
  try {
    await assert.rejects(() => q.forceSettleRun(p, 30, { id: 'fs3' }), /force-settled/);
    // 强制结算已发生；此时底层 promise 才失败（真实场景：深层 fetch 最终报错）。
    rejectP(new Error('late underlying failure'));
    let unhandled = 0;
    const h = () => {
      unhandled++;
    };
    process.on('unhandledRejection', h);
    await new Promise((r) => setTimeout(r, 60));
    process.removeListener('unhandledRejection', h);
    assert.strictEqual(unhandled, 0, 'race 的既有 handler 应消化悬挂 rejection');
  } finally {
    clearInterval(keepAlive);
  }
});

// 源码锚点：强制结算必须 `return await Promise.race` —— 缺 await 则 finally 提前
// 执行清掉定时器，强制结算永不触发（该 bug 真实出现过）。
test('P1-7 源码守护：forceSettleRun 必须 await Promise.race，不得改为裸 return', { skip: !RUN }, () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'run-queue.ts'),
    'utf8'
  );
  const m = src.match(/return (await )?Promise\.race\(\[p, hard\]\);/);
  assert.ok(m, 'forceSettleRun 应存在 return Promise.race([p, hard])');
  assert.strictEqual(m[1], 'await ', '必须 return await —— 缺 await 则 finally 提前清定时器，强制结算永不触发');
});
