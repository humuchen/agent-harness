// P3（人工审批门）引擎门单测：requireApproval step 在波次边界暂停 run。
// 覆盖：
// - run() 首道门暂停（state=awaiting、step=awaiting、下游 pending、wf:awaiting-approval 事件）
// - 未批准 resume() 再次暂停（幂等，不重跑已完成 step）
// - 批准写入 run.approvals 后 resume() 放行至 done（跨两道门）
// - 级联跳过预判：输出依赖已被跳过 step 的门 step 不参与门
// - 未标记 requireApproval 的 def 零回归（无 wf:awaiting-approval 事件、正常跑完）
//
// 运行：pnpm --filter @agent-harness/core run build && node --test test/workflow-approval.test.cjs

const test = require('node:test');
const assert = require('node:assert');

const { DagEngine, VolatileWorkflowStore } = require('../dist/workflow/index.js');
const { DEFAULT_AGENT_ID } = require('../dist/agents/index.js');

function makeExecutor({ log = [] } = {}) {
  return async (step) => {
    log.push(step.id);
    return { step: step.id, ok: true };
  };
}

/** def：g1 → g2(requireApproval, 依赖 g1) → g3(requireApproval, 依赖 g2)。 */
function gatedDef(id) {
  return {
    id,
    steps: [
      { id: 'g1', agentRef: DEFAULT_AGENT_ID },
      { id: 'g2', agentRef: DEFAULT_AGENT_ID, dependsOn: ['g1'], requireApproval: true },
      { id: 'g3', agentRef: DEFAULT_AGENT_ID, dependsOn: ['g2'], requireApproval: true },
    ],
  };
}

test('P3 门：run() 在第一道门暂停（awaiting），不越过门执行下游', async () => {
  const store = new VolatileWorkflowStore();
  const events = [];
  const log = [];
  const engine = new DagEngine({
    store,
    executor: makeExecutor({ log }),
    onEvent: (e) => events.push(e),
  });
  const run = await engine.run(gatedDef('wf-gate-run'), 'x');

  assert.strictEqual(run.state, 'awaiting');
  assert.strictEqual(run.steps.g1.state, 'done', '门前的 step 正常完成');
  assert.strictEqual(run.steps.g2.state, 'awaiting', '门 step 标记 awaiting');
  assert.strictEqual(run.steps.g3.state, 'pending', '下游保持 pending（整波暂停）');
  assert.strictEqual(log.filter((x) => x === 'g2').length, 0, '门后 step 未被执行');
  const gateEvents = events.filter((e) => e.type === 'wf:awaiting-approval');
  assert.strictEqual(gateEvents.length, 1);
  assert.deepStrictEqual(gateEvents[0].stepIds, ['g2']);
  // 检查点持久化：state=awaiting 可被 resume 识别。
  const stored = await store.get('wf-gate-run');
  assert.strictEqual(stored.state, 'awaiting');
});

test('P3 门：未批准 resume() 再次暂停（不重跑 g1）', async () => {
  const store = new VolatileWorkflowStore();
  const log = [];
  const engine = new DagEngine({ store, executor: makeExecutor({ log }) });
  await engine.run(gatedDef('wf-gate-re'), 'x');
  const run2 = await engine.resume('wf-gate-re');
  assert.strictEqual(run2.state, 'awaiting', '无 approvals → 门再次拦下');
  assert.strictEqual(log.filter((x) => x === 'g1').length, 1, 'g1 未被重跑');
});

test('P3 门：批准放行后 resume() 至 done（跨两道门）', async () => {
  const store = new VolatileWorkflowStore();
  const engine = new DagEngine({ store, executor: makeExecutor() });
  await engine.run(gatedDef('wf-gate-ok'), 'x');

  // 放行第一道门。
  let run = await store.get('wf-gate-ok');
  run.approvals = [...(run.approvals ?? []), 'g2'];
  await store.save(run);
  run = await engine.resume('wf-gate-ok');
  assert.strictEqual(run.state, 'awaiting', '放行 g2 后继续执行至第二道门再次暂停');
  assert.strictEqual(run.steps.g2.state, 'done');

  // 放行第二道门。
  run = await store.get('wf-gate-ok');
  run.approvals = [...(run.approvals ?? []), 'g3'];
  await store.save(run);
  run = await engine.resume('wf-gate-ok');
  assert.strictEqual(run.state, 'done');
  assert.strictEqual(run.steps.g3.state, 'done');
  assert.ok(run.approvals.includes('g2') && run.approvals.includes('g3'), 'approvals 随检查点持久化');
});

test('P3 门：级联跳过预判 —— 输出依赖被跳过 step 的门 step 不参与门', async () => {
  const store = new VolatileWorkflowStore();
  const events = [];
  const engine = new DagEngine({
    store,
    executor: makeExecutor(),
    onEvent: (e) => events.push(e),
  });
  // opt（condition=false → skipped）→ gate（requireApproval，inputMapping 引用 opt 的输出）。
  const def = {
    id: 'wf-gate-skip',
    steps: [
      { id: 'opt', agentRef: DEFAULT_AGENT_ID, condition: 'false' },
      {
        id: 'gate',
        agentRef: DEFAULT_AGENT_ID,
        dependsOn: ['opt'],
        inputMapping: { src: 'steps.opt' },
        requireApproval: true,
      },
    ],
  };
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'done', '门 step 因级联跳过被自动绕过，run 正常完成');
  assert.strictEqual(run.steps.opt.state, 'skipped');
  assert.strictEqual(run.steps.gate.state, 'skipped', '输出依赖被跳过 → 门 step 级联跳过');
  assert.strictEqual(events.filter((e) => e.type === 'wf:awaiting-approval').length, 0, '未触发审批门暂停');
});

test('P3 零回归：未标记 requireApproval 的 def 正常跑完、无暂停事件', async () => {
  const store = new VolatileWorkflowStore();
  const events = [];
  const engine = new DagEngine({
    store,
    executor: makeExecutor(),
    onEvent: (e) => events.push(e),
  });
  const def = {
    id: 'wf-gate-plain',
    steps: [
      { id: 'a', agentRef: DEFAULT_AGENT_ID },
      { id: 'b', agentRef: DEFAULT_AGENT_ID, dependsOn: ['a'] },
    ],
  };
  const run = await engine.run(def, 'x');
  assert.strictEqual(run.state, 'done');
  assert.strictEqual(run.approvals, undefined, '无门时检查点不写 approvals');
  assert.strictEqual(events.filter((e) => e.type === 'wf:awaiting-approval').length, 0);
  assert.strictEqual(run.steps.b.state, 'done');
});
