/**
 * 医美客资插件端到端测试。
 *
 * 覆盖核心业务链路：
 * - 线索资质评估 → 留资 → 预约 → 转人工
 * - 号源防超卖
 * - 渠道入站去重
 * - 知识库查空拦截
 * - 发件箱投递
 * - 看板统计
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 临时数据目录
let DATA_DIR;

test.beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-e2e-'));
  process.env.MA_DATA_DIR = DATA_DIR;
  process.env.MA_TENANT_ID = 'test';
  process.env.MA_OUTBOX_ENABLED = 'false';
});

test.afterEach(() => {
  // 清理临时目录
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
  // 重置数据库连接
  try {
    const db = require('../dist/infra/db');
    db.closeDb();
  } catch {}
});

describe('医美客资插件 E2E', () => {
  test('完整链路：资质评估 → 留资 → 预约 → 转人工', async () => {
    const sched = require('../dist/repo/schedule-repo');
    const schedSvc = require('../dist/services/schedule-service');
    const leadSvc = require('../dist/services/lead-service');
    const lead = require('../dist/repo/lead-repo');

    // 1. 导入号源
    sched.upsertClinic({
      clinicId: 'c1',
      name: '测试院区',
      city: '上海',
      active: true
    });
    sched.upsertSlot({
      slotId: 's1',
      clinicId: 'c1',
      date: '2026-09-01',
      time: '14:30',
      capacity: 2
    });

    // 2. 线索资质评估
    const q = leadSvc.qualifyLead({
      leadId: 'lead_001',
      channel: '抖音',
      project: '双眼皮',
      city: '上海',
      grade: 'A',
      intent: '咨询双眼皮'
    });
    assert.ok(q.ok);
    assert.strictEqual(q.stage, 'qualified');
    assert.strictEqual(lead.getLead('lead_001').reached, 'qualified');

    // 3. 授权留资
    const cap = leadSvc.captureLead({
      leadId: 'lead_001',
      consent: true,
      wechat: 'wx_test'
    });
    assert.ok(cap.ok);
    assert.strictEqual(cap.stage, 'captured');

    // 4. 预约咨询 (使用 schedSvc)
    const b = schedSvc.bookConsultation({
      leadId: 'lead_001',
      clinic: '测试院区',
      date: '2026-09-01',
      time: '14:30'
    });
    assert.ok(b.ok);
    assert.ok(b.appointmentId);
    assert.strictEqual(lead.getLead('lead_001').stage, 'booked');

    // 5. 转人工
    const h = leadSvc.handoffLead({
      leadId: 'lead_001',
      reason: '高意向需面诊设计'
    });
    assert.ok(h.ok);
    assert.ok(h.handedOff);
    assert.strictEqual(lead.getLead('lead_001').stage, 'arrived');
  });

  test('号源防超卖', async () => {
    const sched = require('../dist/repo/schedule-repo');
    const schedSvc = require('../dist/services/schedule-service');

    // 导入仅 1 个容量的号源
    sched.upsertClinic({
      clinicId: 'c2',
      name: '院区2',
      city: '上海',
      active: true
    });
    sched.upsertSlot({
      slotId: 's2',
      clinicId: 'c2',
      date: '2026-09-02',
      time: '10:00',
      capacity: 1
    });

    // 第一次预约成功
    const b1 = schedSvc.bookConsultation({
      leadId: 'lead_002',
      clinic: '院区2',
      date: '2026-09-02',
      time: '10:00'
    });
    assert.ok(b1.ok);

    // 第二次预约应失败
    let rejected = false;
    try {
      schedSvc.bookConsultation({
        leadId: 'lead_003',
        clinic: '院区2',
        date: '2026-09-02',
        time: '10:00'
      });
    } catch (e) {
      rejected = e.code === 'CONFLICT' || e.code === 'NOT_FOUND';
    }
    assert.ok(rejected, '满号源应拒绝预约');
  });

  test('线索阶段不回退', async () => {
    const leadSvc = require('../dist/services/lead-service');
    const lead = require('../dist/repo/lead-repo');
    const sched = require('../dist/repo/schedule-repo');
    const schedSvc = require('../dist/services/schedule-service');

    sched.upsertClinic({
      clinicId: 'c3',
      name: '院区3',
      city: '上海',
      active: true
    });
    sched.upsertSlot({
      slotId: 's3',
      clinicId: 'c3',
      date: '2026-09-03',
      time: '15:00',
      capacity: 5
    });

    // 资质评估
    const q = leadSvc.qualifyLead({
      leadId: 'lead_norewind',
      channel: '微信',
      project: '光子嫩肤',
      city: '上海',
      grade: 'B',
      intent: '咨询护肤'
    });
    assert.ok(q.ok, 'qualifyLead 应成功');

    // 留资
    const cap = leadSvc.captureLead({
      leadId: 'lead_norewind',
      consent: true,
      phone: '13800138000'
    });
    assert.ok(cap.ok, 'captureLead 应成功');

    // 预约 (使用 schedSvc)
    const b = schedSvc.bookConsultation({
      leadId: 'lead_norewind',
      clinic: '院区3',
      date: '2026-09-03',
      time: '15:00'
    });
    assert.ok(b.ok, 'bookConsultation 应成功');

    const stageAfterBook = lead.getLead('lead_norewind').stage;
    assert.strictEqual(
      stageAfterBook,
      'booked',
      `预约后阶段应为 booked, 实际为 ${stageAfterBook}`
    );

    // 尝试回退到 qualified（应被阻止）
    leadSvc.qualifyLead({
      leadId: 'lead_norewind',
      channel: '微信',
      project: '光子嫩肤',
      city: '上海',
      grade: 'A',
      intent: '重新评估'
    });

    // 阶段应保持 booked
    assert.strictEqual(lead.getLead('lead_norewind').stage, 'booked');
  });

  test('看板统计准确性', async () => {
    const leadSvc = require('../dist/services/lead-service');
    const lead = require('../dist/repo/lead-repo');

    // 使用唯一 ID 创建 2 条线索
    leadSvc.qualifyLead({
      leadId: 'stat_unique_001',
      channel: '抖音',
      project: '双眼皮',
      city: '上海',
      grade: 'A',
      intent: '咨询'
    });

    leadSvc.qualifyLead({
      leadId: 'stat_unique_002',
      channel: '小红书',
      project: '隆鼻',
      city: '北京',
      grade: 'B',
      intent: '咨询'
    });

    leadSvc.captureLead({
      leadId: 'stat_unique_001',
      consent: true,
      wechat: 'wx1'
    });

    const stats = lead.computeStats();
    // 统计是全局的,至少包含我们创建的 2 条
    assert.ok(stats.total >= 2, `total 应 >= 2, 实际为 ${stats.total}`);
    assert.ok(stats.funnel.qualified >= 2);
    assert.ok(stats.funnel.captured >= 1);
  });

  test('渠道入站去重', async () => {
    const inbound = require('../dist/repo/inbound-repo');

    const m1 = inbound.saveInbound({
      channel: '抖音',
      externalId: 'ext_dup_001',
      leadKey: 'key1',
      text: '你好'
    });

    const m2 = inbound.saveInbound({
      channel: '抖音',
      externalId: 'ext_dup_001',
      leadKey: 'key1',
      text: '你好'
    });

    // 重复 externalId 应返回同一记录
    assert.strictEqual(m1.id, m2.id);
  });

  test('知识库空库返回空（fail-closed）', async () => {
    const kbSvc = require('../dist/services/kb-service');

    const kb = await kbSvc.searchProjects('双眼皮');
    assert.ok(Array.isArray(kb));
    assert.strictEqual(kb.length, 0);
  });

  test('发件箱入队与扫描', async () => {
    const outbox = require('../dist/repo/outbox-repo');

    outbox.enqueue('lead.upsert', 'lead:test_001:1', { leadId: 'test_001' });

    const due = outbox.dueBatch(10, Date.now());
    assert.strictEqual(due.length, 1);
    assert.strictEqual(due[0].topic, 'lead.upsert');

    const stats = outbox.outboxStats();
    assert.strictEqual(stats.pending, 1);
  });

  test('外部同步回执回填', async () => {
    const sched = require('../dist/repo/schedule-repo');
    const schedSvc = require('../dist/services/schedule-service');

    sched.upsertClinic({
      clinicId: 'c4',
      name: '院区4',
      city: '上海',
      active: true
    });
    sched.upsertSlot({
      slotId: 's4',
      clinicId: 'c4',
      date: '2026-09-04',
      time: '16:00',
      capacity: 3
    });

    const b = schedSvc.bookConsultation({
      leadId: 'lead_005',
      clinic: '院区4',
      date: '2026-09-04',
      time: '16:00'
    });

    const apptId = b.appointmentId;

    // 模拟 HIS 系统回调
    sched.setAppointmentExternal(apptId, 'HIS20260904A', 'confirmed');

    // 反查
    const byExt = sched.getAppointmentByExternalId('HIS20260904A');
    assert.ok(byExt);
    assert.strictEqual(byExt.appointmentId, apptId);
    assert.strictEqual(byExt.externalStatus, 'confirmed');

    const direct = sched.getAppointment(apptId);
    assert.strictEqual(direct.externalId, 'HIS20260904A');
    assert.strictEqual(direct.externalStatus, 'confirmed');
  });
});
