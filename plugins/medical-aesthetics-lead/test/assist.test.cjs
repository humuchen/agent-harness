// 咨询师辅助简报（C6/C7 本地库版）测试：
//   1) 不存在的线索 → NOT_FOUND
//   2) 完整简报：画像/授权/脱敏联系方式（掩码不泄露完整号码）/对话摘录正序/预约记录/触达统计
//   3) 规则化建议：D 级/已转人工 → 人工接手；已预约 → 到店确认；未授权 → 先取授权；
//      已授权有联系方式 → 错峰触达；缺项目 → 优先探明；A 级 → 尽快面诊
//   4) reveal：返回完整联系方式（脱敏简报之外的正门）
//   5) 工具 lead_briefing：ok:true / 缺参 INVALID_ARGUMENT / 不存在 NOT_FOUND
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DATA_DIR;

test.beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-assist-'));
  process.env.MA_DATA_DIR = DATA_DIR;
  process.env.MA_TENANT_ID = 'test';
  process.env.MA_OUTBOX_ENABLED = 'false';
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

const { upsertLead, appendLeadMessage } = require('../dist/repo/lead-repo');
const { getDb } = require('../dist/infra/db');
const { buildLeadBriefing, revealContact, maskContact, deriveSuggestions } = require('../dist/services/assist-service');
const { registerAssistTool } = require('../dist/tools/assist');

/** 直插一条预约单（简报按 lead_id 反查）。 */
async function seedAppointment(leadId, { date = '2026-09-25', time = '14:00', status = 'booked' } = {}) {
  const db = await getDb();
  await db
    .prepare(
      `INSERT INTO ma_appointment (appointment_id, tenant_id, lead_id, clinic_id, slot_id, slot_date, slot_time, status, created_at, updated_at)
       VALUES (?, 'test', ?, 'clinic-1', 'slot-1', ?, ?, ?, ?, ?)`
    )
    .run(`appt-${leadId}`, leadId, date, time, status, Date.now(), Date.now());
}

describe('简报基础（真实数据组装）', () => {
  test('不存在的线索 → NOT_FOUND', async () => {
    await assert.rejects(() => buildLeadBriefing('no-such'), /不存在/);
  });

  test('完整简报：画像 + 掩码联系方式 + 对话正序 + 预约 + 触达统计', async () => {
    await upsertLead('b1', {
      channel: '小红书', name: '王小明', grade: 'B', stage: 'qualified', project: '热玛吉',
      budget: '1-2 万', city: '苏州', intent: '咨询紧肤', phone: '13800000000', wechat: 'wx_wang',
      consentAt: Date.now(),
    });
    await appendLeadMessage('b1', 'user', '想了解热玛吉');
    await appendLeadMessage('b1', 'assistant', '热玛吉是常见紧肤项目，建议先面诊评估。');
    await appendLeadMessage('b1', 'user', '大概什么价位');
    await seedAppointment('b1');

    const b = await buildLeadBriefing('b1');
    assert.equal(b.source, 'local-db', '应明示数据来源');
    assert.equal(b.profile.channel, '小红书');
    assert.equal(b.profile.project, '热玛吉');
    assert.equal(b.profile.grade, 'B');
    assert.equal(b.consent.granted, true);

    // 脱敏：掩码出现、完整号码绝不出现
    assert.equal(b.contact.phone, '138****0000');
    assert.equal(b.contact.wechat, 'wx***');
    const raw = JSON.stringify(b);
    assert.ok(!raw.includes('13800000000'), '简报不得泄露完整手机号');
    assert.ok(!raw.includes('wx_wang'), '简报不得泄露完整微信号');

    // 对话摘录正序（user → assistant → user）
    assert.equal(b.recentMessages.length, 3);
    assert.equal(b.recentMessages[0].role, 'user');
    assert.match(b.recentMessages[0].text, /热玛吉/);
    assert.equal(b.recentMessages[2].role, 'user');

    // 预约与触达统计
    assert.equal(b.appointments.length, 1);
    assert.equal(b.appointments[0].date, '2026-09-25');
    assert.equal(b.appointments[0].status, 'booked');
    assert.equal(typeof b.outreach.byState, 'object');
  });

  test('maskContact：手机/微信/异常输入', () => {
    assert.equal(maskContact('13800000000'), '138****0000');
    assert.equal(maskContact('wx_wang'), 'wx***');
    assert.equal(maskContact('ab'), '****');
    assert.equal(maskContact(undefined), undefined);
  });
});

