// 零依赖测试（node:test + node:assert）：覆盖 P1-⑤ 工作流编排引擎。
// - DAG 拓扑并行 + 依赖顺序 + inputMapping 取上游输出
// - 失败补偿（completed step 逆序执行 compensate）
// - 检查点续跑（resume 从断点继续，已完成 step 不被重跑）
// - P5 有界并发（maxConcurrency 工作池：峰值锁定 / 非法值回落不限并发 / fail-fast 不拉新 / resume 同样有界）
// - 成环检测（fail-fast）
// - WorkflowStore（Volatile / File）save/get
// - HarnessEvent 的 run:meta 元数据通道（agentId/workflowId/traceId/tenantId）

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const wf = require('../dist/workflow/index.js');
const { DagEngine, VolatileWorkflowStore, FileWorkflowStore } = wf;
const { getAgentRegistry, makeDefaultAgentCard, DEFAULT_AGENT_ID } = require('../dist/agents/index.js');
const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry } = require('../dist/tools.js');

// 注入式 mock executor：按 step.id 决定回显或抛错，便于断言 DAG / 补偿行为。
function makeExecutor({ fail = new Set(), transform } = {}) {
  return async (step, input) => {
    if (fail.has(step.id)) throw new Error(`step ${step.id} failed`);
    const out = transform ? transform(step, input) : { step: step.id, got: input };
    return out;
  };
}

test('DAG: 依赖 step 在 upstream 之后执行，inputMapping 取到上游输出', async () => {
  const def = {
    id: 'wf-dag',
    steps: [
      { id: 's1', agentRef: DEFAULT_AGENT_ID, inputMapping: { q: 'input' } },
      { id: 's2', agentRef: DEFAULT_AGENT_ID, dependsOn: ['s1'], inputMapping: { prev: 'steps.s1' } },
    ],
  };
  const store = new VolatileWorkflowStore();
  const engine = new DagEngine({ store, executor: makeExecutor() });
  const run = await engine.run(def, 'hello');

  assert.strictEqual(run.state, 'done');
  assert.strictEqual(run.steps.s1.state, 'done');
  assert.strictEqual(run.steps.s2.state, 'done');
  // inputMapping 把上游输出包进结构化输入 { prev: <s1 输出> }，executor 回显在 got 下。
  assert.strictEqual(run.steps.s2.output.got.prev.step, 's1');
  assert.strictEqual(run.steps.s2.output.got.prev.got.q, 'hello');
  assert.strictEqual(run.steps.s1.output.got.q, 'hello');
  // 落盘 + 可回查。
  const stored = await store.get('wf-dag');
  assert.ok(stored && stored.state === 'done');
});

test('DAG: 无依赖的 step 并行执行', async () => {
  const def = {
    id: 'wf-par',
    steps: [
      { id: 'a', agentRef: DEFAULT_AGENT_ID },
      { id: 'b', agentRef: DEFAULT_AGENT_ID },
    ],
  };
  const order = [];
  const executor = async (step) => {
    order.push(step.id);
    return { step: step.id };
  };
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor });
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'done');
  assert.strictEqual(run.steps.a.state, 'done');
  assert.strictEqual(run.steps.b.state, 'done');
  // 两者都在首轮（同一波次）执行。
  assert.deepStrictEqual(order.sort(), ['a', 'b']);
});

test('P5 serial: execMode=serial 时无依赖 step 也按定义顺序逐个执行（单步发送）', async () => {
  const def = {
    id: 'wf-serial',
    execMode: 'serial',
    steps: [
      { id: 'a', agentRef: DEFAULT_AGENT_ID },
      { id: 'b', agentRef: DEFAULT_AGENT_ID },
      { id: 'c', agentRef: DEFAULT_AGENT_ID },
    ],
  };
  const order = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const executor = async (step) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    order.push(step.id);
    // 人为让出事件循环：并行模式下 a/b/c 会交错（maxConcurrent>1），串行必然逐个。
    await new Promise((r) => setTimeout(r, 5));
    concurrent -= 1;
    return { step: step.id };
  };
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor });
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'done');
  // 严格按定义顺序（无依赖 → 同一波次，串行按波内声明序）。
  assert.deepStrictEqual(order, ['a', 'b', 'c']);
  assert.strictEqual(maxConcurrent, 1, '任一时刻至多一个 step 在执行');
});

