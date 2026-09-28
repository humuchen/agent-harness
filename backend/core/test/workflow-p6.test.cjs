// 零依赖测试（node:test + node:assert）：P6 引擎增强四件套。
// - 步骤级重试（retries + 指数退避：成功恢复 / 预算耗尽 / 缺省零回归 / 参数校验）
// - 产出 outputSchema 闸门（不合规失败 + 错误信息含路径；未声明零回归）
// - 动态 fan-out（运行期物化 spawn 子任务：并发执行 / 字面量输入 / 失败波次丢弃）
// - step 分叉重跑（resetForRerun：下游重置 + resume 复跑 + running 拒绝）
// - DbWorkflowStore（sqlite 适配器形态：CRUD + claim 原子占位语义 + 引擎适配）

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const wf = require('../dist/workflow/index.js');
const { DagEngine, VolatileWorkflowStore, DbWorkflowStore, downstreamSteps, resetRunForRerun } = wf;
const { DEFAULT_AGENT_ID } = require('../dist/agents/index.js');
const { ToolRegistry, objectParams } = require('../dist/tools.js');
const { validateAgainstSchema } = require('../dist/json-schema.js');
const { getDbAdapter } = require('../dist/db-adapter.js');

function makeExecutor({ failMap = {}, calls = {} } = {}) {
  return async (step, input) => {
    calls[step.id] = (calls[step.id] ?? 0) + 1;
    const failN = failMap[step.id] ?? 0;
    if (calls[step.id] <= failN) throw new Error(`step ${step.id} transient failure #${calls[step.id]}`);
    return { step: step.id, got: input };
  };
}

// ─── 1. 步骤级重试 ───────────────────────────────────────────────────────────

test('P6 retry: 瞬时失败在 retries 预算内重试后成功，attempts/事件/检查点齐备', async () => {
  const calls = {};
  const def = {
    id: 'wf-retry-ok',
    steps: [{ id: 'a', agentRef: DEFAULT_AGENT_ID, retries: 2, retryBackoffMs: 1 }],
  };
  const events = [];
  const store = new VolatileWorkflowStore();
  const engine = new DagEngine({ store, executor: makeExecutor({ failMap: { a: 2 }, calls }), onEvent: (e) => events.push(e) });
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'done');
  assert.strictEqual(run.steps.a.state, 'done');
  assert.strictEqual(run.steps.a.attempts, 2, '两次额外重试');
  assert.strictEqual(calls.a, 3, '共执行 3 次（1 首次 + 2 重试）');
  const retries = events.filter((e) => e.type === 'wf:step:retry');
  assert.strictEqual(retries.length, 2);
  assert.deepStrictEqual(retries.map((e) => e.attempt), [1, 2]);
  const stored = await store.get('wf-retry-ok');
  assert.strictEqual(stored.steps.a.attempts, 2, 'attempts 随检查点持久化');
});

test('P6 retry: 预算耗尽走既有失败路径（failed + wf:step:failed）', async () => {
  const calls = {};
  const def = {
    id: 'wf-retry-exhaust',
    steps: [{ id: 'a', agentRef: DEFAULT_AGENT_ID, retries: 1, retryBackoffMs: 1 }],
  };
  const events = [];
  const engine = new DagEngine({
    store: new VolatileWorkflowStore(),
    executor: makeExecutor({ failMap: { a: 99 }, calls }),
    onEvent: (e) => events.push(e),
  });
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'failed');
  assert.strictEqual(run.steps.a.state, 'failed');
  assert.strictEqual(run.steps.a.attempts, 1);
  assert.strictEqual(calls.a, 2, '首次 + 1 次重试');
  assert.ok(events.some((e) => e.type === 'wf:step:failed'));
  assert.match(run.steps.a.error, /transient failure/);
});

test('P6 retry: 缺省 retries=0 不重试（存量零回归），非法 retries 在 validateWorkflow 拒绝', async () => {
  const calls = {};
  const def = { id: 'wf-retry-off', steps: [{ id: 'a', agentRef: DEFAULT_AGENT_ID }] };
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor: makeExecutor({ failMap: { a: 3 }, calls }) });
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'failed');
  assert.strictEqual(calls.a, 1, '无重试，仅执行一次');
  assert.strictEqual(run.steps.a.attempts, undefined);

  const bad = { id: 'wf-retry-bad', steps: [{ id: 'a', agentRef: DEFAULT_AGENT_ID, retries: -1 }] };
  assert.throws(() => engine.validateWorkflow(bad), /retries 须为非负数/);
});

