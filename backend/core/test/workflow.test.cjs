// 零依赖测试（node:test + node:assert）：覆盖 P1-⑤ 工作流编排引擎。
// - DAG 拓扑并行 + 依赖顺序 + inputMapping 取上游输出
// - 失败补偿（completed step 逆序执行 compensate）
// - 检查点续跑（resume 从断点继续，已完成 step 不被重跑）
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
