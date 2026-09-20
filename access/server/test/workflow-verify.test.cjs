'use strict';
/**
 * P0（DAG 校验/反思门禁）单测：createWorkflowExecutor 的 verify 选项接线。
 * 覆盖：
 * - verify 缺省 → 无 verify:* 事件（零回归）
 * - verify:{auto:true} → harness 产出经 RuleBasedVerifier 门禁 → verify:result 事件流出
 * - 断言必失败 + AGENT_VERIFY_MAX_RETRIES=1 → 自检重跑（反思循环）产生 2 次 verify:result
 *
 * 运行：pnpm --filter @agent-harness/server run build && node --test access/server/test/workflow-verify.test.cjs
 * mock 模式离线可跑（无需 LLM Key），默认 agentRef 'default' 由共享注册表种子提供。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createWorkflowExecutor } = require('../dist/workflow-executor.js');

const STEP = { id: 't1', agentRef: 'default' };
const CTX = { workflowId: 'wf-verify-test', outputs: {}, signal: undefined, compensate: false };

async function runExecutor(opts, step = STEP, input = '调研一个主题并给出结论') {
  const events = [];
  const ex = createWorkflowExecutor({ ...opts, onEvent: (e) => events.push(e) });
  const out = await ex(step, input, CTX);
  const verifyEvents = events.filter((e) => typeof e?.type === 'string' && e.type.startsWith('verify:'));
  return { out, events, verifyEvents };
}

test('verify 缺省：无 verify:* 事件（零回归）', async () => {
  const { out, verifyEvents } = await runExecutor({ mode: 'mock' });
  assert.ok(out, 'step 正常产出');
  assert.strictEqual(verifyEvents.length, 0, '未传 verify 时门禁关闭，无 verify 事件');
});

test('verify:{auto:true}：规则门禁生效，verify:result 事件流出', async () => {
  const { verifyEvents } = await runExecutor({ mode: 'mock', verify: { auto: true } });
  assert.ok(verifyEvents.length >= 1, 'auto 门禁应产生至少一次 verify:result');
  assert.strictEqual(typeof verifyEvents[0].passed, 'boolean');
  assert.strictEqual(typeof verifyEvents[0].score, 'number');
});

test('断言必失败 + AGENT_VERIFY_MAX_RETRIES=1：自检重试定向补齐（P4.6：reasons 带具体缺失词）', async () => {
  const prev = process.env.AGENT_VERIFY_MAX_RETRIES;
  process.env.AGENT_VERIFY_MAX_RETRIES = '1';
  try {
    const { out, verifyEvents } = await runExecutor({
      mode: 'mock',
      verify: { assertions: [{ contains: '__UNPOSSIBLE_SUBSTRING__' }] }
    });
    assert.strictEqual(verifyEvents.length, 2, '初次校验 + 1 次自检重跑');
    assert.strictEqual(verifyEvents[0].passed, false, '首查不通过');
    // P4.6 后自检提示带「产出未包含『__UNPOSSIBLE_SUBSTRING__』」——模型（含 mock 回显）
    // 按提示定向补齐关键词，重跑后通过。这正是自愈循环的设计目的（不再盲猜）。
    assert.strictEqual(verifyEvents[1].passed, true, '自检重跑后定向补齐 → 通过');
    assert.ok(typeof out === 'string' && out.length > 0, 'step 返回产出');
  } finally {
    if (prev === undefined) delete process.env.AGENT_VERIFY_MAX_RETRIES;
    else process.env.AGENT_VERIFY_MAX_RETRIES = prev;
  }
});

/* ---------- P4.5 逐 task 结果断言（taskMeta.outputChecks → per-step contains 断言） ---------- */

// 与 planToWorkflowDef.buildInputMapping 产出对齐的 step 形状（携带 inputMapping.taskMeta）。
function planStepWithChecks(id, checks, extra) {
  const meta = { id, title: '任务', steps: ['执行'], expectedOutput: '产出', ...(extra ?? {}) };
  if (checks) meta.outputChecks = checks;
  return {
    id,
    agentRef: 'default',
    inputMapping: { goal: 'input', taskMeta: JSON.stringify(meta), ...(checks ? {} : {}) }
  };
}

test('P4.5：planOutputChecks 开启 + outputChecks 命中 → verify 通过（per-step 装配）', async () => {
  const { out, verifyEvents } = await runExecutor(
    { mode: 'mock', verify: { auto: true }, planOutputChecks: true },
    planStepWithChecks('t1', ['Mock 离线应答']),
    '调研一个主题并给出结论'
  );
  assert.ok(out);
  assert.strictEqual(verifyEvents.length, 1);
  assert.strictEqual(verifyEvents[0].passed, true, 'mock 通用应答含「Mock 离线应答」→ contains 命中');
});

