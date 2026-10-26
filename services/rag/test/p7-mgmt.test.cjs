// 短中期增量测试：
//   短期1  trace 透传（X-Trace-Id 头 / body.trace_id 全程复用）
//   短期2  ingest 后查询缓存按租户失效（消除 TTL 窗口脏读）
//   中期5  文档管理 API（GET /v1/documents + DELETE /v1/documents/:docId）
//   中期6  BM25 语料快照按 revision 失效重建（写入后新文档立即可召回）
//   长期9  文档级 ACL（sqlite 迁移 + 持久化 + 检索过滤 + 文档列表）
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRagServer } = require('../dist/server');
const { MemoryVectorStore, SqliteVectorStore, aclVisible } = require('../dist/store');
const { HashEmbedding } = require('../dist/embed');

async function listen(srv) {
  await srv.listen();
  const addr = srv.server.address();
  return `http://127.0.0.1:${addr.port}`;
}

function mkServer(store, { asyncIngest = false } = {}) {
  process.env.RAG_ASYNC_INGEST = asyncIngest ? 'true' : 'false';
  process.env.RAG_CACHE = 'true';
  return createRagServer({
    port: 0,
    store,
    provider: new HashEmbedding(256),
    tokens: new Map([['static-a', 'acme']]),
  });
}

const auth = { 'content-type': 'application/json', authorization: 'Bearer static-a' };

test('短期1: X-Trace-Id 请求头全程复用（retrieve / generate 契约）', async () => {
  const srv = mkServer(new MemoryVectorStore(256));
  const base = await listen(srv);
  try {
    await srv.store.upsert({
      chunk_id: 'c1', doc_id: 'd1', tenant_id: 'acme', index: 0,
      content: '退款政策：七天无理由退款', vector: new HashEmbedding(256).embed('退款政策：七天无理由退款'),
      created_at: Date.now(),
    });
    const r = await fetch(`${base}/v1/retrieve`, {
      method: 'POST', headers: { ...auth, 'x-trace-id': 'trace-e2e-abc' },
      body: JSON.stringify({ query: '退款' }),
    });
    const j = await r.json();
    assert.equal(j.trace_id, 'trace-e2e-abc', '响应应复用 X-Trace-Id 头');
    // body.trace_id 兼容通道（用不同 query 避开查询缓存 —— 缓存复用整条响应，属预期）
    const r2 = await fetch(`${base}/v1/retrieve`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ query: '退款 政策', trace_id: 'trace-body-xyz' }),
    });
    const j2 = await r2.json();
    assert.equal(j2.trace_id, 'trace-body-xyz', 'body.trace_id 应作为兼容通道生效');
    // 未传时生成新 id（rag_ 前缀；用独立 query 避开查询缓存）
    const r3 = await fetch(`${base}/v1/retrieve`, { method: 'POST', headers: auth, body: JSON.stringify({ query: '退款 政策 流程' }) });
    const j3 = await r3.json();
    assert.ok(String(j3.trace_id).startsWith('rag_'), '未传 trace 时应生成新 id');
  } finally {
    await srv.close();
    delete process.env.RAG_ASYNC_INGEST;
    delete process.env.RAG_CACHE;
  }
});

