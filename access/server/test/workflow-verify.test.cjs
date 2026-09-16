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

test('断言必失败 + AGENT_VERIFY_MAX_RETRIES=1：反思循环产生 2 次 verify:result', async () => {
  const prev = process.env.AGENT_VERIFY_MAX_RETRIES;
  process.env.AGENT_VERIFY_MAX_RETRIES = '1';
  try {
    const { out, verifyEvents } = await runExecutor({
      mode: 'mock',
      verify: { assertions: [{ contains: '__UNPOSSIBLE_SUBSTRING__' }] }
    });
    assert.strictEqual(verifyEvents.length, 2, '初次校验 + 1 次自检重跑');
    assert.ok(verifyEvents.every((e) => e.passed === false), '不可能的断言两次都应不通过');
    assert.ok(typeof out === 'string' && out.length > 0, 'step 仍返回产出（未通过时标记 [verify:failed]）');
  } finally {
    if (prev === undefined) delete process.env.AGENT_VERIFY_MAX_RETRIES;
    else process.env.AGENT_VERIFY_MAX_RETRIES = prev;
  }
});
