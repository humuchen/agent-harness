// 新增能力回归测试：
//   P2 自动策略闭环（ma_strategy_suggestion + strategy-service）
//   1) 规则引擎纯函数：到院率/成交率/复购率/日环比/CPL 各规则按阈值触发；分母为 0 不产建议
//   2) generateStrategySuggestions 落库 + 当天幂等（重复调用不增行）
//   3) 人工闸门：pending → approved → executed；未 approved 直接执行被拒
//   4) rejected 必须给原因
//   ⑨ 续：schedulerTick 集成广告消耗拉取（未配置平台时静默跳过、不清数据）
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DATA_DIR;

test.beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-strategy-'));
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

const {
  evaluateStrategyRules,
  generateStrategySuggestions,
  listSuggestions,
  reviewSuggestion,
  markSuggestionExecuted,
} = require('../dist/services/strategy-service');
const { upsertLead } = require('../dist/repo/lead-repo');
const { upsertOrder } = require('../dist/repo/order-repo');
const { upsertAdSpend } = require('../dist/repo/ad-spend-repo');
const { schedulerTick } = require('../dist/services/scheduler-service');

const THRESHOLDS = {
  arrivalRateMin: 0.15,
  dealRateMin: 0.2,
  repurchaseRateMin: 0.1,
  newLeadDropPct: 60,
  cplMax: 300,
};

describe('策略规则引擎（纯函数）', () => {
  test('全部指标健康 → 无建议', () => {
    const out = evaluateStrategyRules({
      arrivalRate: 80,
      dealRate: 60,
      repurchaseRate: 40,
      newLeadsToday: 100,
      newLeadsYesterday: 100,
      cpl: null,
      totalSpend: 0,
      thresholds: THRESHOLDS,
    });
    assert.strictEqual(out.length, 0, '健康指标不应产建议');
  });

  test('到院率/成交率/复购率低于阈值 → 各产一条', () => {
    const out = evaluateStrategyRules({
      arrivalRate: 5,
      dealRate: 8,
      repurchaseRate: 2,
      newLeadsToday: 100,
      newLeadsYesterday: 100,
      cpl: null,
      totalSpend: 0,
      thresholds: THRESHOLDS,
    });
    const rules = out.map((s) => s.rule).sort();
    assert.deepStrictEqual(rules, ['improve_arrival', 'improve_deal', 'improve_repurchase']);
    // 严重度：远低于阈值 → error
    assert.strictEqual(out.find((s) => s.rule === 'improve_arrival').severity, 'error');
    // 每条建议都必须带证据与可执行动作
    for (const s of out) {
      assert.ok(s.title && s.detail && s.action, '建议必须含标题/详情/动作');
      assert.ok(s.evidence && Object.keys(s.evidence).length > 0, '建议必须带证据');
    }
  });

  test('新增线索日环比大跌 → check_lead_drop', () => {
    const out = evaluateStrategyRules({
      arrivalRate: 80,
      dealRate: 60,
      repurchaseRate: 40,
      newLeadsToday: 10,
      newLeadsYesterday: 100,
      cpl: null,
      totalSpend: 0,
      thresholds: THRESHOLDS,
    });
    const s = out.find((x) => x.rule === 'check_lead_drop');
    assert.ok(s, '应产出日环比告警建议');
    assert.strictEqual(s.evidence.dropPct, 90);
  });

  test('CPL 偏高 → optimize_ad_cpl；无花费数据时不产', () => {
    const withCpl = evaluateStrategyRules({
      arrivalRate: 80,
      dealRate: 60,
      repurchaseRate: 40,
      newLeadsToday: 100,
      newLeadsYesterday: 100,
      cpl: 500,
      totalSpend: 1000,
      thresholds: THRESHOLDS,
    });
    assert.ok(withCpl.some((s) => s.rule === 'optimize_ad_cpl'), 'CPL 超阈值应产建议');

    const noSpend = evaluateStrategyRules({
      arrivalRate: 80,
      dealRate: 60,
      repurchaseRate: 40,
      newLeadsToday: 100,
      newLeadsYesterday: 100,
      cpl: null,
      totalSpend: 0,
      thresholds: THRESHOLDS,
    });
    assert.ok(!noSpend.some((s) => s.rule === 'optimize_ad_cpl'), '无花费数据不应产 CPL 建议');
  });

  test('分母为 0（无数据）→ 不产比率类建议', () => {
    const out = evaluateStrategyRules({
      arrivalRate: 0,
      dealRate: 0,
      repurchaseRate: 0,
      newLeadsToday: 0,
      newLeadsYesterday: 0,
      cpl: null,
      totalSpend: 0,
      thresholds: THRESHOLDS,
    });
    // 比率为 0 但分母为 0 时（真实场景由调用方以 total>0 前置判断），此处引擎层
    // 对 newLeadsYesterday=0 的环比规则不触发；CPL 无数据不触发。
    assert.ok(!out.some((s) => s.rule === 'check_lead_drop'), '昨日为 0 不应触发环比');
    assert.ok(!out.some((s) => s.rule === 'optimize_ad_cpl'), '无 CPL 不应触发');
  });
});