test('P5 serial: resume 同样串行执行且只重跑未完成 step', async () => {
  const def = {
    id: 'wf-serial-resume',
    execMode: 'serial',
    steps: [
      { id: 'a', agentRef: DEFAULT_AGENT_ID },
      { id: 'b', agentRef: DEFAULT_AGENT_ID, dependsOn: ['a'] },
    ],
  };
  const store = new VolatileWorkflowStore();
  // 首跑 b 失败（a 完成）。
  let failB = true;
  const executor = async (step) => {
    if (step.id === 'b' && failB) throw new Error('b failed');
    return { step: step.id };
  };
  const engine = new DagEngine({ store, executor });
  const run1 = await engine.run(def, 'x');
  assert.strictEqual(run1.state, 'failed');
  assert.strictEqual(run1.steps.a.state, 'done');
  assert.strictEqual(run1.steps.b.state, 'failed');
  // 续跑：b 修复后完成（串行语义不影响断点续跑）。
  failB = false;
  const run2 = await engine.resume('wf-serial-resume');
  assert.strictEqual(run2.state, 'done');
  assert.strictEqual(run2.steps.a.state, 'done');
  assert.strictEqual(run2.steps.b.state, 'done');
});

test('P5 有界并发: maxConcurrency=2 时同波次 4 个 step 峰值并发恰为 2（工作池保序补位）', async () => {
  const def = {
    id: 'wf-bounded',
    execMode: 'parallel',
    maxConcurrency: 2,
    steps: [
      { id: 'a', agentRef: DEFAULT_AGENT_ID },
      { id: 'b', agentRef: DEFAULT_AGENT_ID },
      { id: 'c', agentRef: DEFAULT_AGENT_ID },
      { id: 'd', agentRef: DEFAULT_AGENT_ID },
    ],
  };
  let concurrent = 0;
  let maxConcurrent = 0;
  const order = [];
  const executor = async (step) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    order.push(step.id);
    await new Promise((r) => setTimeout(r, 15));
    concurrent -= 1;
    return { step: step.id };
  };
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor });
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'done');
  assert.strictEqual(maxConcurrent, 2, `期望峰值并发恰为 2，实际 ${maxConcurrent}`);
  // 工作池按波内声明序保序取任务、完成一个补一个：单线程事件循环下取任务顺序确定。
  assert.deepStrictEqual(order, ['a', 'b', 'c', 'd']);
});

test('P5 有界并发: 非法 maxConcurrency 回落为不限并发（存量全并行语义零回归）', async () => {
  for (const bad of [0, -3, NaN, Infinity]) {
    const def = {
      id: 'wf-bounded-bad',
      execMode: 'parallel',
      maxConcurrency: bad,
      steps: [
        { id: 'a', agentRef: DEFAULT_AGENT_ID },
        { id: 'b', agentRef: DEFAULT_AGENT_ID },
        { id: 'c', agentRef: DEFAULT_AGENT_ID },
        { id: 'd', agentRef: DEFAULT_AGENT_ID },
      ],
    };
    let concurrent = 0;
    let maxConcurrent = 0;
    const executor = async (step) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent -= 1;
      return { step: step.id };
    };
    // 每轮独立 store，避免 def.id 撞 running 检查点。
    const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor });
    const run = await engine.run(def, 'x');
    assert.strictEqual(run.state, 'done', `bad=${bad}`);
    assert.strictEqual(maxConcurrent, 4, `bad=${bad} 时应回落为全并发（峰值 4）`);
  }
});

test('P5 有界并发: 某 step 失败后工作池 fail-fast，不再拉起新任务（在途自然跑完）', async () => {
  const def = {
    id: 'wf-bounded-failfast',
    execMode: 'parallel',
    maxConcurrency: 2,
    steps: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, agentRef: DEFAULT_AGENT_ID })),
  };
  const executed = [];
  const executor = async (step) => {
    executed.push(step.id);
    if (step.id === 'a') throw new Error('a failed');
    await new Promise((r) => setTimeout(r, 20));
    return { step: step.id };
  };
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor });
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'failed');
  assert.ok(run.error && run.error.includes('a failed'));
  assert.strictEqual(run.steps.a.state, 'failed');
  // 两个 worker 先各拉取一个任务（同步取任务先于任何 microtask），a 立即失败置 failed；
  // 在途的 b 自然跑完；c-f 不再被拉起。
  assert.ok(executed.includes('b'), '已拉起的在途任务应自然跑完');
  for (const id of ['c', 'd', 'e', 'f']) {
    assert.strictEqual(run.steps[id].state, 'pending', `${id} 不应在 fail-fast 后被拉起`);
  }
  assert.ok(executed.length <= 2, `fail-fast 后最多执行 a+b 两个，实际 ${executed.length}`);
});

