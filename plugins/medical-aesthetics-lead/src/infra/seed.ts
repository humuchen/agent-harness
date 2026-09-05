/**
 * 医美客资插件 —— 启动时演示数据种子（seed-on-startup）。
 *
 * 在 `onStart` 时机调用：仅当 `MA_SEED_ON_STARTUP=1` 且数据表为空时执行。
 * 生成真实业务场景的模拟数据，支撑看板 / 统计 / 预约打卡 / webhook 流转等端到端验证。
 *
 * 数据分布（与 scripts/seed.cjs 保持一致）：
 * - 200 条线索：6% deal / 10% arrived / 22% booked / 43% captured / 63% qualified / 88% contacted / 8% lost / 12% new
 * - 7 个院区（北京 / 上海 / 广州 / 深圳 / 杭州 / 南京 / 武汉）
 * - 4 个项目（玻尿酸 / 肉毒 / 激光祛斑 / 减肥针）
 * - 14 天号源 × 7 院区
 *
 * 该模块仅为开发 / 验证环境服务，生产环境请勿开启。
 */

import { getConfig } from '../config';
import { getDb } from './db';

// ─── 业务字典 ────────────────────────────────────────────────────────────────

const CHANNELS = ['wechat', 'douyin', 'xiaohongshu', 'meituan', 'toutiao', 'baidu', 'kuaishou', 'xiaomi'];

const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '南京', '武汉', '成都', '重庆', '青岛', '厦门', '福州'];

const INTENT_TAGS = [
  '面部年轻化', '祛斑', '祛黑眼圈', '抗衰老', '美白', '减肥瘦身',
  '除皱', '脸型整形', '鼻部整形', '眼部整形', '唇部整形', '胸部塑形',
  '腹腹针', '薄嘴唇', '法令纹', '眼袋', '水光针', '玻尿酸',
  '肉毒注射', '激光去皱', 'RF 紧致', '冷吔噜', '耻骨架', '大腿抽筋',
  '微胆小', '眉毛内陷', '下颚线', '脖子松弛', '手臂松弛', '大腿线',
];

const PROJECTS = [
  { id: 'proj_1', name: '玻尿酸填充', category: '注射', summary: '适用于唇部丰满、鼻部微调、眼神折叠等面部轮廓优化。', priceTier: '入门', avgPrice: 1280, durationMin: 30, painLevel: 2, downtimeDays: '0-1 天', indications: '唇薄、鼻梁不挺、面部对称不佳', contraindications: '对玻尿酸过敏、感染性皮肤病', recovery: '轻微肿胀消肿 24-48 小时', faq: [{q:'疼吗？',a:'微针刺一般感觉轻微，持续数秒'}] },
  { id: 'proj_2', name: '肉毒注射除皱', category: '注射', summary: '通过肉毒毒素松缓面部肌肉，减少法令纹、眉峰纹等动态性皱纹。', priceTier: '中端', avgPrice: 2880, durationMin: 20, painLevel: 1, downtimeDays: '0 天', indications: '法令纹、眉峰纹、口周皱纹', contraindications: '肌阵挛性疾病、妊娠期', recovery: '术后立即可恢复正常活动', faq: [{q:'多久见效？',a:'3 天左右肌肉逐渐松弛，2 周见效'}] },
  { id: 'proj_3', name: '激光祛斑', category: '光电', summary: '运用多波段激束激光吸收色素，祛除面色斑点、均匀肤色。', priceTier: '中端', avgPrice: 3200, durationMin: 30, painLevel: 3, downtimeDays: '3-5 天', indications: '色斑、黄褐斑、雀斑', contraindications: '皮肤感染、光敏性皮肤病', recovery: '愈伤期间注意防晒，避免直接暴霣阳光', faq: [{q:'治疗前需准备？',a:'治疗前 2 个月停止食用维生素 C 并避光'}] },
  { id: 'proj_4', name: '非处方激素减肥', category: '其他', summary: '...', priceTier: '奢享', avgPrice: 15800, durationMin: 20, painLevel: 1, downtimeDays: '0 天', indications: '局部难瘦', contraindications: '心脏病、高血压', recovery: '注射后 4-6 小时开始燃脂', faq: [] },
];

