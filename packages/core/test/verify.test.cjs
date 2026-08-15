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
