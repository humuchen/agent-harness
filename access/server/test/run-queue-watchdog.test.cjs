// P4.8 守护：计划任务执行的「看门狗预算」必须与 harness 侧预算同源。
// 背景（已复现的确定性缺陷）：run-queue 的看门狗无条件用 JOB_TIMEOUT_MS（默认 300s），
// 而计划任务执行在 harness 侧拿到的是 PLAN_TASK_TIMEOUT_MS（默认 600s）—— 看门狗会在
// 5 分钟就把「预算 10 分钟」的计划任务掐断，用户看到「等待很久 → step 超时中止」。
//
// 同源缺陷第二例（已复现）：计划 propose 的两段式规划管线（理解 → 调研 → 生成计划，
// 澄清回复轮还有防重问守卫重试）是 3~4 次顺序 LLM 调用，此前与普通 run 共用 300s
// 看门狗，会在阶段3 中途被 abort —— 前端只见「规划未完成：连接可能已中断或处理超时」，
// 已烧 token 全部作废。现按 isPlanProposeRun 分流到 PLAN_PROPOSE_TIMEOUT_MS（默认 600s）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { isPlanTaskRun, isPlanProposeRun } = require('../dist/queue-backend.js');
const {
  PLAN_TASK_TIMEOUT_MS,
  PLAN_PROPOSE_TIMEOUT_MS
} = require('../dist/run-queue.js');

test('isPlanTaskRun：仅「计划执行」阶段算计划任务（propose 阶段不算）', () => {
  assert.strictEqual(isPlanTaskRun({ interactionMode: 'plan', planPhase: 'execute' }), true);
  assert.strictEqual(isPlanTaskRun({ interactionMode: 'plan', planPhase: 'propose' }), false);
  // 缺 planPhase 按「执行」处理（存量语义：propose 路径由前端显式带 planPhase='propose'，
  // 未声明阶段的 plan 运行按重任务给定更长预算，属宽松偏好）。
  assert.strictEqual(isPlanTaskRun({ interactionMode: 'plan' }), true);
  assert.strictEqual(isPlanTaskRun({ interactionMode: 'qa', planPhase: 'execute' }), false);
  assert.strictEqual(isPlanTaskRun({}), false);
});

test('isPlanProposeRun：仅「计划 propose」阶段算规划管线（与 isPlanTaskRun 互斥）', () => {
  assert.strictEqual(isPlanProposeRun({ interactionMode: 'plan', planPhase: 'propose' }), true);
  assert.strictEqual(isPlanProposeRun({ interactionMode: 'plan', planPhase: 'execute' }), false);
  assert.strictEqual(isPlanProposeRun({ interactionMode: 'plan' }), false);
  assert.strictEqual(isPlanProposeRun({ interactionMode: 'qa' }), false);
  assert.strictEqual(isPlanProposeRun({}), false);
  // 互斥：任何 job 至多命中其一（watchdog 三岔路无重叠）。
  for (const j of [
    { interactionMode: 'plan', planPhase: 'propose' },
    { interactionMode: 'plan', planPhase: 'execute' },
    { interactionMode: 'plan' },
    { interactionMode: 'qa' }
  ]) {
    assert.strictEqual(
      isPlanTaskRun(j) && isPlanProposeRun(j),
      false,
      `job ${JSON.stringify(j)} 不得同时算 planTask 与 propose`
    );
  }
});

test('PLAN_TASK_TIMEOUT_MS：缺省 10 分钟（可经 env 覆盖）', () => {
  assert.strictEqual(PLAN_TASK_TIMEOUT_MS, 600_000);
});

test('PLAN_PROPOSE_TIMEOUT_MS：缺省与 planTask 对齐 10 分钟（可经 env 覆盖）', () => {
  assert.strictEqual(PLAN_PROPOSE_TIMEOUT_MS, 600_000);
  // 必须显著大于普通 run 的 5 分钟：多阶段规划管线的确定性超时防护。
  assert.ok(PLAN_PROPOSE_TIMEOUT_MS > 300_000);
});

test('源码守护：看门狗预算必须按 planTask / propose 分流，不得硬编码 JOB_TIMEOUT_MS', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'run-queue.ts'),
    'utf8'
  );
  // runTimeoutMs 三岔路：planTask → PLAN_TASK_TIMEOUT_MS，propose → PLAN_PROPOSE_TIMEOUT_MS，
  // 其余 → JOB_TIMEOUT_MS；看门狗与 assembleAgent 超时都用它（同源）。
  assert.match(
    src,
    /const runTimeoutMs = isPlanTaskRun\(job\)\s*\?\s*PLAN_TASK_TIMEOUT_MS\s*:\s*isPlanProposeRun\(job\)\s*\?\s*PLAN_PROPOSE_TIMEOUT_MS\s*:\s*JOB_TIMEOUT_MS/
  );
  assert.match(src, /const watchdogMs = runTimeoutMs/);
  assert.match(src, /setTimeout\(\(\) => \{[\s\S]{0,220}?\}, watchdogMs\)/);
  // assembleAgent 的 timeoutMs 也走 runTimeoutMs（harness 侧与看门狗同源）。
  assert.match(src, /runTimeoutMs,/);
  // 反例守护：不得存在「setTimeout(..., JOB_TIMEOUT_MS)」形式的看门狗（回归即报错）。
  assert.ok(
    !/setTimeout\(\(\) => \{\s*try \{\s*job\.controller\.abort\('timeout'\)/.test(
      src.replace(/const runTimeoutMs[\s\S]{0,500}?\}, watchdogMs\)/, '')
    ),
    '看门狗不得硬编码 JOB_TIMEOUT_MS'
  );
});

test('源码守护：A2A 派发 sla.timeoutMs 同样按 propose 分流', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'run-queue.ts'),
    'utf8'
  );
  assert.match(
    src,
    /timeoutMs: isPlanTaskRun\(job\)\s*\?\s*PLAN_TASK_TIMEOUT_MS\s*:\s*isPlanProposeRun\(job\)\s*\?\s*PLAN_PROPOSE_TIMEOUT_MS\s*:\s*JOB_TIMEOUT_MS/
  );
});
