'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { estimateTokens, estimateToolsTokens } = require('../dist/llm/token-estimator.js');

test('estimateTokens 空输入为 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens 中文按字计数', () => {
  const n = estimateTokens('你好世界');
  assert.equal(n, 4);
});

test('estimateTokens 混合文本非0', () => {
  const n = estimateTokens('Hello 世界, this is a test.');
  assert.ok(n > 4, `混合文本应>4，实际 ${n}`);
});

test('estimateToolsTokens 累加各工具', () => {
  const tools = [
    { name: 'a', description: '工具A' },
    { name: 'b', description: '工具B较长描述用于验证累加' },
  ];
  const total = estimateToolsTokens(tools);
  assert.ok(total > 0);
  // 每个工具至少含名字的 token 数
  assert.ok(total >= estimateTokens('a') + estimateTokens('b'));
});
