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
 *
 * 注：repo/service 层已全面异步化（DB 适配器在 Turso HTTP 模式下返回 Promise），
 * 因此所有 DB 读写调用都必须 await。
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
  // 隔离：确保不继承外部 MA_RAG_BASE_URL，否则「空库返回空」用例会误走 RAG 路径
  delete process.env.MA_RAG_BASE_URL;
  delete process.env.MA_RAG_TOKEN;
  // 关键：config 是模块级单例缓存，若不失效，第二个用例起仍会复用第一个用例的 DB 路径，
  // 而 afterEach 删除的是「当前」DATA_DIR，导致 DB 实际文件未被清理、跨用例数据串扰（flaky 根因）。
  // 这里先关闭上一连接、再失效配置缓存，确保每个用例解析到自己的临时库。
  try {
    require('../dist/infra/db').closeDb();
  } catch {}
  try {
    require('../dist/config').resetConfig();
  } catch {}
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
    await sched.upsertClinic({
      clinicId: 'c1',
      name: '测试院区',
      city: '上海',
      active: true
    });
    await sched.upsertSlot({
      slotId: 's1',
      clinicId: 'c1',
      date: '2026-09-01',
      time: '14:30',
      capacity: 2
    });

    // 2. 线索资质评估
    const q = await leadSvc.qualifyLead({
      leadId: 'lead_001',
      channel: '抖音',
      project: '双眼皮',
      city: '上海',
      grade: 'A',
      intent: '咨询双眼皮'
    });
    assert.ok(q.ok);
    assert.strictEqual(q.stage, 'qualified');
    assert.strictEqual((await lead.getLead('lead_001')).reached, 'qualified');

    // 3. 授权留资
    const cap = await leadSvc.captureLead({
      leadId: 'lead_001',
      consent: true,
      wechat: 'wx_test'
    });
    assert.ok(cap.ok);
    assert.strictEqual(cap.stage, 'captured');

    // 4. 预约咨询 (使用 schedSvc)
    const b = await schedSvc.bookConsultation({
      leadId: 'lead_001',
      clinic: '测试院区',
      date: '2026-09-01',
      time: '14:30'
    });
    assert.ok(b.ok);
    assert.ok(b.appointmentId);
    assert.strictEqual((await lead.getLead('lead_001')).stage, 'booked');

    // 5. 转人工
    const h = await leadSvc.handoffLead({
      leadId: 'lead_001',
      reason: '高意向需面诊设计'
    });
    assert.ok(h.ok);
    assert.ok(h.handedOff);
    assert.strictEqual((await lead.getLead('lead_001')).stage, 'arrived');
  });

  test('号源防超卖', async () => {
    const sched = require('../dist/repo/schedule-repo');
    const schedSvc = require('../dist/services/schedule-service');

    // 导入仅 1 个容量的号源
    await sched.upsertClinic({
      clinicId: 'c2',
      name: '院区2',
      city: '上海',
      active: true
    });
    await sched.upsertSlot({
      slotId: 's2',
      clinicId: 'c2',
      date: '2026-09-02',
      time: '10:00',
      capacity: 1
    });

    // 第一次预约成功
    const b1 = await schedSvc.bookConsultation({
      leadId: 'lead_002',
      clinic: '院区2',
      date: '2026-09-02',
      time: '10:00'
    });
    assert.ok(b1.ok);

    // 第二次预约应失败
    let rejected = false;
    try {
      await schedSvc.bookConsultation({
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

    await sched.upsertClinic({
      clinicId: 'c3',
      name: '院区3',
      city: '上海',
      active: true
    });
    await sched.upsertSlot({
      slotId: 's3',
      clinicId: 'c3',
      date: '2026-09-03',
      time: '15:00',
      capacity: 5
    });

    // 资质评估
    const q = await leadSvc.qualifyLead({
      leadId: 'lead_norewind',
      channel: '微信',
      project: '光子嫩肤',
      city: '上海',
      grade: 'B',
      intent: '咨询护肤'
    });
    assert.ok(q.ok, 'qualifyLead 应成功');

    // 留资
    const cap = await leadSvc.captureLead({
      leadId: 'lead_norewind',
      consent: true,
      phone: '13800138000'
    });
    assert.ok(cap.ok, 'captureLead 应成功');

    // 预约 (使用 schedSvc)
    const b = await schedSvc.bookConsultation({
      leadId: 'lead_norewind',
      clinic: '院区3',
      date: '2026-09-03',
      time: '15:00'
    });
    assert.ok(b.ok, 'bookConsultation 应成功');

    const stageAfterBook = (await lead.getLead('lead_norewind')).stage;
    assert.strictEqual(
      stageAfterBook,
      'booked',
      `预约后阶段应为 booked, 实际为 ${stageAfterBook}`
    );

    // 尝试回退到 qualified（应被阻止）
    await leadSvc.qualifyLead({
      leadId: 'lead_norewind',
      channel: '微信',
      project: '光子嫩肤',
      city: '上海',
      grade: 'A',
      intent: '重新评估'
    });

    // 阶段应保持 booked
    assert.strictEqual((await lead.getLead('lead_norewind')).stage, 'booked');
  });

  test('看板统计准确性', async () => {
    const leadSvc = require('../dist/services/lead-service');
    const lead = require('../dist/repo/lead-repo');

    // 使用唯一 ID 创建 2 条线索
    await leadSvc.qualifyLead({
      leadId: 'stat_unique_001',
      channel: '抖音',
      project: '双眼皮',
      city: '上海',
      grade: 'A',
      intent: '咨询'
    });

    await leadSvc.qualifyLead({
      leadId: 'stat_unique_002',
      channel: '小红书',
      project: '隆鼻',
      city: '北京',
      grade: 'B',
      intent: '咨询'
    });

    await leadSvc.captureLead({
      leadId: 'stat_unique_001',
      consent: true,
      wechat: 'wx1'
    });

    const stats = await lead.computeStats();
    // 统计是全局的,至少包含我们创建的 2 条
    assert.ok(stats.total >= 2, `total 应 >= 2, 实际为 ${stats.total}`);
    assert.ok(stats.funnel.qualified >= 2);
    assert.ok(stats.funnel.captured >= 1);
  });

  test('渠道入站去重', async () => {
    const inbound = require('../dist/repo/inbound-repo');

    const m1 = await inbound.saveInbound({
      channel: '抖音',
      externalId: 'ext_dup_001',
      leadKey: 'key1',
      text: '你好'
    });

    const m2 = await inbound.saveInbound({
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

    await outbox.enqueue('lead.upsert', 'lead:test_001:1', { leadId: 'test_001' });

    const due = await outbox.dueBatch(10, Date.now());
    assert.strictEqual(due.length, 1);
    assert.strictEqual(due[0].topic, 'lead.upsert');

    const stats = await outbox.outboxStats();
    assert.strictEqual(stats.pending, 1);
  });

  test('外部同步回执回填', async () => {
    const sched = require('../dist/repo/schedule-repo');
    const schedSvc = require('../dist/services/schedule-service');

    await sched.upsertClinic({
      clinicId: 'c4',
      name: '院区4',
      city: '上海',
      active: true
    });
    await sched.upsertSlot({
      slotId: 's4',
      clinicId: 'c4',
      date: '2026-09-04',
      time: '16:00',
      capacity: 3
    });

    const b = await schedSvc.bookConsultation({
      leadId: 'lead_005',
      clinic: '院区4',
      date: '2026-09-04',
      time: '16:00'
    });

    const apptId = b.appointmentId;

    // 模拟 HIS 系统回调
    await sched.setAppointmentExternal(apptId, 'HIS20260904A', 'confirmed');

    // 反查
    const byExt = await sched.getAppointmentByExternalId('HIS20260904A');
    assert.ok(byExt);
    assert.strictEqual(byExt.appointmentId, apptId);
    assert.strictEqual(byExt.externalStatus, 'confirmed');

    const direct = await sched.getAppointment(apptId);
    assert.strictEqual(direct.externalId, 'HIS20260904A');
    assert.strictEqual(direct.externalStatus, 'confirmed');
  });

  test('多Agent编排工作流：项目咨询 → 价格评估 → 预约', async () => {
    const { DagEngine, getAgentRegistry } = require('@agent-harness/core');
    const sched = require('../dist/repo/schedule-repo');
    const schedSvc = require('../dist/services/schedule-service');
    const leadSvc = require('../dist/services/lead-service');
    const lead = require('../dist/repo/lead-repo');

    // 1. 导入号源
    await sched.upsertClinic({
      clinicId: 'wf_c1',
      name: '工作流测试院区',
      city: '苏州',
      active: true
    });
    await sched.upsertSlot({
      slotId: 'wf_s1',
      clinicId: 'wf_c1',
      date: '2026-09-20',
      time: '14:30',
      capacity: 2
    });

    // 2. 预先创建客资（确保预约步骤能成功）
    await leadSvc.qualifyLead({
      leadId: 'lead_workflow_001',
      channel: '抖音',
      project: '双眼皮',
      city: '苏州',
      grade: 'A',
      intent: '咨询双眼皮'
    });
    await leadSvc.captureLead({
      leadId: 'lead_workflow_001',
      consent: true,
      wechat: 'wx_workflow_test'
    });

    // 3. 创建 workflow executor（mock LLM，不调用真实 API）
    // 直接传递 AgentCard（而非字符串 agentRef），避免 registry 解析
    const executor = async (step, input, ctx) => {
      // step.agentRef 可以是字符串或 AgentCard；这里使用字符串执行逻辑
      const agentId = typeof step.agentRef === 'string' ? step.agentRef : step.agentRef.id;
      switch (agentId) {
        case 'project-advisor':
          return Promise.resolve(`项目咨询结果: 客户咨询 "${input}" → 双眼皮项目适合，恢复期约7天，价格区间3800-8800元`);
        case 'pricing-agent':
          return Promise.resolve(`价格评估结果: 双眼皮手术价格区间为3800-8800元起，具体费用因个体差异而异`);
        case 'booking-agent':
          const booking = await schedSvc.bookConsultation({
            leadId: 'lead_workflow_001',
            clinic: '工作流测试院区',
            date: '2026-09-20',
            time: '14:30'
          });
          return Promise.resolve(JSON.stringify({ ok: true, ...booking, clinic: '工作流测试院区', date: '2026-09-20', time: '14:30' }));
        default:
          return Promise.resolve(`未知Agent: ${agentId}`);
      }
    };

    // 4. 运行工作流（直接使用 AgentCard 对象，避免 registry 解析）
    const engine = new DagEngine({ executor });
    const run = await engine.run({
      id: 'consultation-booking-test',
      steps: [
        { id: 'analyze-project', agentRef: { id: 'project-advisor', name: '项目咨询', domain: 'medical-aesthetics', capabilities: [], transport: 'local', version: '1.0.0', health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 } }, inputMapping: { requirement: 'input' } },
        { id: 'price-eval', agentRef: { id: 'pricing-agent', name: '价格评估', domain: 'medical-aesthetics', capabilities: [], transport: 'local', version: '1.0.0', health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 } }, dependsOn: ['analyze-project'], inputMapping: { projectResult: 'steps.analyze-project.output' } },
        { id: 'book-consultation', agentRef: { id: 'booking-agent', name: '预约管理', domain: 'medical-aesthetics', capabilities: [], transport: 'local', version: '1.0.0', health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 } }, dependsOn: ['analyze-project', 'price-eval'], inputMapping: { projectResult: 'steps.analyze-project.output', priceResult: 'steps.price-eval.output' } },
      ]
    }, '客户问：我想做双眼皮，大概多少钱？苏州有号吗？', { tenantId: 'test' });

    // 5. 验证工作流执行结果
    assert.strictEqual(run.state, 'done', `工作流状态应为 done，实际为 ${run.state}, 错误: ${run.error}`);
    assert.ok(run.steps['analyze-project'].output.includes('双眼皮'), '项目咨询应返回双眼皮相关结果');
    assert.ok(run.steps['price-eval'].output.includes('3800-8800'), '价格评估应返回价格区间');
    const bookingOutput = JSON.parse(run.steps['book-consultation'].output);
    assert.ok(bookingOutput.ok, '预约应成功');

    // 6. 验证客资状态已更新为 booked
    const leadRecord = await lead.getLead('lead_workflow_001');
    assert.ok(leadRecord, '客资应被录入');
    assert.ok(leadRecord.project?.includes('双眼皮'), '项目应为双眼皮');
    assert.strictEqual(leadRecord.stage, 'booked', `客资阶段应为 booked，实际为 ${leadRecord.stage}`);
  });
});