describe('规则化跟进建议（确定性推导）', () => {
  test('D 级 / 已转人工 → 人工接手优先', async () => {
    await upsertLead('s1', { channel: 'wechat', grade: 'D', stage: 'new', phone: '13800000000', consentAt: Date.now() });
    const lead = await require('../dist/repo/lead-repo').getLead('s1');
    const s = deriveSuggestions(lead, [], {});
    assert.ok(s.some((x) => x.includes('人工接手')), 'D 级必须建议人工接手');
  });

  test('已转人工 → 提示接手并带原因', async () => {
    await upsertLead('s2', { channel: 'wechat', grade: 'B', stage: 'contacted', handedOff: true, handoffReason: 'complaint' });
    const lead = await require('../dist/repo/lead-repo').getLead('s2');
    const s = deriveSuggestions(lead, [], {});
    assert.ok(s.some((x) => x.includes('转人工') && x.includes('complaint')));
  });

  test('已预约 → 到店确认提醒', async () => {
    await upsertLead('s3', { channel: 'wechat', grade: 'B', stage: 'booked', phone: '13800000000', consentAt: Date.now() });
    await seedAppointment('s3');
    const b = await buildLeadBriefing('s3');
    assert.ok(b.suggestions.some((x) => x.includes('到店前一天确认')), 'booked 必须建议到店确认');
  });

  test('未授权 → 先取授权；已授权 → 错峰/首触建议', async () => {
    await upsertLead('s4', { channel: 'wechat', grade: 'C', stage: 'contacted' });
    const lead4 = await require('../dist/repo/lead-repo').getLead('s4');
    assert.ok(deriveSuggestions(lead4, [], {}).some((x) => x.includes('授权')), '无授权必须提示先取授权');

    await upsertLead('s5', { channel: 'wechat', grade: 'C', stage: 'qualified', phone: '13900000000', consentAt: Date.now() });
    const lead5 = await require('../dist/repo/lead-repo').getLead('s5');
    const withAuto = deriveSuggestions(lead5, [], { pending: 1 });
    assert.ok(withAuto.some((x) => x.includes('错峰')), '已有自动触达排期时建议错峰');
    const noAuto = deriveSuggestions(lead5, [], {});
    assert.ok(noAuto.some((x) => x.includes('首次触达')), '无自动排期时建议 24h 内首触');
  });

  test('A 级高意向 → 尽快面诊；缺项目 → 优先探明', async () => {
    await upsertLead('s6', { channel: 'wechat', grade: 'A', stage: 'captured', phone: '13700000000', consentAt: Date.now() });
    const lead = await require('../dist/repo/lead-repo').getLead('s6');
    const s = deriveSuggestions(lead, [], {});
    assert.ok(s.some((x) => x.includes('面诊')));
    assert.ok(s.some((x) => x.includes('意向项目')), '无项目画像必须提示优先探明');
  });
});

describe('reveal 与工具接线', () => {
  test('revealContact 返回完整联系方式', async () => {
    await upsertLead('r1', { channel: 'wechat', name: '李雷', phone: '13600000000', wechat: 'lilei_wx' });
    const r = await revealContact('r1');
    assert.equal(r.phone, '13600000000');
    assert.equal(r.wechat, 'lilei_wx');
    await assert.rejects(() => revealContact('no-such'), /不存在/);
  });

  test('工具 lead_briefing：正常 / 缺参 / 不存在', async () => {
    const calls = [];
    registerAssistTool({ register: (name, desc, schema, fn) => calls.push({ name, fn }) });
    assert.equal(calls[0].name, 'lead_briefing');
    const fn = calls[0].fn;

    await upsertLead('t1', { channel: 'wechat', grade: 'B', stage: 'qualified', project: '超声炮' });
    const ok = await fn({ leadId: 't1' });
    assert.equal(ok.ok, true);
    assert.equal(ok.briefing.profile.project, '超声炮');
    assert.ok(Array.isArray(ok.briefing.suggestions));

    const missing = await fn({});
    assert.equal(missing.code, 'INVALID_ARGUMENT');

    const none = await fn({ leadId: 'ghost' });
    assert.equal(none.code, 'NOT_FOUND');
  });
});
