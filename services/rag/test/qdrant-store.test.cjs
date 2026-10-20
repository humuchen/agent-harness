// P6-B：QdrantVectorStore 契约测试（mock fetch，零真实服务依赖）。
// - 确定性点 id（chunk_id → UUID 形态，幂等 upsert 的根基）
// - 集合按需自建（首次操作 GET → 404 → PUT create）
// - upsert / search / deleteByDoc / count / getChunks(scroll 分页) 请求形状与结果映射
// - 维度校验、URL 未配置 fail-fast、工厂缺省 memory
const test = require('node:test');
const assert = require('node:assert');

const { MemoryVectorStore, createVectorStore } = require('../dist/store.js');
const { QdrantVectorStore } = require('../dist/qdrant.js');

/** mock 全局 fetch：按 (method, path) 注册处理器，记录全部请求。 */
function mockFetch(routes) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname + u.search, body, headers: init.headers ?? {} });
    const key = `${method} ${u.pathname}`;
    const handler = routes[key] ?? routes[`${method} ${u.pathname.split('?')[0]}`];
    if (!handler) {
      return { ok: false, status: 404, text: async () => 'not mocked' };
    }
    const out = handler({ body, headers: init.headers ?? {}, calls });
    return {
      ok: true,
      status: 200,
      json: async () => out,
      text: async () => JSON.stringify(out),
    };
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('qdrant: upsert — 集合自建 + 确定性 UUID 点 id + payload 剥离 vector', async () => {
  const seen = [];
  const { restore, calls } = mockFetch({
    'GET /collections/rag_c': () => ({ result: null }), // 不存在 → 触发建表
    'PUT /collections/rag_c': () => ({ result: 'ok' }),
    'PUT /collections/rag_c/points': ({ body }) => {
      seen.push(body);
      return { result: 'ok' };
    },
  });
  try {
    const store = new QdrantVectorStore({ dim: 3, url: 'http://q', collection: 'rag_c', apiKey: 'k' });
    await store.upsert({
      chunk_id: 'd1#0', doc_id: 'd1', tenant_id: 't1', index: 0,
      content: 'hello', title: 'T', tags: ['a'], metadata: { k: 1 },
      vector: [1, 0, 0], created_at: 123,
    });
    // 建表：GET 后 PUT（vectors.size = dim, Cosine）。
    assert.ok(calls.some((c) => c.method === 'PUT' && c.path === '/collections/rag_c'));
    const up = seen[0];
    assert.strictEqual(up.points.length, 1);
    assert.match(up.points[0].id, UUID_RE);
    assert.deepStrictEqual(up.points[0].vector, [1, 0, 0]);
    assert.strictEqual(up.points[0].payload.tenant_id, 't1');
    assert.strictEqual(up.points[0].payload.content, 'hello');
    assert.strictEqual(up.points[0].payload.vector, undefined, 'vector 不进 payload');
    assert.strictEqual(calls.some((c) => c.headers['api-key'] === 'k'), true, 'api-key 头');
    // 同 chunk_id 幂等：点 id 不变。
    await store.upsert({
      chunk_id: 'd1#0', doc_id: 'd1', tenant_id: 't1', index: 0,
      content: 'hello v2', vector: [0, 1, 0], created_at: 124,
    });
    assert.strictEqual(seen[1].points[0].id, seen[0].points[0].id);
    // 维度不匹配拒绝。
    await assert.rejects(
      () => store.upsert({ chunk_id: 'x', doc_id: 'd', tenant_id: 't', index: 0, content: '', vector: [1], created_at: 0 }),
      /维度不匹配/
    );
  } finally {
    restore();
  }
});

