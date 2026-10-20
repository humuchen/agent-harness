// P6-C：LLM 响应引用来源归一（citations）—— 双 wire 形态（顶层累积数组 / annotations
// url_citation 对象）统一抽 url、按出现序去重；流式与非流式（单条 JSON）路径都覆盖。
const test = require('node:test');
const assert = require('node:assert');
const { createOpenRouterLLM } = require('../dist/llm/openrouter.js');

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

test('P6-C citations: 顶层累积数组 + delta.annotations 双形态归一去重', async () => {
  const llm = createOpenRouterLLM({
    apiKey: 'k',
    retries: 0,
    fetchImpl: async () =>
      sseResponse([
        'data: {"citations":["https://a.com"],"choices":[{"delta":{"content":"答","annotations":[{"type":"url_citation","url_citation":{"url":"https://a.com","title":"A"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"案"}}]}\n\n',
        'data: {"citations":["https://a.com","https://b.com"]}\n\n',
        'data: [DONE]\n\n',
      ]),
  });
  const res = await llm([{ role: 'user', content: 'q' }], [], { onToken: () => {} });
  assert.strictEqual(res.content, '答案');
  // a.com 同时来自 annotations 与两次顶层 citations —— 去重后按首次出现序。
  assert.deepStrictEqual(res.citations, ['https://a.com', 'https://b.com']);
});

test('P6-C citations: 无引用响应缺省该字段（零回归）；非流式单条 JSON 路径同样归一', async () => {
  // 无引用：字段缺省（无 onToken → 非流式路径，mock 提供 json()）。
  const llm1 = createOpenRouterLLM({
    apiKey: 'k',
    retries: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ model: 'm', choices: [{ message: { content: 'hi' } }] }),
    }),
  });
  const r1 = await llm1([{ role: 'user', content: 'q' }], []);
  assert.strictEqual(r1.content, 'hi');
  assert.strictEqual(r1.citations, undefined);

  // 非流式：整条 JSON 无 data: 前缀 → sawSse=false 兜底解析路径。
  const body = {
    model: 'm',
    citations: ['https://c.com', 'https://c.com'],
    choices: [
      {
        message: {
          content: 'x',
          reasoning_content: 'think',
          annotations: [{ url_citation: { url: 'https://d.com' } }],
        },
      },
    ],
  };
  const encoder = new TextEncoder();
  let sent = false;
  const llm2 = createOpenRouterLLM({
    apiKey: 'k',
    retries: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            !sent
              ? ((sent = true), { done: false, value: encoder.encode(JSON.stringify(body)) })
              : { done: true, value: undefined },
        }),
      },
    }),
  });
  const r2 = await llm2([{ role: 'user', content: 'q' }], [], { onToken: () => {} });
  assert.strictEqual(r2.content, 'x');
  assert.deepStrictEqual(r2.citations, ['https://c.com', 'https://d.com']);
});