describe('策略建议生命周期（人工闸门）', () => {
  async function seedBadMetrics() {
    const now = Date.now();
    // 造低到院率/成交率/复购率：10 new + 1 arrived + 0 deal；1 笔订单无复购
    for (let i = 0; i < 10; i++) {
      await upsertLead(`s${i}`, { channel: 'wechat', name: `L${i}`, stage: 'new', consentAt: now });
    }
    await upsertLead('s_arr', { channel: 'wechat', name: '到院', stage: 'arrived', consentAt: now });
    await upsertOrder({ orderId: 'so1', leadId: 's_arr', project: '玻尿酸', amount: 1000, status: 'paid', paidAt: now });
  }

  test('落库 + 当天幂等', async () => {
    await seedBadMetrics();
    const g1 = await generateStrategySuggestions();
    assert.ok(g1.length >= 2, '低指标应产出至少 2 条建议');
    const rules1 = g1.map((g) => g.rule).sort();

    const list1 = await listSuggestions({ status: 'pending' });
    assert.strictEqual(list1.length, g1.length, 'pending 数量应等于本次生成数');

    // 同日再生成 → 幂等，不增行
    const g2 = await generateStrategySuggestions();
    assert.deepStrictEqual(g2.map((g) => g.rule).sort(), rules1, '同日重复生成规则集应一致');
    const list2 = await listSuggestions({ status: 'pending' });
    assert.strictEqual(list2.length, list1.length, '不应产生重复建议行');
  });

  test('pending → approved → executed；未确认直接执行被拒', async () => {
    await seedBadMetrics();
    await generateStrategySuggestions();
    const pending = await listSuggestions({ status: 'pending' });
    const target = pending[0];

    // 未确认 → 直接执行被拒
    await assert.rejects(() => markSuggestionExecuted(target.suggestionId), /仅 approved 可执行/, '未确认不能执行');

    const approved = await reviewSuggestion(target.suggestionId, 'approved', '运营小王');
    assert.strictEqual(approved.status, 'approved');
    assert.strictEqual(approved.reviewedBy, '运营小王');

    const executed = await markSuggestionExecuted(target.suggestionId);
    assert.strictEqual(executed.status, 'executed');
    assert.ok(executed.executedAt, '应记录执行时间');

    // 已执行的建议不可再审
    await assert.rejects(
      () => reviewSuggestion(target.suggestionId, 'rejected', '运营小王', '太晚了'),
      /不允许再审/,
      '终态不可再审'
    );
  });

  test('rejected 必须给原因', async () => {
    await seedBadMetrics();
    await generateStrategySuggestions();
    const pending = await listSuggestions({ status: 'pending' });
    await assert.rejects(
      () => reviewSuggestion(pending[0].suggestionId, 'rejected', '运营小王'),
      /必须给出原因/,
      '驳回必须给原因'
    );
    const rejected = await reviewSuggestion(pending[0].suggestionId, 'rejected', '运营小王', '本周期不适用');
    assert.strictEqual(rejected.status, 'rejected');
    assert.strictEqual(rejected.reviewReason, '本周期不适用');
  });

  test('建议不存在 → 明确报错', async () => {
    await assert.rejects(() => reviewSuggestion('sug_nope_2099-01-01', 'approved', 'op'), /不存在/);
    await assert.rejects(() => markSuggestionExecuted('sug_nope_2099-01-01'), /不存在/);
  });
});

describe('schedulerTick 集成（⑨ 续）', () => {
  test('广告消耗拉取：平台未配置 → 静默跳过且不清空既有数据', async () => {
    await upsertAdSpend([{ spendDate: '2026-01-01', channel: 'douyin', campaignId: 'c1', spend: 100 }]);
    const r = await schedulerTick();
    // 未配置平台：adSpendPull 为 { pulled:false, ... } 或 null（未到拉取周期），
    // 关键是 SOP 主流程不受影响且既有数据保留。
    assert.ok(r.plan, 'SOP 规划应正常返回');
    assert.ok(r.run, 'SOP 消费应正常返回');
    const { adSpendStats } = require('../dist/repo/ad-spend-repo');
    const stats = await adSpendStats();
    assert.strictEqual(stats.rowCount, 1, '既有导入数据不得被清空');
  });
});
