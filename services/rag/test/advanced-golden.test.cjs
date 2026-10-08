// P6-B 方案二二期 + 方案三二期：高级检索（ParentDocument / multi-query / HyDE）
// 与 golden 回归套件契约测试。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { splitParentChild } = require('../dist/splitter.js');
const { MemoryVectorStore } = require('../dist/store.js');
const { HashEmbedding } = require('../dist/embed.js');
const { ingestStructured } = require('../dist/ingest.js');
const { retrieve } = require('../dist/retrieve.js');
const { multiQueryRetrieve, hydeRetrieve } = require('../dist/advanced-retrieval.js');
const { loadGoldenDataset, runGoldenSuite, diffGoldenReports } = require('../dist/golden.js');

const DOC = `# 手册

总体说明段落，覆盖本手册的组织方式。

## 会员

会员系统的安装步骤与数据库配置说明，会员功能依赖许可服务。
安装细节一：下载安装包并校验签名，确认版本号与目标环境匹配。
安装细节二：配置环境变量与数据库连接串，执行初始化脚本完成建表。
安装细节三：启动服务并接入许可服务，验证会员功能的健康检查端点。

## 发票

发票模块独立部署，发票税率配置在管理后台。
发票细节一：启用开票通道并在管理后台录入税号与银行账户。
发票细节二：配置税率模板与发票类型，验证样例发票的生成流程。
`;

const mkMockLlm = (reply) => ({ chat: async () => reply });

test('splitParentChild: 父块粒度 > 子块粒度，heading_path 传递', () => {
  const groups = splitParentChild(DOC, { parentLen: 400, childLen: 120 });
  assert.ok(groups.length >= 2, `多父块（实际 ${groups.length}）`);
  const all = groups.flatMap((g) => g.children);
  const maxChild = Math.max(...all.map((c) => c.content.length));
  assert.ok(maxChild <= 200, `子块受控（${maxChild}）`);
  assert.ok(groups.every((g) => g.children.length >= 1));
});

test('parent-child 端到端：入库含父+子，检索命中子块返回父块全文', async () => {
  const store = new MemoryVectorStore(256);
  const provider = new HashEmbedding(256);
  const res = await ingestStructured(store, provider, {
    doc_id: 'pc1',
    tenant_id: 't1',
    source: { type: 'markdown', value: DOC },
    retrieval_mode: 'parent-child',
    parent_len: 400,
    child_len: 120,
  });
  const chunks = store.getChunks('t1');
  const parents = chunks.filter((c) => c.metadata?.retrieval_role === 'parent');
  const children = chunks.filter((c) => c.metadata?.retrieval_role === 'child');
  assert.ok(parents.length >= 2);
  assert.ok(children.length > parents.length, '子块多于父块');
  assert.ok(children.every((c) => typeof c.metadata?.parent_id === 'string'));
  assert.strictEqual(res.chunks, chunks.length);

  // 检索：parent 模式 —— 候选排除父块，命中子块返回父块全文。
  const resp = await retrieve(
    store,
    provider,
    { query: '会员 安装 数据库', tenant_id: 't1', top_k: 3, parent: true }
  );
  assert.ok(resp.results.length > 0);
  const hit = resp.results[0];
  assert.ok(hit.content.includes('安装步骤'), '返回父块全文而非子块碎片');
  assert.ok(hit.metadata?.expanded_from, '记录来源子块');
  // 不含父块自身的直接命中（候选已排除）。
  assert.strictEqual(
    resp.results.some((r) => r.metadata?.retrieval_role === 'parent' && !r.metadata?.expanded_from),
    false
  );
  // 关闭 parent → 返回子块碎片（存量行为）。
  const resp2 = await retrieve(
    store,
    provider,
    { query: '会员 安装 数据库', tenant_id: 't1', top_k: 3 }
  );
  assert.ok(resp2.results[0].content.length < hit.content.length, '非 parent 模式返回子块');
});

