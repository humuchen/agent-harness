// 增强：golden 数据集门禁 —— data/golden.json 版本化入库，经 pnpm -r test 进 CI。
// 语义：任一关键词缺失即 fail（不许变坏）；语料与数据集同源演进（改语料必须同步数据集）。
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');

const { loadGoldenDataset, runGoldenSuite, diffGoldenReports } = require('../dist/golden.js');
const { MemoryVectorStore } = require('../dist/store.js');
const { HashEmbedding } = require('../dist/embed.js');
const { ingestDocument } = require('../dist/ingest.js');

const DATASET_FILE = join(__dirname, '..', 'data', 'golden.json');
const TENANT = 'golden';
const DIM = 256;

/** 与数据集同源的知识语料（五篇客服 FAQ；改动须同步 data/golden.json）。 */
const CORPUS = [
  {
    doc_id: 'refund',
    title: '退款政策',
    text: '退款政策：支持七天无理由退款。退款将原路退回，1-3 个工作日到账。超过七天或人为损坏的商品不在退款范围。',
  },
  {
    doc_id: 'member',
    title: '会员规则',
    text: '会员规则：消费 1 元累计 1 积分，积分可在结算时抵扣现金。每月 8 日会员日积分双倍，会员等级越高折扣越多。',
  },
  {
    doc_id: 'shipping',
    title: '物流说明',
    text: '物流说明：下单后 48 小时内发货，默认顺丰快递包邮（偏远地区除外）。发货后可在订单详情查看物流轨迹。',
  },
  {
    doc_id: 'warranty',
    title: '保修条款',
    text: '保修条款：整机保修一年，电池保修半年。人为损坏、进水与私自拆机不在保修范围，可付费维修。',
  },
  {
    doc_id: 'booking',
    title: '预约规则',
    text: '预约规则：支持提前 7 天预约到店服务，改期或取消需至少提前 24 小时，逾期未到将扣除预约积分。',
  },
];

async function buildStore() {
  const store = new MemoryVectorStore(DIM);
  const provider = new HashEmbedding(DIM);
  for (const doc of CORPUS) {
    await ingestDocument(store, provider, { ...doc, tenant_id: TENANT });
  }
  return store;
}

describe('RAG golden 数据集门禁（data/golden.json）', () => {
  test('数据集文件可加载且结构合法（版本化）', () => {
    const ds = loadGoldenDataset(DATASET_FILE);
    assert.ok(ds.version, '应有版本号');
    assert.ok(ds.cases.length >= 8, `至少 8 个用例，实际 ${ds.cases.length}`);
    assert.ok(ds.cases.every((c) => c.q && Array.isArray(c.expect_contains) && c.expect_contains.length > 0));
  });

  test('门禁：全部用例通过（passRate === 1，不许变坏）', async () => {
    const store = await buildStore();
    const dataset = loadGoldenDataset(DATASET_FILE);
    const report = await runGoldenSuite(store, new HashEmbedding(DIM), dataset, { tenantId: TENANT });
    assert.strictEqual(
      report.failed.length,
      0,
      `golden 用例失败（回归信号，检查检索链路或语料/数据集同步）：${JSON.stringify(report.failed)}`,
    );
    assert.strictEqual(report.passRate, 1);
    assert.ok(report.latencyAvgMs >= 0);
  });

  test('multi-query 模式（mock LLM）同样全部通过', async () => {
    const store = await buildStore();
    const dataset = loadGoldenDataset(DATASET_FILE);
    const mockLlm = { chat: async () => JSON.stringify(['退款', '积分']) };
    const report = await runGoldenSuite(store, new HashEmbedding(DIM), dataset, {
      tenantId: TENANT,
      mode: 'multi-query',
      llm: mockLlm,
    });
    assert.strictEqual(report.failed.length, 0, JSON.stringify(report.failed));
  });

  test('diffGoldenReports：回归对比输出（修复/新增失败可读）', async () => {
    const store = await buildStore();
    const dataset = loadGoldenDataset(DATASET_FILE);
    const provider = new HashEmbedding(DIM);
    const good = await runGoldenSuite(store, provider, dataset, { tenantId: TENANT });
    // 构造一个"退化"报告（直接操纵 failed）验证 diff 文案
    const bad = { ...good, passed: good.passed - 1, passRate: (good.passed - 1) / good.total, failed: [{ q: '退款多久到账', reason: '结果正文缺失关键词：原路退回' }] };
    const diff = diffGoldenReports(good, bad);
    assert.ok(diff.includes('退款多久到账'), 'diff 应点名退化用例');
  });
});
