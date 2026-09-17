// 零依赖测试（node:test + node:assert）：P4.5 产出有效性闸门。
// 覆盖（docs/design/plan-mode-multiagent.md §9.6）：
// - inspectStepOutput 检测器：empty / partial / fallback / ok 四态 + 非字符串不越界
// - 引擎成功出口闸门（def.failOnInvalidOutput）：
//   计划桥 def（planToWorkflowDef）下 空 / 中断 / 护栏兜底产出 → step failed + run failed
//   （配合既有补偿 / 级联 / 断点续跑通道）；干净产出 → done（零回归）
// - 存量手工 def（未开闸门）：无效产出仍 done，仅记录 outputIssue（逐字对照旧行为）
// - resume 路径：检查点续跑时闸门同样生效
//
// 运行：pnpm --filter @agent-harness/server... build && node --test backend/core/test/step-output-gate.test.cjs

const test = require('node:test');
const assert = require('node:assert');

const plan = require('../dist/plan.js');
const { planToWorkflowDef } = plan;
const {
  DagEngine,
  VolatileWorkflowStore,
  inspectStepOutput,
  PARTIAL_NOTICE,
  GUARDRAIL_FALLBACK_PREFIX
} = require('../dist/workflow/index.js');

const AGENT_X = { id: 'agent-x', name: 'Test Agent' };

const samplePlan = {
  goal: '产出一份研报',
  tasks: [
    { id: 't1', title: '收集数据', steps: ['搜索'], dependsOn: [], expectedOutput: '数据表' },
    { id: 't2', title: '分析', steps: ['建模'], dependsOn: ['t1'], expectedOutput: '分析结论' },
    { id: 't3', title: '整合', steps: ['撰写'], dependsOn: ['t2'], expectedOutput: '研报全文' }
  ]
};

const CLEAN = '完整的研报产出：一、市场规模 二、竞争格局';
const EMPTY_LIKE = '';
const PARTIAL_LIKE = '写了一半…\n\n' + PARTIAL_NOTICE + '：连接空闲超时';
const FALLBACK_LIKE = GUARDRAIL_FALLBACK_PREFIX + '。如有进一步需求，建议您通过官方正规渠道咨询。';

/* ---------- 检测器单测 ---------- */

test('inspectStepOutput：空串 / 纯空白 / null / undefined → empty', () => {
  assert.strictEqual(inspectStepOutput('').issue, 'empty');
  assert.strictEqual(inspectStepOutput('   \n  ').issue, 'empty');
  assert.strictEqual(inspectStepOutput(null).issue, 'empty');
  assert.strictEqual(inspectStepOutput(undefined).issue, 'empty');
});

test('inspectStepOutput：干净文本 / 非字符串 → ok（不越界判断对象内容）', () => {
  assert.strictEqual(inspectStepOutput(CLEAN).issue, 'ok');
  assert.strictEqual(inspectStepOutput({ key: 'val' }).issue, 'ok');
  assert.strictEqual(inspectStepOutput([1, 2]).issue, 'ok');
  assert.strictEqual(inspectStepOutput(42).issue, 'ok');
});

test('inspectStepOutput：含中断标记 → partial（detail 说明截断）', () => {
  const r = inspectStepOutput(PARTIAL_LIKE);
  assert.strictEqual(r.issue, 'partial');
  assert.ok(r.detail && r.detail.length > 0);
});

test('inspectStepOutput：以护栏兜底话术开头 → fallback', () => {
  assert.strictEqual(inspectStepOutput(FALLBACK_LIKE).issue, 'fallback');
  // 兜底话术嵌在中间不算 fallback（避免误伤正常引用了该句子的长文）——
  // 以「开头」为准（检测器语义：整段无实质产出的兜底回复）。
  assert.strictEqual(inspectStepOutput('正常内容开头…' + FALLBACK_LIKE).issue, 'ok');
});

/* ---------- 引擎闸门（计划桥 def：failOnInvalidOutput=true） ---------- */

async function runPlanWithExecutor(exec) {
  const def = planToWorkflowDef(samplePlan, { agentRef: AGENT_X, workflowId: 'gate-' + Math.random().toString(36).slice(2) });
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor: exec });
  return engine.run(def, samplePlan.goal);
}

