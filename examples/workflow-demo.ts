/**
 * 工作流编排集成冒烟（P1-⑤）。
 *
 * 演示核心 DagEngine 的能力：
 *   1. 拓扑分层并行：无依赖的 step 同一波次并行，依赖 step 等上游完成；
 *   2. inputMapping：下游 step 取上游输出作为自己的输入；
 *   3. 失败补偿：某 step 失败后，已完成 step 逆序执行 compensate；
 *   4. validateWorkflow：成环 / 未知依赖直接 fail-fast 拒绝。
 *
 * 用 mock StepExecutor（直接回显），离线、无需密钥。真实部署时把 executor 换成
 * server 端的 createWorkflowExecutor（assembleAgent + harness.run）即可接入真实 agent。
 *
 * 运行：pnpm --filter @agent-harness/examples run workflow-demo
 */
import {
  DagEngine,
  VolatileWorkflowStore,
  DEFAULT_AGENT_ID,
  type StepExecutor,
  type WorkflowDef,
} from '@agent-harness/core';
import { loadEnv } from '@agent-harness/core';

loadEnv();

/** 回显型 mock executor：把输入原样返回，便于观察 DAG 数据流。 */
const echoExecutor: StepExecutor = async (step, input) => ({
  step: step.id,
  got: input,
});

async function main(): Promise<void> {
  // 1) 正常 DAG：s1 / s2 并行 → s3 合并两者输出。
  const def: WorkflowDef = {
    id: 'demo-dag',
    steps: [
      { id: 's1', agentRef: DEFAULT_AGENT_ID, inputMapping: { q: 'input' } },
      { id: 's2', agentRef: DEFAULT_AGENT_ID, inputMapping: { q: 'input' } },
      {
        id: 's3',
        agentRef: DEFAULT_AGENT_ID,
        dependsOn: ['s1', 's2'],
        inputMapping: { a: 'steps.s1', b: 'steps.s2' },
      },
    ],
  };
  const engine = new DagEngine({ store: new VolatileWorkflowStore(), executor: echoExecutor });
  const run = await engine.run(def, 'hello');
  console.log('[workflow] DAG 状态：', run.state);
  console.log('[workflow] s3 输入（合并 s1/s2 输出）：', JSON.stringify(run.steps.s3?.output));
  if (run.state !== 'done') throw new Error('DAG 未成功完成');

  // 2) 失败补偿：s1 完成、s2 失败 → s1 的 compensate 被逆序执行。
  const compDef: WorkflowDef = {
    id: 'demo-comp',
    steps: [
      { id: 's1', agentRef: DEFAULT_AGENT_ID, compensate: 'c1' },
      { id: 's2', agentRef: DEFAULT_AGENT_ID, dependsOn: ['s1'] },
      { id: 'c1', agentRef: DEFAULT_AGENT_ID },
    ],
  };
  const failingExecutor: StepExecutor = async (step) => {
    if (step.id === 's2') throw new Error('s2 执行失败');
    return { step: step.id };
  };
  const engine2 = new DagEngine({ store: new VolatileWorkflowStore(), executor: failingExecutor });
  const run2 = await engine2.run(compDef, 'go');
  console.log('[workflow] 补偿场景状态：', run2.state, '（期望 failed）');
  console.log('[workflow] 各 step 终态：', JSON.stringify(
    Object.fromEntries(Object.entries(run2.steps).map(([k, v]) => [k, v.state])),
  ));
  if (run2.steps.s1?.state !== 'done' || run2.steps.c1?.state !== 'compensated') {
    throw new Error('失败补偿未按预期执行（s1 应 done、c1 应 compensated）');
  }

  // 3) 成环 fail-fast：不应静默进入执行。
  const cycleDef: WorkflowDef = {
    id: 'demo-cycle',
    steps: [
      { id: 'x', agentRef: DEFAULT_AGENT_ID, dependsOn: ['y'] },
      { id: 'y', agentRef: DEFAULT_AGENT_ID, dependsOn: ['x'] },
    ],
  };
  const engine3 = new DagEngine({ store: new VolatileWorkflowStore(), executor: echoExecutor });
  let rejected = false;
  try {
    await engine3.run(cycleDef, 'x');
  } catch {
    rejected = true;
  }
  console.log('[workflow] 成环定义是否 fail-fast 拒绝：', rejected, '（期望 true）');
  if (!rejected) throw new Error('成环未 fail-fast 拒绝');

  console.log('[workflow] ✅ 工作流编排闭环验证通过');
}

main().catch((e) => {
  console.error('[workflow] 失败：', e);
  process.exit(1);
});
