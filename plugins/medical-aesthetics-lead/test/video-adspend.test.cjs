// 新增能力回归测试：
//   ⑩ 视频脚本生成（video_script 平台）
//   1) KB 导入后生成 video_script：五段式分镜结构（钩子/科普/适用与恢复/注意事项/风险+引导面诊）
//   2) 视频脚本不含疗效承诺、价格以「面诊为准」收口、末镜含风险提示
//   3) KB 缺字段时对应镜头被跳过（不编造）
//   4) 手写 video_script 草稿合规筛查仍生效
//   ⑨ 广告消耗 + 真实 ROI
//   5) 导入消耗 → adSpendStats 汇总正确；同日同计划重复导入幂等（不增行）
//   6) 有花费 → roiAnalysis spendConnected=true、ROI/CPL 为真实值
//   7) 无花费 → spendConnected=false、roi/cpl=null（不虚构）
//   8) 非法输入（坏日期 / 负花费）fail-fast
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DATA_DIR;

test.beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-video-ad-'));
  process.env.MA_DATA_DIR = DATA_DIR;
  process.env.MA_TENANT_ID = 'test';
  process.env.MA_OUTBOX_ENABLED = 'false';
  delete process.env.MA_OUTREACH_BASE_URL;
  delete process.env.MA_AD_PLATFORM_BASE_URL;
  delete process.env.MA_AD_PLATFORM_TOKEN;
  try { require('../dist/infra/db').closeDb(); } catch {}
  try { require('../dist/config').resetConfig(); } catch {}
});

test.afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { require('../dist/infra/db').closeDb(); } catch {}
});

const { upsertProject } = require('../dist/repo/kb-repo');
const { generateTemplateContent, createManualDraft, screenContent } = require('../dist/services/content-service');
const { getContent } = require('../dist/repo/content-repo');
const { upsertAdSpend, adSpendStats, listAdSpend } = require('../dist/repo/ad-spend-repo');
const { roiAnalysis } = require('../dist/analytics/analytics-service');
const { upsertLead } = require('../dist/repo/lead-repo');
const { upsertOrder } = require('../dist/repo/order-repo');
const { pullAdSpend } = require('../dist/services/ad-client');

function seedProject(id, name, extra = {}) {
  return upsertProject({
    projectId: id,
    name,
    summary: `${name}是通过特定技术改善外观的医美项目。`,
    audience: '成年且身体健康者',
    recovery: '3-7 天',
    contraindications: '孕期、哺乳期及局部活动性炎症者不宜',
    priceRange: '2000-8000 元',
    ...extra,
  });
}

describe('视频脚本生成（⑩）', () => {
  test('五段式分镜结构 + 合规收口', async () => {
    await seedProject('p_video', '玻尿酸填充');
    const r = await generateTemplateContent({ platform: 'video_script' });
    assert.strictEqual(r.generated, 1, '应生成 1 条视频脚本');
    assert.strictEqual(r.skipped.length, 0, '合规内容不应被跳过');

    const c = await getContent(r.contentIds[0]);
    assert.ok(c, '内容应已落库');
    assert.strictEqual(c.platform, 'video_script');
    assert.strictEqual(c.state, 'review', '生成即入审');

    // 五段式结构
    assert.ok(c.body.includes('【0-3s】'), '应含钩子镜头');
    assert.ok(c.body.includes('【3-15s】'), '应含科普镜头');
    assert.ok(c.body.includes('【15-25s】'), '应含适用与恢复镜头');
    assert.ok(c.body.includes('【25-30s】'), '应含注意事项镜头');
    assert.ok(c.body.includes('【30-35s】'), '应含风险提示+引导面诊镜头');
    // 每个镜头都有画面/口播/字幕三要素
    assert.ok(/画面：.+/.test(c.body) && /口播：.+/.test(c.body) && /字幕：.+/.test(c.body));

    // 合规收口
    assert.ok(c.body.includes('以面诊方案为准'), '价格/方案必须以面诊为准收口');
    assert.ok(c.body.includes('医疗美容有风险'), '末镜应含风险提示');
    assert.ok(!/保证|100%|绝对|根治/.test(c.body), '脚本不得含疗效承诺');
    assert.strictEqual(screenContent(c.title, c.body).length, 0, '脚本应通过合规筛查');
  });

  test('KB 缺字段时跳过对应镜头（不编造）', async () => {
    await upsertProject({
      projectId: 'p_min',
      name: '极简项目',
      summary: '仅有科普摘要。',
      // 无 audience / recovery / contraindications / priceRange
    });
    const r = await generateTemplateContent({ platform: 'video_script' });
    const c = await getContent(r.contentIds[0]);
    assert.ok(c.body.includes('【0-3s】'), '钩子镜头恒存在');
    assert.ok(c.body.includes('【3-15s】'), '有 summary → 科普镜头存在');
    assert.ok(!c.body.includes('【15-25s】'), '无 audience/recovery → 跳过适用与恢复镜头');
    assert.ok(!c.body.includes('【25-30s】'), '无 contraindications → 跳过注意事项镜头');
    assert.ok(c.body.includes('【30-35s】'), '风险+引导面诊镜头恒存在');
    assert.ok(!/适合人群：/.test(c.body), '不得补写适合人群');
  });

  test('手写 video_script 草稿：命中疗效承诺 → 拒绝且不落库', async () => {
    await assert.rejects(
      () =>
        createManualDraft({
          platform: 'video_script',
          title: '玻尿酸填充｜30 秒科普短视频脚本',
          body: '【0-3s】\n画面：近景\n口播：保证 100% 见效，绝对安全\n字幕：钩子',
        }),
      /医疗广告合规红线/,
      '应被合规红线拒绝'
    );
    const list = await require('../dist/repo/content-repo').listContent({ platform: 'video_script' });
    assert.strictEqual(list.length, 0, '违规草稿不得落库');
  });
});

