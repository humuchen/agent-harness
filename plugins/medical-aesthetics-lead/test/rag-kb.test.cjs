/**
 * 医美客资插件 · RAG 知识检索路径测试。
 *
 * 验证 `kb-service.searchProjectsRag` 在接入外部 RAG（services/rag）HTTP 服务时：
 * - 对 `type==='project'` 的 chunk 由元数据重建 ProjectRecord，并保留合规闸门
 *   （compliantCopy 优先、complianceReviewed 透传、未过审不返回疗效 FAQ）；
 * - 对 `type==='reference'` 的 chunk 作为 refs 返回；
 * - RAG 返回空结果时返回 { projects: [], refs: [] }（fail-closed，不伪造数据）。
 *
 * 通过 mock 全局 fetch 完成，无需真实启动 RAG 服务。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');

// 隔离：确保未被外部 MA_RAG_BASE_URL 干扰
delete process.env.MA_RAG_BASE_URL;
delete process.env.MA_RAG_TOKEN;

function mockFetchOnce(body) {
  const controller = { abort() {} };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
  return controller;
}

function setRagEnabled(baseUrl = 'http://rag.test') {
  process.env.MA_RAG_BASE_URL = baseUrl;
  // 失效配置缓存，使 getConfig().rag.enabled 重新读取 env
  try {
    require('../dist/config').resetConfig();
  } catch {}
}

describe('知识库 RAG 检索路径', () => {
  test('重建结构化项目并保留合规闸门', async () => {
    mockFetchOnce({
      results: [
        {
          chunk_id: 'project:thermage#0',
          doc_id: 'project:thermage',
          title: '热玛吉/超声炮',
          content: '热玛吉通过能量加热刺激胶原...',
          score: 0.92,
          metadata: {
            type: 'project',
            category: '光电',
            name: '热玛吉/超声炮',
            projectId: 'thermage',
            aliases: ['热玛吉', '超声炮'],
            intentTags: ['抗衰紧致', '轮廓提升'],
            complianceReviewed: true,
            compliantCopy: '热玛吉属光电抗衰项目，须由合规机构医师面诊评估后操作。',
            summary: '刺激胶原改善松弛的科普简介',
            indications: '面部松弛、细纹',
            contraindications: '孕期、起搏器',
            recovery: '1-3 天泛红消退',
            priceRange: '¥8000-25000/次',
            faq: [{ q: '能维持多久', a: '6-12 个月' }],
            audience: '初老人群',
            seasonality: '四季',
          },
        },
        {
          chunk_id: 'ref:compliance/ad-compliance-rules#0',
          doc_id: 'ref:compliance/ad-compliance-rules',
          title: 'ad-compliance-rules.md',
          content: '广告法禁止承诺疗效...',
          score: 0.71,
          metadata: { type: 'reference', category: 'compliance', confidence: 'high' },
        },
      ],
    });

    setRagEnabled();

    const kb = require('../dist/services/kb-service');
    const { projects, refs } = await kb.searchProjectsRag('热玛吉 抗衰', 5);

    assert.strictEqual(projects.length, 1, '应重建 1 个结构化项目');
    const p = projects[0];
    assert.strictEqual(p.projectId, 'thermage');
    assert.strictEqual(p.name, '热玛吉/超声炮');
    assert.strictEqual(p.complianceReviewed, true);
    assert.strictEqual(p.compliantCopy, '热玛吉属光电抗衰项目，须由合规机构医师面诊评估后操作。');
    assert.strictEqual(p.category, '光电');
    assert.deepStrictEqual(p.aliases, ['热玛吉', '超声炮']);
    assert.strictEqual(p.priceRange, '¥8000-25000/次');

    assert.strictEqual(refs.length, 1, '参考文档应作为 refs 返回');
    assert.strictEqual(refs[0].confidence, 'high');
    assert.strictEqual(refs[0].title, 'ad-compliance-rules.md');
  });

  test('RAG 空结果返回空（fail-closed）', async () => {
    mockFetchOnce({ results: [] });
    setRagEnabled();

    const kb = require('../dist/services/kb-service');
    const { projects, refs } = await kb.searchProjectsRag('冷门项目', 5);
    assert.strictEqual(projects.length, 0);
    assert.strictEqual(refs.length, 0);
  });

  test('RAG 服务异常时抛错（fail-closed，不伪造）', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'rag internal error',
    });
    setRagEnabled();

    const kb = require('../dist/services/kb-service');
    await assert.rejects(() => kb.searchProjectsRag('玻尿酸', 5), /RAG 检索失败/);
  });

  test('未配 MA_RAG_BASE_URL 时不走 RAG（回退本地库）', async () => {
    delete process.env.MA_RAG_BASE_URL;
    try {
      require('../dist/config').resetConfig();
    } catch {}

    const cfg = require('../dist/config').getConfig();
    assert.strictEqual(cfg.rag.enabled, false, '未配 MA_RAG_BASE_URL 时 RAG 应禁用');
  });
});
