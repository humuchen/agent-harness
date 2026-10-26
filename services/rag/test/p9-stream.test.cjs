// 增强：RAG 流式生成（SSE）测试 —— stub 流式 LLM 上游 + /v1/generate stream=true 契约。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('node:http');
const { createRagServer } = require('../dist/server');
const { MemoryVectorStore } = require('../dist/store');
const { HashEmbedding } = require('../dist/embed');
const { OpenAIProvider } = require('../dist/generate');

const TOKENS = ['退款', '政策', '为', '七天', '无理由', '。'];

let llmSrv;

before(async () => {
  // stub 流式 LLM（OpenAI 兼容 SSE）
  llmSrv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (!parsed.stream) {
        // 非流式回退（chat() 路径）
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ choices: [{ message: { content: TOKENS.join('') } }] }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const timer = setInterval(() => {
        if (i < TOKENS.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: TOKENS[i] } }] })}\n\n`);
          i++;
        } else {
          res.write('data: [DONE]\n\n');
          clearInterval(timer);
          res.end();
        }
      }, 5);
    });
  });
  await new Promise((r) => llmSrv.listen(0, r));
  globalThis.__llmBase = `http://127.0.0.1:${llmSrv.address().port}/v1`;
});

after(() => {
  llmSrv?.close();
});

function mkRag() {
  const store = new MemoryVectorStore(256);
  const vec = new HashEmbedding(256).embed('退款政策：七天无理由退款');
  store.upsert({
    chunk_id: 'c1', doc_id: 'd1', tenant_id: 'acme', index: 0,
    content: '退款政策：七天无理由退款', vector: vec, created_at: Date.now(),
  });
  process.env.RAG_ASYNC_INGEST = 'false';
  process.env.RAG_CACHE = 'false';
  return createRagServer({
    port: 0,
    store,
    provider: new HashEmbedding(256),
    llm: new OpenAIProvider({ baseUrl: globalThis.__llmBase, apiKey: 'k', model: 'm' }),
    tokens: new Map([['static-a', 'acme']]),
  });
}

describe('RAG 流式生成（/v1/generate stream=true → SSE）', () => {
  test('SSE 帧序列：sources → delta* → done（完整答案与增量拼接一致）', async () => {
    const rag = mkRag();
    await rag.listen();
    const base = `http://127.0.0.1:${rag.server.address().port}`;
    try {
      const r = await fetch(`${base}/v1/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer static-a' },
        body: JSON.stringify({ query: '退款政策是什么', stream: true, top_k: 3 }),
      });
      assert.equal(r.status, 200);
      assert.ok(String(r.headers.get('content-type')).includes('text/event-stream'), '应返回 SSE');
      const raw = await r.text();
      const events = raw
        .split('\n\n')
        .filter((f) => f.startsWith('data:'))
        .map((f) => JSON.parse(f.slice(5).trim()));
      const types = events.map((e) => e.type);
      assert.equal(types[0], 'sources', '首帧应为 sources');
      assert.equal(types[types.length - 1], 'done', '末帧应为 done');
      const deltas = events.filter((e) => e.type === 'delta');
      assert.ok(deltas.length >= 2, `应有多条增量，实际 ${deltas.length}`);
      const joined = deltas.map((d) => d.text).join('');
      assert.equal(joined, TOKENS.join(''), '增量拼接应等于完整文本');
      const done = events[events.length - 1];
      assert.equal(done.answer, TOKENS.join(''));
      assert.equal(done.trace_id.startsWith('rag_'), true);
      assert.ok(done.sources.length >= 1, 'done 应携带来源');
      // sources 帧
      assert.equal(events[0].retrieved >= 1, true);
      assert.ok(events[0].trace_id);
    } finally {
      await rag.close();
      delete process.env.RAG_ASYNC_INGEST;
      delete process.env.RAG_CACHE;
    }
  });

  test('非流式路径零回归：stream 缺省 → 原样 JSON 响应', async () => {
    const rag = mkRag();
    await rag.listen();
    const base = `http://127.0.0.1:${rag.server.address().port}`;
    try {
      const r = await fetch(`${base}/v1/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer static-a' },
        body: JSON.stringify({ query: '退款政策是什么' }),
      });
      assert.equal(r.status, 200);
      assert.ok(String(r.headers.get('content-type')).includes('application/json'));
      const j = await r.json();
      assert.equal(j.answer, TOKENS.join(''));
    } finally {
      await rag.close();
    }
  });

  test('LLM 失败 fail-closed：SSE 输出 error + 兜底文案（不伪造引用）', async () => {
    // 指向不存在端口的 LLM → chat/chatStream 均失败
    const rag = mkRag();
    // 替换 llm 为坏 baseUrl
    (rag.llm).baseUrl = 'http://127.0.0.1:9/v1';
    await rag.listen();
    const base = `http://127.0.0.1:${rag.server.address().port}`;
    try {
      const r = await fetch(`${base}/v1/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer static-a' },
        body: JSON.stringify({ query: '退款', stream: true }),
      });
      const raw = await r.text();
      const events = raw.split('\n\n').filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5).trim()));
      assert.ok(events.some((e) => e.type === 'error'), '应有 error 事件');
      const done = events.find((e) => e.type === 'done');
      assert.ok(done, '仍应有 done 帧（兜底文案）');
      assert.ok(done.answer.includes('生成服务暂时不可用'), 'fail-closed 兜底文案');
    } finally {
      await rag.close();
    }
  });
});