const INTENT_MAP = [
  { intent: '面部年轻化', projectId: 'proj_1', weight: 3, keywords: ['唇薄', '唇嘴沟', '面部对称'] },
  { intent: '面部年轻化', projectId: 'proj_2', weight: 3, keywords: ['法令纹', '眉峰纹', '口周皱纹', '除皱拉伸'] },
  { intent: '祛斑', projectId: 'proj_3', weight: 5, keywords: ['色斑', '黄褐斑', '面斑', '雀斑', '肤色不均'] },
  { intent: '减肥瘦身', projectId: 'proj_4', weight: 4, keywords: ['傅额外脖', '大腿粗', '肚子不平', '局部难瘦'] },
];

const CLINICS = [
  { id: 'clinic_1', name: '雅思美容整形诊所', city: '北京', address: '朝阳区建外大街 88 号', phone: '010-8888-1234' },
  { id: 'clinic_2', name: '丽华美肤门诊', city: '上海', address: '徐汇区漕溪路 101 号', phone: '021-6666-7890' },
  { id: 'clinic_3', name: '芙兰卡丽雅整形医院', city: '广州', address: '天河区珠江新城 22 号', phone: '020-5555-3344' },
  { id: 'clinic_4', name: '美联达整形美容中心', city: '深圳', address: '南山区科技园 5 号', phone: '0755-7777-8888' },
  { id: 'clinic_5', name: '华生美学诊所', city: '杭州', address: '西湖区文三西路 99 号', phone: '0571-4444-5555' },
  { id: 'clinic_6', name: '新中大医美门诊', city: '南京', address: '玫溪区玫阁路 18 号', phone: '025-3333-2211' },
  { id: 'clinic_7', name: '恒生美学中心', city: '武汉', address: '武昌区狮子山 1 号', phone: '027-9999-0000' },
];

const DOCTORS = ['欧阳医生', '李主任', '王医师', '赵主任', '孙医生', '周医师'];
const CONSULTANTS = ['小米', '小李', '小王', '小赵', '小陈', '小周'];

const SURNAMES = '王李张赵孙周吴郑冯陈'.split('');
const GIRL_NAMES = ['娜', '敏', '静', '丽', '艳', '芳', '燕', '红', '霞', '婷', '琳'];
const BOY_NAMES = ['伟', '强', '磊', '斌', '辉', '浩', '鹏', '军', '霖', '宇', '轩'];
const CLINIC_NAMES: Record<string, string> = {
  clinic_1: '雅思美容整形诊所', clinic_2: '丽华美肤门诊', clinic_3: '芙兰卡丽雅整形医院',
  clinic_4: '美联达整形美容中心', clinic_5: '华生美学诊所', clinic_6: '新中大医美门诊', clinic_7: '恒生美学中心',
};

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

const now = Date.now();

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  if (arr.length === 0) throw new Error('pick() received empty array');
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function genPhone(): string {
  const prefix = pick(['138', '139', '155', '156', '176', '186', '191']);
  return prefix + String(rand(10000000, 99999999));
}

function genName(): string {
  const surname = pick(SURNAMES);
  const isGirl = Math.random() > 0.5;
  const name = isGirl ? pick(GIRL_NAMES) : pick(BOY_NAMES);
  return surname + name;
}

function genLeadId(i: number): string {
  return `lead_${now}_${i}`;
}

function genApptId(): string {
  return `appt_${now}_${Math.random().toString(36).slice(2, 10)}`;
}

function genClinicId(n: number): string {
  return `clinic_${n}`;
}

// ─── 检查是否需要种子 ────────────────────────────────────────────────────────

/**
 * 检查数据库是否需要种子数据：仅当所有业务表都为空时返回 true。
 * 避免重复执行导致数据污染。
 */
export async function shouldSeed(): Promise<boolean> {
  // 环境开关
  if (process.env.MA_SEED_ON_STARTUP !== '1') {
    return false;
  }

  const db = await getDb();
  const rows = await db.prepare('SELECT COUNT(*) AS c FROM ma_lead').get();
  const count = Number(rows?.c ?? 0);
  return count === 0;
}

// ─── 种子逻辑 ────────────────────────────────────────────────────────────────

