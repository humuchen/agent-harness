// 内容生产 + 先审后发（D8/D9）测试：
//   1) 知识库为空 → 生成 fail-closed（绝不回退内置语料）
//   2) KB 导入后模板生成：只组装 KB 字段、价格收口「面诊为准」、入审即 review 状态
//   3) 同日批量幂等：重复调用 generated=0；contentIds 无重复
//   4) 合规红线：手写草稿 / Agent 起草命中疗效承诺 → 拒绝且不落库
//   5) 状态机：draft→review→approved→published 全链；非法迁移 → CONFLICT
//   6) 驳回必须带原因；rejected 可重新送审
//   7) 发布：网关未配置 → NOT_CONFIGURED，内容保持 approved（publish_error 记录），绝不假装已发布
//   8) 发布：网关已配置 + mock fetch → POST /v1/content/publish，幂等键 content:{id}，文案末尾含风险提示
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DATA_DIR;

test.beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-content-'));
  process.env.MA_DATA_DIR = DATA_DIR;
  process.env.MA_TENANT_ID = 'test';
  process.env.MA_OUTBOX_ENABLED = 'false';
  delete process.env.MA_OUTREACH_BASE_URL;
  delete process.env.MA_OUTREACH_TOKEN;
  delete process.env.MA_OUTREACH_RETRIES;
  try {
    require('../dist/infra/db').closeDb();
  } catch {}
  try {
    require('../dist/config').resetConfig();
  } catch {}
});

test.afterEach(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
  try {
    require('../dist/infra/db').closeDb();
  } catch {}
});

const { upsertProject } = require('../dist/repo/kb-repo');
const {
  generateTemplateContent,
  createManualDraft,
  submitContent,
  approveContent,
  rejectContent,
  publishContent,
  screenContent,
} = require('../dist/services/content-service');
const { getContent, listContent } = require('../dist/repo/content-repo');
const { registerContentTool } = require('../dist/tools/content');

/** 导入一个合规测试项目（字段即运营导入接口的最小集）。 */
function seedProject(id, name) {
  upsertProject({
    projectId: id,
    name,
    category: '紧肤抗衰',
    aliases: [],
    summary: `${name}是一种常见的紧肤类项目，通过射频方式作用皮肤层，具体效果因人而异。`,
    indications: '适合皮肤松弛人群',
    contraindications: '孕期内不得进行此类操作',
    recovery: '一般恢复期约 1-3 天，具体因人而异',
    priceRange: '3000-8000 元',
    compliantCopy: `${name}为正规机构开展的常见紧肤项目，需先经医生面诊评估是否适合。`,
    complianceReviewed: true,
    audience: '25-45 岁有紧肤需求人群',
    faq: [{ q: '需要几次？', a: '按面诊方案确定，因人而异。' }],
    source: 'import',
    active: true,
    updatedAt: Date.now(),
  });
}

describe('模板生成（知识库驱动）', () => {
  test('知识库为空 → fail-closed 报错，绝不回退内置语料', async () => {
    await assert.rejects(
      () => generateTemplateContent(),
      /知识库为空/,
      '空库必须报错而不是生成占位内容'
    );
  });

  test('导入项目后生成：KB 字段组装 + 价格面诊收口 + 直接入审', async () => {
    seedProject('p-thermage', '热玛吉');
    const r = await generateTemplateContent({ platform: 'xiaohongshu' });
    assert.equal(r.generated, 1);
    assert.equal(r.skipped.length, 0);
    const c = await getContent(r.contentIds[0]);
    assert.ok(c, '生成内容应落库');
    assert.equal(c.state, 'review', '模板内容应直接进入人工审核队列');
    assert.equal(c.source, 'template');
    assert.match(c.title, /热玛吉/);
    assert.match(c.body, /面诊为准/, '价格段必须以面诊为准收口');
    assert.match(c.body, /适合人群/, '应组装 KB 的 audience 字段');
    assert.match(c.body, /恢复期/, '应组装 KB 的 recovery 字段');
    assert.match(c.body, /注意事项/, '应组装 KB 的 contraindications 字段');
    assert.doesNotMatch(c.title + c.body, /保证|绝对|100%|百分百|最有效/, '模板文案不得含疗效承诺');
  });

  test('同日批量幂等：全平台生成 → 重复调用 generated=0', async () => {
    seedProject('p-ultra', '超声炮');
    const r1 = await generateTemplateContent();
    assert.equal(r1.generated, 3, '缺省应覆盖三平台各一条');
    assert.equal(new Set(r1.contentIds).size, 3, 'contentIds 不应重复');
    const r2 = await generateTemplateContent();
    assert.equal(r2.generated, 0, '同日同项目同平台应幂等去重');
    const all = await listContent({ state: 'review' });
    assert.equal(all.length, 3);
  });

  test('指定项目名不存在 → NOT_FOUND', async () => {
    seedProject('p-x', '项目X');
    await assert.rejects(() => generateTemplateContent({ projectName: '不存在的项目' }), /不存在/);
  });
});

