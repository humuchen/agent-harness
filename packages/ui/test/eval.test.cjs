// 评估 & 配方版本化 单元测试（业务层，零依赖 node:test）。
// 需在 pnpm --filter @agent-harness/ui build 之后运行：node --test test/*.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const { runRecordFromEvents, RuleBasedEvaluator, VolatileRecipeStore } = require('../dist/eval.js');

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
