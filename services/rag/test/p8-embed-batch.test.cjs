// 增强：嵌入批处理（embedBatchAsync）测试。
//   1) OpenAIEmbedding.embedBatchAsync：单次批量请求 + index 对齐 + 缓存复用 + strict 失败
//   2) RemoteEmbedding.embedBatchAsync：{texts:[]} 批量契约 + 维度校验 + 分批
//   3) ingest 批量路径：provider 带 embedBatchAsync 时按批调用（请求次数 = ceil(n/批)）
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { OpenAIEmbedding, RemoteEmbedding } = require('../dist/embed');
const { ingestDocument } = require('../dist/ingest');
const { MemoryVectorStore } = require('../dist/store');

function makeOpenAIServer(reqLog, { dim = 8, fail = false } = {}) {
  const { createServer } = require('node:http');
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        reqLog.push({ input: parsed.input, count: Array.isArray(parsed.input) ? parsed.input.length : 1 });
        if (fail) {
          res.statusCode = 500;
          return res.end('{"error":"boom"}');
        }
        const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          data: inputs.map((text, i) => ({ index: i, embedding: new Array(dim).fill((i + 1) / dim) })),
        }));
      });
    });
    srv.listen(0, () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/v1` }));
  });
}

describe('OpenAIEmbedding.embedBatchAsync', () => {
  test('批量请求：一次携带整批 + 顺序对齐 + 命中缓存不重发', async () => {
    const reqLog = [];
    const { srv, url } = await makeOpenAIServer(reqLog);
    const provider = new OpenAIEmbedding({ dim: 8, baseUrl: url, apiKey: 'k', model: 'm' });
    try {
      const texts = ['退款政策', '营业时间', '门店地址', '会员积分'];
      const vecs = await provider.embedBatchAsync(texts);
      assert.equal(vecs.length, 4);
      assert.ok(vecs.every((v) => v.length === 8), '向量维度正确');
      assert.equal(reqLog.length, 1, '应单次批量请求');
      assert.equal(reqLog[0].count, 4);
      // 顺序对齐：text[0] 的向量 = fill(1/8)
      assert.equal(vecs[0][0], 1 / 8);
      assert.equal(vecs[1][0], 2 / 8);
      // 缓存复用：再次调用零网络请求
      const again = await provider.embedBatchAsync(texts);
      assert.equal(reqLog.length, 1, '缓存命中后不应再发请求');
      assert.deepEqual(again, vecs);
    } finally {
      srv.close();
    }
  });

  test('strict 失败：HTTP 500 → EmbeddingUnavailableError（不入库毒化）', async () => {
    const reqLog = [];
    const { srv, url } = await makeOpenAIServer(reqLog, { fail: true });
    process.env.RAG_EMBED_STRICT = 'true';
    const provider = new OpenAIEmbedding({ dim: 8, baseUrl: url, apiKey: 'k' });
    try {
      await assert.rejects(() => provider.embedBatchAsync(['a', 'b']), /批量嵌入失败|EmbeddingUnavailable|HTTP 500/);
    } finally {
      srv.close();
      delete process.env.RAG_EMBED_STRICT;
    }
  });
});

describe('RemoteEmbedding.embedBatchAsync', () => {
  test('texts 契约批量 + 维度校验', async () => {
    const { createServer } = require('node:http');
    const reqLog = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        reqLog.push({ count: parsed.texts.length });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ embeddings: parsed.texts.map((_, i) => new Array(4).fill(i + 0.5)) }));
      });
    });
    await new Promise((r) => srv.listen(0, r));
    const provider = new RemoteEmbedding({ dim: 4, baseUrl: `http://127.0.0.1:${srv.address().port}/embed` });
    try {
      const vecs = await provider.embedBatchAsync(['甲', '乙', '丙']);
      assert.equal(vecs.length, 3);
      assert.equal(vecs[0][0], 0.5);
      assert.equal(vecs[2][0], 2.5);
      assert.equal(reqLog.length, 1);
      // 维度不匹配 → strict 拒绝
      process.env.RAG_EMBED_STRICT = 'true';
      const bad = new RemoteEmbedding({ dim: 9, baseUrl: `http://127.0.0.1:${srv.address().port}/embed` });
      await assert.rejects(() => bad.embedBatchAsync(['x']), /维度不匹配/);
    } finally {
      delete process.env.RAG_EMBED_STRICT;
      srv.close();
    }
  });
});

describe('ingest 批量路径', () => {
  test('provider 带 embedBatchAsync → 分批调用（请求次数 = ceil(n/批)）', async () => {
    const calls = [];
    const provider = {
      dim: 4,
      embed: () => new Array(4).fill(0),
      embedAsync: async () => new Array(4).fill(0),
      embedBatchAsync: async (texts) => {
        calls.push(texts.length);
        return texts.map(() => new Array(4).fill(0.25));
      },
    };
    const store = new MemoryVectorStore(4);
    process.env.RAG_EMBED_BATCH_SIZE = '3';
    // 每段 ~200 字符 → 8 段 ≈ 1600 字符 → 默认滑窗（480/80）切出多块
    const text = Array.from({ length: 8 }, (_, i) => `段落${i}：${'内容说明'.repeat(100)}`).join('\n\n');
    const r = await ingestDocument(store, provider, { doc_id: 'd1', tenant_id: 't1', text });
    delete process.env.RAG_EMBED_BATCH_SIZE;
    assert.ok(r.chunks >= 3, `长文本应切出多块，实际 ${r.chunks}`);
    assert.equal(calls.reduce((a, b) => a + b, 0), r.chunks, '分批总量应等于 chunk 数');
    assert.ok(calls.every((c) => c <= 3), '每批不超过 RAG_EMBED_BATCH_SIZE');
    assert.equal(calls.length, Math.ceil(r.chunks / 3), '请求次数 = ceil(n/批)');
    assert.equal(store.count('t1'), r.chunks, '全部 chunk 已入库');
  });

  test('无 embedBatchAsync 的 provider 回退逐条（零回归）', async () => {
    let single = 0;
    const provider = {
      dim: 4,
      embed: () => new Array(4).fill(0),
      embedAsync: async () => {
        single++;
        return new Array(4).fill(0.5);
      },
    };
    const store = new MemoryVectorStore(4);
    await ingestDocument(store, provider, { doc_id: 'd2', tenant_id: 't1', text: '短文本' });
    assert.equal(single, 1, '回退逐条路径');
  });
});