test('闸门开（plan def）：干净产出 → run done（零回归基线）', async () => {
  const run = await runPlanWithExecutor(async (step) => `output-of-${step.id}`);
  assert.strictEqual(run.state, 'done');
  assert.ok(Object.values(run.steps).every((s) => s.state === 'done'));
  assert.strictEqual(run.steps.t2.outputIssue, undefined);
});

test('闸门开（plan def）：空产出 → step failed + run failed + error 标注', async () => {
  const run = await runPlanWithExecutor(async (step) => (step.id === 't2' ? EMPTY_LIKE : `output-of-${step.id}`));
  assert.strictEqual(run.state, 'failed');
  assert.strictEqual(run.steps.t2.state, 'failed');
  assert.strictEqual(run.steps.t2.outputIssue, 'empty');
  assert.ok(run.error && run.error.includes('无效产出（empty）'), `error=${run.error}`);
});

test('闸门开（plan def）：中断产出（partial 标记）→ step failed', async () => {
  const run = await runPlanWithExecutor(async (step) => (step.id === 't2' ? PARTIAL_LIKE : `output-of-${step.id}`));
  assert.strictEqual(run.state, 'failed');
  assert.strictEqual(run.steps.t2.state, 'failed');
  assert.strictEqual(run.steps.t2.outputIssue, 'partial');
  assert.ok(run.error.includes('无效产出（partial）'));
});

test('闸门开（plan def）：护栏兜底产出 → step failed（消灭 5/5 ✅ 假成功）', async () => {
  const run = await runPlanWithExecutor(async (step) => (step.id === 't2' ? FALLBACK_LIKE : `output-of-${step.id}`));
  assert.strictEqual(run.state, 'failed');
  assert.strictEqual(run.steps.t2.state, 'failed');
  assert.strictEqual(run.steps.t2.outputIssue, 'fallback');
});

test('planToWorkflowDef：生成的 def 默认开启 failOnInvalidOutput', () => {
  const def = planToWorkflowDef(samplePlan, { agentRef: AGENT_X });
  assert.strictEqual(def.failOnInvalidOutput, true);
});

/* ---------- 存量手工 def（未开闸门）：零回归钉死 ---------- */

test('闸门关（手工 def）：无效产出仍 done，仅记录 outputIssue（旧行为逐字不变）', async () => {
  const def = { id: 'plain-gate', steps: [{ id: 'a', agentRef: AGENT_X }] };
  const events = [];
  const engine = new DagEngine({
    store: new VolatileWorkflowStore(),
    executor: async () => EMPTY_LIKE,
    onEvent: (e) => events.push(e)
  });
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'done');
  assert.strictEqual(run.steps.a.state, 'done');
  // 分类记录在（审计 / 抽屉可用），但不阻断。
  assert.strictEqual(run.steps.a.outputIssue, 'empty');
  // 事件面与旧版一致：done 事件照常发出。
  assert.ok(events.some((e) => e.type === 'wf:step:done'));
});

/* ---------- resume 路径闸门 ---------- */

test('resume（plan def 检查点）：续跑 step 产出无效 → failed + run failed', async () => {
  const def = planToWorkflowDef(samplePlan, { agentRef: AGENT_X, workflowId: 'gate-resume-1' });
  const store = new VolatileWorkflowStore();
  await store.save({
    def,
    state: 'running',
    steps: {
      t1: { id: 't1', state: 'done', output: 'output-of-t1' },
      t2: { id: 't2', state: 'pending' },
      t3: { id: 't3', state: 'pending' }
    },
    startedAt: Date.now()
  });
  const engine = new DagEngine({
    store,
    executor: async (step) => (step.id === 't2' ? FALLBACK_LIKE : `output-of-${step.id}`)
  });
  const run = await engine.resume('gate-resume-1');
  assert.strictEqual(run.state, 'failed');
  assert.strictEqual(run.steps.t2.state, 'failed');
  assert.strictEqual(run.steps.t2.outputIssue, 'fallback');
  // 无效产出细节落在 step.error（resume 的 run.error 为既有固定文案，不改语义）。
  assert.ok(run.steps.t2.error && run.steps.t2.error.includes('无效产出'));
  // 已完成 t1 复用输出不受影响。
  assert.strictEqual(run.steps.t1.output, 'output-of-t1');
});
