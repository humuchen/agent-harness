// 评估 & 配方版本化 单元测试（业务层，零依赖 node:test）。
// 需在 pnpm --filter @agent-harness/server build 之后运行：node --test test/*.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const {
  runRecordFromEvents, RuleBasedEvaluator, LLMJudgeEvaluator, VolatileRecipeStore,
  resolveEvalGate, evaluateCompletion, createEvaluator, getEvaluator, resetEvaluator,
  parseJudgeOutput, normalizeScore
} = require('../dist/eval.js');

// 测试环境不配置 judge LLM 凭据，确保默认评估器为规则评估器（确定性）。
delete process.env.EVAL_JUDGE_API_KEY;
delete process.env.EVAL_JUDGE_ENABLED;
delete process.env.OPEN_API_KEY;
resetEvaluator();

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

test('evaluateCompletion: off 返回 null；warn 以 finalText 覆盖最终回答并通过；enforce 命中护栏硬失败', async () => {
  // off：零开销，直接 null
  assert.strictEqual(await evaluateCompletion('j_off', SAMPLE_EVENTS, '最终回答', 'off'), null);

  // warn：正常闭环，finalAnswer 被运行最终回答覆盖
  const warn = await evaluateCompletion('j_warn', SAMPLE_EVENTS, '本轮真实最终回答', 'warn');
  assert.ok(warn, 'warn 模式应返回评估结果');
  assert.strictEqual(warn.gate, 'warn');
  assert.strictEqual(warn.record.finalAnswer, '本轮真实最终回答');
  assert.strictEqual(warn.result.passed, true);

  // enforce：事件流含护栏拦截 → 判定不通过（fail closed 由调用方依据此结果拦截）
  const blockedEvents = [...SAMPLE_EVENTS, { type: 'guardrail:blocked', phase: 'input', reason: '注入尝试' }];
  const enforce = await evaluateCompletion('j_enf', blockedEvents, '可能被污染的回答', 'enforce');
  assert.ok(enforce);
  assert.strictEqual(enforce.result.passed, false);
  assert.strictEqual(enforce.result.score, 0);
});

// ---------------------------------------------------------------------------
// LLM-as-judge 评估器（默认实现）测试
// ---------------------------------------------------------------------------

/** 构造返回固定内容的 mock LLM。 */
function mockLLM(content, { capture } = {}) {
  return async (msgs) => {
    if (capture) capture.push(msgs);
    return { content };
  };
}

test('parseJudgeOutput: 解析文本格式「评分 + 逐条理由」', () => {
  const out = parseJudgeOutput('评分: 0.85\n理由:\n- 相关性高\n- 回答准确');
  assert.ok(out);
  assert.strictEqual(out.score, 0.85);
  assert.deepStrictEqual(out.reasons, ['相关性高', '回答准确']);
});

test('parseJudgeOutput: 解析 JSON 格式与十分制折算', () => {
  const json = parseJudgeOutput('{"score": 8, "reasons": ["好", "快"]}');
  assert.ok(json);
  assert.strictEqual(json.score, 0.8);
  assert.deepStrictEqual(json.reasons, ['好', '快']);

  const ten = parseJudgeOutput('评分: 7\n理由:\n- ok');
  assert.ok(ten);
  assert.strictEqual(ten.score, 0.7);
});

test('parseJudgeOutput: 无法解析返回 null（触发兜底）', () => {
  assert.strictEqual(parseJudgeOutput(''), null);
  assert.strictEqual(parseJudgeOutput('完全无法识别的输出'), null);
});

test('normalizeScore: 归一到 0..1', () => {
  assert.strictEqual(normalizeScore(0), 0);
  assert.strictEqual(normalizeScore(1), 1);
  assert.strictEqual(normalizeScore(8), 0.8);
  assert.strictEqual(normalizeScore(10), 1);
  assert.strictEqual(normalizeScore(11), 1);
  assert.strictEqual(normalizeScore(-1), 0);
  assert.strictEqual(normalizeScore(NaN), 0);
});

