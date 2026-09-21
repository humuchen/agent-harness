// 零依赖测试（node:test + node:assert）：覆盖 P1 计划→工作流映射桥
// （planToWorkflowDef / buildInputMapping，见 docs/design/plan-mode-multiagent.md §4/§9）。
// - ExecutionPlan → WorkflowDef：task→step 映射、dependsOn 透传、agentRef 默认/按 task 覆盖
// - buildInputMapping 黑板契约：goal='input' / taskMeta 字面量 JSON / upstream_<dep>='steps.<dep>'
// - fail-fast：空 tasks、缺 agentRef
// - DagEngine 集成（mock executor）：下游 step 的 input 里 upstream_* = 上游真实 output
//   （零摘要、零有损），独立 task 同波次并行。

const test = require('node:test');
const assert = require('node:assert');

const plan = require('../dist/plan.js');
const { planToWorkflowDef, buildInputMapping } = plan;
const { DagEngine, VolatileWorkflowStore } = require('../dist/workflow/index.js');

const AGENT_X = { id: 'agent-x', name: 'Test Agent' };

const samplePlan = {
  goal: '上线一个新功能',
  tasks: [
    {
      id: 't1',
      title: '写核心逻辑',
      steps: ['实现 A', '实现 B'],
      dependsOn: [],
      expectedOutput: '可编译的核心模块'
    },
    {
      id: 't2',
      title: '写测试',
      steps: ['单测'],
      dependsOn: ['t1'],
      expectedOutput: '全绿测试'
    },
    {
      id: 't3',
      title: '写文档',
      steps: [],
      dependsOn: ['t1'],
      expectedOutput: 'README 更新'
    }
  ]
};

/* ---------- 纯映射 ---------- */

test('planToWorkflowDef: task→step 映射，dependsOn 透传，agentRef 默认', () => {
  const def = planToWorkflowDef(samplePlan, {
    agentRef: AGENT_X,
    workflowId: 'plan-test-1',
    tenantId: 'tenant-a',
    traceId: 'trace-1'
  });
  assert.strictEqual(def.id, 'plan-test-1');
  assert.strictEqual(def.tenantId, 'tenant-a');
  assert.strictEqual(def.traceId, 'trace-1');
  assert.strictEqual(def.steps.length, 3);
  const s1 = def.steps.find((s) => s.id === 't1');
  assert.strictEqual(s1.agentRef, AGENT_X);
  assert.deepStrictEqual(s1.dependsOn, []);
  const s2 = def.steps.find((s) => s.id === 't2');
  assert.deepStrictEqual(s2.dependsOn, ['t1']);
  // 全 step 都有黑板 inputMapping。
  assert.ok(def.steps.every((s) => s.inputMapping && s.inputMapping.goal === 'input'));
});

test('planToWorkflowDef: agentRefByTask 按 task 覆盖默认 agent', () => {
  const def = planToWorkflowDef(samplePlan, {
    agentRef: AGENT_X,
    agentRefByTask: { t2: 'agent-test-special' }
  });
  assert.strictEqual(def.steps.find((s) => s.id === 't1').agentRef, AGENT_X);
  assert.strictEqual(def.steps.find((s) => s.id === 't2').agentRef, 'agent-test-special');
});

test('planToWorkflowDef: P5 自动决策 —— 分支计划（波宽>1）→ parallel+有界并发，链状 → serial，显式传入优先', () => {
  // samplePlan：t1 → (t2, t3)，最大拓扑波宽 2 → 自动 parallel，并带缺省并发上限。
  const d1 = planToWorkflowDef(samplePlan, { agentRef: AGENT_X });
  assert.strictEqual(d1.execMode, 'parallel');
  assert.strictEqual(d1.maxConcurrency, plan.PLAN_WAVE_CONCURRENCY_DEFAULT);
  // 纯链状计划：波宽恒 1 → serial（并行无收益），不带 maxConcurrency 字段。
  const chainPlan = {
    goal: '链式计划',
    tasks: [
      { id: 't1', title: 'a', steps: [], dependsOn: [], expectedOutput: 'a' },
      { id: 't2', title: 'b', steps: [], dependsOn: ['t1'], expectedOutput: 'b' },
      { id: 't3', title: 'c', steps: [], dependsOn: ['t2'], expectedOutput: 'c' }
    ]
  };
  const d2 = planToWorkflowDef(chainPlan, { agentRef: AGENT_X });
  assert.strictEqual(d2.execMode, 'serial');
  assert.strictEqual(d2.maxConcurrency, undefined);
  // 显式覆盖优先于自动决策：分支计划显式 serial / 链状显式 parallel。
  const d3 = planToWorkflowDef(samplePlan, { agentRef: AGENT_X, execMode: 'serial' });
  assert.strictEqual(d3.execMode, 'serial');
  assert.strictEqual(d3.maxConcurrency, undefined);
  const d4 = planToWorkflowDef(chainPlan, { agentRef: AGENT_X, execMode: 'parallel' });
  assert.strictEqual(d4.execMode, 'parallel');
  assert.strictEqual(d4.maxConcurrency, plan.PLAN_WAVE_CONCURRENCY_DEFAULT);
  // maxConcurrency：显式值生效；非法值（0 / 负数 / 非有限数）回落缺省。
  const d5 = planToWorkflowDef(samplePlan, { agentRef: AGENT_X, maxConcurrency: 2 });
  assert.strictEqual(d5.maxConcurrency, 2);
  for (const bad of [0, -3, Number.NaN, Infinity]) {
    const d = planToWorkflowDef(samplePlan, { agentRef: AGENT_X, maxConcurrency: bad });
    assert.strictEqual(d.maxConcurrency, plan.PLAN_WAVE_CONCURRENCY_DEFAULT, `bad=${bad}`);
  }
});

