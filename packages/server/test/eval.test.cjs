// 评估 & 配方版本化 单元测试（业务层，零依赖 node:test）。
// 需在 pnpm --filter @agent-harness/server build 之后运行：node --test test/*.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const { runRecordFromEvents, RuleBasedEvaluator, VolatileRecipeStore, resolveEvalGate, evaluateCompletion } = require('../dist/eval.js');

const SAMPLE_EVENTS = [
  { type: 'run:start', input: '拉一个临时环境' },
  { type: 'run:tools', tools: [{ name: 'create_ephemeral_environment' }, { name: 'destroy_environment' }] },
  { type: 'tool:start', call: { name: 'create_ephemeral_environment' } },
  { type: 'step:start', step: 1 },
  { type: 'llm:response', content: '已为你拉起环境 env-123' },
  { type: 'run:cost', cumulativeTokens: 1200, cumulativeCost: 0.004 },
  { type: 'run:end', final: '已为你拉起环境 env-123', steps: 1 },
  { type: '_done' },
];

test('runRecordFromEvents: 从事件流还原运行配方快照', () => {
  const rec = runRecordFromEvents('job_x', SAMPLE_EVENTS);
  assert.strictEqual(rec.jobId, 'job_x');
  assert.strictEqual(rec.prompt, '拉一个临时环境');
  assert.deepStrictEqual(rec.tools.sort(), ['create_ephemeral_environment', 'destroy_environment']);
  assert.strictEqual(rec.steps, 1);
  assert.strictEqual(rec.finalAnswer, '已为你拉起环境 env-123');
  assert.strictEqual(rec.totalTokens, 1200);
  assert.strictEqual(rec.guardrailsBlocked, 0);
  assert.strictEqual(rec.budgetExceeded, false);
});

test('RuleBasedEvaluator: 正常闭环通过，护栏/预算/无回答硬性不通过', () => {
  const ev = new RuleBasedEvaluator();
  const ok = ev.evaluate(runRecordFromEvents('j1', SAMPLE_EVENTS));
  assert.strictEqual(ok.passed, true);
  assert.ok(ok.score > 0.5);

  const blocked = ev.evaluate(runRecordFromEvents('j2', [
    ...SAMPLE_EVENTS,
    { type: 'guardrail:blocked', phase: 'input', reason: 'x' },
  ]));
  assert.strictEqual(blocked.passed, false);
  assert.strictEqual(blocked.score, 0);

  const noAns = ev.evaluate(runRecordFromEvents('j3', [
    { type: 'run:start', input: 'hi' },
    { type: 'run:end', final: '', steps: 1 },
  ]));
  assert.strictEqual(noAns.passed, false);

  const overBudget = ev.evaluate(runRecordFromEvents('j4', [
    { type: 'run:start', input: 'hi' },
    { type: 'llm:response', content: 'ok' },
    { type: 'budget:exceeded', kind: 'cost', used: 2, limit: 1 },
    { type: 'run:end', final: 'ok', steps: 1 },
  ]));
  assert.strictEqual(overBudget.passed, false);
});

test('VolatileRecipeStore: 保存/读取/列表', () => {
  const store = new VolatileRecipeStore();
  const recipe = { id: 'rcp_1', name: '基线', createdAt: Date.now(), record: runRecordFromEvents('j1', SAMPLE_EVENTS) };
  store.save(recipe);
  assert.strictEqual(store.get('rcp_1').name, '基线');
  assert.strictEqual(store.get('nope'), null);
  assert.strictEqual(store.list().length, 1);
});

test('resolveEvalGate: 环境变量驱动 off(默认)/warn/enforce', () => {
  const prev = process.env.HARNESS_EVAL_GATE;
  try {
    delete process.env.HARNESS_EVAL_GATE;
    assert.strictEqual(resolveEvalGate(), 'off');
    process.env.HARNESS_EVAL_GATE = 'enforce';
    assert.strictEqual(resolveEvalGate(), 'enforce');
    process.env.HARNESS_EVAL_GATE = 'warn';
    assert.strictEqual(resolveEvalGate(), 'warn');
    process.env.HARNESS_EVAL_GATE = 'garbage';
    assert.strictEqual(resolveEvalGate(), 'off');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_EVAL_GATE;
    else process.env.HARNESS_EVAL_GATE = prev;
  }
});

test('evaluateCompletion: off 返回 null；warn 以 finalText 覆盖最终回答并通过；enforce 命中护栏硬失败', () => {
  // off：零开销，直接 null
  assert.strictEqual(evaluateCompletion('j_off', SAMPLE_EVENTS, '最终回答', 'off'), null);

  // warn：正常闭环，finalAnswer 被运行最终回答覆盖
  const warn = evaluateCompletion('j_warn', SAMPLE_EVENTS, '本轮真实最终回答', 'warn');
  assert.ok(warn, 'warn 模式应返回评估结果');
  assert.strictEqual(warn.gate, 'warn');
  assert.strictEqual(warn.record.finalAnswer, '本轮真实最终回答');
  assert.strictEqual(warn.result.passed, true);

  // enforce：事件流含护栏拦截 → 判定不通过（fail closed 由调用方依据此结果拦截）
  const blockedEvents = [...SAMPLE_EVENTS, { type: 'guardrail:blocked', phase: 'input', reason: '注入尝试' }];
  const enforce = evaluateCompletion('j_enf', blockedEvents, '可能被污染的回答', 'enforce');
  assert.ok(enforce);
  assert.strictEqual(enforce.result.passed, false);
  assert.strictEqual(enforce.result.score, 0);
});