test('multi-query: LLM 改写多路检索 RRF 融合；LLM 失败降级原查询', async () => {
  const store = new MemoryVectorStore(256);
  const provider = new HashEmbedding(256);
  await ingestStructured(store, provider, {
    doc_id: 'mq1',
    tenant_id: 't1',
    source: { type: 'markdown', value: DOC },
  });
  // 成功：mock 改写两个查询。
  const llmOk = mkMockLlm('["会员系统如何安装","数据库配置步骤"]');
  const r1 = await multiQueryRetrieve(store, provider, llmOk, {
    query: '会员安装', tenant_id: 't1', top_k: 3,
  });
  assert.deepStrictEqual(r1.rewritten.slice(0, 3), [
    '会员安装',
    '会员系统如何安装',
    '数据库配置步骤',
  ]);
  assert.strictEqual(r1.degraded, undefined);
  assert.ok(r1.results.length > 0);
  // 失败：llm 抛错 → 降级单查询仍出结果。
  const llmBad = { chat: async () => { throw new Error('llm down'); } };
  const r2 = await multiQueryRetrieve(store, provider, llmBad, {
    query: '会员安装', tenant_id: 't1', top_k: 3,
  });
  assert.strictEqual(r2.degraded, true);
  assert.deepStrictEqual(r2.rewritten, ['会员安装']);
  assert.ok(r2.results.length > 0);
});

test('hyde: 假设答案检索透出 hypothetical；LLM 失败降级', async () => {
  const store = new MemoryVectorStore(256);
  const provider = new HashEmbedding(256);
  await ingestStructured(store, provider, {
    doc_id: 'hy1',
    tenant_id: 't1',
    source: { type: 'markdown', value: DOC },
  });
  const llmOk = mkMockLlm('会员系统安装需要先配置数据库连接，随后启动许可服务完成激活。');
  const r1 = await hydeRetrieve(store, provider, llmOk, { query: '怎么装会员系统', tenant_id: 't1' });
  assert.ok(r1.hypothetical?.includes('数据库'));
  assert.ok(r1.results.length > 0);
  const r2 = await hydeRetrieve(store, provider, { chat: async () => { throw new Error('down'); } }, {
    query: '怎么装会员系统', tenant_id: 't1',
  });
  assert.strictEqual(r2.degraded, true);
  assert.strictEqual(r2.hypothetical, undefined);
  assert.ok(r2.results.length > 0, '降级原查询仍出结果');
});

test('golden: loadGoldenDataset 结构校验 + runGoldenSuite 通过/失败判定 + diff 报告', async () => {
  const store = new MemoryVectorStore(256);
  const provider = new HashEmbedding(256);
  await ingestStructured(store, provider, {
    doc_id: 'g1',
    tenant_id: 't1',
    source: { type: 'markdown', value: DOC },
  });
  // 数据集文件加载 + 校验。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'));
  const file = path.join(dir, 'golden.json');
  const dataset = {
    version: 'v1',
    cases: [
      { q: '会员系统安装', expect_contains: ['会员'] },
      { q: '发票部署', expect_contains: ['发票'] },
      { q: '不存在的主题', expect_contains: ['量子芯片'] },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(dataset));
  const loaded = loadGoldenDataset(file);
  assert.strictEqual(loaded.version, 'v1');
  assert.throws(() => {
    fs.writeFileSync(file, JSON.stringify({ cases: [] }));
    loadGoldenDataset(file);
  }, /version/);

  // 批跑：2 过 1 挂。
  const report = await runGoldenSuite(store, provider, loaded, { tenantId: 't1' });
  assert.strictEqual(report.total, 3);
  assert.strictEqual(report.passed, 2);
  assert.strictEqual(report.failed.length, 1);
  assert.match(report.failed[0].reason, /量子芯片/);
  assert.strictEqual(report.mode, 'chunk');

  // diff：目标版修复失败用例 → 输出「已修复」；回退 → 输出「回归」。
  const target = { ...report, version: 'v2', passed: 3, failed: [], passRate: 1 };
  const md = diffGoldenReports(report, target);
  assert.match(md, /v1 → v2/);
  assert.match(md, /✅ 已修复/);
  assert.match(md, /100%/);
  const regressed = diffGoldenReports(target, report);
  assert.match(regressed, /⚠️ 回归/);
  assert.match(regressed, /新增失败/);

  // 多查询模式批跑（mock llm）。
  const reportMq = await runGoldenSuite(store, provider, loaded, {
    tenantId: 't1', mode: 'multi-query', llm: mkMockLlm('["改写一","改写二"]'),
  });
  assert.strictEqual(reportMq.mode, 'multi-query');
  assert.strictEqual(reportMq.passed, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});
