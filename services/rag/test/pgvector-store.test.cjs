// P6-B：PgVectorStore 契约测试（mock pg Pool，零真实 Postgres 依赖）。
// - 建表 + HNSW 索引幂等（information_schema / pg_indexes 查询）
// - upsert（INSERT ... ON CONFLICT）请求形状与 revision 递增
// - search（ORDER BY vector <=> $2::vector）租户过滤 + score 映射 + acl 过滤 + topK 截断
// - deleteByDoc / count / getChunks / listDocs 结果映射
// - URL 未配置 fail-fast、pg 驱动缺失可操作报错、工厂按 env 构造
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const { MemoryVectorStore, createVectorStore } = require('../dist/store.js');
const { PgVectorStore } = require('../dist/pgvector.js');

/** mock pg：Pool 构造返回带 query 的池，记录全部 SQL 调用。 */
function mockPg(handler) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return handler(sql, params) ?? { rows: [], rowCount: 0 };
  };
  const pg = {
    Pool: function Pool(cfg) {
      this.cfg = cfg;
      this.query = query;
      this.end = async () => {};
    },
  };
  return { pg, calls };
}

/** 注入 pg mock（Module._load 拦截 'pg' require），返回 restore。 */
function injectPg(pg) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'pg') return pg;
    return origLoad.apply(this, arguments);
  };
  return () => { Module._load = origLoad; };
}

/** ensureSchema 默认 handler：information_schema 返回 acl 列（避免 ALTER），其余空。 */
function defaultSchemaHandler(sql) {
  if (sql.includes('information_schema')) return { rows: [{ column_name: 'acl' }] };
  return undefined;
}

test('pgvector: URL 未配置 fail-fast；pg 驱动缺失可操作报错', () => {
  assert.throws(() => new PgVectorStore({ dim: 3 }), /RAG_PG_URL 未配置/);
  // 不注入 pg mock：loadPg 的 require('pg') 失败 → 可操作错误（不静默降级）。
  assert.throws(() => new PgVectorStore({ dim: 3, url: 'postgres://x' }), /pg 驱动/);
});