test('短期2 + 中期6: ingest 后缓存失效联动；BM25 语料随 revision 重建', async () => {
  const srv = mkServer(new MemoryVectorStore(256));
  const base = await listen(srv);
  try {
    await srv.store.upsert({
      chunk_id: 'c1', doc_id: 'd1', tenant_id: 'acme', index: 0,
      content: '门店营业时间为每天九点到十八点', vector: new HashEmbedding(256).embed('门店营业时间为每天九点到十八点'),
      created_at: Date.now(),
    });
    const body = JSON.stringify({ query: '营业时间', top_k: 3 });
    const j1 = await (await fetch(`${base}/v1/retrieve`, { method: 'POST', headers: auth, body })).json();
    assert.equal(j1.cache_hit, false);
    const j2 = await (await fetch(`${base}/v1/retrieve`, { method: 'POST', headers: auth, body })).json();
    assert.equal(j2.cache_hit, true, '重复查询应命中缓存');

    // 同步 ingest 新文档（含旧索引没有的词）→ 缓存应被失效、BM25 语料随 revision 重建
    const ir = await fetch(`${base}/v1/ingest`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ doc_id: 'd2', title: '退款', text: '光子嫩肤术后需要严格防晒' }),
    });
    assert.equal(ir.status, 200, '同步入库应 200');
    const body2 = JSON.stringify({ query: '光子嫩肤', top_k: 3 });
    const j3 = await (await fetch(`${base}/v1/retrieve`, { method: 'POST', headers: auth, body: body2 })).json();
    assert.equal(j3.cache_hit, false, 'ingest 后原缓存应已失效');
    assert.ok(j3.results.length >= 1, '新文档应立即可召回（BM25 语料已重建）');
    assert.equal(j3.results[0].doc_id, 'd2');

    // revision 语义：写路径自增
    const revBefore = srv.store.revision();
    await fetch(`${base}/v1/ingest`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ doc_id: 'd3', text: '停车场的入口在东侧' }),
    });
    assert.ok(srv.store.revision() > revBefore, 'ingest 应推进 store.revision');
  } finally {
    await srv.close();
    delete process.env.RAG_ASYNC_INGEST;
    delete process.env.RAG_CACHE;
  }
});

test('中期5: 文档管理 API — 列表 + 删除（租户隔离）', async () => {
  const srv = mkServer(new MemoryVectorStore(256));
  const base = await listen(srv);
  try {
    for (const [id, text] of [['d1', '项目一的热玛吉介绍'], ['d2', '项目二的水光针介绍']]) {
      await fetch(`${base}/v1/ingest`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ doc_id: id, title: id, text }),
      });
    }
    const lr = await fetch(`${base}/v1/documents`, { headers: { authorization: 'Bearer static-a' } });
    assert.equal(lr.status, 200);
    const lj = await lr.json();
    assert.equal(lj.tenant_id, 'acme');
    const ids = lj.docs.map((d) => d.doc_id).sort();
    assert.deepEqual(ids, ['d1', 'd2'], '列表应含两篇文档');
    assert.ok(lj.docs.every((d) => d.chunks >= 1), '每篇应带 chunk 计数');

    // 删除 d2
    const dr = await fetch(`${base}/v1/documents/d2`, { method: 'DELETE', headers: { authorization: 'Bearer static-a' } });
    assert.equal(dr.status, 200);
    const dj = await dr.json();
    assert.ok(dj.deleted >= 1, '删除应返回删除 chunk 数');
    const lr2 = await fetch(`${base}/v1/documents`, { headers: { authorization: 'Bearer static-a' } });
    const lj2 = await lr2.json();
    assert.deepEqual(lj2.docs.map((d) => d.doc_id), ['d1'], '删除后列表应只剩 d1');

    // 删除不存在文档：deleted=0 但不报错（幂等）
    const dr2 = await fetch(`${base}/v1/documents/nope`, { method: 'DELETE', headers: { authorization: 'Bearer static-a' } });
    assert.equal(dr2.status, 200);
    assert.equal((await dr2.json()).deleted, 0);

    // 未鉴权应 401
    assert.equal((await fetch(`${base}/v1/documents`)).status, 401, '列表未鉴权应 401');
  } finally {
    await srv.close();
    delete process.env.RAG_ASYNC_INGEST;
    delete process.env.RAG_CACHE;
  }
});