// ─── 2. 产出 outputSchema 闸门 ──────────────────────────────────────────────

test('P6 outputSchema: 产出不合规 → failed（错误含路径），合规 → done', async () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, score: { type: 'number' } },
    required: ['name'],
  };
  let payload = { name: 123 };
  const def = {
    id: 'wf-schema',
    failOnInvalidOutput: false, // schema 闸门独立于 P4.5 有效性闸门
    steps: [{ id: 'a', agentRef: DEFAULT_AGENT_ID, outputSchema: schema }],
  };
  const engine = new DagEngine({
    store: new VolatileWorkflowStore(),
    executor: async () => payload,
  });
  const run1 = await engine.run(def, 'x');
  assert.strictEqual(run1.state, 'failed');
  assert.strictEqual(run1.steps.a.state, 'failed');
  assert.match(run1.steps.a.error, /outputSchema/);
  assert.match(run1.steps.a.error, /name/, '错误信息含具体路径');

  payload = { name: 'ok', score: 3.5 };
  const run2 = await engine.run({ ...def, id: 'wf-schema-ok' }, 'x');
  assert.strictEqual(run2.state, 'done');
  assert.strictEqual(run2.steps.a.output.score, 3.5);
});

test('P6 outputSchema: 未声明的 step 不受影响（零回归），validateAgainstSchema 基础语义', () => {
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor: async () => 'any' });
  const run = engine.run({ id: 'wf-no-schema', steps: [{ id: 'a', agentRef: DEFAULT_AGENT_ID }] }, 'x');
  return run.then((r) => assert.strictEqual(r.state, 'done')).then(() => {
    assert.deepStrictEqual(validateAgainstSchema({ a: 1 }, { type: 'object', required: ['a'] }), { ok: true, errors: [] });
    const v = validateAgainstSchema({ a: 'x' }, { type: 'object', properties: { a: { type: 'number' } } });
    assert.strictEqual(v.ok, false);
    assert.match(v.errors[0], /a: 类型应为 number/);
    assert.strictEqual(validateAgainstSchema(null, { type: ['null', 'string'] }).ok, true);
    assert.strictEqual(validateAgainstSchema('hi', { enum: ['a', 'hi'] }).ok, true);
  });
});

// ─── 3. 动态 fan-out ────────────────────────────────────────────────────────

test('P6 fan-out: dynamic step 产出 spawn → 物化并行子任务并调度执行', async () => {
  const events = [];
  const store = new VolatileWorkflowStore();
  const def = {
    id: 'wf-fanout',
    steps: [
      {
        id: 'planner',
        agentRef: DEFAULT_AGENT_ID,
        dynamic: true,
        inputMapping: { q: 'input' },
      },
      { id: 'agg', agentRef: DEFAULT_AGENT_ID, dependsOn: ['planner'], inputMapping: { prev: 'steps.planner' } },
    ],
  };
  const executor = async (step, input) => {
    if (step.id === 'planner') {
      return { spawn: [{ id: 'c1' }, { id: 'c2', input: 'literal-in' }] };
    }
    return { step: step.id, got: input };
  };
  const engine = new DagEngine({ store, executor, onEvent: (e) => events.push(e) });
  const run = await engine.run(def, 'goal');
  assert.strictEqual(run.state, 'done');
  const spawnedEvent = events.find((e) => e.type === 'wf:step:spawned');
  assert.ok(spawnedEvent, '发出 wf:step:spawned');
  assert.deepStrictEqual([...spawnedEvent.spawned].sort(), ['planner.c1', 'planner.c2']);
  assert.strictEqual(run.steps['planner.c1'].state, 'done');
  assert.strictEqual(run.steps['planner.c2'].state, 'done');
  assert.strictEqual(run.steps['planner.c2'].output.got, 'literal-in', '字面量输入经 literalInput 生效');
  assert.ok(run.def.steps.some((s) => s.id === 'planner.c1'), '子任务写入 def（随检查点持久化）');
  assert.strictEqual(run.steps.agg.state, 'done', '下游依赖父 step 的步骤正常执行');
  const stored = await store.get('wf-fanout');
  assert.ok(stored.def.steps.some((s) => s.id === 'planner.c2'), '检查点持久化物化后的 def');
});

