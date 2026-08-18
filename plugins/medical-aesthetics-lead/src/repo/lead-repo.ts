/**
 * 线索仓储（真实参数化 SQL）。
 *
 * 取代原 store.ts 的「JSON 文件 + 扫目录聚合」：
 * - upsert 用 SQLite UPSERT（ON CONFLICT DO UPDATE），并在应用层单调推进 reached；
 * - 漏斗/渠道/等级分布用 SQL 聚合（GROUP BY），O(1) 往返而非遍历文件；
 * - 全部按 tenant_id 过滤，天然多租户隔离。
 */

import { getDb, dbCall, type SqliteDatabase } from '../infra/db';
import { getConfig } from '../config';
import {
  type LeadRecord,
  type LeadPatch,
  type LeadStage,
  type LeadGrade,
  type LeadStats,
  type CrmSyncState,
  STAGE_ORDER,
  stageRank,
} from './types';

/** DB 行 → 领域模型。 */
function rowToLead(r: Record<string, unknown>): LeadRecord {
  return {
    leadId: String(r.lead_id),
    tenantId: String(r.tenant_id),
    channel: String(r.channel),
    intent: (r.intent as string) ?? undefined,
    project: (r.project as string) ?? undefined,
    budget: (r.budget as string) ?? undefined,
    city: (r.city as string) ?? undefined,
    grade: (r.grade as LeadGrade) ?? undefined,
    stage: r.stage as LeadStage,
    reached: r.reached as LeadStage,
    name: (r.name as string) ?? undefined,
    phone: (r.phone as string) ?? undefined,
    wechat: (r.wechat as string) ?? undefined,
    consentAt: r.consent_at != null ? Number(r.consent_at) : undefined,
    clinicId: (r.clinic_id as string) ?? undefined,
    clinicName: (r.clinic_name as string) ?? undefined,
    bookingDate: (r.booking_date as string) ?? undefined,
    bookingTime: (r.booking_time as string) ?? undefined,
    appointmentId: (r.appointment_id as string) ?? undefined,
    handedOff: Number(r.handed_off) === 1,
    handoffReason: (r.handoff_reason as string) ?? undefined,
    consultedBy: (r.consulted_by as string) ?? undefined,
    crmId: (r.crm_id as string) ?? undefined,
    crmSyncState: (r.crm_sync_state as CrmSyncState) ?? 'pending',
    crmSyncedAt: r.crm_synced_at != null ? Number(r.crm_synced_at) : undefined,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** 读取单条线索（含最近消息）。 */
export function getLead(leadId: string, withMessages = false): LeadRecord | null {
  return dbCall(() => {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM ma_lead WHERE tenant_id = ? AND lead_id = ?')
      .get(getConfig().tenantId, leadId);
    if (!row) return null;
    const lead = rowToLead(row);
    if (withMessages) lead.messages = getMessages(leadId);
    return lead;
  }, '读取线索');
}

export function leadExists(leadId: string): boolean {
  return getLead(leadId) !== null;
}

/**
 * upsert 线索：不存在则插入，存在则按 patch 更新非空字段。
 * reached 在应用层单调推进（除 lost 外取 max(reached, stage)）。
 */
export function upsertLead(leadId: string, patch: LeadPatch): LeadRecord {
  return dbCall(() => {
    const db = getDb();
    const now = Date.now();
    const cfg = getConfig();
    const existing = db
      .prepare('SELECT * FROM ma_lead WHERE tenant_id = ? AND lead_id = ?')
      .get(cfg.tenantId, leadId);

    // 合并当前值与 patch，计算最终 stage/reached
    const cur = existing ? rowToLead(existing) : null;
    const stage: LeadStage = (patch.stage ?? cur?.stage ?? 'new') as LeadStage;
    let reached: LeadStage = cur?.reached ?? stage;
    if (stage !== 'lost') {
      reached = STAGE_ORDER[Math.max(stageRank(reached), stageRank(stage))];
    } else if (!cur) {
      reached = 'lost' as LeadStage;
    }

    const merged = {
      channel: patch.channel ?? cur?.channel ?? 'unknown',
      intent: patch.intent ?? cur?.intent ?? null,
      project: patch.project ?? cur?.project ?? null,
      budget: patch.budget ?? cur?.budget ?? null,
      city: patch.city ?? cur?.city ?? null,
      grade: patch.grade ?? cur?.grade ?? null,
      stage,
      reached,
      name: patch.name ?? cur?.name ?? null,
      phone: patch.phone ?? cur?.phone ?? null,
      wechat: patch.wechat ?? cur?.wechat ?? null,
      consent_at: patch.consentAt ?? cur?.consentAt ?? null,
      clinic_id: patch.clinicId ?? cur?.clinicId ?? null,
      clinic_name: patch.clinicName ?? cur?.clinicName ?? null,
      booking_date: patch.bookingDate ?? cur?.bookingDate ?? null,
      booking_time: patch.bookingTime ?? cur?.bookingTime ?? null,
      appointment_id: patch.appointmentId ?? cur?.appointmentId ?? null,
      handed_off: (patch.handedOff ?? cur?.handedOff ?? false) ? 1 : 0,
      handoff_reason: patch.handoffReason ?? cur?.handoffReason ?? null,
      consulted_by: patch.consultedBy ?? cur?.consultedBy ?? null,
      crm_id: patch.crmId ?? cur?.crmId ?? null,
      crm_sync_state: patch.crmSyncState ?? cur?.crmSyncState ?? 'pending',
      crm_synced_at: patch.crmSyncedAt ?? cur?.crmSyncedAt ?? null,
    };

    db.prepare(
      `INSERT INTO ma_lead (
        lead_id, tenant_id, channel, intent, project, budget, city, grade, stage, reached,
        name, phone, wechat, consent_at, clinic_id, clinic_name, booking_date, booking_time,
        appointment_id, handed_off, handoff_reason, consulted_by, crm_id, crm_sync_state, crm_synced_at,
        created_at, updated_at
      ) VALUES (
        :lead_id, :tenant_id, :channel, :intent, :project, :budget, :city, :grade, :stage, :reached,
        :name, :phone, :wechat, :consent_at, :clinic_id, :clinic_name, :booking_date, :booking_time,
        :appointment_id, :handed_off, :handoff_reason, :consulted_by, :crm_id, :crm_sync_state, :crm_synced_at,
        :created_at, :updated_at
      )
      ON CONFLICT(lead_id) DO UPDATE SET
        channel=excluded.channel, intent=excluded.intent, project=excluded.project,
        budget=excluded.budget, city=excluded.city, grade=excluded.grade,
        stage=excluded.stage, reached=excluded.reached, name=excluded.name,
        phone=excluded.phone, wechat=excluded.wechat, consent_at=excluded.consent_at,
        clinic_id=excluded.clinic_id, clinic_name=excluded.clinic_name,
        booking_date=excluded.booking_date, booking_time=excluded.booking_time,
        appointment_id=excluded.appointment_id, handed_off=excluded.handed_off,
        handoff_reason=excluded.handoff_reason, consulted_by=excluded.consulted_by,
        crm_id=excluded.crm_id, crm_sync_state=excluded.crm_sync_state,
        crm_synced_at=excluded.crm_synced_at, updated_at=excluded.updated_at`
    ).run({
      lead_id: leadId,
      tenant_id: cfg.tenantId,
      ...merged,
      created_at: cur?.createdAt ?? now,
      updated_at: now,
    });

    return getLead(leadId)!;
  }, 'upsert 线索');
}

/** 追加已归属线索的对话消息（保留最近 200 条，超出裁剪）。 */
export function appendLeadMessage(leadId: string, role: string, text: string, runId?: string): void {
  dbCall(() => {
    const db = getDb();
    db.prepare(
      'INSERT INTO ma_lead_message (lead_id, run_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(leadId, runId ?? null, role, String(text ?? '').slice(0, 4000), Date.now());
    // 裁剪：仅保留该 lead 最近 200 条
    db.prepare(
      `DELETE FROM ma_lead_message WHERE lead_id = ? AND id NOT IN (
         SELECT id FROM ma_lead_message WHERE lead_id = ? ORDER BY id DESC LIMIT 200
       )`
    ).run(leadId, leadId);
  }, '写入线索消息');
}

export function getMessages(leadId: string, limit = 50): { role: string; text: string; t: number }[] {
  return dbCall(() => {
    const rows = getDb()
      .prepare('SELECT role, text, created_at FROM ma_lead_message WHERE lead_id = ? ORDER BY id DESC LIMIT ?')
      .all(leadId, limit);
    return rows
      .map((r) => ({ role: String(r.role), text: String(r.text), t: Number(r.created_at) }))
      .reverse();
  }, '读取线索消息');
}

/** 列出线索（按更新时间倒序，分页）。 */
export function listLeads(limit = 100, offset = 0): LeadRecord[] {
  return dbCall(() => {
    const rows = getDb()
      .prepare(
        'SELECT * FROM ma_lead WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?'
      )
      .all(getConfig().tenantId, limit, offset);
    return rows.map(rowToLead);
  }, '列出线索');
}

/**
 * 完整统计（SQL 聚合）。漏斗按 reached 口径累计：某线索 reached=booked 时，
 * new..booked 各 +1，符合转化漏斗直觉；lost 独立计数、不进漏斗。
 */
export function computeStats(): LeadStats {
  return dbCall(() => {
    const db = getDb();
    const tid = getConfig().tenantId;

    const total = Number(
      db.prepare('SELECT COUNT(*) AS c FROM ma_lead WHERE tenant_id = ?').get(tid)?.c ?? 0
    );

    // reached 分布（排除 lost），据此累计成漏斗
    const reachedRows = db
      .prepare(
        `SELECT reached, COUNT(*) AS c FROM ma_lead
         WHERE tenant_id = ? AND stage != 'lost' GROUP BY reached`
      )
      .all(tid);
    const funnel = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0])) as Record<LeadStage, number> & {
      lost: number;
    };
    (funnel as Record<string, number>).lost = 0;
    for (const row of reachedRows) {
      const rr = stageRank(row.reached as LeadStage);
      const c = Number(row.c);
      for (let i = 0; i <= rr; i++) funnel[STAGE_ORDER[i]] += c;
    }
    (funnel as Record<string, number>).lost = Number(
      db.prepare(`SELECT COUNT(*) AS c FROM ma_lead WHERE tenant_id = ? AND stage = 'lost'`).get(tid)?.c ?? 0
    );

    const channelDist: Record<string, number> = {};
    for (const row of db
      .prepare(`SELECT channel, COUNT(*) AS c FROM ma_lead WHERE tenant_id = ? AND stage != 'lost' GROUP BY channel`)
      .all(tid)) {
      channelDist[String(row.channel)] = Number(row.c);
    }

    const gradeDist: Record<string, number> = {};
    for (const row of db
      .prepare(`SELECT grade, COUNT(*) AS c FROM ma_lead WHERE tenant_id = ? AND grade IS NOT NULL GROUP BY grade`)
      .all(tid)) {
      gradeDist[String(row.grade)] = Number(row.c);
    }

    const crmSync: Record<CrmSyncState, number> = { pending: 0, synced: 0, failed: 0, disabled: 0 };
    for (const row of db
      .prepare('SELECT crm_sync_state AS s, COUNT(*) AS c FROM ma_lead WHERE tenant_id = ? GROUP BY crm_sync_state')
      .all(tid)) {
      crmSync[(row.s as CrmSyncState) ?? 'pending'] = Number(row.c);
    }

    const followupQueue = db
      .prepare(
        `SELECT * FROM ma_lead WHERE tenant_id = ? AND handed_off = 0
         AND (grade = 'C' OR stage = 'lost') ORDER BY updated_at DESC LIMIT 100`
      )
      .all(tid)
      .map(rowToLead);

    const handoffQueue = db
      .prepare(
        `SELECT * FROM ma_lead WHERE tenant_id = ? AND handed_off = 1 AND consulted_by IS NULL
         ORDER BY updated_at DESC LIMIT 100`
      )
      .all(tid)
      .map(rowToLead);

    const arrived = funnel.arrived;
    const deal = funnel.deal;
    return {
      total,
      funnel,
      channelDist,
      gradeDist,
      arrived,
      deal,
      arriveRate: total ? Math.round((arrived / total) * 100) : 0,
      dealRate: total ? Math.round((deal / total) * 100) : 0,
      followupQueue,
      handoffQueue,
      crmSync,
    };
  }, '统计聚合');
}

