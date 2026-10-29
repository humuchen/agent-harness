// embedding 失败回退（FallbackEmbedding）测试。
//   1) 主可用：直接走主，不触发回退
//   2) 主抛 EmbeddingUnavailableError：回退备
//   3) 主抛非 EmbeddingUnavailableError：不回退（向上抛）
//   4) 主备 dim 不一致：构造 fail-fast
//   5) createEmbedder：配置 RAG_EMBEDDING_FALLBACK_ENDPOINT_URL 时构造回退链
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const {
  FallbackEmbedding,
  HashEmbedding,
  EmbeddingUnavailableError,
  createEmbedder,
} = require('../dist/embed');

// 构造一个可控 provider：可指定 model / 是否抛 EmbeddingUnavailableError / 自定义向量。
function makeProvider({ dim = 8, model = 'm', fail = false, vec = null } = {}) {
  return {
    dim,
    model,
    embed: (text) => {
      if (fail) throw new EmbeddingUnavailableError('主不可用');
      return vec ?? new Array(dim).fill(1);
    },
    async embedAsync(text) {
      return this.embed(text);
    },
    async embedBatchAsync(texts) {
      return texts.map((t) => this.embed(t));
    },
  };
}

describe('FallbackEmbedding', () => {
  test('主可用：走主不回退', async () => {
    const primary = makeProvider({ model: 'main', vec: new Array(8).fill(2) });
    const fallback = makeProvider({ model: 'backup', vec: new Array(8).fill(9) });
    const fb = new FallbackEmbedding(primary, fallback);
    const v = await fb.embedAsync('x');
    assert.deepEqual(v, new Array(8).fill(2), '主可用应返回主向量');
    assert.equal(fb.model, 'main', 'model 取主');
  });

  test('主抛 EmbeddingUnavailableError：回退备', async () => {
    const primary = makeProvider({ model: 'main', fail: true });
    const fallback = makeProvider({ model: 'backup', vec: new Array(8).fill(7) });
    const fb = new FallbackEmbedding(primary, fallback);
    const v = await fb.embedAsync('x');
    assert.deepEqual(v, new Array(8).fill(7), '主不可用应回退备向量');
  });

  test('主抛非 EmbeddingUnavailableError：不回退', async () => {
    const primary = {
      dim: 8,
      model: 'main',
      embedAsync: async () => {
        throw new Error('编程错误/网络协议错误');
      },
    };
    const fallback = makeProvider({ model: 'backup', vec: new Array(8).fill(7) });
    const fb = new FallbackEmbedding(primary, fallback);
    await assert.rejects(() => fb.embedAsync('x'), /编程错误/, '非规范错误应向上抛不回退');
  });

  test('主备 dim 不一致：构造 fail-fast', () => {
    const primary = makeProvider({ dim: 8 });
    const fallback = makeProvider({ dim: 16 });
    assert.throws(() => new FallbackEmbedding(primary, fallback), /维度不一致/);
  });

  test('批量路径：主批量失败回退备批量', async () => {
    const primary = makeProvider({ model: 'main', fail: true });
    const fallback = makeProvider({ model: 'backup', vec: new Array(8).fill(5) });
    const fb = new FallbackEmbedding(primary, fallback);
    const vecs = await fb.embedBatchAsync(['a', 'b', 'c']);
    assert.equal(vecs.length, 3);
    assert.ok(vecs.every((v) => v[0] === 5), '批量回退备');
  });
});

describe('createEmbedder 回退链', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['RAG_EMBEDDING_ENDPOINT_URL', 'RAG_EMBEDDING_FALLBACK_ENDPOINT_URL', 'RAG_EMBEDDING_API_KEY']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('配置备端点时构造 FallbackEmbedding', () => {
    process.env.RAG_EMBEDDING_ENDPOINT_URL = 'http://primary.example/embeddings';
    process.env.RAG_EMBEDDING_FALLBACK_ENDPOINT_URL = 'http://backup.example/embeddings';
    const e = createEmbedder();
    assert.ok(e instanceof FallbackEmbedding, '应构造回退链');
  });

  test('仅主端点：不构造回退链', () => {
    process.env.RAG_EMBEDDING_ENDPOINT_URL = 'http://primary.example/embeddings';
    delete process.env.RAG_EMBEDDING_FALLBACK_ENDPOINT_URL;
    const e = createEmbedder();
    assert.ok(!(e instanceof FallbackEmbedding), '无备端点应直接用主');
  });
});
