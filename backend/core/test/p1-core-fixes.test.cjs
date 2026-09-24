// P1 C1–C6 修复的针对性回归测试（2026-09-24 评估报告 P1 修复批）。
// - C2 multi-key：冷却过期后探活失败必须续期冷却（死 Key 不得每次请求都被轮询）
// - C4 workflow：claim 原子占位 —— 同 def 并发 run 后到者被拒（Volatile / File 两后端）
// - C5 workflow：补偿失败标 compensate-failed（非终态），resume 重试补偿成功后转 compensated
// - C6 shell：解释器 inline-eval（-e/-c/--eval）在 local 执行器上拒绝、在隔离执行器上放行

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const wf = require('../dist/workflow/index.js');
const { DagEngine, VolatileWorkflowStore, FileWorkflowStore } = wf;
const { DEFAULT_AGENT_ID } = require('../dist/agents/index.js');
const { registerShell } = require('../dist/builtins/shell.js');
const { LocalSandboxExecutor } = require('../dist/builtins/sandbox.js');
const { ToolRegistry } = require('../dist/tools.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// C2 multi-key 冷却续期
// ---------------------------------------------------------------------------

function okResp() {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }),
  };
}

function headerOf(init) {
  const h = init?.headers ?? {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === 'authorization') return String(v);
  }
  return '';
}

test('C2 multi-key：冷却过期后探活失败应续期冷却，死 Key 不得每次请求都被轮询', async () => {
  const { createMultiKeyLLM } = require('../dist/llm/multi-key.js');
  const seen = [];
  const fetchImpl = async (_url, init) => {
    const h = headerOf(init);
    seen.push(h);
    if (h.includes('sk-a')) {
      throw new Error('LLM API error 401 (model=m): invalid api key');
    }
    return okResp();
  };
  const llm = createMultiKeyLLM(['sk-a', 'sk-b'], { fetchImpl, retries: 0, cooldownMs: 30 });
  const msgs = [{ role: 'user', content: 'hi' }];
  await llm(msgs, []); // k0 401 → 冷却 → k1 成功
  await sleep(50); // 冷却过期，k0 回到「待探活」
  await llm(msgs, []); // 探活 k0：仍 401 → 必须续期冷却 → k1 成功
  await llm(msgs, []); // k0 应仍在冷却期内，不得被联系
  const aHits = seen.filter((h) => h.includes('sk-a')).length;
  assert.strictEqual(aHits, 2, `探活失败后续期冷却（期望 a 恰好被调 2 次，实际 ${aHits}）`);
});

// ---------------------------------------------------------------------------
// C4 workflow claim 原子占位
// ---------------------------------------------------------------------------

test('C4 claim：同 def 并发 run（Volatile）——第二个 run 必须被拒绝', async () => {
  const store = new VolatileWorkflowStore();
  const def = { id: 'wf-claim-race', steps: [{ id: 's', agentRef: DEFAULT_AGENT_ID }] };
  let release;
  const gate = new Promise((r) => { release = r; });
  const executor = async () => { await gate; return { ok: true }; };
  const run1 = new DagEngine({ store, executor }).run(def, 'go');
  // 等 run1 完成 claim 并进入执行（检查点 state=running）
  for (let i = 0; i < 50; i++) {
    const cp = await store.get('wf-claim-race');
    if (cp && cp.state === 'running') break;
    await sleep(2);
  }
  await assert.rejects(
    () => new DagEngine({ store, executor }).run(def, 'go'),
    /already has a running execution/,
    '并发 run 必须在 claim 阶段被原子拒绝',
  );
  release();
  const r1 = await run1;
  assert.strictEqual(r1.state, 'done');
});

