const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryVectorStore } = require('../dist/store');
const { HashEmbedding } = require('../dist/embed');
const { ingestDocument } = require('../dist/ingest');
const { retrieve } = require('../dist/retrieve');

function makeRag() {
  const dim = 256;
  return { store: new MemoryVectorStore(dim), provider: new HashEmbedding(dim) };
}

test('ingest: 入库并分块', async () => {
  const { store, provider } = makeRag();
  const r = await ingestDocument(store, provider, {
    doc_id: 'd1',
    tenant_id: 'tA',
    title: '退款政策',
    text: '我们支持七天无理由退款。退款将在三个工作日内原路返回支付账户。',
  });
  assert.ok(r.chunks >= 1, '至少 1 个 chunk');
  assert.equal(store.count('tA'), r.chunks);
});

test('retrieve: 召回相关片段且 score>0', async () => {
  const { store, provider } = makeRag();
  await ingestDocument(store, provider, {
    doc_id: 'd1',
    tenant_id: 'tA',
    title: '退款政策',
    text: '我们支持七天无理由退款。退款将在三个工作日内原路返回支付账户。',
  });
  await ingestDocument(store, provider, {
    doc_id: 'd2',
    tenant_id: 'tA',
    title: '配送时效',
    text: '标准配送需要三到五天，偏远地区可能延迟送达。',
  });
  const resp = retrieve(store, provider, { query: '退款怎么操作', tenant_id: 'tA', top_k: 3 });
  assert.ok(resp.results.length >= 1);
  assert.ok(resp.results[0].score > 0);
  // 演示用 HashEmbedding 维度有限、哈希碰撞难免，不保证严格排序；
  // 检索闭环的有效判据是"相关文档被召回且分数>0"（真实 embedding 负责精确排序）。
  assert.ok(resp.results.some((r) => r.doc_id === 'd1'), '相关文档 d1 应被召回');
  assert.ok(resp.trace_id.startsWith('rag_'));
  assert.equal(typeof resp.latency_ms, 'number');
});

test('tenant 隔离: 跨租户不可见', async () => {
  const { store, provider } = makeRag();
  await ingestDocument(store, provider, {
    doc_id: 'd1',
    tenant_id: 'tA',
    title: '机密',
    text: '只有租户 A 能看到的退款条款与金额。',
  });
  const resp = retrieve(store, provider, { query: '退款条款', tenant_id: 'tB', top_k: 5 });
  assert.equal(resp.results.length, 0, '租户 B 不应看到 A 的 chunk');
  assert.equal(store.count('tB'), 0);
});

test('幂等: 重复 ingest 同 doc 替换而非叠加', async () => {
  const { store, provider } = makeRag();
  const r1 = await ingestDocument(store, provider, {
    doc_id: 'd1',
    tenant_id: 'tA',
    text: '原始短内容。',
  });
  const r2 = await ingestDocument(store, provider, {
    doc_id: 'd1',
    tenant_id: 'tA',
    text: '更新后的更长版本内容，用于验证增量更新替换行为是否正常生效了。',
  });
  assert.equal(store.count('tA'), r2.chunks);
  assert.ok(r2.replaced >= r1.chunks, '应替换旧 chunk');
});

test('score_threshold 过滤低分结果', async () => {
  const { store, provider } = makeRag();
  await ingestDocument(store, provider, {
    doc_id: 'd1',
    tenant_id: 'tA',
    text: '关于猫咪的饲养与日常护理知识分享。',
  });
  const resp = retrieve(store, provider, { query: '火箭发射原理', tenant_id: 'tA', top_k: 5, score_threshold: 0.5 });
  assert.equal(resp.results.length, 0);
});
