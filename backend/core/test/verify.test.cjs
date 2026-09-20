// 零依赖测试（node:test + node:assert）：覆盖 P0-2 运行期自动验证门禁抽象。
// 直接 require 编译后的叶子模块，避免引入其它运行时依赖。
const test = require('node:test');
const assert = require('node:assert');

const {
  RuleBasedVerifier,
  assertionsVerifier,
  specsVerifier,
  composeVerifiers,
  createVerifier,
} = require('../dist/verify.js');

/** 构造一个健康的验证上下文（可覆盖部分字段）。 */
function ctx(over = {}) {
  return {
    input: 'do X',
    final: 'done X',
    steps: 2,
    toolCalls: [{ id: '1', name: 'tool_a', arguments: {} }],
    guardrailsBlocked: 0,
    budgetExceeded: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// RuleBasedVerifier（过程质量门禁）
// ---------------------------------------------------------------------------

test('RuleBasedVerifier 健康运行通过', () => {
  const r = RuleBasedVerifier(ctx());
  assert.strictEqual(r.passed, true);
  assert.ok(r.score >= 0.5);
});

test('RuleBasedVerifier 护栏拦截硬失败', () => {
  const r = RuleBasedVerifier(ctx({ guardrailsBlocked: 1 }));
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.score, 0);
});

test('RuleBasedVerifier 预算超限硬失败', () => {
  const r = RuleBasedVerifier(ctx({ budgetExceeded: true }));
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.score, 0);
});

test('RuleBasedVerifier 无最终回答硬失败', () => {
  const r = RuleBasedVerifier(ctx({ final: '' }));
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.score, 0);
});

test('RuleBasedVerifier 未调用工具/无步骤仅扣分不硬失败', () => {
  const r = RuleBasedVerifier(ctx({ toolCalls: [], steps: 0 }));
  assert.strictEqual(r.passed, true, '仍通过（仅降分）');
  assert.ok(r.score < 1, '分数应被扣减');
});

// ---------------------------------------------------------------------------
// assertionsVerifier / specsVerifier（结果正确性校验）
// ---------------------------------------------------------------------------

test('assertionsVerifier 全部断言通过', async () => {
  const v = assertionsVerifier([(c) => c.final.includes('done'), (c) => c.steps > 0]);
  const r = await v(ctx());
  assert.strictEqual(r.passed, true);
  assert.strictEqual(r.score, 1);
});

test('assertionsVerifier 任一断言失败即整体失败', async () => {
  const v = assertionsVerifier([(c) => c.final.includes('done'), (c) => c.final.includes('NOPE')]);
  const r = await v(ctx());
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.score, 0);
  assert.ok(r.reasons.some((x) => x.includes('断言 #2')), '应指出失败的是第 2 条断言');
});

test('assertionsVerifier 断言抛错按失败处理', async () => {
  const v = assertionsVerifier([() => { throw new Error('boom'); }]);
  const r = await v(ctx());
  assert.strictEqual(r.passed, false, '抛错应判失败（不向上冒泡）');
});

test('specsVerifier contains / notContains / matches / 长度区间', async () => {
  const v = specsVerifier([
    { contains: 'done' },
    { notContains: 'SECRET' },
    { matches: '^done' },
    { minLength: 3 },
    { maxLength: 100 },
  ]);
  assert.strictEqual((await v(ctx())).passed, true);
  assert.strictEqual((await v(ctx({ final: 'xx' }))).passed, false, '过短应失败');
  assert.strictEqual((await v(ctx({ final: 'SECRET leaked' }))).passed, false, '含禁用串应失败');
  assert.strictEqual((await v(ctx({ final: 'no done here' }))).passed, false, '不含 required 串应失败');
});

test('specsVerifier 坏正则不崩溃（按失败处理）', async () => {
  const v = specsVerifier([{ matches: '([' }]);
  const r = await v(ctx());
  assert.strictEqual(r.passed, false);
});

