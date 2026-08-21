'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry, objectParams } = require('../dist/tools.js');
const { Memory } = require('../dist/memory.js');

// 一次性返回最终文本（无工具调用）的 Mock LLM
function singleTurnLLM(text) {
  return async () => ({ content: text, tool_calls: [] });
}

// 第一轮返回工具调用、第二轮返回最终文本的 Mock LLM
function toolLoopLLM(toolName, finalText) {
  let n = 0;
  return async () => {
    n += 1;
    if (n === 1) {
      return { content: '', tool_calls: [{ id: 'c1', name: toolName, arguments: { x: 1 } }] };
    }
    return { content: finalText, tool_calls: [] };
  };
}

// 永不 settle 的 LLM（用于超时 / 取消测试）
function hangingLLM() {
  return async () => new Promise(() => {});
}

test('单次对话：直接返回最终文本', async () => {
  const h = new AgentHarness({ llm: singleTurnLLM('你好'), tools: new ToolRegistry() });
  const out = await h.run('hi');
  assert.equal(out, '你好');
});

test('工具循环：工具结果回灌后再产出最终文本', async () => {
  const tools = new ToolRegistry();
  tools.register('double', '翻倍', objectParams({ x: { type: 'number' } }, ['x']), (a) => Number(a.x) * 2);
  const h = new AgentHarness({ llm: toolLoopLLM('double', 'done'), tools });
  const out = await h.run('go');
  assert.equal(out, 'done');
});

test('输入护栏命中：直接拦截并返回提示', async () => {
  const h = new AgentHarness({ llm: singleTurnLLM('x'), tools: new ToolRegistry() });
  const out = await h.run('AKIAIOSFODNN7EXAMPLE');
  assert.match(out, /blocked/);
});

test('remember 注入系统提示词（长期记忆可见）', async () => {
  let captured;
  const captureLLM = async (messages) => {
    captured = messages;
    return { content: 'ok', tool_calls: [] };
  };
  const h = new AgentHarness({ llm: captureLLM, tools: new ToolRegistry(), systemPrompt: 'SYS' });
  h.remember('长期笔记：偏好 A');
  await h.run('hi');
  assert.equal(captured[0].role, 'system');
  assert.match(captured[0].content, /SYS/);
  assert.match(captured[0].content, /长期笔记：偏好 A/);
});

test('超时：永不返回的 LLM 在 timeoutMs 后中止', async () => {
  const h = new AgentHarness({ llm: hangingLLM(), tools: new ToolRegistry(), timeoutMs: 50 });
  const out = await h.run('hi');
  assert.match(out, /timeout/);
});

test('外部取消：外部 signal abort 后中止', async () => {
  const ac = new AbortController();
  const h = new AgentHarness({ llm: hangingLLM(), tools: new ToolRegistry(), signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  const out = await h.run('hi');
  assert.match(out, /abort/);
});

test('事件流：发出 run:start / step:start / run:end', async () => {
  const events = [];
  const h = new AgentHarness({
    llm: singleTurnLLM('ok'),
    tools: new ToolRegistry(),
    onEvent: (e) => events.push(e.type),
  });
  await h.run('hi');
  assert.ok(events.includes('run:start'));
  assert.ok(events.includes('step:start'));
  assert.ok(events.includes('run:end'));
});
