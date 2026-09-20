// P2.5 每 step 调用链路（StepRun.trace）引擎合并单测。
// 覆盖：
// - executor 经 ctx.trace 附挂节点 → 引擎合并进 StepRun.trace 并随检查点持久化
// - 节点数超上限截断（保早期调用）+ 超长 detail 截断兜底
// - 失败 step 的链路同样落检查点
// - 未附挂 ctx.trace（旧 executor / mock）→ 零回归：StepRun 不写 trace 字段
//
// 运行：pnpm --filter @agent-harness/core run build && node --test test/workflow-step-trace.test.cjs

const test = require('node:test');
const assert = require('node:assert');

const {
  DagEngine,
  VolatileWorkflowStore,
  STEP_TRACE_MAX_NODES,
  STEP_TRACE_DETAIL_MAX,
} = require('../dist/workflow/index.js');
const { DEFAULT_AGENT_ID } = require('../dist/agents/index.js');

function traceNode(type, extra = {}) {
  return { type, ts: Date.now(), ...extra };
}

test('P2.5：executor 经 ctx.trace 附挂节点 → 合并进 StepRun.trace 并持久化', async () => {
  const store = new VolatileWorkflowStore();
  const nodes = [
    traceNode('run:start', { label: '任务开始' }),
    traceNode('llm:call', { step: 1, label: 'LLM 调用', meta: { msgs: '1' } }),
    traceNode('tool:start', { step: 1, label: '工具 echo', detail: 'a=1' }),
    traceNode('run:end', { label: '任务结束', meta: { steps: '1' } }),
  ];
  const engine = new DagEngine({
    store,
    executor: async (step, _input, ctx) => {
      ctx.trace = nodes;
      return `done:${step.id}`;
    },
  });
  const def = {
    id: 'wf-trace-basic',
    steps: [
      { id: 'a', agentRef: DEFAULT_AGENT_ID },
      { id: 'b', agentRef: DEFAULT_AGENT_ID, dependsOn: ['a'] },
    ],
  };
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'done');
  for (const id of ['a', 'b']) {
    assert.strictEqual(run.steps[id].trace.length, 4, `step ${id} 应带 4 节点链路`);
    assert.strictEqual(run.steps[id].trace[1].type, 'llm:call');
    assert.strictEqual(run.steps[id].trace[2].detail, 'a=1');
  }
  // 持久化：检查点落盘后可读回（FileWorkflowStore 序列化形状不变）。
  const stored = await store.get('wf-trace-basic');
  assert.strictEqual(stored.steps.a.trace.length, 4);
});

test('P2.5：节点数超上限截断（保早期调用）+ 超长 detail 截断兜底', async () => {
  const store = new VolatileWorkflowStore();
  const many = Array.from({ length: STEP_TRACE_MAX_NODES + 50 }, (_, i) =>
    traceNode(i === 0 ? 'run:start' : 'llm:call', { step: i })
  );
  many[0].detail = 'x'.repeat(STEP_TRACE_DETAIL_MAX + 100);
  const engine = new DagEngine({
    store,
    executor: async (step, _input, ctx) => {
      ctx.trace = many;
      return 'ok';
    },
  });
  const run = await engine.run({ id: 'wf-trace-cap', steps: [{ id: 'a', agentRef: DEFAULT_AGENT_ID }] }, 'x');
  const t = run.steps.a.trace;
  assert.strictEqual(t.length, STEP_TRACE_MAX_NODES, '超上限截断到 MAX');
  assert.ok(t[0].detail.length === STEP_TRACE_DETAIL_MAX + 1, '超长 detail 截断 + 省略号');
  assert.ok(t[0].detail.endsWith('…'));
});

test('P2.5：失败 step 的链路同样落检查点（排障关键信息）', async () => {
  const store = new VolatileWorkflowStore();
  const engine = new DagEngine({
    store,
    executor: async (step, _input, ctx) => {
      ctx.trace = [traceNode('run:start'), traceNode('llm:call', { step: 1 }), traceNode('run:end', { label: '任务结束', status: 'error' })];
      throw new Error('llm 401 无 Key');
    },
  });
  const run = await engine.run({ id: 'wf-trace-fail', steps: [{ id: 'a', agentRef: DEFAULT_AGENT_ID }] }, 'x');
  assert.strictEqual(run.state, 'failed');
  assert.strictEqual(run.steps.a.state, 'failed');
  assert.strictEqual(run.steps.a.trace.length, 3, '失败 step 也保留已捕获的链路');
});

test('P2.5 零回归：未附挂 ctx.trace 的 executor → StepRun 不写 trace 字段', async () => {
  const store = new VolatileWorkflowStore();
  const engine = new DagEngine({
    store,
    executor: async (step) => `done:${step.id}`, // 旧 executor / 测试 mock：不写 ctx.trace
  });
  const run = await engine.run({ id: 'wf-trace-plain', steps: [{ id: 'a', agentRef: DEFAULT_AGENT_ID }] }, 'x');
  assert.strictEqual(run.state, 'done');
  assert.strictEqual(run.steps.a.trace, undefined, '不附挂时 StepRun 无 trace 键（JSON 形状零变化）');
  const stored = await store.get('wf-trace-plain');
  assert.strictEqual(stored.steps.a.trace, undefined);
});