test('组标签：多组断言 reasons 带组前缀（P4.5 消歧——「全部 N 项通过 / 断言 #k 未通过」不再自相矛盾）', async () => {
  // 模拟 per-step 双组：默认门禁组（3 条全过）+ 任务验收组（1 条挂）——旧版 reasons 拼接为
  // 「全部 3 项断言通过; 断言 #1 未通过」读起来自相矛盾；加组标签后可区分。
  const v = composeVerifiers(
    specsVerifier([{ contains: 'x' }, { minLength: 1 }, { notContains: 'Z' }], '默认门禁'),
    specsVerifier([{ contains: 'NOPE' }], '任务验收')
  );
  const r = await v(ctx({ final: 'x' }));
  assert.strictEqual(r.passed, false);
  assert.ok(r.reasons.some((x) => x === '默认门禁：全部 3 项断言通过'), `reasons=${r.reasons}`);
  assert.ok(
    r.reasons.some((x) => x.startsWith('任务验收：断言 #1 未通过')),
    `reasons=${r.reasons}`
  );
});

// ---------------------------------------------------------------------------
// P4.6 修复：contains 断言归一化匹配 + 失败原因带具体词（自检重试定向补齐）
// ---------------------------------------------------------------------------

test('P4.6 contains 归一化：大小写/全角半角/空白差异不再误判', async () => {
  const v = specsVerifier([{ contains: 'AI Agent' }, { contains: '市场规模' }]);
  // 大小写差异（tam vs TAM）、全角空格、跨行换行都应命中。
  const ok = await v(ctx({ final: '本章分析 TAM 与\nＡＩ　Ａｇｅｎｔ落地，含市场规模数据。' }));
  assert.strictEqual(ok.passed, true, `reasons=${ok.reasons}`);
  // 语义不同仍应失败。
  const bad = await v(ctx({ final: '完全无关的内容' }));
  assert.strictEqual(bad.passed, false);
});

test('P4.6 失败原因带具体词：自检重试可定向补齐', async () => {
  const v = specsVerifier([{ contains: '监管合规' }], '任务验收');
  const r = await v(ctx({ final: '有内容但没有该词' }));
  assert.strictEqual(r.passed, false);
  assert.ok(
    r.reasons.some((x) => x.includes('产出未包含「监管合规」')),
    `reasons=${r.reasons}`
  );
});

// ---------------------------------------------------------------------------
// P4.7 验收主题词容错匹配（同义改写不再误判）
// ---------------------------------------------------------------------------

test('P4.7 topicHit：严格子串命中优先', () => {
  const { topicHit } = require('../dist/verify.js');
  assert.strictEqual(topicHit('本节给出市场规模数据', '市场规模'), true);
});

test('P4.7 topicHit：同义改写的小节标题按「主题前缀」命中（≥2 连续汉字）', () => {
  const { topicHit } = require('../dist/verify.js');
  // 真实模型高频改写：planner 出「市场规模」，executor 写「市场概况与容量估算」——
  // 主题前缀「市场」命中；不再触发无谓的自检重跑。
  assert.strictEqual(topicHit('## 市场概况与容量估算\n正文…', '市场规模'), true);
  assert.strictEqual(topicHit('## 主要参与者与竞争态势', '竞争格局'), true);
  // 真正跑题（主题前缀完全不出现）仍判未命中。
  assert.strictEqual(topicHit('## 完全无关的内容\n天气与交通', '市场规模'), false);
});

test('P4.7 topicHit：拉丁词不做前缀容错（避免 AI→air 这类误命中）', () => {
  const { topicHit } = require('../dist/verify.js');
  assert.strictEqual(topicHit('the air quality report', 'AI Agent'), false);
  assert.strictEqual(topicHit('AI Agent 落地路径', 'AI Agent'), true);
});

test('P4.7 contains 断言走容错匹配（specsVerifier 层）', async () => {
  const v = specsVerifier([{ contains: '市场规模' }, { contains: '竞争格局' }], '任务验收', true);
  const r = await v(ctx({ final: '## 市场概况\n## 竞争者分析' }));
  // 「竞争格局」的前缀是「竞争」→ 命中；两条均命中 → 通过。
  assert.strictEqual(r.passed, true, `reasons=${r.reasons}`);
});

