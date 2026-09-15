'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { estimateTokens, estimateToolsTokens } = require('../dist/llm/token-estimator.js');
const { serializeToolsCached } = require('../dist/llm/shared.js');

test('estimateTokens 空输入为 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens 中文按系数计数(非 1 字 1 token)', () => {
  // 4 个汉字：ceil(4 * 0.6) = 3，修正此前 1 字 1 token 的高估。
  const n = estimateTokens('你好世界');
  assert.equal(n, 3);
  // 纯中文长度与 token 数不再相等，应小于字符数。
  assert.ok(n < '你好世界'.length, `中文 token 应小于字符数，实际 ${n}`);
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

test('serializeToolsCached：低频工具 description 被截短', () => {
  const longDesc = '这是一个非常长的工具描述，超过八十个字符，用于测试 serializeToolsCached 对低频工具的截断行为，确保不会发送完整的描述文本给模型，从而减少传输体积和 token 消耗。';
  const tools = [
    { function: { name: 'tool_a', description: longDesc } },
    { function: { name: 'tool_b', description: '简单描述' } },
  ];

  // 第一次调用：低频工具 description 应被截短
  const first = serializeToolsCached(tools);
  assert.ok(first[0].function.description.length < longDesc.length, '低频工具描述应被截短');
  assert.equal(first[1].function.description, '简单描述', '高频简单描述不变');

  // 第二次调用：缓存命中，返回相同引用
  const second = serializeToolsCached(tools);
  assert.equal(second, first, '缓存命中应返回相同对象引用');
});
