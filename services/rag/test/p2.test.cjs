// P2 测试：完整鉴权（JWT/静态令牌）、真 BM25、异步入库队列。
// 对应设计文档 P2：越权 401/403、BM25 区分度、队列统计、跨租户隔离。
const test = require('node:test');
const assert = require('node:assert/strict');
const { signJwt, verifyJwt, resolveTenant } = require('../dist/auth');
const { Bm25Corpus } = require('../dist/bm25');
const { IngestQueue } = require('../dist/queue');
const { MemoryVectorStore } = require('../dist/store');
const { HashEmbedding } = require('../dist/embed');

test('JWT: sign/verify 往返 + 篡改/过期拒绝', () => {
  const tok = signJwt({ tenant: 'acme', sub: 'svc' }, 'secret1', { expiresInSec: 3600 });
  const payload = verifyJwt(tok, 'secret1');
  assert.equal(payload.tenant, 'acme');
  assert.equal(payload.sub, 'svc');
  assert.ok(payload.iat, '应含 iat');
  assert.ok(payload.exp, '应含 exp');
  assert.equal(verifyJwt(tok, 'wrong-secret'), null, '错密钥应拒绝');
  assert.equal(verifyJwt('not-a-jwt', 'secret1'), null, '非 JWT 应拒绝');
  const expired = signJwt({ tenant: 'acme' }, 'secret1', { expiresInSec: -10 });
  assert.equal(verifyJwt(expired, 'secret1'), null, '过期应拒绝');
});

test('鉴权: JWT 成功 / 篡改 403 / 缺失 401 / 静态令牌兼容 / 开放模式', () => {
  const opts = {
    tokens: new Map([['static-a', 'acme']]),
    jwtSecret: 's3cret',
    defaultTenant: 'default',
  };
  const mkReq = (auth) => ({ headers: auth ? { authorization: `Bearer ${auth}` } : {} });

  const good = resolveTenant(mkReq(signJwt({ tenant: 'beta' }, 's3cret')), opts);
  assert.equal(good.tenantId, 'beta', '合法 JWT 应解析出 tenant');

  const tampered = resolveTenant(mkReq(signJwt({ tenant: 'beta' }, 's3cret') + 'x'), opts);
  assert.equal(tampered.error, 403, '篡改令牌应 403');

  const none = resolveTenant(mkReq(null), opts);
  assert.equal(none.error, 401, '缺失令牌应 401');

  const staticOk = resolveTenant(mkReq('static-a'), opts);
  assert.equal(staticOk.tenantId, 'acme', '静态令牌应仍可用');

  const open = resolveTenant(mkReq(null), { defaultTenant: 'trusted' });
  assert.equal(open.tenantId, 'trusted', '开放模式应回退默认租户');
});

test('BM25: 词项命中区分度 + 增量维护', () => {
  const c = new Bm25Corpus();
  c.add('c1', '退款政策 七天无理由 退款 原路返回支付账户');
  c.add('c2', '火箭发射 原理 轨道 推进剂');
  c.add('c3', '退款 流程 申请 步骤说明');
  assert.equal(c.size, 3);

  const q = ['退款'];
  const s1 = c.scoreChunk('c1', q);
  const s3 = c.scoreChunk('c3', q);
  const s2 = c.scoreChunk('c2', q);
  assert.ok(s1 > 0, '含查询词的 chunk 应得分');
  assert.ok(s3 > 0);
  assert.equal(s2, 0, '不含查询词的 chunk 不得分');

  c.remove('c3');
  assert.equal(c.size, 2, 'remove 后语料应收缩');
  assert.equal(c.scoreChunk('c3', q), 0, '已删除 chunk 不得分');
});

test('异步入库队列: enqueue → drain → 统计与 store 落库', async () => {
  const store = new MemoryVectorStore(256);
  const provider = new HashEmbedding(256);
  const q = new IngestQueue(store, provider, { concurrency: 2 });

  const j1 = q.enqueue({ doc_id: 'd1', tenant_id: 'tA', text: '第一条知识库内容用于异步入库验证。' });
  const j2 = q.enqueue({ doc_id: 'd2', tenant_id: 'tA', text: '第二条知识库内容用于异步入库验证。' });
  // pump 可能已同步进入 processing（并发 worker 立即取走），断言「已入队在途」即可
  assert.ok(['queued', 'processing'].includes(j1.status), '入队应立即返回 queued/processing');
  const mid = q.stats();
  assert.ok(mid.queued + mid.processing >= 1, '入队后应有在途任务');

  await q.drain(3000);
  const st = q.stats();
  assert.equal(st.done, 2, '两个任务都应完成');
  assert.equal(st.failed, 0);
  assert.equal(store.count('tA'), 2, 'store 应落库 2 个 chunk');
  assert.ok(q.job(j1.jobId).status === 'done');
  assert.ok(q.job(j1.jobId).chunks >= 1, 'job 应记录 chunk 数');
});