// ---------------------------------------------------------------------------
// P4.7 软性门禁（soft）：只告警不阻断，但仍参与 AND 与软性传播
// ---------------------------------------------------------------------------

test('P4.7 软性断言组未通过：passed=false 且 soft=true', async () => {
  const v = specsVerifier([{ contains: '绝不可能出现的词' }], '任务验收', true);
  const r = await v(ctx());
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.soft, true, '声明为软性组 → 未通过时标记 soft');
});

test('P4.7 硬性断言组未通过：不带 soft（存量语义不变）', async () => {
  const v = specsVerifier([{ contains: '绝不可能出现的词' }], '默认门禁');
  const r = await v(ctx());
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.soft, undefined, '未声明软性 → 硬性未通过');
});

test('P4.7 composeVerifiers 软性传播：全软组失败 → soft=true', async () => {
  const ok = specsVerifier([{ contains: 'done' }], '默认门禁');
  const soft = specsVerifier([{ contains: '绝不可能出现的词' }], '任务验收', true);
  const r = await composeVerifiers(ok, soft)(ctx());
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.soft, true, '唯一的失败方是软组 → 整体可软性化');
});

test('P4.7 composeVerifiers 硬性优先：硬组失败压过软组失败（soft 不生效）', async () => {
  const hard = specsVerifier([{ minLength: 999 }], '默认门禁');
  const soft = specsVerifier([{ contains: '绝不可能出现的词' }], '任务验收', true);
  const r = await composeVerifiers(hard, soft)(ctx());
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.soft, undefined, '任一硬组失败 → 不得软性化（空/兜底产出不会被漏拦）');
});

test('P4.7 composeVerifiers 全部通过：不带 soft', async () => {
  const r = await composeVerifiers(
    specsVerifier([{ contains: 'done' }], '默认门禁'),
    specsVerifier([{ contains: 'done' }], '任务验收', true)
  )(ctx());
  assert.strictEqual(r.passed, true);
  assert.strictEqual(r.soft, undefined);
});

// ---------------------------------------------------------------------------
// composeVerifiers（AND 组合）
// ---------------------------------------------------------------------------

test('composeVerifiers 全部通过才通过，分数取最低', async () => {
  const v = composeVerifiers(
    assertionsVerifier([(c) => c.final.includes('done')]),
    assertionsVerifier([(c) => c.steps > 0])
  );
  const ok = await v(ctx());
  assert.strictEqual(ok.passed, true);
  const bad = await v(ctx({ final: 'x' }));
  assert.strictEqual(bad.passed, false);
});

// ---------------------------------------------------------------------------
// createVerifier（从可序列化配置装配）
// ---------------------------------------------------------------------------

test('createVerifier auto → RuleBasedVerifier', async () => {
  const v = createVerifier({ auto: true });
  assert.ok(typeof v === 'function');
  assert.strictEqual((await v(ctx())).passed, true);
});

test('createVerifier ruleBased 别名同样启用规则门禁', () => {
  const v = createVerifier({ ruleBased: true });
  assert.ok(typeof v === 'function');
});

test('createVerifier assertions → 结果断言校验', async () => {
  const v = createVerifier({ assertions: [{ contains: 'done' }] });
  assert.strictEqual((await v(ctx())).passed, true);
  assert.strictEqual((await v(ctx({ final: 'nope' }))).passed, false);
});

test('createVerifier auto + assertions → 组合门禁', async () => {
  const v = createVerifier({ auto: true, assertions: [{ contains: 'done' }] });
  assert.strictEqual((await v(ctx())).passed, true);
  // 规则门禁硬失败（预算超限）应盖过断言通过。
  assert.strictEqual((await v(ctx({ budgetExceeded: true }))).passed, false);
});

test('createVerifier 无启用项返回 undefined', () => {
  assert.strictEqual(createVerifier(undefined), undefined);
  assert.strictEqual(createVerifier({}), undefined);
  assert.strictEqual(createVerifier({ assertions: [] }), undefined);
});
