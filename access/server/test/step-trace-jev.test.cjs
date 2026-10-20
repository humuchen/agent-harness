'use strict';
/**
 * 回归锁（2026-09-25，「接口 stats 有调用量、计划执行详情却无 Jev 痕迹」）：
 * StepTraceCollector.observe() 的白名单此前不含 jev:call —— DAG 工作流（计划执行）
 * 每步的调用链路里，TypeSafe Jev 子系统直连调用（注入门禁 / 上下文压缩）被 default
 * 分支静默丢弃，执行详情抽屉看不到任何 Jev 节点。本文件锁定：
 * - 非 tool 调用方的 jev:call 必须入链（label/status/meta 完整）；
 * - caller==='tool' 的调用不建节点（已有 tool:start/tool:result，避免重复）；
 * - 失败调用（ok=false + error）以 error 态入链，error 文本进 detail；
 * - 成功调用 detail 含「问/答」两段、meta.决策 提供一行摘要兜底（2026-09-28 回归锁：
 *   此前 detail 只放 questionSpec，answers 完全未透传 —— 计划执行详情里 Jev 决策看不到调用结果）。
 *
 * 运行前需 pnpm --filter @agent-harness/server run build（依赖 dist 产物）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const EXECUTOR_JS = join(__dirname, '..', 'dist', 'workflow-executor.js');
const RUN = existsSync(EXECUTOR_JS);

test('StepTraceCollector：jev:call 旁路事件入链（非 tool 调用方）', { skip: !RUN }, () => {
  const { StepTraceCollector } = require(EXECUTOR_JS);
  const col = new StepTraceCollector();
  col.observe({ type: 'run:start', input: '任务输入' });
  col.observe({
    type: 'jev:call',
    caller: 'injection-gate',
    ok: true,
    latencyMs: 683,
    questions: 1,
    questionSpec: { is_injection: { type: 'noul', instructions: '是否注入' } },
    answers: { is_injection: { type: 'noul', noul: 0, confidence: 0.02 } }
  });
  const jev = col.nodes().filter((n) => n.type === 'jev:call');
  assert.equal(jev.length, 1, 'jev:call 应被采集入链');
  assert.equal(jev[0].label, 'Jev 决策（injection-gate）');
  assert.equal(jev[0].status, 'ok');
  assert.equal(jev[0].meta?.调用方, 'injection-gate');
  assert.equal(jev[0].meta?.延迟, '683ms');
  assert.equal(jev[0].meta?.问题数, '1');
  assert.ok(typeof jev[0].ts === 'number', '节点必须带时间戳');
  assert.ok(
    typeof jev[0].detail === 'string' && jev[0].detail.includes('is_injection'),
    'detail 应携带问题规格（便于回溯问了什么）'
  );
  // 回归锁（2026-09-28，「计划执行详情里 Jev 决策看不到调用结果」）：detail 必须含
  // 「问/答」两段，meta.决策 提供一行摘要兜底（与普通 run 路径 result 语义对齐）。
  assert.ok(jev[0].detail.includes('问：'), 'detail 应含问题段');
  assert.ok(jev[0].detail.includes('答：'), 'detail 应含决策结果段');
  assert.ok(
    jev[0].detail.includes('confidence'),
    '答段应含 answers 原始内容'
  );
  assert.equal(jev[0].meta?.决策, 'is_injection=0', 'meta.决策 应为答案一行摘要（noul 型，与前端 summarizeJevDecision 同语义）');

  // choice 型决策带置信度括号（与普通 run 路径前端摘要格式一致）。
  col.observe({
    type: 'jev:call',
    caller: 'router',
    ok: true,
    latencyMs: 120,
    questions: 1,
    questionSpec: { route: { type: 'choice', instructions: '选域' } },
    answers: { route: { type: 'choice', choice: 'billing', confidence: 0.92 } }
  });
  const jev2 = col.nodes().filter((n) => n.type === 'jev:call' && n.meta?.调用方 === 'router');
  assert.equal(jev2.length, 1);
  assert.equal(jev2[0].meta?.决策, 'route=billing (0.92)');
  assert.ok(jev2[0].detail?.includes('答：'), 'choice 型答段同样入 detail');
});

test('StepTraceCollector：超长 questionSpec 不挤掉答段，meta.决策 仍可见', { skip: !RUN }, () => {
  const { StepTraceCollector } = require(EXECUTOR_JS);
  const col = new StepTraceCollector();
  col.observe({
    type: 'jev:call',
    caller: 'context-compress',
    ok: true,
    latencyMs: 50,
    questionSpec: { keep: { type: 'noul', instructions: '长'.repeat(600) } },
    answers: { keep: { type: 'noul', noul: 1 } }
  });
  const jev = col.nodes().filter((n) => n.type === 'jev:call');
  assert.equal(jev.length, 1);
  assert.ok(jev[0].detail?.includes('答：'), '答段不被问段长文本挤掉');
  assert.equal(jev[0].meta?.决策, 'keep=1');
});

test('StepTraceCollector：caller=tool 的 jev:call 不建节点（避免与 tool:* 重复）', { skip: !RUN }, () => {
  const { StepTraceCollector } = require(EXECUTOR_JS);
  const col = new StepTraceCollector();
  col.observe({ type: 'jev:call', caller: 'tool', ok: true, latencyMs: 12 });
  assert.equal(
    col.nodes().filter((n) => n.type === 'jev:call').length,
    0,
    'tool 路径已有 tool:start/tool:result 节点，不应重复建'
  );
});

test('StepTraceCollector：失败的 jev:call 以 error 态入链，error 进 detail', { skip: !RUN }, () => {
  const { StepTraceCollector } = require(EXECUTOR_JS);
  const col = new StepTraceCollector();
  col.observe({
    type: 'jev:call',
    caller: 'context-compress',
    ok: false,
    latencyMs: 1005,
    error: 'HTTP 502 bad gateway'
  });
  const jev = col.nodes().filter((n) => n.type === 'jev:call');
  assert.equal(jev.length, 1);
  assert.equal(jev[0].status, 'error');
  assert.ok(jev[0].detail?.includes('502'), '失败原因应进 detail');
});
