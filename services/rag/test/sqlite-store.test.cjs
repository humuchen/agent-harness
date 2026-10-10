// P6-C：SqliteVectorStore 契约测试（node:sqlite 零依赖，临时文件，进程内真实落盘）。
// - upsert 幂等（同 chunk_id 覆盖）/ 维度校验
// - deleteByDoc 按 doc+tenant 删除
// - search 租户隔离 + 余弦排序 + metadata/tags 往返
// - count / tenantCounts / getChunks（BM25 语料导出）
// - 持久性：关实例 → 重开同文件 → 数据完整
// - 维度不一致 fail-fast；工厂分支（memory 缺省 / sqlite）
// - persist/load 为 no-op（写即持久语义）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MemoryVectorStore, SqliteVectorStore, createVectorStore } = require('../dist/store.js');

let nodeSqliteOk = true;
try {
  require('node:sqlite');
} catch {
  nodeSqliteOk = false;
}

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rag-sqlite-')), 'index.db');
}

function chunk(overrides = {}) {
  return {
    chunk_id: 'd1#0',
    doc_id: 'd1',
    tenant_id: 't1',
    index: 0,
    content: 'hello world',
    title: 'T',
    tags: ['a', 'b'],
    metadata: { k: 1 },
    vector: [1, 0, 0],
    created_at: 123,
    ...overrides,
  };
}

test('sqlite: upsert / 维度校验 / 幂等覆盖', { skip: !nodeSqliteOk }, () => {
  const file = tmpDb();
  const store = new SqliteVectorStore(3, file);
  store.upsert(chunk());
  assert.strictEqual(store.count(), 1);
  // 同 chunk_id 覆盖
  store.upsert(chunk({ content: 'v2', vector: [0, 1, 0], created_at: 124 }));
  assert.strictEqual(store.count(), 1);
  // 维度不匹配：拒绝
  assert.throws(() => store.upsert(chunk({ chunk_id: 'd1#9', vector: [1, 0] })), /维度不匹配/);
  store.close();
});

test('sqlite: search 租户隔离 + 余弦排序 + 字段往返', { skip: !nodeSqliteOk }, () => {
  const file = tmpDb();
  const store = new SqliteVectorStore(3, file);
  store.upsert(chunk({ chunk_id: 'd1#0', vector: [1, 0, 0] }));
  store.upsert(chunk({ chunk_id: 'd1#1', doc_id: 'd1', index: 1, vector: [0, 1, 0], content: 'second', title: undefined, tags: undefined, metadata: undefined }));
  store.upsert(chunk({ chunk_id: 'd2#0', doc_id: 'd2', tenant_id: 't2', vector: [1, 0, 0], content: 'other tenant' }));

  const hits = store.search('t1', [1, 0, 0], 2);
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0].chunk_id, 'd1#0');
  assert.strictEqual(hits[0].score > hits[1].score, true);
  assert.strictEqual(hits[0].title, 'T');
  assert.deepStrictEqual(hits[0].tags, ['a', 'b']);
  assert.deepStrictEqual(hits[0].metadata, { k: 1 });

  // 租户隔离：t2 只见自己的 chunk
  assert.strictEqual(store.search('t2', [1, 0, 0], 10).length, 1);
  assert.strictEqual(store.count('t1'), 2);
  assert.strictEqual(store.count('t2'), 1);
  assert.strictEqual(store.count(), 3);
  store.close();
});

test('sqlite: deleteByDoc / tenantCounts / getChunks', { skip: !nodeSqliteOk }, () => {
  const file = tmpDb();
  const store = new SqliteVectorStore(3, file);
  store.upsert(chunk({ chunk_id: 'd1#0' }));
  store.upsert(chunk({ chunk_id: 'd1#1', index: 1 }));
  store.upsert(chunk({ chunk_id: 'd2#0', doc_id: 'd1', tenant_id: 't2', vector: [0, 0, 1] })); // 同 doc 不同租户（chunk_id 全局唯一）
  assert.strictEqual(store.deleteByDoc('d1', 't1'), 2, '只删 t1 的两个 chunk');
  assert.strictEqual(store.count(), 1);
  assert.deepStrictEqual(store.tenantCounts(), { t2: 1 });

  store.upsert(chunk({ chunk_id: 'd3#0', doc_id: 'd3', index: 0 }));
  const chunks = store.getChunks('t1');
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].chunk_id, 'd3#0');
  assert.deepStrictEqual(chunks[0].vector, [1, 0, 0]);
  store.close();
});

test('sqlite: 持久性 —— 重开同文件数据完整', { skip: !nodeSqliteOk }, () => {
  const file = tmpDb();
  const s1 = new SqliteVectorStore(3, file);
  s1.upsert(chunk({ chunk_id: 'p#0' }));
  s1.upsert(chunk({ chunk_id: 'p#1', index: 1, vector: [0, 1, 0] }));
  s1.close();

  const s2 = new SqliteVectorStore(3, file);
  assert.strictEqual(s2.count(), 2);
  const hits = s2.search('t1', [0, 1, 0], 1);
  assert.strictEqual(hits[0].chunk_id, 'p#1');
  s2.close();
});

test('sqlite: 维度不一致 fail-fast（构造期）', { skip: !nodeSqliteOk }, () => {
  const file = tmpDb();
  const s1 = new SqliteVectorStore(3, file);
  s1.upsert(chunk());
  s1.close();
  assert.throws(() => new SqliteVectorStore(4, file), /维度.*不一致|不一致/, '存量维度与新 dim 不一致必须报错');
});

test('sqlite: persist / load 为 no-op（写即持久）', { skip: !nodeSqliteOk }, () => {
  const file = tmpDb();
  const store = new SqliteVectorStore(3, file);
  store.upsert(chunk());
  store.persist('/nonexistent/should-not-write.json');
  store.load('/nonexistent/should-not-read.json');
  assert.strictEqual(store.count(), 1);
  store.close();
});

test('工厂：缺省 memory / sqlite 分支', () => {
  const orig = process.env.RAG_STORE_BACKEND;
  try {
    delete process.env.RAG_STORE_BACKEND;
    assert.ok(createVectorStore(3) instanceof MemoryVectorStore);
    if (nodeSqliteOk) {
      process.env.RAG_STORE_BACKEND = 'sqlite';
      const f = tmpDb();
      const store = createVectorStore(3);
      assert.ok(store instanceof SqliteVectorStore);
      (store).close?.();
      void f;
    }
  } finally {
    if (orig === undefined) delete process.env.RAG_STORE_BACKEND;
    else process.env.RAG_STORE_BACKEND = orig;
  }
});

test('sqlite: node:sqlite 不可用时给出可操作错误（不静默降级）', { skip: nodeSqliteOk }, () => {
  assert.throws(() => new SqliteVectorStore(3, tmpDb()), /node:sqlite|Node 22/);
});