test('P6 fan-out: 所在波次失败（fail-fast）时 spawn 丢弃，不写入 def', async () => {
  const def = {
    id: 'wf-fanout-fail',
    steps: [
      { id: 'boom', agentRef: DEFAULT_AGENT_ID }, // 同波次失败
      { id: 'planner', agentRef: DEFAULT_AGENT_ID, dynamic: true },
    ],
  };
  const executor = async (step) => {
    if (step.id === 'boom') throw new Error('boom');
    if (step.id === 'planner') return { spawn: [{ id: 'c1' }] };
    return { step: step.id };
  };
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor });
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'failed');
  assert.ok(!run.def.steps.some((s) => s.id === 'planner.c1'), '失败波次的 spawn 不物化');
});

// ─── 4. step 分叉重跑 ───────────────────────────────────────────────────────

test('P6 rerun: 重置指定 step 及其下游后 resume 复跑，上游产出复用', async () => {
  const calls = {};
  const def = {
    id: 'wf-rerun',
    steps: [
      { id: 'a', agentRef: DEFAULT_AGENT_ID },
      { id: 'b', agentRef: DEFAULT_AGENT_ID, dependsOn: ['a'] },
      { id: 'c', agentRef: DEFAULT_AGENT_ID, dependsOn: ['b'] },
    ],
  };
  const store = new VolatileWorkflowStore();
  let failC = true;
  const engine = new DagEngine({
    store,
    executor: (step) => {
      calls[step.id] = (calls[step.id] ?? 0) + 1;
      if (step.id === 'c' && failC) throw new Error('c failed');
      return { step: step.id };
    },
  });
  const run1 = await engine.run(def, 'x');
  assert.strictEqual(run1.state, 'failed');
  assert.strictEqual(calls.a, 1);
  assert.strictEqual(calls.b, 1);

  const updated = await engine.resetForRerun('wf-rerun', 'b');
  assert.strictEqual(updated.state, 'pending');
  assert.strictEqual(updated.steps.a.state, 'done', '上游不在下游集合，产出复用');
  assert.strictEqual(updated.steps.b.state, 'pending');
  assert.strictEqual(updated.steps.c.state, 'pending');
  assert.strictEqual(updated.steps.c.output, undefined, '下游产出已清空');

  failC = false;
  const run2 = await engine.resume('wf-rerun');
  assert.strictEqual(run2.state, 'done');
  assert.strictEqual(calls.a, 1, '上游不重跑');
  assert.strictEqual(calls.b, 2, '分叉起点重跑');
  assert.strictEqual(calls.c, 2, '下游重跑');
});

test('P6 rerun: 纯函数语义 —— running 拒绝 / 未知 step 拒绝 / downstreamSteps 传递闭包', () => {
  const def = {
    id: 'wf-rerun-pure',
    steps: [
      { id: 'a', agentRef: DEFAULT_AGENT_ID },
      { id: 'b', agentRef: DEFAULT_AGENT_ID, dependsOn: ['a'] },
      { id: 'c', agentRef: DEFAULT_AGENT_ID, dependsOn: ['b'] },
    ],
  };
  assert.deepStrictEqual(downstreamSteps(def, 'b').sort(), ['b', 'c']);
  assert.throws(() => downstreamSteps(def, 'nope'), /不存在 step/);
  const run = { def, state: 'running', steps: {} };
  assert.throws(() => resetRunForRerun(run, 'b'), /正在运行/);
  const stopped = { def, state: 'failed', steps: { a: { id: 'a', state: 'done', output: 1 }, b: { id: 'b', state: 'failed', error: 'x' }, c: { id: 'c', state: 'skipped' } } };
  const updated = resetRunForRerun(stopped, 'a');
  assert.strictEqual(updated.state, 'pending');
  assert.strictEqual(updated.steps.a.state, 'pending');
  assert.strictEqual(updated.steps.b.state, 'pending');
  assert.strictEqual(updated.steps.c.state, 'pending');
});

