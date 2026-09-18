// P4.8 守护：计划任务执行的「看门狗预算」必须与 harness 侧预算同源。
// 背景（已复现的确定性缺陷）：run-queue 的看门狗无条件用 JOB_TIMEOUT_MS（默认 300s），
// 而计划任务执行在 harness 侧拿到的是 PLAN_TASK_TIMEOUT_MS（默认 600s）—— 看门狗会在
// 5 分钟就把「预算 10 分钟」的计划任务掐断，用户看到「等待很久 → step 超时中止」。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { isPlanTaskRun } = require('../dist/queue-backend.js');
const { PLAN_TASK_TIMEOUT_MS } = require('../dist/run-queue.js');

test('isPlanTaskRun：仅「计划执行」阶段算计划任务（propose 阶段不算）', () => {
  assert.strictEqual(isPlanTaskRun({ interactionMode: 'plan', planPhase: 'execute' }), true);
  assert.strictEqual(isPlanTaskRun({ interactionMode: 'plan', planPhase: 'propose' }), false);
  // 缺 planPhase 按「执行」处理（存量语义：propose 路径由前端显式带 planPhase='propose'，
  // 未声明阶段的 plan 运行按重任务给定更长预算，属宽松偏好）。
  assert.strictEqual(isPlanTaskRun({ interactionMode: 'plan' }), true);
  assert.strictEqual(isPlanTaskRun({ interactionMode: 'qa', planPhase: 'execute' }), false);
  assert.strictEqual(isPlanTaskRun({}), false);
});

test('PLAN_TASK_TIMEOUT_MS：缺省 10 分钟（可经 env 覆盖）', () => {
  assert.strictEqual(PLAN_TASK_TIMEOUT_MS, 600_000);
});

test('源码守护：看门狗预算必须按 isPlanTaskRun 分流，不得硬编码 JOB_TIMEOUT_MS', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'run-queue.ts'),
    'utf8'
  );
  // 看门狗定时器的延时参数必须是分流后的 watchdogMs。
  assert.match(
    src,
    /const watchdogMs = isPlanTaskRun\(job\)\s*\?\s*PLAN_TASK_TIMEOUT_MS\s*:\s*JOB_TIMEOUT_MS/
  );
  assert.match(src, /setTimeout\(\(\) => \{[\s\S]{0,220}?\}, watchdogMs\)/);
  // 反例守护：不得存在「setTimeout(..., JOB_TIMEOUT_MS)」形式的看门狗（回归即报错）。
  assert.ok(
    !/setTimeout\(\(\) => \{\s*try \{\s*job\.controller\.abort\('timeout'\)/.test(
      src.replace(/const watchdogMs[\s\S]{0,400}?\}, watchdogMs\)/, '')
    ),
    '看门狗不得硬编码 JOB_TIMEOUT_MS'
  );
});