test('P5 有界并发: resume 同样走工作池（maxConcurrency=2，已完成 step 复用不被重跑）', async () => {
  const def = {
    id: 'wf-bounded-resume',
    execMode: 'parallel',
    maxConcurrency: 2,
    steps: [
      { id: 'a', agentRef: DEFAULT_AGENT_ID },
      { id: 'b', agentRef: DEFAULT_AGENT_ID, dependsOn: ['a'] },
      { id: 'c', agentRef: DEFAULT_AGENT_ID, dependsOn: ['a'] },
      { id: 'd', agentRef: DEFAULT_AGENT_ID, dependsOn: ['a'] },
    ],
  };
  const store = new VolatileWorkflowStore();
  // 植入「a 已完成、b/c/d pending」检查点。
  await store.save({
    def,
    state: 'running',
    steps: {
      a: { id: 'a', state: 'done', output: 'done-out' },
      b: { id: 'b', state: 'pending' },
      c: { id: 'c', state: 'pending' },
      d: { id: 'd', state: 'pending' },
    },
    startedAt: Date.now(),
  });
  let concurrent = 0;
  let maxConcurrent = 0;
  const executor = async (step) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 10));
    concurrent -= 1;
    return { step: step.id };
  };
  const engine = new DagEngine({ store, executor });
  const run = await engine.resume('wf-bounded-resume');
  assert.strictEqual(run.state, 'done');
  assert.strictEqual(run.steps.a.output, 'done-out', '已完成的 a 输出应被复用，不被重跑');
  assert.strictEqual(maxConcurrent, 2, 'b/c/d 同波次，峰值并发应为 2');
});

test('失败补偿：完成 step 逆序执行 compensate', async () => {
  const def = {
    id: 'wf-comp',
    steps: [
      { id: 's1', agentRef: DEFAULT_AGENT_ID, compensate: 'c1' },
      { id: 's2', agentRef: DEFAULT_AGENT_ID, dependsOn: ['s1'] },
      { id: 'c1', agentRef: DEFAULT_AGENT_ID },
    ],
  };
  const store = new VolatileWorkflowStore();
  const engine = new DagEngine({ store, executor: makeExecutor({ fail: new Set(['s2']) }) });
  const run = await engine.run(def, 'go');

  assert.strictEqual(run.state, 'failed');
  assert.ok(run.error && run.error.includes('s2 failed'));
  // s1 已完成，s2 失败 → 触发补偿：c1 被执行并标记为 compensated。
  assert.strictEqual(run.steps.s1.state, 'done');
  assert.strictEqual(run.steps.s2.state, 'failed');
  assert.strictEqual(run.steps.c1.state, 'compensated');
});

test('检查点续跑：resume 仅执行未完成 step，已完成输出被复用', async () => {
  const def = {
    id: 'wf-resume',
    steps: [
      { id: 's1', agentRef: DEFAULT_AGENT_ID },
      { id: 's2', agentRef: DEFAULT_AGENT_ID, dependsOn: ['s1'] },
    ],
  };
  const store = new VolatileWorkflowStore();
  // 手工植入一个「s1 已完成、s2 未完成」的检查点。
  await store.save({
    def,
    state: 'running',
    steps: {
      s1: { id: 's1', state: 'done', output: 'done-out' },
      s2: { id: 's2', state: 'pending' },
    },
    startedAt: Date.now(),
  });
  const engine = new DagEngine({ store, executor: makeExecutor() });
  const run = await engine.resume('wf-resume');

  assert.strictEqual(run.state, 'done');
  assert.strictEqual(run.steps.s1.output, 'done-out', '已完成的 s1 输出应被复用，不被重跑');
  assert.strictEqual(run.steps.s2.state, 'done');
});

test('成环检测：非法 dependsOn 直接抛错（fail-fast）', async () => {
  const def = {
    id: 'wf-cycle',
    steps: [
      { id: 'x', agentRef: DEFAULT_AGENT_ID, dependsOn: ['y'] },
      { id: 'y', agentRef: DEFAULT_AGENT_ID, dependsOn: ['x'] },
    ],
  };
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor: makeExecutor() });
  await assert.rejects(() => engine.run(def, 'x'), /cycle|depends on/);
});

test('并发护栏：同 def.id 存在另一 runId 的 running 检查点时，新 run 被拒绝（不互相覆盖）', async () => {
  const store = new VolatileWorkflowStore();
  const def = { id: 'wf-concurrent', steps: [{ id: 's', agentRef: DEFAULT_AGENT_ID }] };
  // 模拟：另一个执行体（runId=A）正在跑，检查点落盘为 running。
  await store.save({ def, state: 'running', runId: 'A', steps: { s: { id: 's', state: 'running' } } });
  const engine = new DagEngine({ store, executor: makeExecutor() });
  await assert.rejects(() => engine.run(def, 'go'), /already has a running execution/);
  // 原执行体正常续跑不受影响。
  const resumed = await engine.resume('wf-concurrent');
  assert.strictEqual(resumed.runId, 'A', 'resume 应沿用原 runId');
  assert.strictEqual(resumed.state, 'done');
});