// ─── 5. DbWorkflowStore（sqlite 适配器形态）────────────────────────────────

test('P6 DbWorkflowStore: CRUD + claim 原子占位（sqlite 适配器）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-db-store-'));
  const file = path.join(dir, 'wf.db');
  try {
    const adapter = getDbAdapter({ file, backend: 'sqlite' });
    const store = new DbWorkflowStore({ adapter, table: 'workflow_runs_p6' });
    const mkRun = (id, runId, state) => ({
      def: { id, steps: [{ id: 'a', agentRef: DEFAULT_AGENT_ID }] },
      state,
      runId,
      steps: { a: { id: 'a', state: 'pending' } },
    });
    const run = mkRun('wf-db-1', 'r1', 'running');
    await store.save(run);
    const got = await store.get('wf-db-1');
    assert.ok(got && got.runId === 'r1' && got.state === 'running');
    // claim：同 runId 重取放行；异 runId 在跑拒绝；终态后异 runId 放行。
    assert.strictEqual(await store.claim(run), true, '同 runId 重取放行');
    assert.strictEqual(await store.claim(mkRun('wf-db-1', 'r2', 'running')), false, '异 runId 在跑拒绝');
    run.state = 'done';
    await store.save(run);
    assert.strictEqual(await store.claim(mkRun('wf-db-1', 'r3', 'running')), true, '终态后异 runId 放行');
    // list / delete
    const list = await store.list();
    assert.strictEqual(list.length, 1);
    await store.delete('wf-db-1');
    assert.strictEqual(await store.get('wf-db-1'), null);

    // 引擎适配：run + resume 与接口实现无关
    const engine = new DagEngine({
      store: new DbWorkflowStore({ adapter: getDbAdapter({ file, backend: 'sqlite', }), table: 'workflow_runs_p6_b' }),
      executor: makeExecutor(),
    });
    const wfRun = await engine.run({ id: 'wf-db-engine', steps: [{ id: 'a', agentRef: DEFAULT_AGENT_ID }] }, 'x');
    assert.strictEqual(wfRun.state, 'done');
  } finally {
    // Windows：先释放 sqlite 文件句柄再删目录（适配器按 file 单例缓存，close 一次即可）。
    try {
      getDbAdapter({ file, backend: 'sqlite' }).close?.();
    } catch { /* ok */ }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* 句柄释放竞态下允许残留临时目录 */ }
  }
});

// ─── 6. 工具参数 JSON-Schema 校验（validateArgs：harness 执行链在真实执行前调用）──────

test('P6 工具参数校验: validateArgs 返回错误列表；registry.call 契约不变（不校验不抛错）', async () => {
  const reg = new ToolRegistry();
  reg.register(
    't_strict',
    'strict tool',
    objectParams({ a: { type: 'number' }, b: { type: 'string' } }, ['a', 'b']),
    async (args) => ({ received: args })
  );
  reg.register('t_loose', 'no schema', undefined, async () => 'ok');

  // validateArgs：缺参 / 错型给出带路径的可读错误；合规为空数组。
  assert.ok(reg.validateArgs('t_strict', { a: 1 }).join(' ').includes('b'), '缺 b 报错');
  assert.match(reg.validateArgs('t_strict', { a: 'x', b: 's' })[0] ?? '', /类型应为 number/);
  assert.deepStrictEqual(reg.validateArgs('t_strict', { a: 1, b: 's' }), []);
  assert.deepStrictEqual(reg.validateArgs('t_loose', { anything: true }), [], '无 schema 不约束');
  assert.deepStrictEqual(reg.validateArgs('t_unknown', {}), [], '未知工具走 call 的既有路径');
  // registry.call 契约保持：不校验、不因 schema 违规抛错（工具自身 error: 语义不受影响）。
  const ok = await reg.call('t_strict', { a: 1, b: 's' });
  assert.deepStrictEqual(ok, { received: { a: 1, b: 's' } });
  assert.deepStrictEqual(await reg.call('t_loose', { anything: true }), 'ok');
});