describe('合规筛查（入审闸门）', () => {
  test('screenContent 命中疗效承诺词 → 返回违规明细', () => {
    const hits = screenContent('热玛吉', '做完保证不留疤，100%有效，全网第一。');
    assert.ok(hits.length >= 2, '至少命中两条红线');
    for (const h of hits) assert.ok(h.reason.length > 0);
  });

  test('手写草稿命中红线 → INVALID_ARGUMENT 且不落库', async () => {
    await assert.rejects(
      () => createManualDraft({ platform: 'xiaohongshu', title: '标题', body: '承诺术前术后对比明显，立减 3000 元永久有效。' }),
      /医疗广告合规红线/
    );
    const all = await listContent({});
    assert.equal(all.length, 0, '违规文案不得落库');
  });

  test('Agent 工具 content_draft：违规 → ok:false + violations；合规 → 落库 review', async () => {
    const calls = [];
    const tools = { register: (name, desc, schema, fn) => calls.push({ name, fn }) };
    registerContentTool(tools);
    assert.equal(calls[0].name, 'content_draft');
    const fn = calls[0].fn;

    const bad = await fn({ platform: 'douyin', title: '超声炮', body: '3 天见效，术后对比效果惊人，价格一口价 3000 元。' });
    assert.equal(bad.ok, false, '违规草稿必须拒绝');
    assert.ok(Array.isArray(bad.violations) && bad.violations.length > 0);
    assert.equal((await listContent({})).length, 0, '违规草稿不得落库');

    const good = await fn({ platform: 'douyin', title: '超声炮科普', body: '超声炮是常见紧肤项目，需先到店面诊评估，具体方案因人而异。' });
    assert.equal(good.ok, true);
    assert.equal(good.state, 'review');
    assert.match(good.note, /审核/);
    const saved = await getContent(good.contentId);
    assert.equal(saved.source, 'llm');
  });
});

describe('状态机（先审后发）', () => {
  test('draft→review→approved；非法迁移 → CONFLICT', async () => {
    const d = await createManualDraft({
      platform: 'livestream',
      title: '直播科普脚本',
      body: '本场直播为项目科普，适合人群与禁忌以医生面诊意见为准。',
    });
    assert.equal(d.state, 'draft');

    // 未送审直接过审 → CONFLICT
    await assert.rejects(() => approveContent(d.contentId, '审核员A'), /CONFLICT|不允许过审/);

    const s = await submitContent(d.contentId, '运营B');
    assert.equal(s.state, 'review');
    const a = await approveContent(d.contentId, '审核员A');
    assert.equal(a.state, 'approved');
    assert.equal(a.reviewedBy, '审核员A');

    // 过审后不允许驳回
    await assert.rejects(() => rejectContent(d.contentId, '审核员A', '改一下'), /不允许驳回/);
  });

  test('驳回必须带原因；rejected 可重新送审', async () => {
    seedProject('p-y', '项目Y');
    const r = await generateTemplateContent({ platform: 'douyin' });
    const id = r.contentIds[0];

    await assert.rejects(() => rejectContent(id, '审核员C', '   '), /原因/, '空原因必须拒绝');
    const rej = await rejectContent(id, '审核员C', '标题与平台调性不符，请改写');
    assert.equal(rej.state, 'rejected');
    assert.equal(rej.reviewReason, '标题与平台调性不符，请改写');

    const resub = await submitContent(id, '运营B');
    assert.equal(resub.state, 'review', '驳回后应可改稿重新送审');
    const a = await approveContent(id, '审核员D');
    assert.equal(a.state, 'approved');
  });
});

describe('发布（渠道网关）', () => {
  test('网关未配置 → NOT_CONFIGURED，内容保持 approved 可重试', async () => {
    seedProject('p-z', '项目Z');
    const r = await generateTemplateContent({ platform: 'xiaohongshu' });
    const id = r.contentIds[0];
    await approveContent(id, '审核员A');

    await assert.rejects(() => publishContent(id), /未配置/);
    const c = await getContent(id);
    assert.equal(c.state, 'approved', '发布失败必须保持 approved（绝不假装已发布）');
    assert.ok(String(c.publishError ?? '').length > 0, '应记录 publish_error');
  });

  test('网关已配置 + mock fetch → published；幂等键 + 风险提示', async () => {
    seedProject('p-w', '项目W');
    const r = await generateTemplateContent({ platform: 'douyin' });
    const id = r.contentIds[0];
    await approveContent(id, '审核员A');

    process.env.MA_OUTREACH_BASE_URL = 'http://gateway.test';
    process.env.MA_OUTREACH_TOKEN = 'tok';
    process.env.MA_OUTREACH_RETRIES = '0';
    const { resetConfig } = require('../dist/config');
    resetConfig();

    const calls = [];
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true, postId: 'post-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      const c = await publishContent(id);
      assert.equal(c.state, 'published');
      assert.equal(c.publishRef, 'post-1');
      assert.ok(c.publishedAt > 0);

      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/v1\/content\/publish$/, '应 POST 到网关 /v1/content/publish 契约端点');
      assert.equal(calls[0].init.headers['idempotency-key'], `content:${id}`, '幂等键应为 content:{contentId}');
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.platform, 'douyin');
      assert.match(body.text, /医疗美容有风险/, '发布文案末尾必须附风险提示');

      // 已发布 → 重复发布 CONFLICT（状态机保护，配合网关幂等键双保险）
      await assert.rejects(() => publishContent(id), /不允许发布/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
