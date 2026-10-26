// 短期：客服 KB 接入 RAG —— RAG 优先 / 失败回退本地 LIKE / cs_kb_add 镜像到 RAG。
// 独立进程运行（node --test 每文件独立进程），env 在 require 前注入。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// ---- stub RAG 服务（记录请求、返回固定结果）----
const calls = { retrieve: [], ingest: [] };
let ragMode = 'ok'; // ok | empty | down
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === '/v1/retrieve') {
      calls.retrieve.push(parsed);
      if (ragMode === 'down') { res.statusCode = 500; return res.end('{"error":"boom"}'); }
      if (ragMode === 'empty') return res.end(JSON.stringify({ results: [], trace_id: 't' }));
      return res.end(JSON.stringify({
        trace_id: 't',
        results: [{
          chunk_id: 'cs-kb-99#0', doc_id: 'cs-kb-99', title: '跨店退货政策',
          content: '支持 30 天跨门店退货，需保留小票。', score: 0.87,
          metadata: { tags: ['售后'] },
        }],
      }));
    }
    if (req.url === '/v1/ingest') {
      calls.ingest.push(parsed);
      res.statusCode = 202;
      return res.end(JSON.stringify({ accepted: true, job_id: 'j1' }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});

// ---- 隔离数据目录 + RAG env：必须在 require 业务模块前设置 ----
const dir = mkdtempSync(join(tmpdir(), 'cs-rag-test-'));
process.env.CS_DATA_DIR = dir;

const { ToolRegistry } = require('@agent-harness/core');
let baseUrl = '';
let kbSvc, kbRepo, config, kbTools;

before(async () => {
  await new Promise((r) => stub.listen(0, r));
  baseUrl = `http://127.0.0.1:${stub.address().port}`;
  process.env.CS_RAG_BASE_URL = baseUrl;
  process.env.CS_RAG_TIMEOUT_MS = '2000';
  kbSvc = require('../dist/services/kb-service.js');
  kbRepo = require('../dist/repo/kb-repo.js');
  config = require('../dist/config.js');
  kbTools = require('../dist/tools/kb.js');
  require('../dist/infra/db.js').getDb();
});

after(() => {
  require('../dist/infra/db.js').closeDb();
  config.resetConfig();
  stub.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不阻断 */ }
});

test('RAG 优先：search 返回 rag 来源条目（含 score/category）', async () => {
  const hits = await kbSvc.search({ query: '跨店退货 怎么退', limit: 3 });
  assert.ok(hits.length >= 1);
  assert.strictEqual(hits[0].source, 'rag');
  assert.strictEqual(hits[0].question, '跨店退货政策');
  assert.strictEqual(hits[0].answer.includes('30 天'), true);
  assert.strictEqual(hits[0].category, '售后');
  assert.ok(hits[0].score > 0.8);
});

test('RAG 空结果：回退本地 LIKE（source=local）', async () => {
  kbRepo.insertKb({ question: '发票怎么开', answer: '下单后可在订单详情申请电子发票' });
  ragMode = 'empty';
  const hits = await kbSvc.search({ query: '发票', limit: 3 });
  assert.ok(hits.length >= 1);
  assert.strictEqual(hits[0].source, 'local');
  assert.strictEqual(hits[0].answer.includes('电子发票'), true);
});

test('RAG 故障（500+重试耗尽）：回退本地 LIKE 且不抛错', async () => {
  ragMode = 'down';
  const hits = await kbSvc.search({ query: '发票', limit: 3 });
  assert.ok(hits.length >= 1);
  assert.strictEqual(hits[0].source, 'local');
  ragMode = 'ok';
});

test('cs_kb_add：本地落库 + 尽力镜像 RAG（doc_id=cs-kb-<id>）', async () => {
  const reg = new ToolRegistry();
  kbTools.registerKbTools(reg);
  const out = await reg.call('cs_kb_add', { question: '会员积分规则', answer: '消费 1 元累计 1 积分', category: '会员' });
  assert.ok(out.kbId > 0);
  // fire-and-forget 镜像：轮询等待落达
  for (let i = 0; i < 50 && calls.ingest.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.strictEqual(calls.ingest.length, 1, '应向 RAG 发起镜像 ingest');
  const sent = calls.ingest[0];
  assert.strictEqual(sent.doc_id, `cs-kb-${out.kbId}`);
  assert.strictEqual(sent.title, '会员积分规则');
  assert.ok(sent.text.includes('1 积分'));
  assert.deepEqual(sent.tags, ['会员']);
});

test('未配置 RAG：search 直接走本地（零回归）', async () => {
  delete process.env.CS_RAG_BASE_URL;
  config.resetConfig();
  const hits = await kbSvc.search({ query: '发票', limit: 3 });
  assert.ok(hits.length >= 1);
  assert.strictEqual(hits[0].source, 'local');
  const c = config.getConfig();
  assert.strictEqual(c.rag.enabled, false);
  // 恢复 env（进程内其他用例已结束，仅为整洁）
  process.env.CS_RAG_BASE_URL = baseUrl;
  config.resetConfig();
});
