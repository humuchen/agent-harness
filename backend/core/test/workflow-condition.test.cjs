/**
 * Workflow 条件分支单元测试（P2）
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const coreDist = path.join(__dirname, '../../../backend/core/dist/index.js');
const { DagEngine } = require(coreDist);
const { makeDefaultAgentCard, DEFAULT_AGENT_ID } = require(coreDist);

describe('Workflow 条件分支', () => {
  it('应跳过条件不满足的 step', async () => {
    const executor = async (step, input) => {
      if (step.id === 'step-b') throw new Error('should not execute');
      return { output: `result-${step.id}` };
    };

    const store = {
      save: async () => {},
      get: async () => null,
    };

    const engine = new DagEngine({ executor, store });

    const def = {
      id: 'wf-cond',
      steps: [
        { id: 'step-a', agentRef: DEFAULT_AGENT_ID, inputMapping: { query: 'input' } },
        {
          id: 'step-b',
          agentRef: DEFAULT_AGENT_ID,
          condition: 'false',
          inputMapping: { query: 'steps.step-a.output' },
        },
      ],
    };

    const run = await engine.run(def);
    assert.equal(run.steps['step-a'].state, 'done');
    assert.equal(run.steps['step-b'].state, 'skipped');
    assert.equal(run.state, 'done');
  });

  it('应执行条件满足的 step', async () => {
    let executed = false;
    const executor = async (step, input) => {
      if (step.id === 'step-b') executed = true;
      return { output: `result-${step.id}` };
    };

    const store = {
      save: async () => {},
      get: async () => null,
    };

    const engine = new DagEngine({ executor, store });

    const def = {
      id: 'wf-cond-true',
      steps: [
        { id: 'step-a', agentRef: DEFAULT_AGENT_ID },
        {
          id: 'step-b',
          agentRef: DEFAULT_AGENT_ID,
          condition: 'true',
          inputMapping: { query: 'steps.step-a.output' },
        },
      ],
    };

    const run = await engine.run(def);
    assert.equal(run.steps['step-b'].state, 'done');
    assert.equal(executed, true);
  });

  it('应引用上游 step 的输出作为条件', async () => {
    let stepBCalled = false;
    const executor = async (step, input) => {
      if (step.id === 'step-b') {
        stepBCalled = true;
        return { result: 'b-done' };
      }
      return { result: 'a-done' };
    };

    const store = {
      save: async () => {},
      get: async () => null,
    };

    const engine = new DagEngine({ executor, store });

    const def = {
      id: 'wf-cond-output',
      steps: [
        { id: 'step-a', agentRef: DEFAULT_AGENT_ID },
        {
          id: 'step-b',
          agentRef: DEFAULT_AGENT_ID,
          dependsOn: ['step-a'],
          condition: 'steps.step-a.output',
          inputMapping: { query: 'steps.step-a.output' },
        },
      ],
    };

    const run = await engine.run(def);
    assert.equal(stepBCalled, true);
    assert.equal(run.steps['step-b'].state, 'done');
  });

  it('向后兼容：无条件时正常执行', async () => {
    const executor = async (step) => ({ output: `result-${step.id}` });

    const store = {
      save: async () => {},
      get: async () => null,
    };

    const engine = new DagEngine({ executor, store });

    const def = {
      id: 'wf-no-cond',
      steps: [
        { id: 'step-a', agentRef: DEFAULT_AGENT_ID },
        { id: 'step-b', agentRef: DEFAULT_AGENT_ID, dependsOn: ['step-a'] },
      ],
    };

    const run = await engine.run(def);
    assert.equal(run.steps['step-a'].state, 'done');
    assert.equal(run.steps['step-b'].state, 'done');
  });

  it('state 条件：裸写 steps.<id>.state 等价于 == done', async () => {
    const executor = async (step) => ({ output: `result-${step.id}` });
    const store = { save: async () => {}, get: async () => null };
    const engine = new DagEngine({ executor, store });
    const def = {
      id: 'wf-state-bare',
      steps: [
        { id: 'step-a', agentRef: DEFAULT_AGENT_ID },
        {
          id: 'step-b',
          agentRef: DEFAULT_AGENT_ID,
          dependsOn: ['step-a'],
          condition: "steps.step-a.state",
        },
      ],
    };
    const run = await engine.run(def);
    assert.equal(run.steps['step-a'].state, 'done');
    assert.equal(run.steps['step-b'].state, 'done');
  });

  it('state 条件：显式 == / != 比较', async () => {
    const executor = async (step) => ({ output: `result-${step.id}` });
    const store = { save: async () => {}, get: async () => null };
    const engine = new DagEngine({ executor, store });
    const def = {
      id: 'wf-state-cmp',
      steps: [
        { id: 'step-a', agentRef: DEFAULT_AGENT_ID },
        { id: 'step-b', agentRef: DEFAULT_AGENT_ID, dependsOn: ['step-a'], condition: "steps.step-a.state != 'failed'" },
        { id: 'step-c', agentRef: DEFAULT_AGENT_ID, dependsOn: ['step-a'], condition: "steps.step-a.state == 'skipped'" },
      ],
    };
    const run = await engine.run(def);
    assert.equal(run.steps['step-b'].state, 'done'); // a 是 done，!= failed 通过
    assert.equal(run.steps['step-c'].state, 'skipped'); // a 不是 skipped，条件不满足
  });

  it('级联跳过：上游被条件跳过时，下游依赖它的 step 自动跳过（不死锁）', async () => {
    let stepCExecuted = false;
    const executor = async (step) => {
      if (step.id === 'step-c') stepCExecuted = true;
      return { output: `result-${step.id}` };
    };
    const store = { save: async () => {}, get: async () => null };
    const engine = new DagEngine({ executor, store });
    const def = {
      id: 'wf-cascade-skip',
      steps: [
        { id: 'step-a', agentRef: DEFAULT_AGENT_ID, condition: 'false' },
        { id: 'step-b', agentRef: DEFAULT_AGENT_ID, dependsOn: ['step-a'], condition: 'true' },
        {
          id: 'step-c',
          agentRef: DEFAULT_AGENT_ID,
          dependsOn: ['step-b'],
          // 若级联跳过失效，此 step 会等待 step-b 永远不产出的 output。
          inputMapping: { x: 'steps.step-b.output' },
        },
      ],
    };
    const run = await engine.run(def);
    assert.equal(run.steps['step-a'].state, 'skipped');
    assert.equal(run.steps['step-b'].state, 'skipped');
    assert.equal(run.steps['step-c'].state, 'skipped');
    assert.equal(stepCExecuted, false);
    assert.equal(run.state, 'done');
  });

  it('state 条件读取真实 StepRun 状态（skipped 上游不再被误判为 failed）', async () => {
    const executor = async (step) => ({ output: `result-${step.id}` });
    const store = { save: async () => {}, get: async () => null };
    const engine = new DagEngine({ executor, store });
    const def = {
      id: 'wf-skip-branch',
      steps: [
        { id: 'step-a', agentRef: DEFAULT_AGENT_ID, condition: 'false' },
        {
          id: 'step-fallback',
          agentRef: DEFAULT_AGENT_ID,
          condition: "steps.step-a.state == 'skipped'",
        },
      ],
    };
    const run = await engine.run(def);
    assert.equal(run.steps['step-a'].state, 'skipped');
    // step-a 被跳过 → fallback 分支命中（旧实现用 outputs 近似，skipped 无 output，此条件无法正确表达）
    assert.equal(run.steps['step-fallback'].state, 'done');
    assert.equal(run.state, 'done');
  });
});