test('C4 claim：File 后端 claim 串行化 —— 在跑 runId 不同则拒绝，同 runId（resume）放行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-claim-'));
  try {
    const store = new FileWorkflowStore({ dir });
    const def = { id: 'wf-claim-file', steps: [{ id: 's', agentRef: DEFAULT_AGENT_ID }] };
    const mkRun = (runId) => ({ def, state: 'running', runId, steps: { s: { id: 's', state: 'running' } } });
    assert.strictEqual(await store.claim(mkRun('A')), true, '首次 claim 应成功');
    assert.strictEqual(await store.claim(mkRun('B')), false, '异 runId 并发 claim 应被拒');
    assert.strictEqual(await store.claim(mkRun('A')), true, '同 runId 重取（resume 语义）应放行');
    // 终态检查点可被新 run 接管
    const done = { def, state: 'done', runId: 'A', steps: { s: { id: 's', state: 'done' } } };
    await store.save(done);
    assert.strictEqual(await store.claim(mkRun('C')), true, '终态检查点应可被新 run 接管');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C5 补偿失败 → compensate-failed → resume 重试
// ---------------------------------------------------------------------------

test('C5 补偿失败：标 compensate-failed（不再冒充 compensated），resume 重试后转 compensated', async () => {
  const store = new VolatileWorkflowStore();
  const def = {
    id: 'wf-comp-fail',
    steps: [
      { id: 's1', agentRef: DEFAULT_AGENT_ID, onRolling: ['c1'] },
      { id: 's2', agentRef: DEFAULT_AGENT_ID, dependsOn: ['s1'] },
      { id: 'c1', agentRef: DEFAULT_AGENT_ID, dependsOn: ['s1'] },
    ],
  };
  let s2Attempts = 0;
  let compAttempts = 0;
  const executor = async (step, input, ctx) => {
    if (step.id === 's2' && s2Attempts === 0) {
      s2Attempts += 1;
      throw new Error('transient s2 failure');
    }
    if (step.id === 'c1' && ctx?.compensate) {
      compAttempts += 1;
      if (compAttempts === 1) throw new Error('transient compensate failure');
    }
    return { step: step.id };
  };
  const engine = new DagEngine({ store, executor });
  const run = await engine.run(def, 'go');
  assert.strictEqual(run.state, 'failed');
  assert.strictEqual(
    run.steps.c1.state,
    'compensate-failed',
    '补偿失败必须标 compensate-failed（非终态），不得冒充 compensated',
  );
  // resume：s2 重跑成功；历史补偿失败被重试，本次成功 → compensated → run done。
  const run2 = await engine.resume('wf-comp-fail');
  assert.strictEqual(run2.steps.c1.state, 'compensated', 'resume 应重试补偿失败项');
  assert.strictEqual(compAttempts, 2, '补偿应恰好执行两次（首次失败 + resume 重试成功）');
  assert.strictEqual(run2.state, 'done');
});

// ---------------------------------------------------------------------------
// C6 解释器 inline-eval 逃逸拦截
// ---------------------------------------------------------------------------

function makeRegistry() {
  const reg = new ToolRegistry();
  return reg;
}

test('C6 shell：local 执行器上解释器 inline-eval（node -e）被拒绝', async () => {
  const reg = new ToolRegistry();
  registerShell(reg, {
    root: os.tmpdir(),
    allowedCommands: ['node'],
    executor: new LocalSandboxExecutor(),
  });
  const out = await reg.call('builtin__shell_exec', { command: 'node', args: ['-e', "require('fs').rmSync('/etc/passwd')"] });
  assert.match(String(out), /inline-eval is blocked/, 'local 执行器必须拒绝 inline-eval');
});

test('C6 shell：local 执行器上非 eval 用法（node -v）不受影响', async () => {
  const reg = new ToolRegistry();
  registerShell(reg, {
    root: os.tmpdir(),
    allowedCommands: ['node'],
    timeoutMs: 8000,
    executor: new LocalSandboxExecutor(),
  });
  const out = await reg.call('builtin__shell_exec', { command: 'node', args: ['-v'] });
  assert.doesNotMatch(String(out), /inline-eval is blocked/);
});

test('C6 shell：隔离执行器（非 local）上 inline-eval 放行', async () => {
  const reg = new ToolRegistry();
  const fakeIsolatedExecutor = { kind: 'container', exec: async () => ({ stdout: 'EVIL-RAN', stderr: '', code: 0, signal: null }) };
  registerShell(reg, {
    root: os.tmpdir(),
    allowedCommands: ['node'],
    executor: fakeIsolatedExecutor,
  });
  const out = await reg.call('builtin__shell_exec', { command: 'node', args: ['--eval', 'ok'] });
  assert.match(String(out), /EVIL-RAN/, 'container/os 执行器有真实隔离，inline-eval 应放行');
});

test('C6 shell：组合短参数（-pe）与 --eval= 形式同样被拦截', async () => {
  const reg = new ToolRegistry();
  registerShell(reg, {
    root: os.tmpdir(),
    allowedCommands: ['node', 'python3'],
    executor: new LocalSandboxExecutor(),
  });
  const out1 = await reg.call('builtin__shell_exec', { command: 'node', args: ['-pe', '1+1'] });
  assert.match(String(out1), /inline-eval is blocked/);
  const out2 = await reg.call('builtin__shell_exec', { command: 'python3', args: ['--eval=print(1)'] });
  assert.match(String(out2), /inline-eval is blocked/);
});
