// 重排测试（P2：真实 cross-encoder 重排 + MMR 兜底）。
// 覆盖：MMR 多样性重排确定性、rerankWithApi 未配置回退 null、本地 stub Rerank API 集成
// （HTTP 全链路：检索 → API 反转相关性 → 结果按 API 分数重排 + rerank_score）。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mmrRerank, rerankWithApi } = require('../dist/rerank');
const { createRagServer } = require('../dist/server');
const { MemoryVectorStore } = require('../dist/store');
const { HashEmbedding } = require('../dist/embed');

/** 起一个本地 stub Rerank API：把输入文档按逆序打分（index i -> (n-1-i) 相关性）。 */
function startStubRerank() {
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let docs = [];
      try {
        docs = JSON.parse(body).documents || [];
      } catch {
        /* ignore */
      }
      const n = Math.max(1, docs.length);
      // index i -> i/(n-1)：把靠后的文档打更高分（反转自然序），用于验证重排生效
      const results = docs.map((_, i) => ({ index: i, relevance_score: i / Math.max(1, n - 1) }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results }));
    });
  });
  return new Promise((resolve) => {
    stub.listen(0, () => resolve(stub));
  });
}

async function listen(srv) {
  await srv.listen();
  return `http://127.0.0.1:${srv.server.address().port}`;
}

test('MMR: 多样性重排（高相关但冗余的被排后）', () => {
  const vectorMap = new Map([
    ['A', [1, 0]],
    ['B', [0, 1]],
    ['C', [0.99, 0.14]],
  ]);
  const items = [
    { chunk_id: 'A', score: 0.9 },
    { chunk_id: 'C', score: 0.85 }, // 与 A 高度相似（冗余）
    { chunk_id: 'B', score: 0.6 }, // 与 A 正交（多样性）
  ];
  const ordered = mmrRerank(items, vectorMap, 0.5);
  assert.equal(ordered[0].chunk_id, 'A', '首条应为最高相关度');
  assert.equal(ordered[1].chunk_id, 'B', '第二条应为多样性更强的 B（而非冗余的 C）');
  assert.equal(ordered[2].chunk_id, 'C', '冗余的 C 应排最后');
});

test('rerankWithApi: 未配置 URL/KEY 返回 null（回退路径）', async () => {
  const results = [{ chunk_id: 'a', doc_id: 'a', content: 'x', score: 1 }];
  assert.equal(await rerankWithApi('q', results, { apiUrl: '', apiKey: '' }), null, '缺配置应回退');
  assert.equal(await rerankWithApi('q', results, { apiUrl: 'http://x', apiKey: '' }), null);
  assert.equal(await rerankWithApi('q', results, { apiUrl: '', apiKey: 'k' }), null);
});

test('rerankWithApi: 真实调用成功（stub 反转相关性）', async () => {
  const stub = await startStubRerank();
  const apiUrl = `http://127.0.0.1:${stub.address().port}/v1/rerank`;
  try {
    const results = [
      { chunk_id: 'a', doc_id: 'a', content: '退款政策', score: 0.8 },
      { chunk_id: 'b', doc_id: 'b', content: '退款流程', score: 0.6 },
    ];
    const rr = await rerankWithApi('退款', results, { apiUrl, apiKey: 'k', model: 'stub-model' });
    assert.ok(rr, '应返回重排结果');
    assert.equal(rr.length, 2);
    assert.equal(rr[0].chunk_id, 'b', 'stub 把 index1 打最高分，应排第一');
    assert.equal(rr[0].rerank_score, 1, '应记录 API 相关性分');
    assert.equal(rr[1].rerank_score, 0);
    // 原融合分保留
    assert.equal(rr[0].score, 0.6);
  } finally {
    stub.close();
  }
});

test('HTTP 集成: RAG_RERANK=api 检索后按 API 分数重排', async () => {
  const stub = await startStubRerank();
  const apiUrl = `http://127.0.0.1:${stub.address().port}/v1/rerank`;
  process.env.RAG_RERANK = 'api';
  process.env.RAG_RERANK_API_URL = apiUrl;
  process.env.RAG_RERANK_API_KEY = 'k';
  process.env.RAG_ASYNC_INGEST = 'false'; // 同步入库保证确定性
  const srv = createRagServer({
    port: 0,
    store: new MemoryVectorStore(256),
    provider: new HashEmbedding(256),
    defaultTenant: 'acme',
  });
  const baseUrl = await listen(srv);

  try {
    const post = (path, body) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    await post('/v1/ingest', { doc_id: 'd1', title: '退款政策', text: '退款政策：支持七天无理由退款，退款原路返回。' });
    await post('/v1/ingest', { doc_id: 'd2', title: '退款流程', text: '退款流程：申请退款需要提交订单号与原因。' });

    const r = await post('/v1/retrieve', { query: '退款', top_k: 3 });
    const j = await r.json();
    assert.ok(j.results.length >= 2, '应召回两个相关文档');
    // stub 按输入位置打分（index i -> i/(n-1)）：首位必携带 API 最高分 1，末位 0
    assert.equal(j.results[0].rerank_score, 1, 'API 最高分应位于首位');
    assert.equal(j.results[1].rerank_score, 0, 'API 最低分应位于末位');
    assert.notEqual(j.results[0].doc_id, j.results[1].doc_id);
    // 重排结果应被缓存（cache_hit 契约仍在，内容与首次一致）
    const r2 = await post('/v1/retrieve', { query: '退款', top_k: 3 });
    const j2 = await r2.json();
    assert.equal(j2.cache_hit, true);
    assert.deepEqual(j2.results, j.results, '缓存命中应与重排结果一致');
  } finally {
    await srv.close();
    stub.close();
    delete process.env.RAG_RERANK;
    delete process.env.RAG_RERANK_API_URL;
    delete process.env.RAG_RERANK_API_KEY;
    delete process.env.RAG_ASYNC_INGEST;
  }
});
