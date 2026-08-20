// P3 测试：查询缓存命中、metrics 可观测、按租户分片持久化、Pre-retrieval 查询扩展。
// HTTP 集成：起真实 server（动态端口），走「JWT 鉴权 → 异步入库 → 轮询 job → 检索 → 缓存 → metrics → 分片」全链路。
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, existsSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRagServer } = require('../dist/server');
const { signJwt } = require('../dist/auth');
const { MemoryVectorStore } = require('../dist/store');
const { HashEmbedding } = require('../dist/embed');

async function listen(srv) {
  await srv.listen();
  const addr = srv.server.address();
  return `http://127.0.0.1:${addr.port}`;
}

test('HTTP: JWT 鉴权 + 异步入库 + 缓存命中 + metrics + 分片持久化 + 查询扩展', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-p3-'));
  const dataFile = join(dir, 'rag.json');
  process.env.RAG_SHARD_BY_TENANT = 'true';
  process.env.RAG_CACHE = 'true';
  process.env.RAG_ASYNC_INGEST = 'true';

  const srv = createRagServer({
    port: 0,
    store: new MemoryVectorStore(256),
    provider: new HashEmbedding(256),
    tokens: new Map([['static-a', 'acme']]),
    dataFile,
    jwtSecret: 'jwt-secret',
  });
  const baseUrl = await listen(srv);
  const jwt = signJwt({ tenant: 'acme' }, 'jwt-secret', { expiresInSec: 600 });
  const auth = (t) => (t ? { authorization: `Bearer ${t}` } : {});

  try {
    // 1) 鉴权：缺失 401 / 错令牌 403 / JWT 200
    let r = await fetch(`${baseUrl}/v1/retrieve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x' }) });
    assert.equal(r.status, 401, '无令牌应 401');
    r = await fetch(`${baseUrl}/v1/retrieve`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth('wrong') }, body: JSON.stringify({ query: 'x' }) });
    assert.equal(r.status, 403, '错令牌应 403');

    // 2) 异步入库：静态令牌 -> 202 + job_id
    r = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth('static-a') },
      body: JSON.stringify({ doc_id: 'd1', title: '退款政策', text: '退款政策：支持七天无理由退款，退款原路返回支付账户。', tags: ['policy'] }),
    });
    assert.equal(r.status, 202, '异步入库应 202 Accepted');
    const accepted = await r.json();
    assert.ok(accepted.job_id, '应返回 job_id');

    // 3) 轮询 job 完成
    let done = false;
    for (let i = 0; i < 100; i++) {
      const jr = await fetch(`${baseUrl}/v1/ingest/${accepted.job_id}`, { headers: auth(jwt) });
      const job = await jr.json();
      if (job.status === 'done') { done = true; break; }
      await new Promise((rr) => setTimeout(rr, 30));
    }
    assert.ok(done, '异步任务应完成');

    // 4) 检索 + 缓存命中
    const body = { query: '退款', top_k: 3 };
    const r1 = await fetch(`${baseUrl}/v1/retrieve`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(jwt) }, body: JSON.stringify(body) });
    const j1 = await r1.json();
    assert.equal(j1.cache_hit, false, '首次应未命中缓存');
    assert.ok(j1.results.length >= 1, '应召回片段');
    assert.ok(j1.results[0].score > 0, '融合分应 >0');

    const r2 = await fetch(`${baseUrl}/v1/retrieve`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(jwt) }, body: JSON.stringify(body) });
    const j2 = await r2.json();
    assert.equal(j2.cache_hit, true, '重复查询应命中缓存');
    assert.equal(j2.results.length, j1.results.length, '缓存内容应与首次一致');

    // 5) Pre-retrieval：expand 返回扩展词
    const er = await fetch(`${baseUrl}/v1/retrieve`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(jwt) }, body: JSON.stringify({ query: '退款', expand: true }) });
    const ej = await er.json();
    assert.ok(Array.isArray(ej.expanded_terms), 'expand 应返回扩展词数组');

    // 6) metrics 端点（Prometheus 文本）
    const mr = await fetch(`${baseUrl}/v1/metrics`);
    const text = await mr.text();
    assert.ok(text.includes('rag_retrieve_total'), 'metrics 应含检索计数');
    assert.ok(text.includes('rag_tenant_chunks{tenant="acme"} 1'), 'metrics 应含租户 chunk 计数');
    assert.ok(text.includes('rag_retrieve_latency_ms{p="95"}'), 'metrics 应含 P95');

    // 7) health 附队列统计
    const hr = await fetch(`${baseUrl}/v1/health`);
    const health = await hr.json();
    assert.ok(health.ingest.done >= 1, 'health 应含异步入库完成数');
    assert.ok(health.cache_size >= 2, 'health 应含缓存条目数');

    // 8) 分片持久化：<base>.<tenant>.json 落盘 + 可重载
    const shardFile = join(dir, 'rag.json.acme.json');
    assert.ok(existsSync(shardFile), '应按租户分片落盘');
    const raw = JSON.parse(readFileSync(shardFile, 'utf8'));
    assert.equal(raw.tenant, 'acme');
    const store2 = new MemoryVectorStore(256);
    store2.load(dataFile, true);
    assert.equal(store2.count('acme'), 1, '分片重载应恢复 chunk');
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.RAG_SHARD_BY_TENANT;
    delete process.env.RAG_CACHE;
    delete process.env.RAG_ASYNC_INGEST;
  }
});