test('qdrant: search — 租户过滤 + 结果映射；deleteByDoc / count 请求形状', async () => {
  const { restore, calls } = mockFetch({
    'GET /collections/rag_c': () => ({ result: { config: {} } }), // 已存在 → 不建表
    'POST /collections/rag_c/points/search': () => ({
      result: [
        { id: 'u1', score: 0.92, payload: { chunk_id: 'd1#0', doc_id: 'd1', tenant_id: 't1', content: 'alpha', title: 'A', metadata: { tags: ['x'] } } },
        { id: 'u2', score: 0.5, payload: { chunk_id: 'd1#1', doc_id: 'd1', tenant_id: 't1', content: 'beta' } },
      ],
    }),
    'POST /collections/rag_c/points/delete': () => ({ result: {} }),
    'POST /collections/rag_c/points/count': () => ({ result: { count: 7 } }),
  });
  try {
    const store = new QdrantVectorStore({ dim: 3, url: 'http://q', collection: 'rag_c' });
    const results = await store.search('t1', [0.1, 0.2, 0.3], 5);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].chunk_id, 'd1#0');
    assert.strictEqual(results[0].score, 0.92);
    assert.strictEqual(results[0].title, 'A');
    const searchCall = calls.find((c) => c.path.includes('/points/search'));
    assert.deepStrictEqual(searchCall.body.filter.must, [{ key: 'tenant_id', match: { value: 't1' } }]);
    assert.strictEqual(searchCall.body.limit, 5);
    const deleted = await store.deleteByDoc('d1', 't1');
    const delCall = calls.find((c) => c.path.includes('/points/delete'));
    assert.deepStrictEqual(delCall.body.filter.must, [
      { key: 'tenant_id', match: { value: 't1' } },
      { key: 'doc_id', match: { value: 'd1' } },
    ]);
    assert.strictEqual(typeof deleted, 'number');
    assert.strictEqual(await store.count('t1'), 7);
    assert.strictEqual(await store.count(), 7);
  } finally {
    restore();
  }
});

test('qdrant: getChunks — scroll 分页聚合（with_vector），hybridCapable=true', async () => {
  let page = 0;
  const { restore } = mockFetch({
    'GET /collections/rag_c': () => ({ result: { config: {} } }),
    'POST /collections/rag_c/points/scroll': () => {
      page += 1;
      if (page === 1) {
        return {
          result: {
            points: [{ id: 'u1', payload: { chunk_id: 'c1', doc_id: 'd', tenant_id: 't', content: 'a', index: 0, created_at: 1 }, vector: [1, 0, 0] }],
            next_page_offset: 'cursor-1',
          },
        };
      }
      return {
        result: {
          points: [{ id: 'u2', payload: { chunk_id: 'c2', doc_id: 'd', tenant_id: 't', content: 'b', index: 1, created_at: 2 }, vector: [0, 1, 0] }],
          next_page_offset: null,
        },
      };
    },
  });
  try {
    const store = new QdrantVectorStore({ dim: 3, url: 'http://q', collection: 'rag_c' });
    assert.strictEqual(store.hybridCapable, true);
    const chunks = await store.getChunks('t');
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].content, 'a');
    assert.deepStrictEqual(chunks[0].vector, [1, 0, 0]);
    assert.strictEqual(chunks[1].chunk_id, 'c2');
  } finally {
    restore();
  }
});

test('qdrant: URL 未配置 fail-fast；工厂缺省 memory、qdrant 后端按 env 构造', () => {
  assert.throws(() => new QdrantVectorStore({ dim: 3 }), /QDRANT_URL 未配置/);
  const prev = process.env.RAG_STORE_BACKEND;
  delete process.env.RAG_STORE_BACKEND;
  assert.strictEqual(createVectorStore(4) instanceof MemoryVectorStore, true, '缺省 memory');
  process.env.RAG_STORE_BACKEND = 'qdrant';
  process.env.QDRANT_URL = 'http://q2';
  const s = createVectorStore(4);
  assert.strictEqual(s instanceof QdrantVectorStore, true);
  assert.strictEqual(s.dim, 4);
  delete process.env.RAG_STORE_BACKEND;
  delete process.env.QDRANT_URL;
  if (prev !== undefined) process.env.RAG_STORE_BACKEND = prev;
});

test('qdrant: 检索经 VectorStore 契约走通（Memory 后端 retrieve 行为零回归）', async () => {
  // Memory 实现同步方法即可满足 MaybePromise 契约 —— retrieve 统一 await。
  const store = new MemoryVectorStore(3);
  await store.upsert({
    chunk_id: 'd#0', doc_id: 'd', tenant_id: 't', index: 0,
    content: '会员 上线', vector: [1, 0, 0], created_at: 1,
  });
  assert.strictEqual(await store.count('t'), 1);
  const hits = await store.search('t', [1, 0, 0], 5);
  assert.strictEqual(hits[0].chunk_id, 'd#0');
  assert.strictEqual(store.hybridCapable, true);
  assert.strictEqual((await store.getChunks('t')).length, 1);
});
