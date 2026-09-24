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
  // 非流式请求已加独立 HTTP 超时兜底（LLM_HTTP_TIMEOUT_MS，修复「TCP 挂起永久阻塞」）：
  // fetch 收到的可能是与超时信号合并后的组合信号（AbortSignal.any），不再保证对象同一。
  // 透传语义的判据是「外部取消会传导到 fetch 收到的信号」。
  assert.equal(seenSignal.aborted, false);
  ac.abort();
  assert.equal(seenSignal.aborted, true);
});

test('非流式请求：LLM_HTTP_TIMEOUT_MS 独立超时兜底生效', async () => {
  process.env.LLM_HTTP_TIMEOUT_MS = '20'; // callOpenAIChat 内逐次读取，进程内即时生效
  // 模拟真实 fetch 的 signal 语义：挂起不动，但 signal abort 时立即 reject。
  const llm = createOpenRouterLLM({
    apiKey: 'k',
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) return;
        if (sig.aborted) return reject(new Error('The operation was aborted'));
        sig.addEventListener(
          'abort',
          () => reject(new Error('The operation was aborted due to timeout')),
          { once: true }
        );
      }),
    retries: 0,
  });
  // 注意：AbortSignal.timeout 内部定时器是 unref 的——若事件循环无其它 ref 句柄
  // 会直接排空，node:test 会以「event loop resolved」取消本用例。加一个受控
  // keep-alive 撑住循环，测试结束即清理。
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(() => llm([{ role: 'user', content: 'hi' }], []), /abort/i);
  } finally {
    clearTimeout(keepAlive);
    delete process.env.LLM_HTTP_TIMEOUT_MS;
  }
});

// ---------------------------------------------------------------------------
// 流式路径：首字节前重试 + 熔断器接入（修复 stream 绕过 breaker/重试）
// ---------------------------------------------------------------------------

// 构造带 getReader 的 SSE 响应 mock
function sseResponse(lines) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () =>
          i < lines.length
            ? { done: false, value: encoder.encode(lines[i++]) }
            : { done: true, value: undefined },
      }),
    },
  };
}

test('流式：首字节前 429 可重试并最终成功', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 429, text: async () => 'rate limited', headers: { get: () => null } };
    }
    return sseResponse(['data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', 'data: [DONE]\n\n']);
  };
  const llm = createOpenRouterLLM({ apiKey: 'k', fetchImpl: flaky, retries: 2 });
  const tokens = [];
  const res = await llm([{ role: 'user', content: 'hi' }], [], { onToken: (d) => tokens.push(d) });
  assert.equal(calls, 2, '429 后应重试一次');
  assert.equal(res.content, 'hello');
  assert.deepEqual(tokens.join(''), 'hello');
});

test('流式：传入的 circuitBreaker 生效（不再被静默忽略）', async () => {
  let wrapped = 0;
  const spyBreaker = {
    async withRequest(fn) {
      wrapped += 1;
      return fn();
    },
  };
  const llm = createOpenRouterLLM({
    apiKey: 'k',
    fetchImpl: async () => sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']),
    retries: 0,
  });
  const res = await llm([{ role: 'user', content: 'hi' }], [], { circuitBreaker: spyBreaker, onToken: () => {} });
  assert.equal(res.content, 'ok');
  assert.ok(wrapped >= 1, 'stream fetch 必须经 circuitBreaker.withRequest 包裹');
});

test('流式：非 200 且不可重试（retries=0）→ 直接抛错', async () => {
  const llm = createOpenRouterLLM({
    apiKey: 'k',
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'forbidden', headers: { get: () => null } }),
    retries: 0,
  });
  await assert.rejects(() => llm([{ role: 'user', content: 'hi' }], [], { onToken: () => {} }), /403/);
});
