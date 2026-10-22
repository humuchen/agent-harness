'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  resolveTierConfig,
  resolveTierModel
} = require('../dist/llm/model-tier.js');

const HEAVY = 'openai/gpt-4o';
const LIGHT = 'openai/gpt-4o-mini';

function msg(role, content, tool_calls) {
  const m = { role, content };
  if (tool_calls) m.tool_calls = tool_calls;
  return m;
}

test('resolveTierConfig：默认关闭', () => {
  const cfg = resolveTierConfig(undefined, {});
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.lightModel, undefined);
});

test('resolveTierConfig：env 开启 + 轻量模型', () => {
  const cfg = resolveTierConfig(undefined, {
    AH_MODEL_TIERING: 'auto',
    AH_LIGHT_MODEL: LIGHT
  });
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.lightModel, LIGHT);
  assert.strictEqual(cfg.lightMaxChars, 4000);
  assert.strictEqual(cfg.greetingMaxChars, 256);
});

test('resolveTierConfig：配置对象优先于 env，且自定义阈值', () => {
  const cfg = resolveTierConfig(
    { lightModel: LIGHT, modelTiering: 'auto' },
    { AH_LIGHT_MODEL: 'other', AH_TIER_LIGHT_MAX_CHARS: '9999', AH_TIER_GREETING_MAX_CHARS: '100' }
  );
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.lightModel, LIGHT);
  assert.strictEqual(cfg.lightMaxChars, 9999);
  assert.strictEqual(cfg.greetingMaxChars, 100);
});

test('resolveTierModel：关闭时一律高阶', () => {
  const cfg = resolveTierConfig(undefined, {}); // 关闭
  const d = resolveTierModel({
    messages: [msg('user', '你好')],
    tools: [],
    model: HEAVY,
    cfg
  });
  assert.strictEqual(d.tier, 'high');
  assert.strictEqual(d.model, HEAVY);
});

test('resolveTierModel：轻量模型与高阶相同则不起作用', () => {
  const cfg = resolveTierConfig(undefined, { AH_MODEL_TIERING: 'auto', AH_LIGHT_MODEL: HEAVY });
  const d = resolveTierModel({
    messages: [msg('user', 'hi')],
    tools: [],
    model: HEAVY,
    cfg
  });
  assert.strictEqual(d.tier, 'high');
});

test('resolveTierModel：首轮极短问候 → 降级 light', () => {
  const cfg = resolveTierConfig(undefined, { AH_MODEL_TIERING: 'auto', AH_LIGHT_MODEL: LIGHT });
  const d = resolveTierModel({
    messages: [msg('system', '你是一个助手'), msg('user', '你好')],
    tools: [],
    model: HEAVY,
    cfg
  });
  assert.strictEqual(d.tier, 'light');
  assert.strictEqual(d.model, LIGHT);
  assert.strictEqual(d.promptChars, 8);
});

test('resolveTierModel：首轮长问题（超问候阈值）→ 保持 high', () => {
  const cfg = resolveTierConfig(undefined, { AH_MODEL_TIERING: 'auto', AH_LIGHT_MODEL: LIGHT });
  const longQ = '请详细解释' + 'x'.repeat(500);
  const d = resolveTierModel({
    messages: [msg('user', longQ)],
    tools: [],
    model: HEAVY,
    cfg
  });
  assert.strictEqual(d.tier, 'high');
});

test('resolveTierModel：工具结果合成步（小 prompt）→ 降级 light', () => {
  const cfg = resolveTierConfig(undefined, { AH_MODEL_TIERING: 'auto', AH_LIGHT_MODEL: LIGHT });
  const d = resolveTierModel({
    messages: [
      msg('user', '查一下订单'),
      msg('assistant', null, [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }]),
      msg('tool', '订单号 123，状态已付款')
    ],
    tools: [{ name: 'lookup', description: 'd', parameters: {} }],
    model: HEAVY,
    cfg
  });
  assert.strictEqual(d.tier, 'light');
  assert.strictEqual(d.model, LIGHT);
});

test('resolveTierModel：工具结果合成步但 prompt 超阈值 → 保持 high', () => {
  const cfg = resolveTierConfig(undefined, {
    AH_MODEL_TIERING: 'auto',
    AH_LIGHT_MODEL: LIGHT,
    AH_TIER_LIGHT_MAX_CHARS: '200'
  });
  const bigTool = 'x'.repeat(500);
  const d = resolveTierModel({
    messages: [
      msg('user', '查一下'),
      msg('assistant', null, [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }]),
      msg('tool', bigTool)
    ],
    tools: [{ name: 'lookup', description: 'd', parameters: {} }],
    model: HEAVY,
    cfg
  });
  assert.strictEqual(d.tier, 'high');
});

test('resolveTierModel：多轮复杂推理（无 tool_calls 收尾）→ 保持 high', () => {
  const cfg = resolveTierConfig(undefined, { AH_MODEL_TIERING: 'auto', AH_LIGHT_MODEL: LIGHT });
  const d = resolveTierModel({
    messages: [
      msg('user', '帮我设计一个方案'),
      msg('assistant', '好的，我们分析如下…'),
      msg('user', '再细化一下预算部分')
    ],
    tools: [],
    model: HEAVY,
    cfg
  });
  assert.strictEqual(d.tier, 'high');
});