test('P4.7：outputChecks 未命中 → 软性未通过（只告警，产出不被改写、step 不判失败）', async () => {
  const { out, verifyEvents } = await runExecutor(
    { mode: 'mock', verify: { auto: true }, planOutputChecks: true },
    planStepWithChecks('t1', ['__IMPOSSIBLE_CHECK_X__'])
  );
  assert.strictEqual(verifyEvents.length, 1);
  assert.strictEqual(verifyEvents[0].passed, false, '断言未命中 → 未通过');
  assert.strictEqual(verifyEvents[0].soft, true, '任务验收组是软性组 → soft=true');
  // 关键：产出不被追加 [verify:failed]，否则引擎出口闸门会判无效产出 → step failed → run failed。
  assert.ok(
    typeof out === 'string' && !out.includes('[verify:failed]'),
    `软性未通过不得改写产出: ${String(out).slice(0, 80)}`
  );
});

test('P4.7：outputChecks 命中 → 通过（软性组不影响通过语义）', async () => {
  const { verifyEvents } = await runExecutor(
    { mode: 'mock', verify: { auto: true }, planOutputChecks: true },
    planStepWithChecks('t1', ['Mock 离线应答'])
  );
  assert.strictEqual(verifyEvents.length, 1);
  assert.strictEqual(verifyEvents[0].passed, true);
  assert.strictEqual(verifyEvents[0].soft, undefined);
});

test('P4.7：同一 executor 两个 step 的 outputChecks 互不串染（per-step 隔离）', async () => {
  const ctx = { workflowId: 'wf-p45', outputs: {}, signal: undefined, compensate: false };
  const evA = [];
  const evB = [];
  const exA = createWorkflowExecutor({ mode: 'mock', verify: { auto: true }, planOutputChecks: true, onEvent: (e) => evA.push(e) });
  await exA(planStepWithChecks('t1', ['Mock 离线应答']), '调研一个主题并给出结论', ctx);
  const exB = createWorkflowExecutor({ mode: 'mock', verify: { auto: true }, planOutputChecks: true, onEvent: (e) => evB.push(e) });
  await exB(planStepWithChecks('t2', ['__IMPOSSIBLE_CHECK_Y__']), '调研一个主题并给出结论', ctx);
  // A 命中、B 未命中 —— 若 A 的 checks 串染进 B（闭包共享状态），B 的判定会与 A 同向；此断言钉死 per-step 计算。
  assert.strictEqual(evA.find((e) => e.type === 'verify:result').passed, true, 'A 的 checks 命中');
  assert.strictEqual(evB.find((e) => e.type === 'verify:result').passed, false, 'B 按自身 checks 判未通过');
});

test('P4.5：无 taskMeta 的普通 step + planOutputChecks → 回落 executor 级验证器（零回归）', async () => {
  const { verifyEvents } = await runExecutor(
    { mode: 'mock', verify: { auto: true }, planOutputChecks: true },
    { id: 'plain', agentRef: 'default' }
  );
  // 行为与无 planOutputChecks 完全一致：仅规则过程门禁（1 次事件）。
  assert.strictEqual(verifyEvents.length, 1);
  assert.strictEqual(verifyEvents[0].passed, true, 'mock 通用应答通过规则门禁');
});

test('P4.5：未开 planOutputChecks 时 outputChecks 不生效（开关门控，零回归）', async () => {
  const { verifyEvents } = await runExecutor(
    { mode: 'mock', verify: { auto: true } }, // 无 planOutputChecks
    planStepWithChecks('t1', ['__IMPOSSIBLE_CHECK__'])
  );
  // 开关关：taskMeta.outputChecks 被忽略，仅规则门禁 → 1 次事件且通过。
  assert.strictEqual(verifyEvents.length, 1);
  assert.strictEqual(verifyEvents[0].passed, true);
});

test('P4.5：taskMeta 非法 JSON + planOutputChecks → 不阻断，回落 executor 级验证器', async () => {
  const step = {
    id: 'bad',
    agentRef: 'default',
    inputMapping: { taskMeta: '{not-json' }
  };
  const { out, verifyEvents } = await runExecutor(
    { mode: 'mock', verify: { auto: true }, planOutputChecks: true },
    step
  );
  assert.ok(out, 'step 正常完成');
  assert.strictEqual(verifyEvents.length, 1);
  assert.strictEqual(verifyEvents[0].passed, true, '回落规则门禁');
});

test('P4.5：verifyMaxRetries 选项优先于 AGENT_VERIFY_MAX_RETRIES env', async () => {
  const prev = process.env.AGENT_VERIFY_MAX_RETRIES;
  process.env.AGENT_VERIFY_MAX_RETRIES = '3';
  try {
    // env 说 3 次，opts 说 0 次 → 以 opts 为准（plan 桥由 server 注入 AGENT_PLAN_VERIFY_RETRIES 值）。
    const { verifyEvents } = await runExecutor(
      {
        mode: 'mock',
        verify: { assertions: [{ contains: '__UNPOSSIBLE_SUBSTRING__' }] },
        verifyMaxRetries: 0
      }
    );
    assert.strictEqual(verifyEvents.length, 1, 'opts.verifyMaxRetries=0 覆盖 env=3 → 仅标记不重跑');
  } finally {
    if (prev === undefined) delete process.env.AGENT_VERIFY_MAX_RETRIES;
    else process.env.AGENT_VERIFY_MAX_RETRIES = prev;
  }
});
