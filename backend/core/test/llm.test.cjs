'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createOpenRouterLLM } = require('../dist/llm/openrouter.js');
const { createOpenAILLM } = require('../dist/llm/openai.js');

// 构造一个返回标准 OpenAI Chat Completions 形态的 mock fetch
function jsonFetch(body, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

const TOOL_COMPLETION = {
  choices: [
    {
      message: {
        content: '',
        tool_calls: [
          { id: 't1', function: { name: 'do_thing', arguments: '{"a":1}' } },
        ],
      },
    },
  ],
};

test('OpenRouter：解析工具调用参数（容错 JSON）', async () => {
  const llm = createOpenRouterLLM({ apiKey: 'k', fetchImpl: jsonFetch(TOOL_COMPLETION), retries: 0 });
  const res = await llm([{ role: 'user', content: 'hi' }], []);
  assert.equal(res.tool_calls.length, 1);
  assert.equal(res.tool_calls[0].name, 'do_thing');
  assert.deepStrictEqual(res.tool_calls[0].arguments, { a: 1 });
});

test('OpenRouter：发送 models 降级数组', async () => {
  let captured;
  const spy = async (url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }), text: async () => '' };
  };
  const llm = createOpenRouterLLM({ apiKey: 'k', models: ['a/b', 'c/d'], fetchImpl: spy, retries: 0 });
  await llm([{ role: 'user', content: 'hi' }], []);
  assert.deepStrictEqual(captured.models, ['a/b', 'c/d']);
  assert.equal(captured.model, undefined);
});

test('OpenRouter：429 后按重试次数重试并最终成功', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'recovered', tool_calls: [] } }] }), text: async () => '' };
  };
  const llm = createOpenRouterLLM({ apiKey: 'k', fetchImpl: flaky, retries: 3 });
  const res = await llm([{ role: 'user', content: 'hi' }], []);
  assert.equal(res.content, 'recovered');
  assert.equal(calls, 3);
});

test('OpenAI：基本请求并解析内容', async () => {
  const llm = createOpenAILLM({ apiKey: 'k', fetchImpl: jsonFetch({ choices: [{ message: { content: 'hi there', tool_calls: [] } }] }), retries: 0 });
  const res = await llm([{ role: 'user', content: 'hi' }], []); // 第三个参数可选
  assert.equal(res.content, 'hi there');
});

test('取消信号透传给 fetch', async () => {
  let seenSignal;
  const spy = async (url, init) => {
    seenSignal = init.signal;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }), text: async () => '' };
  };
  const llm = createOpenRouterLLM({ apiKey: 'k', fetchImpl: spy, retries: 0 });
  const ac = new AbortController();
  await llm([{ role: 'user', content: 'hi' }], [], { signal: ac.signal });
  assert.equal(seenSignal, ac.signal);
});
