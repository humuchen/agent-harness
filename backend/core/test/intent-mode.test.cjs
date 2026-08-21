// 零依赖测试（node:test + node:assert）：覆盖 P2 投产 Gap 4 —— INTENT_ROUTER 智能降级模式。
// 关注：resolveIntentMode 把 'auto' 收敛为 'rule'|'llm'、显式 llm/rule 优先、缺省 rule、
// IntentRouter.activeMode 反映生效模式。
//
// 直接 require 编译后的叶子模块（../dist/index.js）。

const test = require('node:test');
const assert = require('node:assert');

const core = require('../dist/index.js');
const { resolveIntentMode, IntentRouter } = core;

test('resolveIntentMode：显式 llm → llm（忽略 env key）', () => {
  assert.strictEqual(resolveIntentMode('llm', { OPENROUTER_API_KEY: '' }), 'llm');
});

test('resolveIntentMode：显式 rule → rule（即使有 key）', () => {
  assert.strictEqual(resolveIntentMode('rule', { OPENROUTER_API_KEY: 'sk-x' }), 'rule');
});

test('resolveIntentMode：auto + 有 OPENROUTER_API_KEY → llm（精准）', () => {
  assert.strictEqual(resolveIntentMode('auto', { OPENROUTER_API_KEY: 'sk-x' }), 'llm');
});

test('resolveIntentMode：auto + 无 OPENROUTER_API_KEY → rule（离线可用）', () => {
  assert.strictEqual(resolveIntentMode('auto', {}), 'rule');
  assert.strictEqual(resolveIntentMode('auto', { OPENROUTER_API_KEY: '' }), 'rule');
});

test('resolveIntentMode：缺省（无参数）→ rule（向后兼容）', () => {
  assert.strictEqual(resolveIntentMode(undefined, {}), 'rule');
});

test('resolveIntentMode：env INTENT_ROUTER=auto 收敛为 rule（无 key）', () => {
  assert.strictEqual(resolveIntentMode(undefined, { INTENT_ROUTER: 'auto' }), 'rule');
});

test('resolveIntentMode：env INTENT_ROUTER=llm → llm', () => {
  assert.strictEqual(resolveIntentMode(undefined, { INTENT_ROUTER: 'llm' }), 'llm');
});

test('resolveIntentMode：未知值 → rule（稳健降级）', () => {
  assert.strictEqual(resolveIntentMode('bogus', {}), 'rule');
  assert.strictEqual(resolveIntentMode(undefined, { INTENT_ROUTER: 'weird' }), 'rule');
});

test('IntentRouter：mode=rule → activeMode rule', () => {
  assert.strictEqual(new IntentRouter({ mode: 'rule' }).activeMode, 'rule');
});

test('IntentRouter：mode=llm → activeMode llm', () => {
  assert.strictEqual(new IntentRouter({ mode: 'llm' }).activeMode, 'llm');
});

test('IntentRouter：mode=auto + 有 key → activeMode llm', () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-test';
  try {
    assert.strictEqual(new IntentRouter({ mode: 'auto' }).activeMode, 'llm');
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('IntentRouter：mode=auto + 无 key → activeMode rule（降级可用）', () => {
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.strictEqual(new IntentRouter({ mode: 'auto' }).activeMode, 'rule');
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  }
});