/**
 * 向空数据库中写入演示数据。
 * 使用插件已有的 getDb() 连接，支持 sqlite / turso 双后端。
 */
export async function seedDemoData(tenantId: string): Promise<{ total: number; [key: string]: number }> {
  const db = await getDb();
  const counts = {
    clinics: 0, projects: 0, intents: 0, slots: 0,
    leads: 0, messages: 0, stageLogs: 0,
    appointments: 0, inbound: 0, outbox: 0,
  };

  // 1. 种子院区
  const clinicStmt = db.prepare(
    `INSERT OR REPLACE INTO ma_clinic (clinic_id, tenant_id, name, city, address, phone, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  );
  for (const c of CLINICS) {
    await clinicStmt.run(c.id, tenantId, c.name, c.city, c.address, c.phone, now);
    counts.clinics++;
  }

  // 2. 种子项目
  const projStmt = db.prepare(
    `INSERT OR REPLACE INTO ma_project (
      project_id, tenant_id, name, category, aliases, summary, indications,
      contraindications, recovery, price_range, faq, source, active, updated_at,
      intent_tags, combo_with, audience, seasonality, duration_min, pain_level,
      downtime_days, course_sessions, avg_price_tier, compliant_copy, compliance_reviewed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const p of PROJECTS) {
    await projStmt.run(
      p.id, tenantId, p.name, p.category,
      JSON.stringify([p.name, ...p.faq.map(f => f.q)]),
      p.summary, p.indications, p.contraindications, p.recovery,
      `¥${p.avgPrice}`, JSON.stringify(p.faq), 'seed', now,
      JSON.stringify([p.name]), '', '', '',
      p.durationMin, p.painLevel, p.downtimeDays,
      p.category === '注射' ? '1-3 次' : '1 次',
      p.priceTier, `适用于${p.indications}`
    );
    counts.projects++;
  }

  // 3. 种子意图映射
  const intentStmt = db.prepare(
    `INSERT OR REPLACE INTO ma_project_intent (intent, project_id, tenant_id, weight, keywords)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const im of INTENT_MAP) {
    await intentStmt.run(im.intent, im.projectId, tenantId, im.weight, JSON.stringify(im.keywords));
    counts.intents++;
  }

  // 4. 种子号源（7 院区 × 14 天 × 每天 5 个时段）
  const slotStmt = db.prepare(
    `INSERT OR REPLACE INTO ma_slot (
      slot_id, tenant_id, clinic_id, slot_date, slot_time, capacity, booked, status, doctor, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 0, 'open', ?, ?)`
  );
  const slotTimes = ['09:30', '10:30', '14:00', '15:00', '16:00'];
  let slotCount = 0;
  for (const clinic of CLINICS) {
    for (let d = 0; d < 14; d++) {
      const date = new Date(now + (d + 1) * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().slice(0, 10);
      const doctor = pick(DOCTORS);
      for (const time of slotTimes) {
        const slotId = `${clinic.id}_${dateStr}_${time}`;
        await slotStmt.run(slotId, tenantId, clinic.id, dateStr, time, now, now);
        slotCount++;
      }
    }
  }
  counts.slots = slotCount;

  // 5. 种子线索（200 条）
  const STAGE_ORDER = ['new', 'contacted', 'qualified', 'captured', 'booked', 'arrived', 'deal'];
  const leadStmt = db.prepare(
    `INSERT INTO ma_lead (
      lead_id, tenant_id, channel, intent, project, budget, city, grade, stage, reached,
      stage_updated_at, name, phone, wechat, consent_at, clinic_id, clinic_name,
      booking_date, booking_time, appointment_id, handed_off, handoff_reason,
      consulted_by, crm_id, crm_sync_state, crm_synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const msgStmt = db.prepare(
    `INSERT INTO ma_lead_message (lead_id, run_id, role, text, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );

  const stageLogStmt = db.prepare(
    `INSERT INTO ma_lead_stage_log (lead_id, tenant_id, from_stage, to_stage, changed_at, operated_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const apptStmt = db.prepare(
    `INSERT INTO ma_appointment (
      appointment_id, tenant_id, lead_id, clinic_id, slot_id, slot_date, slot_time,
      status, external_id, external_status, arrived_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const outboxStmt = db.prepare(
    `INSERT INTO ma_outbox (tenant_id, topic, idempotency_key, payload, state, attempts, last_error, next_retry_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const inboundStmt = db.prepare(
    `INSERT INTO ma_inbound_message (tenant_id, channel, external_id, lead_key, text, state, run_id, error, received_at, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const budgets = ['1000-3000', '3000-8000', '8000-15000', '15000+'];

  for (let i = 1; i <= 200; i++) {
    const leadId = genLeadId(i);
    const createdAt = now - Math.random() * 30 * 24 * 60 * 60 * 1000;

    const roll = Math.random();
    let stage: string, reached: string;
    if (roll < 0.06) { stage = 'deal'; reached = 'deal'; }
    else if (roll < 0.16) { stage = 'arrived'; reached = 'arrived'; }
    else if (roll < 0.28) { stage = 'booked'; reached = 'booked'; }
    else if (roll < 0.43) { stage = 'captured'; reached = 'captured'; }
    else if (roll < 0.63) { stage = 'qualified'; reached = 'qualified'; }
    else if (roll < 0.88) { stage = 'contacted'; reached = 'contacted'; }
    else { stage = 'new'; reached = 'new'; }
    // lost 的概率是 2% (roll >= 0.06 时才可能丢失，非 deal 阶段才覆盖)
    if (roll >= 0.06 && roll < 0.08) { stage = 'lost'; reached = 'lost'; }

    const project = pick(PROJECTS);
    const channel = pick(CHANNELS);
    const city = pick(CITIES);

    const gradeRoll = Math.random();
    let grade: string;
    if (gradeRoll < 0.15) grade = 'A';
    else if (gradeRoll < 0.45) grade = 'B';
    else if (gradeRoll < 0.80) grade = 'C';
    else grade = 'D';

    const budget = pick(budgets);
    const hasAppt = stage === 'booked' || stage === 'arrived' || stage === 'deal';
    const appointmentId = hasAppt ? genApptId() : null;

    const assignClinic = Math.random() > 0.08;
    let clinicId = assignClinic ? genClinicId(rand(1, 7)) : null;

    let bookingDate: string | null = null;
    let bookingTime: string | null = null;
    let slotId: string | null = null;

    if (['booked', 'arrived', 'deal'].includes(stage)) {
      const clinicIdx = rand(1, 7);
      clinicId = genClinicId(clinicIdx);
      const apptDate = new Date(now + rand(3, 10) * 24 * 60 * 60 * 1000);
      bookingDate = apptDate.toISOString().slice(0, 10);
      bookingTime = pick(['09:30', '10:30', '14:00', '15:00', '16:00']);
      slotId = `${clinicId}_${bookingDate}_${bookingTime}`;

      let apptStatus = 'booked';
      let arrivedAt: number | null = null;
      let completedAt: number | null = null;

      if (stage === 'arrived' || stage === 'deal') {
        apptStatus = 'arrived';
        arrivedAt = Math.floor(createdAt + rand(1, 10) * 24 * 60 * 60 * 1000);
      }
      if (stage === 'deal') {
        apptStatus = 'completed';
        completedAt = Math.floor((arrivedAt ?? 0) + rand(1, 3) * 24 * 60 * 60 * 1000);
      }

      const extId = `his_${Math.random().toString(36).slice(2, 10)}`;
      const extStatus = apptStatus === 'completed' ? 'done' : (apptStatus === 'arrived' ? 'arrived' : 'confirmed');

      await apptStmt.run(
        appointmentId, tenantId, leadId, clinicId, slotId, bookingDate, bookingTime,
        apptStatus, extId, extStatus, arrivedAt, completedAt, createdAt, now
      );
      counts.appointments++;
    }

    // CRM outbox
    if (appointmentId && ['booked', 'arrived', 'deal'].includes(stage)) {
      const topic = 'lead.upsert';
      const idem = `${leadId}_${topic}_${createdAt}`;
      const crmId = `crm_${Math.random().toString(36).slice(2, 10)}`;
      await outboxStmt.run(
        tenantId, topic, idem,
        JSON.stringify({ leadId, stage, appointmentId, crmId }),
        'pending', 0, null, Math.floor(now / 1000) + rand(0, 300),
        Math.floor(createdAt / 1000), Math.floor(now / 1000)
      );
      counts.outbox++;
    }

    // 阶段流水
    let fromStage = 'new';
    if (stage === 'lost') {
      const fromIdx = rand(0, 5);
      fromStage = STAGE_ORDER[fromIdx]!;

      await stageLogStmt.run(leadId, tenantId, fromStage, 'lost', Math.floor(createdAt / 1000) + rand(0, 7) * 86400, null);
      counts.stageLogs++;
    } else {
      const stagesToLog = STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage) + 1);
      for (const to of stagesToLog) {
        if (to === 'new') continue;
        const changedAt = Math.floor(createdAt / 1000 + rand(0, 30) * 86400);
        await stageLogStmt.run(leadId, tenantId, fromStage, to, changedAt, 'system');
        counts.stageLogs++;
        fromStage = to;
      }
    }

    // 对话消息
    if (stage !== 'new') {
      const runId = `run_${Math.random().toString(36).slice(2, 12)}`;
      const msgCount = rand(2, 8);
      for (let m = 0; m < msgCount; m++) {
        const isUser = m % 2 === 0;
        const msgTime = Math.floor(createdAt / 1000) + m * 600;
        const text = isUser
          ? pick([`你好，想了解${project.name}的效果如何？`, '这个项目需要多久恢复？', '有没有团购优惠？', '医生是谁？有经验吗？'])
          : pick(['欢迎咨询，我们有资深医师团队。', '祝贺您预约成功，医生将为您量身定制方案。', '治疗后请注意及时恢复，避免阳光暴晒。', '感谢您的到店，祝您恢复顺利。']);
        await msgStmt.run(leadId, runId, isUser ? 'user' : 'assistant', text, msgTime);
        counts.messages++;
      }
    }

    // 入站消息（30% 概率）
    if (Math.random() < 0.3) {
      const ch = pick(CHANNELS);
      const extId = `msg_${Math.random().toString(36).slice(2, 10)}`;
      await inboundStmt.run(
        tenantId, ch, extId, leadId,
        `你好，我想了解 ${project.name}，预算 ${budget}`,
        'processed', `run_${Math.random().toString(36).slice(2, 12)}`, null,
        Math.floor(createdAt / 1000), Math.floor(createdAt / 1000) + rand(10, 300)
      );
      counts.inbound++;
    }

    // 写入 ma_lead
    const crmSyncRoll = Math.random();
    let crmSyncState = 'pending';
    let crmId: string | null = null;
    let crmSyncedAt: number | null = null;
    if (crmSyncRoll < 0.7) {
      crmSyncState = 'synced';
      crmId = `crm_${Math.random().toString(36).slice(2, 10)}`;
      crmSyncedAt = Math.floor(createdAt + rand(1, 5) * 3600 * 1000);
    } else if (crmSyncRoll < 0.85) {
      crmSyncState = 'pending';
    } else {
      crmSyncState = 'failed';
    }

    const handedOff = (grade === 'C' || grade === 'D') ? Math.random() < 0.6 : Math.random() < 0.15;
    const consultedBy = (handedOff && Math.random() < 0.7) ? pick(CONSULTANTS) : null;

    await leadStmt.run(
      leadId, tenantId, channel, pick(INTENT_TAGS), project.id, budget, city, grade, stage, reached,
      Math.floor(createdAt + rand(0, 7) * 24 * 60 * 60 * 1000), genName(), genPhone(),
      `wx_${Math.random().toString(36).slice(2, 12)}`, Math.floor(createdAt + rand(0, 3) * 3600 * 1000),
      clinicId, clinicId ? CLINIC_NAMES[clinicId] : null,
      bookingDate, bookingTime, appointmentId, handedOff ? 1 : 0,
      handedOff ? (grade === 'C' || grade === 'D' ? 'C级潜量 / 主动咨询' : '客户要求人工') : null,
      consultedBy, crmId, crmSyncState, crmSyncedAt,
      createdAt, createdAt + rand(1, 30) * 24 * 60 * 60 * 1000
    );
    counts.leads++;
  }

  const total = Object.values(counts).reduce((sum, v) => sum + v, 0);
  return { total, ...counts };
}