test('崩溃残留：同 def.id 有 running 检查点时新 run 仍被拒绝（合法恢复路径只有 resume）', async () => {
  const store = new VolatileWorkflowStore();
  const def = { id: 'wf-retry', steps: [{ id: 's', agentRef: DEFAULT_AGENT_ID }] };
  // 先正常跑一次拿到 runId，再模拟「崩溃残留」：检查点停在 running。
  const myRunId = await new DagEngine({ store, executor: makeExecutor() }).run(def, 'first')
    .then((r) => r.runId);
  assert.ok(myRunId, 'run 快照应携带 runId');
  await store.save({ def, state: 'running', runId: myRunId, steps: { s: { id: 's', state: 'running' } } });
  const engine = new DagEngine({ store, executor: makeExecutor() });
  // 新 run 生成新 runId → 与残留的 running 检查点冲突，必须拒绝（防检查点互踩）。
  await assert.rejects(() => engine.run(def, 'go'), /already has a running execution/);
  // resume 是合法恢复路径：沿用原 runId 继续。
  const resumed = await engine.resume('wf-retry');
  assert.strictEqual(resumed.runId, myRunId, 'resume 应沿用原 runId');
  assert.strictEqual(resumed.state, 'done');
});

test('补偿上下文：compensateInput 落盘，resume 重试时补偿幂等不重复执行', async () => {
  const store = new VolatileWorkflowStore();
  const def = {
    id: 'wf-comp-input',
    steps: [
      { id: 's1', agentRef: DEFAULT_AGENT_ID, onRolling: ['c1'] },
      { id: 's2', agentRef: DEFAULT_AGENT_ID, dependsOn: ['s1'] },
      { id: 'c1', agentRef: DEFAULT_AGENT_ID, dependsOn: ['s1'] },
    ],
  };
  let compExecutions = 0;
  let s2Attempts = 0;
  const executor = async (step, input, ctx) => {
    // 只统计「补偿语义」调用（ctx.compensate=true），排除 c1 作为普通 DAG step 的正常执行。
    if (step.id === 'c1' && ctx?.compensate) compExecutions += 1;
    // 瞬态失败：仅首次执行 s2 时抛错，resume 重试即成功（模拟网络抖动）。
    if (step.id === 's2' && s2Attempts === 0) {
      s2Attempts += 1;
      throw new Error('transient s2 failure');
    }
    return { step: step.id };
  };
  const engine = new DagEngine({ store, executor });
  const run = await engine.run(def, 'go');
  assert.strictEqual(run.state, 'failed');
  assert.strictEqual(run.steps.c1.state, 'compensated');
  assert.deepStrictEqual(run.steps.c1.compensateInput, { step: 's1' }, '补偿输入应落盘');
  const firstCount = compExecutions;
  assert.strictEqual(firstCount, 1);
  // resume：s2 重新执行（本次成功）→ 整个 run 完成；已 compensated 的 c1 不重复回滚。
  const run2 = await engine.resume('wf-comp-input');
  assert.strictEqual(run2.state, 'done');
  assert.strictEqual(compExecutions, firstCount, '已 compensated 的 step 在 resume 时不重复补偿');
});

test('WorkflowStore: File 后端 save/get 原子落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-store-'));
  try {
    const store = new FileWorkflowStore({ dir });
    const def = { id: 'wf-file', steps: [{ id: 's', agentRef: DEFAULT_AGENT_ID }] };
    const run = { def, state: 'done', steps: { s: { id: 's', state: 'done' } }, startedAt: 1, finishedAt: 2 };
    await store.save(run);
    const got = await store.get('wf-file');
    assert.ok(got && got.state === 'done' && got.steps.s.state === 'done');
    const list = await store.list();
    assert.strictEqual(list.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run:meta: harness 在传入 agentId/workflowId/traceId/tenantId 时发出 run:meta', async () => {
  const events = [];
  const harness = new AgentHarness({
    llm: async () => ({ content: 'done', tool_calls: [] }),
    tools: new ToolRegistry(),
    onEvent: (e) => events.push(e),
    agentId: 'agentX',
    workflowId: 'wfX',
    traceId: 'trX',
    tenantId: 'tX',
  });
  const final = await harness.run('hello');
  assert.strictEqual(final, 'done');
  const meta = events.find((e) => e.type === 'run:meta');
  assert.ok(meta, '应发出 run:meta 事件');
  assert.strictEqual(meta.agentId, 'agentX');
  assert.strictEqual(meta.workflowId, 'wfX');
  assert.strictEqual(meta.traceId, 'trX');
  assert.strictEqual(meta.tenantId, 'tX');
});

test('run:meta: 未传元数据时不发出 run:meta（向后兼容零字段）', async () => {
  const events = [];
  const harness = new AgentHarness({
    llm: async () => ({ content: 'ok', tool_calls: [] }),
    tools: new ToolRegistry(),
    onEvent: (e) => events.push(e),
  });
  await harness.run('hi');
  assert.strictEqual(events.some((e) => e.type === 'run:meta'), false);
});