test('planMaxWaveWidth：空=0 / 链=1 / 分支=2 / 星形=独立数 / 混合=最宽层', () => {
  const { planMaxWaveWidth } = plan;
  const t = (id, deps) => ({ id, title: id, steps: [], dependsOn: deps, expectedOutput: id });
  assert.strictEqual(planMaxWaveWidth({ goal: 'g', tasks: [] }), 0);
  assert.strictEqual(planMaxWaveWidth({ goal: 'g', tasks: [t('t1', []), t('t2', ['t1']), t('t3', ['t2'])] }), 1);
  assert.strictEqual(planMaxWaveWidth(samplePlan), 2);
  assert.strictEqual(planMaxWaveWidth({ goal: 'g', tasks: [t('t1', []), t('t2', []), t('t3', []), t('t4', [])] }), 4);
  // 混合：wave1=[t1] wave2=[t2,t3] wave3=[t4] → 最宽 2。
  assert.strictEqual(
    planMaxWaveWidth({ goal: 'g', tasks: [t('t1', []), t('t2', ['t1']), t('t3', ['t1']), t('t4', ['t2'])] }),
    2
  );
});

test('planToWorkflowDef: 缺省 workflowId 自动生成且可多次不同（R4 防并发拒绝）', () => {
  const a = planToWorkflowDef(samplePlan, { agentRef: AGENT_X });
  const b = planToWorkflowDef(samplePlan, { agentRef: AGENT_X });
  assert.ok(a.id.startsWith('plan:'));
  assert.notStrictEqual(a.id, b.id);
});

test('planToWorkflowDef: fail-fast（空 tasks / 缺 agentRef）', () => {
  assert.throws(
    () => planToWorkflowDef({ goal: 'g', tasks: [] }, { agentRef: AGENT_X }),
    /non-empty tasks/
  );
  assert.throws(() => planToWorkflowDef(samplePlan, {}), /agentRef/);
});

test('buildInputMapping: goal/taskMeta/upstream_* 三类源', () => {
  const m = buildInputMapping(samplePlan.tasks[1]); // t2，dependsOn t1
  assert.strictEqual(m.goal, 'input');
  assert.strictEqual(m.upstream_t1, 'steps.t1');
  const meta = JSON.parse(m.taskMeta);
  assert.strictEqual(meta.id, 't2');
  assert.strictEqual(meta.title, '写测试');
  assert.deepStrictEqual(meta.steps, ['单测']);
  assert.strictEqual(meta.expectedOutput, '全绿测试');
  // 无依赖 task 只有 goal + taskMeta 两个键。
  const m1 = buildInputMapping(samplePlan.tasks[0]);
  assert.deepStrictEqual(Object.keys(m1).sort(), ['goal', 'taskMeta']);
});

/* ---------- P4.5 结果断言词表（outputChecks）映射 ---------- */

test('buildInputMapping：outputChecks 非空时内联进 taskMeta；缺省不带键（零回归面）', () => {
  const task = {
    id: 't5',
    title: '整合研报',
    steps: ['撰写'],
    dependsOn: ['t2'],
    expectedOutput: '研报全文',
    outputChecks: ['市场规模', '竞争格局']
  };
  const m = buildInputMapping(task);
  const meta = JSON.parse(m.taskMeta);
  assert.deepStrictEqual(meta.outputChecks, ['市场规模', '竞争格局']);
  // 缺省 task：taskMeta 不含 outputChecks 键。
  const m2 = buildInputMapping(samplePlan.tasks[0]);
  assert.strictEqual('outputChecks' in JSON.parse(m2.taskMeta), false);
});