test('LLMJudgeEvaluator: 正常打分，按阈值判定通过/不通过', async () => {
  const rec = runRecordFromEvents('j1', SAMPLE_EVENTS);
  const pass = new LLMJudgeEvaluator({
    llm: mockLLM('评分: 0.9\n理由:\n- 相关性高\n- 回答准确'),
    passThreshold: 0.5
  });
  const r1 = await pass.evaluate(rec);
  assert.strictEqual(r1.passed, true);
  assert.strictEqual(r1.score, 0.9);
  assert.deepStrictEqual(r1.reasons, ['相关性高', '回答准确']);

  const fail = new LLMJudgeEvaluator({
    llm: mockLLM('评分: 0.2\n理由:\n- 不相关'),
    passThreshold: 0.5
  });
  const r2 = await fail.evaluate(rec);
  assert.strictEqual(r2.passed, false);
  assert.strictEqual(r2.score, 0.2);
});

test('LLMJudgeEvaluator: judge 提示包含系统提示与运行快照', async () => {
  const captured = [];
  const judge = new LLMJudgeEvaluator({ llm: mockLLM('评分: 0.8\n理由:\n- ok', { capture: captured }) });
  await judge.evaluate(runRecordFromEvents('j1', SAMPLE_EVENTS));
  assert.strictEqual(captured[0][0].role, 'system');
  assert.strictEqual(captured[0][1].role, 'user');
  assert.ok(captured[0][1].content.includes('拉一个临时环境'));
});

test('LLMJudgeEvaluator: LLM 抛错时回退规则评估并前置降级原因', async () => {
  const rec = runRecordFromEvents('j1', SAMPLE_EVENTS);
  const judge = new LLMJudgeEvaluator({
    llm: async () => { throw new Error('boom'); }
  });
  const r = await judge.evaluate(rec);
  assert.strictEqual(r.passed, true);
  assert.ok(r.reasons[0].includes('已回退规则评估'));
});

test('LLMJudgeEvaluator: 输出不可解析时回退规则评估', async () => {
  const rec = runRecordFromEvents('j1', SAMPLE_EVENTS);
  const judge = new LLMJudgeEvaluator({ llm: mockLLM('完全无法识别的输出') });
  const r = await judge.evaluate(rec);
  assert.ok(r.reasons[0].includes('已回退规则评估'));
});

test('createEvaluator: 注入 judgeLlm 返回 LLM 评估器；缺省返回规则评估器', () => {
  const withJudge = createEvaluator({ judgeLlm: mockLLM('评分: 0.5\n理由:\n- x') });
  assert.ok(withJudge instanceof LLMJudgeEvaluator);

  const rule = createEvaluator({ useLlmJudge: false });
  assert.ok(rule instanceof RuleBasedEvaluator);
});

test('createEvaluator: 开关开启但无凭据时降级为规则评估（缺失即降级）', () => {
  const prevKey = process.env.EVAL_JUDGE_API_KEY;
  const prevOpen = process.env.OPEN_API_KEY;
  try {
    delete process.env.EVAL_JUDGE_API_KEY;
    delete process.env.OPEN_API_KEY;
    const ev = createEvaluator({ useLlmJudge: true });
    assert.ok(ev instanceof RuleBasedEvaluator);
  } finally {
    if (prevKey !== undefined) process.env.EVAL_JUDGE_API_KEY = prevKey;
    if (prevOpen !== undefined) process.env.OPEN_API_KEY = prevOpen;
  }
});

test('getEvaluator: 返回复用的单例实例', () => {
  const e = getEvaluator();
  assert.strictEqual(getEvaluator(), e);
});

test('evaluateCompletion: 注入 judge 评估器时走 LLM 打分', async () => {
  const judge = new LLMJudgeEvaluator({ llm: mockLLM('评分: 0.9\n理由:\n- 高质量') });
  const ev = await evaluateCompletion('j_judge', SAMPLE_EVENTS, '本轮最终回答', 'warn', judge);
  assert.ok(ev);
  assert.strictEqual(ev.result.score, 0.9);
  assert.strictEqual(ev.result.passed, true);
  assert.strictEqual(ev.record.finalAnswer, '本轮最终回答');
});
