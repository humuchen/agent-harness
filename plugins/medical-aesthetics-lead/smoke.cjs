/* 端到端冒烟：真实 node:sqlite 链路（不依赖任何外部服务，未配置即 fail-closed）。 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-smoke-'));
process.env.MA_DATA_DIR = DATA;
process.env.MA_TENANT_ID = 'smoke';
process.env.MA_OUTBOX_ENABLED = 'false'; // 不参与后台投递

const cfg = require('./dist/config');
const db = require('./dist/infra/db');
const sched = require('./dist/repo/schedule-repo');
const lead = require('./dist/repo/lead-repo');
const inbound = require('./dist/repo/inbound-repo');
const outbox = require('./dist/repo/outbox-repo');
const leadSvc = require('./dist/services/lead-service');
const schedSvc = require('./dist/services/schedule-service');
const kbSvc = require('./dist/services/kb-service');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ok -', msg);
}

(async () => {
  console.log('[1] 导入真实院区/号源（参数化 SQL upsert）');
  sched.upsertClinic({ clinicId: 'c_sh', name: '上海静安院区', city: '上海', active: true });
  sched.upsertSlot({ slotId: 's1', clinicId: 'c_sh', date: '2026-09-01', time: '14:30', capacity: 1 });
  sched.upsertSlot({ slotId: 's2', clinicId: 'c_sh', date: '2026-09-01', time: '16:00', capacity: 2 });
  let slots = sched.listSlots('c_sh', '2026-09-01');
  assert(slots.length === 2 && slots[0].remaining === 1 && slots[1].remaining === 2, '号源导入且余量正确');

  console.log('[2] lead_qualify（真实落库 + 阶段单调推进）');
  const q = leadSvc.qualifyLead({ leadId: 'douyin_001', channel: '抖音', project: '双眼皮', city: '上海', grade: 'A', intent: '咨询双眼皮' });
  assert(q.ok && q.stage === 'qualified' && q.crmSync === 'disabled', 'qualify 落库，CRM 未配置→disabled（据实，不假成功）');
  assert(lead.getLead('douyin_001').reached === 'qualified', '线索 reached 正确');

  console.log('[3] lead_capture（授权留资，阶段不回退）');
  const cap = leadSvc.captureLead({ leadId: 'douyin_001', consent: true, wechat: 'wx_abc' });
  assert(cap.ok && cap.stage === 'captured', 'capture 落库 captured');

  console.log('[4] consultation_book（真实号源校验 + 事务防超卖）');
  const b = schedSvc.bookConsultation({ leadId: 'douyin_001', clinic: '上海静安院区', date: '2026-09-01', time: '14:30' });
  assert(b.ok && b.appointmentId, 'booking 返回真实 appointmentId');
  assert(lead.getLead('douyin_001').stage === 'booked', '线索推进到 booked');
  const s1 = sched.getSlot('s1');
  assert(s1.booked === 1 && s1.remaining === 0, '号源 s1 占用 booked=1/remaining=0（防超卖）');

  console.log('[5] 防超卖：满号源再次预约应被拒（NOT_FOUND/CONFLICT，非假成功）');
  let rejected = false;
  try {
    schedSvc.bookConsultation({ leadId: 'douyin_002', clinic: '上海静安院区', date: '2026-09-01', time: '14:30' });
  } catch (e) {
    rejected = e.code === 'CONFLICT' || e.code === 'NOT_FOUND';
  }
  assert(rejected, '满号源预约被拒（据实报错，绝不假成功）');

  console.log('[6] lead_handoff（转人工 + 不回退）');
  const h = leadSvc.handoffLead({ leadId: 'douyin_001', reason: '高意向需面诊设计' });
  assert(h.ok && h.handedOff && lead.getLead('douyin_001').stage === 'arrived', 'handoff→arrived，未回退到 booked');

  console.log('[7] 看板聚合（SQL GROUP BY）');
  const stats = lead.computeStats();
  assert(stats.total === 1 && stats.funnel.qualified >= 1 && stats.funnel.booked >= 1, `漏斗累计正确 total=${stats.total}`);
  assert(stats.crmSync.disabled === 1, 'CRM 同步健康统计=disabled x1（据实）');

  console.log('[8] 知识库检索：空库返回空（fail-closed，不回退内置语料）');
  const kb = await kbSvc.searchProjects('双眼皮');
  assert(Array.isArray(kb) && kb.length === 0, '空库检索返回 []（无假数据）');

  console.log('[9] 渠道入站去重（UNIQUE 防重放）');
  const m1 = inbound.saveInbound({ channel: '抖音', externalId: 'ext_1', leadKey: 'k1', text: 'hi' });
  const m2 = inbound.saveInbound({ channel: '抖音', externalId: 'ext_1', leadKey: 'k1', text: 'hi' });
  assert(m1.id === m2.id, '重复 externalId 返回同一记录（去重）');

  console.log('[10] 发件箱：入队 + 扫描（CRM 未配置时积压保留，待配置后 flush）');
  outbox.enqueue('lead.upsert', 'lead:douyin_001:1', { leadId: 'douyin_001' });
  const due = outbox.dueBatch(10, Date.now());
  assert(due.length === 1 && due[0].topic === 'lead.upsert', '发件箱入队并可被扫描');
  const os = outbox.outboxStats();
  assert(os.pending === 1, '发件箱 pending=1');

  console.log('[11] dbHealth 真实行数');
  const health = db.dbHealth();
  assert(health.ok && health.counts.ma_lead >= 1 && health.counts.ma_appointment >= 1, 'dbHealth 反映真实行数');

  console.log('\nALL SMOKE CHECKS PASSED ✅');
  db.closeDb();
  process.exit(0);
})().catch((e) => {
  console.error('\nSMOKE FAILED ❌', e);
  try { db.closeDb(); } catch {}
  process.exit(1);
});