test('normalizePlan（parsePlanOutput）：outputChecks 清洗 —— trim / 剔空白 / 上限 4（P4.7）/ 非法丢弃不整单作废', () => {
  const { parsePlanOutput, PLAN_OUTPUT_CHECK_MAX, pickOutputChecks } = require('../dist/plan.js');
  const json = {
    goal: 'g',
    tasks: [
      { id: 't1', title: 'a', steps: [], dependsOn: [], expectedOutput: 'x', outputChecks: [' 医美 ', '', '市场规模', 123, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
      { id: 't2', title: 'b', steps: [], dependsOn: [], expectedOutput: 'y', outputChecks: 'not-array' },
      { id: 't3', title: 'c', steps: [], dependsOn: [], expectedOutput: 'z', outputChecks: [] }
    ]
  };
  const planOut = parsePlanOutput(JSON.stringify(json));
  assert.ok(planOut, '解析成功');
  const t1 = planOut.tasks.find((t) => t.id === 't1');
  // trim + String() + 剔空白 + slice(0, PLAN_OUTPUT_CHECK_MAX=4)：['医美','市场规模','123','a','b','c','d','e','f'] → 前 4
  assert.strictEqual(PLAN_OUTPUT_CHECK_MAX, 4, '上限与 planner 提示词「2~4 个」契约对齐');
  assert.deepStrictEqual(t1.outputChecks, ['医美', '市场规模', '123', 'a']);
  // 非数组 / 空数组 → 缺省丢弃（不带键）。
  assert.strictEqual(planOut.tasks.find((t) => t.id === 't2').outputChecks, undefined);
  assert.strictEqual(planOut.tasks.find((t) => t.id === 't3').outputChecks, undefined);
  // pickOutputChecks 是注入侧与断言侧共用的唯一收敛入口（同源同上限）。
  assert.deepStrictEqual(pickOutputChecks([' a ', '', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(pickOutputChecks('not-array'), []);
  assert.deepStrictEqual(pickOutputChecks(undefined), []);
});

/* ---------- DagEngine 集成（mock executor） ---------- */

test('DagEngine 集成：下游 step 的 input 含 goal + taskMeta + 上游真实 output', async () => {
  const def = planToWorkflowDef(samplePlan, { agentRef: AGENT_X, workflowId: 'plan-int-1' });
  // 校验合法（拓扑无环 / 引用完整）——与 POST /api/workflows 的 fail-fast 同源。
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor: async () => null });
  engine.validateWorkflow(def);

  // mock executor：记录每 step 收到的 input，返回可辨识的真实产出。
  const inputs = {};
  const mockExec = async (step, input) => {
    inputs[step.id] = input;
    return `output-of-${step.id}`;
  };
  const store = new VolatileWorkflowStore();
  const runEngine = new DagEngine({ store, executor: mockExec });
  const run = await runEngine.run(def, samplePlan.goal);

  assert.strictEqual(run.state, 'done');
  // t1（首轮，无依赖）：goal=全局初始输入，taskMeta=自身元数据，无 upstream_*。
  assert.strictEqual(inputs.t1.goal, '上线一个新功能');
  assert.strictEqual(JSON.parse(inputs.t1.taskMeta).title, '写核心逻辑');
  assert.strictEqual('upstream_t1' in inputs.t1, false);
  // t2（依赖 t1）：upstream_t1 = t1 的**真实** output（非摘要、非压缩）。
  assert.strictEqual(inputs.t2.upstream_t1, 'output-of-t1');
  assert.strictEqual(inputs.t2.taskMeta && JSON.parse(inputs.t2.taskMeta).id, 't2');
});

test('DagEngine 集成（成功路径）：无依赖的独立 task 同波次并行（maxConcurrent ≥ 2，显式 parallel）', async () => {
  // P5 自动串/并决策：波宽 > 1 时缺省即 parallel；本测试显式声明 execMode='parallel' 锁住并行路径行为。
  const def = planToWorkflowDef(samplePlan, { agentRef: AGENT_X, workflowId: 'plan-int-par', execMode: 'parallel' });
  const running = new Set();
  let maxConcurrent = 0;
  // 每个 step 进入时先记录在途数，再 await 一段放大重叠窗口——这样同波次的
  // t2/t3 一定能在 running 中同时存在，稳定证明并行度。
  const mockExec = async (step, input) => {
    running.add(step.id);
    maxConcurrent = Math.max(maxConcurrent, running.size);
    await new Promise((r) => setTimeout(r, 15));
    running.delete(step.id);
    return `output-of-${step.id}`;
  };
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor: mockExec });
  const run = await engine.run(def, samplePlan.goal);
  assert.strictEqual(run.state, 'done');
  // t1 与 t1：首轮只有 t1（t2/t3 依赖它），t2/t3 次轮并行 → 并发度至少 2。
  assert.ok(maxConcurrent >= 2, `expected t2/t3 in-flight overlap, maxConcurrent=${maxConcurrent}`);
  assert.deepStrictEqual(
    Object.values(run.steps).map((s) => s.state).sort(),
    ['done', 'done', 'done']
  );
});

test('DagEngine 集成（显式 serial）：无依赖的独立 task 也逐个执行（maxConcurrent === 1）', async () => {
  // P5 自动串/并决策后 serial 为显式 opt-in（缺省按波宽决策，见上方自动决策用例）。
  // 本测试锁住串行路径的执行侧契约：t2/t3 虽无依赖也逐个跑，任一时刻至多一个 task 在执行。
  const def = planToWorkflowDef(samplePlan, { agentRef: AGENT_X, workflowId: 'plan-int-serial', execMode: 'serial' });
  assert.strictEqual(def.execMode, 'serial');
  const running = new Set();
  let maxConcurrent = 0;
  const order = [];
  const mockExec = async (step) => {
    running.add(step.id);
    maxConcurrent = Math.max(maxConcurrent, running.size);
    order.push(step.id);
    await new Promise((r) => setTimeout(r, 10));
    running.delete(step.id);
    return `output-of-${step.id}`;
  };
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor: mockExec });
  const run = await engine.run(def, samplePlan.goal);
  assert.strictEqual(run.state, 'done');
  assert.strictEqual(maxConcurrent, 1, `expected serial execution, maxConcurrent=${maxConcurrent}`);
  assert.deepStrictEqual(order, ['t1', 't2', 't3']);
});