describe('广告消耗 + 真实 ROI（⑨）', () => {
  const DAY = 86_400_000;

  test('导入消耗 → 汇总正确，同日同计划幂等', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yest = new Date(Date.now() - DAY).toISOString().slice(0, 10);

    const n1 = await upsertAdSpend([
      { spendDate: yest, channel: 'douyin', campaignId: 'c1', campaignName: '抖音计划一', spend: 1000, impressions: 10000, clicks: 200, conversions: 20 },
      { spendDate: yest, channel: 'xiaohongshu', campaignId: 'c2', campaignName: '小红书计划一', spend: 500, impressions: 5000, clicks: 80, conversions: 8 },
      { spendDate: today, channel: 'douyin', campaignId: 'c1', campaignName: '抖音计划一', spend: 1200, impressions: 12000, clicks: 240, conversions: 24 },
    ]);
    assert.strictEqual(n1, 3, '应写入 3 条');

    // 同日同渠道同计划重复导入 → 覆盖更新，不增行
    const n2 = await upsertAdSpend([
      { spendDate: today, channel: 'douyin', campaignId: 'c1', spend: 1200, clicks: 240, conversions: 24 },
    ]);
    assert.strictEqual(n2, 1, '幂等写入仍返回 1');
    const list = await listAdSpend();
    assert.strictEqual(list.length, 3, '行数应仍为 3（覆盖而非新增）');
    const updated = list.find((r) => r.spendDate === today && r.channel === 'douyin');
    assert.strictEqual(updated.spend, 1200, '数值应被覆盖更新');

    const stats = await adSpendStats();
    assert.strictEqual(stats.rowCount, 3);
    assert.strictEqual(stats.totalSpend, 2700, '总花费应为 1000+500+1200');
    assert.strictEqual(stats.conversions, 52, '转化合计 20+8+24');
    assert.strictEqual(stats.byChannel.length, 2, '两个渠道');
    assert.strictEqual(stats.byChannel[0].channel, 'douyin', '花费最高渠道排前');
    assert.strictEqual(stats.byDate.length, 2, '两个日期');
  });

  test('有花费 → ROI/CPL 为真实值', async () => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    await upsertLead('roi1', { channel: 'douyin', name: 'A', stage: 'deal', consentAt: now });
    await upsertOrder({ orderId: 'ro_o1', leadId: 'roi1', project: '玻尿酸', amount: 10000, status: 'paid', paidAt: now });
    await upsertAdSpend([
      { spendDate: today, channel: 'douyin', campaignId: 'c1', spend: 2000, impressions: 20000, clicks: 400, conversions: 40 },
    ]);

    const r = await roiAnalysis({ type: 'roi' });
    assert.strictEqual(r.totalRevenue, 10000);
    assert.strictEqual(r.spendConnected, true, '有花费数据应置 true');
    assert.strictEqual(r.adSpend, 2000);
    assert.strictEqual(r.roi, 5, 'ROI = 10000/2000 = 5');
    assert.strictEqual(r.cpl, 50, 'CPL = 2000/40 = 50');
    assert.strictEqual(r.spendMetrics.conversions, 40);
    assert.strictEqual(r.byChannel.length, 1);
  });

  test('无花费 → spendConnected=false、roi/cpl=null（不虚构）', async () => {
    const now = Date.now();
    await upsertLead('roi2', { channel: 'douyin', name: 'B', stage: 'deal', consentAt: now });
    await upsertOrder({ orderId: 'ro_o2', leadId: 'roi2', project: '瘦脸针', amount: 5000, status: 'paid', paidAt: now });

    const r = await roiAnalysis({ type: 'roi' });
    assert.strictEqual(r.spendConnected, false, '无花费数据应为 false');
    assert.strictEqual(r.adSpend, null);
    assert.strictEqual(r.roi, null, '不得虚构 ROI');
    assert.strictEqual(r.cpl, null, '不得虚构 CPL');
    assert.strictEqual(r.totalRevenue, 5000, '成交金额仍真实返回');
  });

  test('非法输入 fail-fast：坏日期 / 负花费', async () => {
    await assert.rejects(
      () => upsertAdSpend([{ spendDate: '2026/01/01', channel: 'douyin', campaignId: 'c1', spend: 100 }]),
      /spendDate 必须是 YYYY-MM-DD/,
      '坏日期应被拒绝'
    );
    await assert.rejects(
      () => upsertAdSpend([{ spendDate: '2026-01-01', channel: 'douyin', campaignId: 'c1', spend: -5 }]),
      /spend 必须是非负数字/,
      '负花费应被拒绝'
    );
    await assert.rejects(
      () => upsertAdSpend([{ spendDate: '2026-01-01', channel: '', campaignId: 'c1', spend: 100 }]),
      /channel 不能为空/,
      '空渠道应被拒绝'
    );
    const stats = await adSpendStats();
    assert.strictEqual(stats.rowCount, 0, '非法数据不得落库');
  });

  test('平台未配置 → pullAdSpend 返回 pulled=false 且不清空数据', async () => {
    await upsertAdSpend([{ spendDate: '2026-01-01', channel: 'douyin', campaignId: 'c1', spend: 100 }]);
    const r = await pullAdSpend('2026-01-01', '2026-01-31');
    assert.strictEqual(r.pulled, false, '未配置平台不应假装拉取成功');
    assert.strictEqual(r.written, 0);
    assert.ok(r.note && r.note.length > 0, '应给出说明');
    const stats = await adSpendStats();
    assert.strictEqual(stats.rowCount, 1, '既有导入数据不得被清空');
  });
});
