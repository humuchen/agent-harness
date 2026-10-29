// embedding 模型管理（模型版本守卫）测试。
//   1) ingest 入库：provider.model / provider.dim 戳写入 chunk.metadata（embedding_model / embedding_dim）
//   2) retrieve 守卫：候选 chunk 的 embedding_model 与 provider.model 不一致 → fail-fast 抛错
//   3) retrieve 守卫：模型一致 → 正常返回
//   4) RAG_EMBED_GUARD=off → 关闭守卫（迁移期临时放行）
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { HashEmbedding } = require('../dist/embed');
const { ingestDocument } = require('../dist/ingest');
const { retrieve } = require('../dist/retrieve');
const { MemoryVectorStore } = require('../dist/store');

describe('ingest 模型版本戳', () => {
  test('入库后 chunk.metadata 携带 embedding_model / embedding_dim', async () => {
    const store = new MemoryVectorStore(16);
    const provider = new HashEmbedding(16);
    await ingestDocument(store, provider, {
      doc_id: 'd1',
      tenant_id: 't1',
      text: '退款政策与营业时间说明。',
    });
    const chunks = await store.getChunks('t1');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].metadata.embedding_model, provider.model, 'model 戳正确');
    assert.equal(chunks[0].metadata.embedding_dim, provider.dim, 'dim 戳正确');
  });
});

describe('retrieve 模型版本守卫', () => {
  let store;
  let provider;
  const savedGuard = process.env.RAG_EMBED_GUARD;

  beforeEach(() => {
    store = new MemoryVectorStore(16);
    provider = new HashEmbedding(16);
  });
  afterEach(() => {
    if (savedGuard === undefined) delete process.env.RAG_EMBED_GUARD;
    else process.env.RAG_EMBED_GUARD = savedGuard;
  });

  test('模型一致：正常检索', async () => {
    await ingestDocument(store, provider, { doc_id: 'd1', tenant_id: 't1', text: '退款政策说明。' });
    const res = await retrieve(store, provider, { query: '退款', tenant_id: 't1' });
    assert.ok(res.results.length >= 1, '应返回结果');
  });

  test('模型不一致：fail-fast 抛错', async () => {
    // 用 providerA 入库（model=hash-16），再用 providerB（model=hash-16 但 model 标识不同）检索。
    const providerA = new HashEmbedding(16);
    await ingestDocument(store, providerA, { doc_id: 'd1', tenant_id: 't1', text: '退款政策说明。' });

    // 构造一个 model 标识不同的同维 provider（模拟切换 embedding 模型）。
    const providerB = new HashEmbedding(16);
    Object.defineProperty(providerB, 'model', { value: 'switched-model-v2' });

    await assert.rejects(
      () => retrieve(store, providerB, { query: '退款', tenant_id: 't1' }),
      (err) => {
        assert.match(err.message, /模型版本不匹配/, '错误信息应说明模型不匹配');
        return true;
      },
      '模型不一致应 fail-fast'
    );
  });

  test('RAG_EMBED_GUARD=off：关闭守卫放行', async () => {
    process.env.RAG_EMBED_GUARD = 'off';
    const providerA = new HashEmbedding(16);
    await ingestDocument(store, providerA, { doc_id: 'd1', tenant_id: 't1', text: '退款政策说明。' });
    const providerB = new HashEmbedding(16);
    Object.defineProperty(providerB, 'model', { value: 'switched-model-v2' });
    // 关闭守卫后不再抛错
    const res = await retrieve(store, providerB, { query: '退款', tenant_id: 't1' });
    assert.ok(res.results.length >= 1, '守卫关闭时应正常返回');
  });
});