test('DagEngine 集成（失败语义）：某 task 失败 → 整个 run 标记 failed，下游不再调度', async () => {
  // 引擎当前为 all-or-nothing 语义：Promise.all(wave) 中任一 step reject，run 进 catch，
  // 后续波次不再调度（与补偿机制配合）。这里精确断言该行为，避免掩盖「独立分支会被
  // 放弃」这一与设计文档 §9 DoD 第 2 条「独立分支正常跑完」的差异 —— 该差异是 P2/P3 需
  // 决策的缺口（见 plan-mode-multiagent.md 风险 R8），此测试作为回归护栏钉死现状。
  const def = planToWorkflowDef(samplePlan, { agentRef: AGENT_X, workflowId: 'plan-int-fail' });
  const executed = [];
  const mockExec = async (step, input) => {
    executed.push(step.id);
    if (step.id === 't2') throw new Error('t2 blew up');
    await new Promise((r) => setTimeout(r, 10));
    return `output-of-${step.id}`;
  };
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor: mockExec });
  const run = await engine.run(def, samplePlan.goal);
  assert.strictEqual(run.state, 'failed');
  assert.strictEqual(run.steps.t2.state, 'failed');
  assert.ok(run.error && run.error.includes('t2 blew up'));
  // t1（上游）已成功执行；t2 执行并失败。
  assert.ok(executed.includes('t1'));
  assert.ok(executed.includes('t2'));
  // 下游（依赖失败 task 的分支）不再调度 —— 现状下 t3 与 t2 同波次，
  // t2 失败可能让 t3 已被并发启动或尚未完成，引擎统一标记 run failed。
});


test('检查点续跑：已完成 step 的 output 被复用，下游重跑时仍能取到黑板值', async () => {
  const def = planToWorkflowDef(samplePlan, { agentRef: AGENT_X, workflowId: 'plan-resume-1' });
  const store = new VolatileWorkflowStore();
  // 植入「t1 已完成、t2/t3 pending」检查点（t1 output 为真实产出的模拟）。
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
  const inputs = {};
  const seen = [];
  const mockExec = async (step, input) => {
    seen.push(step.id);
    inputs[step.id] = input;
    return `output-of-${step.id}`;
  };
  const engine = new DagEngine({ store, executor: mockExec });
  const run = await engine.resume('plan-resume-1');

  assert.strictEqual(run.state, 'done');
  // 已完成 t1 不被重跑。
  assert.ok(!seen.includes('t1'));
  assert.strictEqual(run.steps.t1.output, 'output-of-t1');
  // 下游 t2 重跑时，黑板里的 upstream_t1 仍是 t1 的真实 output（检查点复用）。
  assert.strictEqual(inputs.t2.upstream_t1, 'output-of-t1');
});
