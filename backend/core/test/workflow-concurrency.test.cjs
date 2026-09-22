'use strict';
// 回归测试（P0 DAG 无界 fan-out 修复）：验证 runWaveParallel 在「未设 maxConcurrency」
// 或「maxConcurrency 过大」时，仍受全局上限（默认 16，可经 WF_MAX_CONCURRENCY 覆盖）约束，
// 不会一次性拉起成百上千个 step 压垮事件循环 / 下游配额。

const test = require('node:test');
const assert = require('node:assert');

const { runWorkflow, VolatileWorkflowStore } = require('../dist/workflow/index.js');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 构造 N 个互相独立（无 dependsOn）的 step。agentRef 用内联 AgentCard 跳过注册表解析。
function makeDef(n, extra = {}) {
  const steps = [];
  for (let i = 0; i < n; i++) {
    steps.push({ id: `s${i}`, agentRef: { id: 'noop', name: 'noop' }, input: i });
  }
  return { id: `wf-${Date.now()}-${Math.random().toString(36).slice(2)}`, steps, execMode: 'parallel', ...extra };
}

// 统计最大并发的 executor。
function countingExecutor(track) {
  return async (step) => {
    track.active++;
    track.max = Math.max(track.max, track.active);
    await sleep(5);
    track.active--;
    return { ok: true, id: step.id };
  };
}

test('未设 maxConcurrency：并发受全局上限（默认 16）约束', async () => {
  const track = { active: 0, max: 0 };
  const def = makeDef(80);
  delete process.env.WF_MAX_CONCURRENCY;
  await runWorkflow(def, countingExecutor(track), {}, { store: new VolatileWorkflowStore() });
  assert.ok(track.max <= 16, `实际最大并发 ${track.max} 应 ≤ 16`);
  assert.equal(track.max, 16, '应触达并使用默认上限 16');
});

test('maxConcurrency 超过全局上限：被全局上限夹断', async () => {
  const track = { active: 0, max: 0 };
  const def = makeDef(80, { maxConcurrency: 1000 });
  delete process.env.WF_MAX_CONCURRENCY;
  await runWorkflow(def, countingExecutor(track), {}, { store: new VolatileWorkflowStore() });
  assert.ok(track.max <= 16, `实际最大并发 ${track.max} 应 ≤ 16（被全局上限夹断）`);
});

test('maxConcurrency 低于全局上限：尊重较小值', async () => {
  const track = { active: 0, max: 0 };
  const def = makeDef(80, { maxConcurrency: 4 });
  delete process.env.WF_MAX_CONCURRENCY;
  await runWorkflow(def, countingExecutor(track), {}, { store: new VolatileWorkflowStore() });
  assert.ok(track.max <= 4, `实际最大并发 ${track.max} 应 ≤ 4`);
  assert.equal(track.max, 4, '应触达并使用较小的 maxConcurrency=4');
});

test('WF_MAX_CONCURRENCY 环境变量可覆盖全局上限', async () => {
  const track = { active: 0, max: 0 };
  const def = makeDef(80);
  process.env.WF_MAX_CONCURRENCY = '8';
  try {
    await runWorkflow(def, countingExecutor(track), {}, { store: new VolatileWorkflowStore() });
    assert.ok(track.max <= 8, `实际最大并发 ${track.max} 应 ≤ 8`);
    assert.equal(track.max, 8, '应触达并使用覆盖后的上限 8');
  } finally {
    delete process.env.WF_MAX_CONCURRENCY;
  }
});