/**
 * 认领：仅当已转人工且未被认领时置 consulted_by（条件更新，防并发重复认领）。
 * 返回 true 表示本次认领成功。
 */
export function assignConsultant(leadId: string, consultant: string): boolean {
  return dbCall(() => {
    const res = getDb()
      .prepare(
        `UPDATE ma_lead SET consulted_by = ?, updated_at = ?
         WHERE tenant_id = ? AND lead_id = ? AND handed_off = 1 AND consulted_by IS NULL`
      )
      .run(consultant || 'anonymous', Date.now(), getConfig().tenantId, leadId);
    return res.changes === 1;
  }, '认领线索');
}

/** 供发件箱 worker 使用：更新 CRM 同步结果。 */
export function markCrmSync(leadId: string, state: CrmSyncState, crmId?: string): void {
  dbCall(() => {
    getDb()
      .prepare(
        'UPDATE ma_lead SET crm_sync_state = ?, crm_id = COALESCE(?, crm_id), crm_synced_at = ?, updated_at = ? WHERE lead_id = ?'
      )
      .run(state, crmId ?? null, Date.now(), Date.now(), leadId);
  }, '更新 CRM 同步状态');
}

/** 事务内推进阶段（供 schedule-service 预约成功后原子更新）。 */
export function advanceStageTx(
  conn: SqliteDatabase,
  leadId: string,
  patch: LeadPatch & { stage: LeadStage }
): void {
  const now = Date.now();
  const cur = conn.prepare('SELECT stage, reached FROM ma_lead WHERE lead_id = ?').get(leadId);
  const curReached = (cur?.reached as LeadStage) ?? patch.stage;
  const reached =
    patch.stage === 'lost'
      ? curReached
      : STAGE_ORDER[Math.max(stageRank(curReached), stageRank(patch.stage))];
  conn
    .prepare(
      `UPDATE ma_lead SET stage = ?, reached = ?, clinic_id = COALESCE(?, clinic_id),
       clinic_name = COALESCE(?, clinic_name), booking_date = COALESCE(?, booking_date),
       booking_time = COALESCE(?, booking_time), appointment_id = COALESCE(?, appointment_id),
       updated_at = ? WHERE lead_id = ?`
    )
    .run(
      patch.stage,
      reached,
      patch.clinicId ?? null,
      patch.clinicName ?? null,
      patch.bookingDate ?? null,
      patch.bookingTime ?? null,
      patch.appointmentId ?? null,
      now,
      leadId
    );
}