test('pgvector: upsert — 建表 + HNSW 索引 + INSERT ON CONFLICT + revision 递增', async () => {
  const { pg, calls } = mockPg((sql) => defaultSchemaHandler(sql));
  const restore = injectPg(pg);
  try {
    const store = new PgVectorStore({ dim: 3, url: 'postgres://u:p@h:5432/db' });
    const chunk = {
      chunk_id: 'd1#0', doc_id: 'd1', tenant_id: 't1', index: 0,
      content: 'hello', title: 'T', tags: ['a'], metadata: { k: 1 },
      vector: [1, 0, 0], created_at: 123,
    };
    await store.upsert(chunk);
    // ensureSchema：CREATE TABLE + information_schema + pg_indexes + vector 采样。
    assert.ok(calls.some((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS')), '建表');
    assert.ok(calls.some((c) => c.sql.includes('information_schema')), '列检查');
    assert.ok(calls.some((c) => c.sql.includes('pg_indexes')), '索引检查');
    assert.ok(calls.some((c) => c.sql.includes('CREATE INDEX')), 'HNSW 索引');
    // upsert：INSERT ... ON CONFLICT(chunk_id) DO UPDATE。
    const up = calls.find((c) => c.sql.includes('ON CONFLICT'));
    assert.ok(up, 'upsert 走 ON CONFLICT');
    assert.strictEqual(up.params[0], 'd1#0');
    assert.strictEqual(up.params[1], 'd1');
    assert.strictEqual(up.params[2], 't1');
    assert.strictEqual(up.params[3], 0);
    assert.strictEqual(up.params[4], 'hello');
    assert.strictEqual(up.params[5], 'T');
    assert.strictEqual(up.params[6], '["a"]');
    assert.strictEqual(up.params[7], '{"k":1}');
    assert.strictEqual(up.params[8], null, 'acl 空数组 → null');
    assert.strictEqual(up.params[9], '[1,0,0]', '向量 text 格式');
    assert.strictEqual(up.params[10], 123);
    const revAfter1 = store.revision();
    await store.upsert({ chunk_id: 'd1#1', doc_id: 'd1', tenant_id: 't1', index: 1, content: 'x', vector: [0, 1, 0], created_at: 124 });
    assert.strictEqual(store.revision(), revAfter1 + 1, 'revision 递增');
    // 幂等：同 chunk_id 再 upsert 不新增行（ON CONFLICT 语义）。
    await store.upsert({ ...chunk, content: 'hello v2', vector: [0, 1, 0] });
    const inserts = calls.filter((c) => c.sql.includes('ON CONFLICT'));
    assert.strictEqual(inserts.length, 3, '同 chunk_id 走 UPSERT（不新增）');
  } finally {
    restore();
  }
});

test('pgvector: search — 租户过滤 + 余弦 score + acl 过滤 + topK 截断', async () => {
  const { pg, calls } = mockPg((sql) => {
    if (sql.includes('ORDER BY vector <=>')) {
      return {
        rows: [
          { chunk_id: 'c1', doc_id: 'd1', title: 'A', content: 'alpha', tags: '["x"]', metadata: '{}', acl: null, score: 0.92 },
          { chunk_id: 'c2', doc_id: 'd1', title: null, content: 'beta', tags: null, metadata: null, acl: '["user1"]', score: 0.8 },
          { chunk_id: 'c3', doc_id: 'd2', title: null, content: 'gamma', tags: null, metadata: null, acl: null, score: 0.7 },
        ],
      };
    }
    return defaultSchemaHandler(sql);
  });
  const restore = injectPg(pg);
  try {
    const store = new PgVectorStore({ dim: 3, url: 'postgres://u:p@h:5432/db' });
    // 无 aclPrincipals：全部可见（含 acl 的 c2 也可见——acl 非空但无 principals 约束时可见？查 aclVisible 语义）。
    // aclVisible：acl 非空且 principals 未提供 → 不可见。验证过滤行为。
    const hits = await store.search('t1', [1, 0, 0], 5);
    assert.strictEqual(hits.length, 2, 'acl chunk 无 principals 时被过滤');
    assert.strictEqual(hits[0].chunk_id, 'c1');
    assert.strictEqual(hits[0].score, 0.92);
    assert.deepStrictEqual(hits[0].tags, ['x']);
    // SQL 形状：tenant_id = $1 + ORDER BY vector <=> $2::vector + LIMIT $3。
    const searchCall = calls.find((c) => c.sql.includes('ORDER BY vector <=>'));
    assert.ok(searchCall.sql.includes('tenant_id = $1'), '租户过滤在 SQL 层');
    assert.strictEqual(searchCall.params[0], 't1');
    assert.strictEqual(searchCall.params[1], '[1,0,0]');
    assert.strictEqual(searchCall.params[2], 5);
    // 带 principals：acl chunk 可见。
    const hits2 = await store.search('t1', [1, 0, 0], 5, ['user1']);
    assert.strictEqual(hits2.length, 3, 'principals 命中 acl → 可见');
    // topK 截断。
    const hits3 = await store.search('t1', [1, 0, 0], 1);
    assert.strictEqual(hits3.length, 1);
  } finally {
    restore();
  }
});

test('pgvector: deleteByDoc / count / getChunks / listDocs 结果映射', async () => {
  const { pg, calls } = mockPg((sql, params) => {
    if (sql.startsWith('DELETE')) return { rows: [], rowCount: 2 };
    if (sql.includes('COUNT(*) AS n')) return { rows: [{ n: '3' }] };
    if (sql.includes('GROUP BY doc_id')) {
      return {
        rows: [{ doc_id: 'd1', chunks: '2', title: 'T1', updated_at: '2', acl: '["u1"]' }],
      };
    }
    if (sql.includes('ORDER BY doc_id, idx')) {
      return {
        rows: [
          { chunk_id: 'c1', doc_id: 'd1', tenant_id: 't1', idx: 0, content: 'a', title: 'T1', tags: null, metadata: null, acl: null, vector: '[1,0,0]', created_at: 1 },
          { chunk_id: 'c2', doc_id: 'd1', tenant_id: 't1', idx: 1, content: 'b', title: null, tags: '["x"]', metadata: '{"k":1}', acl: '["u1"]', vector: '[0,1,0]', created_at: 2 },
        ],
      };
    }
    return defaultSchemaHandler(sql);
  });
  const restore = injectPg(pg);
  try {
    const store = new PgVectorStore({ dim: 3, url: 'postgres://u:p@h:5432/db' });
    const del = await store.deleteByDoc('d1', 't1');
    assert.strictEqual(del, 2);
    const delCall = calls.find((c) => c.sql.startsWith('DELETE'));
    assert.strictEqual(delCall.params[0], 'd1');
    assert.strictEqual(delCall.params[1], 't1');
    assert.strictEqual(await store.count('t1'), 3);
    assert.strictEqual(await store.count(), 3);
    const chunks = await store.getChunks('t1');
    assert.strictEqual(chunks.length, 2);
    assert.deepStrictEqual(chunks[0].vector, [1, 0, 0]);
    assert.deepStrictEqual(chunks[1].tags, ['x']);
    assert.deepStrictEqual(chunks[1].acl, ['u1']);
    const docs = await store.listDocs('t1');
    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0].doc_id, 'd1');
    assert.strictEqual(docs[0].chunks, 2);
    assert.deepStrictEqual(docs[0].acl, ['u1']);
    // hybridCapable + revision。
    assert.strictEqual(store.hybridCapable, true);
    assert.strictEqual(typeof store.revision(), 'number');
  } finally {
    restore();
  }
});

test('pgvector: 工厂 RAG_STORE_BACKEND=pgvector 按 env 构造；缺省 memory', () => {
  const { pg } = mockPg((sql) => defaultSchemaHandler(sql));
  const restore = injectPg(pg);
  try {
    const prev = process.env.RAG_STORE_BACKEND;
    const prevUrl = process.env.RAG_PG_URL;
    delete process.env.RAG_STORE_BACKEND;
    assert.strictEqual(createVectorStore(4) instanceof MemoryVectorStore, true, '缺省 memory');
    process.env.RAG_STORE_BACKEND = 'pgvector';
    process.env.RAG_PG_URL = 'postgres://u:p@h:5432/db';
    const s = createVectorStore(4);
    assert.strictEqual(s instanceof PgVectorStore, true);
    assert.strictEqual(s.dim, 4);
    delete process.env.RAG_STORE_BACKEND;
    delete process.env.RAG_PG_URL;
    if (prev !== undefined) process.env.RAG_STORE_BACKEND = prev;
    if (prevUrl !== undefined) process.env.RAG_PG_URL = prevUrl;
  } finally {
    restore();
  }
});