test('长期9: 文档级 ACL — 检索过滤 + ingest.acl + 文档列表透出', async () => {
  const srv = mkServer(new MemoryVectorStore(256));
  const base = await listen(srv);
  try {
    await fetch(`${base}/v1/ingest`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ doc_id: 'pub', text: '公开的项目价格区间说明' }),
    });
    await fetch(`${base}/v1/ingest`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ doc_id: 'secret', text: '内部渠道返佣政策细则', acl: ['group:vip'] }),
    });
    const q = JSON.stringify({ query: '返佣政策细则', top_k: 5 });

    const noP = await (await fetch(`${base}/v1/retrieve`, { method: 'POST', headers: auth, body: q })).json();
    assert.ok(!noP.results.some((r) => r.doc_id === 'secret'), '无 principals 不可见受限文档');

    const wrongP = await (await fetch(`${base}/v1/retrieve`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ query: '返佣政策细则', top_k: 5, acl_principals: ['group:staff'] }),
    })).json();
    assert.ok(!wrongP.results.some((r) => r.doc_id === 'secret'), 'principal 不匹配不可见');

    const vip = await (await fetch(`${base}/v1/retrieve`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ query: '返佣政策细则', top_k: 5, acl_principals: ['user:u1', 'group:vip'] }),
    })).json();
    assert.ok(vip.results.some((r) => r.doc_id === 'secret'), 'principal 交集可见');

    // 文档列表透出 acl
    const lj = await (await fetch(`${base}/v1/documents`, { headers: { authorization: 'Bearer static-a' } })).json();
    const secret = lj.docs.find((d) => d.doc_id === 'secret');
    assert.deepEqual(secret.acl, ['group:vip'], '列表应透出文档 acl');

    // aclVisible 语义
    assert.equal(aclVisible(undefined, undefined), true, '无 acl 全员可见');
    assert.equal(aclVisible(['group:vip'], undefined), false, '有 acl 无 principals 不可见');
    assert.equal(aclVisible(['group:vip'], ['group:vip']), true);
  } finally {
    await srv.close();
    delete process.env.RAG_ASYNC_INGEST;
    delete process.env.RAG_CACHE;
  }
});

test('长期9: SqliteVectorStore — acl 列迁移 + 持久化 + listDocs + revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-acl-'));
  const file = join(dir, 'idx.db');
  try {
    const store = new SqliteVectorStore(8, file);
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    store.upsert({
      chunk_id: 'a#0', doc_id: 'a', tenant_id: 't1', index: 0, content: '公开内容',
      vector: vec, created_at: 1,
    });
    store.upsert({
      chunk_id: 'b#0', doc_id: 'b', tenant_id: 't1', index: 0, content: '受限内容',
      acl: ['group:vip'], vector: vec, created_at: 2,
    });
    const rev0 = store.revision();
    assert.ok(rev0 > 0, '写后 revision 应 >0');

    // listDocs
    const docs = store.listDocs('t1');
    assert.equal(docs.length, 2);
    const b = docs.find((d) => d.doc_id === 'b');
    assert.deepEqual(b.acl, ['group:vip']);

    // search ACL 过滤
    assert.equal(store.search('t1', vec, 10).length, 1, '无 principals 只见公开 chunk');
    assert.equal(store.search('t1', vec, 10, ['group:vip']).length, 2, '有交集 principals 全可见');

    // 重新打开（模拟重启）：acl 持久化 + 存量库缺列自动迁移
    const store2 = new SqliteVectorStore(8, file);
    const chunks = store2.getChunks('t1');
    assert.deepEqual(chunks.find((c) => c.doc_id === 'b').acl, ['group:vip'], '重启后 acl 应保留');
    assert.equal(store2.listDocs('t1').length, 2);

    // 删除推进 revision
    const before = store2.revision();
    const n = store2.deleteByDoc('a', 't1');
    assert.equal(n, 1);
    assert.ok(store2.revision() > before, 'deleteByDoc 应推进 revision');
    store2.close();
  } finally {
    try { store.close(); } catch { /* 已关闭 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 锁延迟释放，清理失败不阻断 */ }
  }
});
