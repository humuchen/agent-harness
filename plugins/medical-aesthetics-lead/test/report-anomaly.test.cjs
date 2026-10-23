// 新增能力回归测试（P1-⑥ 经营日报定时化 + 业务异常预警）：
//   1) generateDailyReport 汇总全量分析 → 落库 Markdown 快照，当天幂等（二次返回 null）
//   2) latestDailyReport 可取回报告与指标
//   3) scanAnomalies 到院率越界 → 发告警；冷却窗口内二次扫描不重复告警
//   4) 无数据时 fail-closed：不产异常告警
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DATA_DIR;

test.beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-report-'));
  process.env.MA_DATA_DIR = DATA_DIR;
  process.env.MA_TENANT_ID = 'test';
  process.env.MA_OUTBOX_ENABLED = 'false';
  delete process.env.MA_OUTREACH_BASE_URL;
  delete process.env.MA_CRM_BASE_URL;
  delete process.env.MA_HIS_BASE_URL;
  try { require('../dist/infra/db').closeDb(); } catch {}
  try { require('../dist/config').resetConfig(); } catch {}
});

test.afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { require('../dist/infra/db').closeDb(); } catch {}
});

const { upsertLead } = require('../dist/repo/lead-repo');
const { upsertOrder } = require('../dist/repo/order-repo');
const { generateDailyReport, latestDailyReport, hasDailyReportToday, scanAnomalies } = require('../dist/services/report-service');

describe('经营日报（P1-⑥）', () => {
  test('汇总全量分析 → 落库快照，当天幂等', async () => {
    const now = Date.now();
    await upsertLead('r1', { channel: 'wechat', name: '王女士', project: '玻尿酸', stage: 'new', consentAt: now });
    await upsertLead('r2', { channel: 'douyin', name: '赵先生', project: '瘦脸针', stage: 'arrived', consentAt: now });
    await upsertLead('r3', { channel: 'xiaohongshu', name: '陈女士', project: '光子嫩肤', stage: 'deal', consentAt: now });
    await upsertOrder({ orderId: 'o1', leadId: 'r3', project: '光子嫩肤', amount: 3000, status: 'paid', paidAt: now });
    await upsertOrder({ orderId: 'o2', leadId: 'r3', project: '光子嫩肤', amount: 2000, status: 'paid', paidAt: now });

    const r = await generateDailyReport(now);
    assert.ok(r, '应生成日报');
    assert.ok(r.markdown.includes('# 医美运营日报'), '应含日报标题');
    assert.ok(r.markdown.includes('核心指标'), '应含核心指标段');
    assert.ok(r.markdown.includes('渠道表现'), '应含渠道表现段');
    assert.ok(r.markdown.includes('近 7 日趋势'), '应含趋势段');
    assert.strictEqual(r.metrics.totalLeads, 3);
    assert.strictEqual(r.metrics.arrived, 1);
    assert.strictEqual(r.metrics.deals, 1);
    assert.strictEqual(r.metrics.totalRevenue, 5000);

    // 当天幂等：二次生成返回 null
    assert.strictEqual(await hasDailyReportToday(now), true);
    const r2 = await generateDailyReport(now);
    assert.strictEqual(r2, null, '当天已生成，应返回 null');

    const latest = await latestDailyReport();
    assert.ok(latest, '可取回最新日报');
    assert.strictEqual(latest.date, r.date);
    assert.ok(latest.markdown.includes('医美运营日报'));
  });

  test('空数据 fail-closed：产出 0 值报告而非虚构', async () => {
    const r = await generateDailyReport(Date.now());
    assert.ok(r, '空库也应产出报告');
    assert.strictEqual(r.metrics.totalLeads, 0);
    assert.strictEqual(r.metrics.totalRevenue, 0);
    assert.ok(!/保证|100%/.test(r.markdown), '报告不得含疗效承诺话术');
  });
});

describe('业务异常预警（P1-⑥）', () => {
  test('到院率越界 → 告警；冷却内二次扫描不重复', async () => {
    process.env.MA_ALERT_ARRIVAL_RATE_MIN = '0.99'; // 100% 才算正常
    require('../dist/config').resetConfig();

    const now = Date.now();
    await upsertLead('a1', { channel: 'wechat', name: 'A', stage: 'new', consentAt: now });
    await upsertLead('a2', { channel: 'wechat', name: 'B', stage: 'new', consentAt: now });
    await upsertLead('a3', { channel: 'wechat', name: 'C', stage: 'arrived', consentAt: now });

    const fired = await scanAnomalies(now);
    const arrival = fired.filter((c) => c.rule === 'arrival_rate');
    assert.ok(arrival.length === 1, '到院率 33% 低于阈值 99%，应告警一次');
    assert.ok(['warn', 'error'].includes(arrival[0].level), '告警级别应为 warn/error');

    // 冷却窗口内二次扫描：不重复告警
    const fired2 = await scanAnomalies(now + 1000);
    assert.strictEqual(fired2.filter((c) => c.rule === 'arrival_rate').length, 0, '冷却期内不重复告警');
  });

  test('无数据 → 不产异常告警（fail-closed）', async () => {
    process.env.MA_ALERT_ARRIVAL_RATE_MIN = '0.15';
    require('../dist/config').resetConfig();
    const fired = await scanAnomalies(Date.now());
    assert.strictEqual(fired.length, 0, '空库不应产生业务异常告警');
  });
});
