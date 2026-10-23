/**
 * 线索仓储（真实参数化 SQL）。
 *
 * 取代原 store.ts 的「JSON 文件 + 扫目录聚合」：
 * - upsert 用 SQLite UPSERT（ON CONFLICT DO UPDATE），并在应用层单调推进 reached；
 * - 漏斗/渠道/等级分布用 SQL 聚合（GROUP BY），O(1) 往返而非遍历文件；
 * - 全部按 tenant_id 过滤，天然多租户隔离。
 */

import { getDb, getDbAsync, dbCall, allRows, getRow, runStmt, type SqliteDatabase } from '../infra/db';
import { getConfig } from '../config';
import {
  type LeadRecord,
  type LeadPatch,
  type LeadStage,
  type LeadGrade,
  type LeadStats,
  type CrmSyncState,
  type LeadPreferences,
  STAGE_ORDER,
  stageRank,
} from './types';

/** 解析偏好 JSON 列（容错：解析失败返回 undefined，绝不抛错阻断读取）。 */
function parsePreferences(v: unknown): LeadPreferences | undefined {
  if (!v) return undefined;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === 'object' ? (o as LeadPreferences) : undefined;
  } catch {
    return undefined;
  }
}

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
    stageUpdatedAt: r.stage_updated_at != null ? Number(r.stage_updated_at) : undefined,
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
    preferences: parsePreferences(r.preferences),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** 读取单条线索（含最近消息）。 */
export async function getLead(leadId: string, withMessages = false): Promise<LeadRecord | null> {
  return await dbCall(async () => {
    const db = await getDb();
    const row = await getRow(db.prepare('SELECT * FROM ma_lead WHERE tenant_id = ? AND lead_id = ?'), getConfig().tenantId, leadId);
    if (!row) return null;
    const lead = rowToLead(row);
    if (withMessages) lead.messages = await getMessages(leadId);
    return lead;
  }, '读取线索');
}

export async function leadExists(leadId: string): Promise<boolean> {
  return (await getLead(leadId)) !== null;
}

/**
 * upsert 线索：不存在则插入，存在则按 patch 更新非空字段。
 * reached 在应用层单调推进（除 lost 外取 max(reached, stage)）。
 * 阶段变更时同步写入 ma_lead_stage_log + 更新 stage_updated_at（用于运营留存分析）。
 */
export async function upsertLead(leadId: string, patch: LeadPatch): Promise<LeadRecord> {
  return await dbCall(async () => {
    const db = await getDb();
    const now = Date.now();
    const cfg = getConfig();
    const existing = await getRow(db.prepare('SELECT * FROM ma_lead WHERE tenant_id = ? AND lead_id = ?'), cfg.tenantId, leadId);

    // 合并当前值与 patch，计算最终 stage/reached
    const cur = existing ? rowToLead(existing) : null;
    const prevStage = cur?.stage ?? 'new';
    const stage: LeadStage = (patch.stage ?? cur?.stage ?? 'new') as LeadStage;
    let reached: LeadStage = cur?.reached ?? stage;
    if (stage !== 'lost') {
      reached = STAGE_ORDER[Math.max(stageRank(reached), stageRank(stage))] ?? 'lost';
    } else if (!cur) {
      reached = 'lost' as LeadStage;
    }

    // 阶段变更 → 记录 stage_updated_at + 写入 stage_log
    const stageChanged = stage !== prevStage;
    const stageUpdatedAt = stageChanged ? now : (cur?.stageUpdatedAt ?? now);

    const merged = {
      channel: patch.channel ?? cur?.channel ?? 'unknown',
      intent: patch.intent ?? cur?.intent ?? null,
      project: patch.project ?? cur?.project ?? null,
      budget: patch.budget ?? cur?.budget ?? null,
      city: patch.city ?? cur?.city ?? null,
      grade: patch.grade ?? cur?.grade ?? null,
      stage,
      reached,
      stage_updated_at: stageUpdatedAt,
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
      preferences: patch.preferences
        ? JSON.stringify(patch.preferences)
        : cur?.preferences
          ? JSON.stringify(cur.preferences)
          : null,
    };

    const upsertRes = await db.prepare(
      `INSERT INTO ma_lead (
        lead_id, tenant_id, channel, intent, project, budget, city, grade, stage, reached,
        stage_updated_at,
        name, phone, wechat, consent_at, clinic_id, clinic_name, booking_date, booking_time,
        appointment_id, handed_off, handoff_reason, consulted_by, crm_id, crm_sync_state, crm_synced_at,
        preferences,
        created_at, updated_at
      ) VALUES (
        :lead_id, :tenant_id, :channel, :intent, :project, :budget, :city, :grade, :stage, :reached,
        :stage_updated_at,
        :name, :phone, :wechat, :consent_at, :clinic_id, :clinic_name, :booking_date, :booking_time,
        :appointment_id, :handed_off, :handoff_reason, :consulted_by, :crm_id, :crm_sync_state, :crm_synced_at,
        :preferences,
        :created_at, :updated_at
      )
      ON CONFLICT(lead_id) DO UPDATE SET
        channel=excluded.channel, intent=excluded.intent, project=excluded.project,
        budget=excluded.budget, city=excluded.city, grade=excluded.grade,
        stage=excluded.stage, reached=excluded.reached, stage_updated_at=excluded.stage_updated_at,
        name=excluded.name,
        phone=excluded.phone, wechat=excluded.wechat, consent_at=excluded.consent_at,
        clinic_id=excluded.clinic_id, clinic_name=excluded.clinic_name,
        booking_date=excluded.booking_date, booking_time=excluded.booking_time,
        appointment_id=excluded.appointment_id, handed_off=excluded.handed_off,
        handoff_reason=excluded.handoff_reason, consulted_by=excluded.consulted_by,
        crm_id=excluded.crm_id, crm_sync_state=excluded.crm_sync_state,
        crm_synced_at=excluded.crm_synced_at, preferences=excluded.preferences, updated_at=excluded.updated_at
      -- P1 跨租户修复：lead_id 是全局主键（不含 tenant_id），租户 B upsert 一个
      -- 已属于租户 A 的 lead_id 时，旧实现 DO UPDATE 会直接整行覆盖 A 的线索
      --（含手机号/微信 PII）。追加 WHERE 后跨租户冲突不更新（changes=0）。
      WHERE ma_lead.tenant_id = excluded.tenant_id`
    ).run({
      lead_id: leadId,
      tenant_id: cfg.tenantId,
      ...merged,
      created_at: cur?.createdAt ?? now,
      updated_at: now,
    });

    // P1 跨租户修复：changes=0 意味着 lead_id 已被其它租户占用（INSERT 冲突但
    // WHERE 未放行）——显式报错而非静默吞掉，避免调用方误认为写入成功。
    const upsertChanges = Number(
      (upsertRes as unknown as { changes?: number })?.changes ?? 1
    );
    if (upsertChanges === 0) {
      throw new Error(`lead_id ${leadId} 已被其它租户占用（跨租户冲突，拒绝覆盖）`);
    }

    // 阶段变更时写入流水日志（用于漏斗留存耗时分析）
    if (stageChanged) {
      db.prepare(
        `INSERT INTO ma_lead_stage_log (lead_id, tenant_id, from_stage, to_stage, changed_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(leadId, cfg.tenantId, prevStage, stage, now);
    }

    return (await getLead(leadId))!;
  }, 'upsert 线索');
}

/** 追加已归属线索的对话消息（保留最近 200 条，超出裁剪）。 */
export async function appendLeadMessage(leadId: string, role: string, text: string, runId?: string): Promise<void> {
  await dbCall(async () => {
    const db = await getDb();
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

export async function getMessages(leadId: string, limit = 50): Promise<{ role: string; text: string; t: number }[]> {
  return await dbCall(async () => {
    const rows = await allRows((await getDb()).prepare('SELECT role, text, created_at FROM ma_lead_message WHERE lead_id = ? ORDER BY id DESC LIMIT ?'), leadId, limit);
    return rows
      .map((r) => ({ role: String(r.role), text: String(r.text), t: Number(r.created_at) }))
      .reverse();
  }, '读取线索消息');
}

/** 列出线索（按更新时间倒序，分页）。 */
export async function listLeads(limit = 100, offset = 0): Promise<LeadRecord[]> {
  return await dbCall(async () => {
    const rows = await allRows((await getDb()).prepare(
        'SELECT * FROM ma_lead WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?'
      ), getConfig().tenantId, limit, offset);
    return rows.map(rowToLead);
  }, '列出线索');
}

/**
 * 完整统计（SQL 聚合）。漏斗按 reached 口径累计：某线索 reached=booked 时，
 * new..booked 各 +1，符合转化漏斗直觉；lost 独立计数、不进漏斗。
 */
export async function computeStats(): Promise<LeadStats> {
  return await dbCall(async () => {
    const db = await getDb();
    const tid = getConfig().tenantId;

    const total = Number(
      (await getRow(db.prepare('SELECT COUNT(*) AS c FROM ma_lead WHERE tenant_id = ?'), tid))?.c ?? 0
    );

    // reached 分布（排除 lost），据此累计成漏斗
    const reachedRows = await allRows(db.prepare(
        `SELECT reached, COUNT(*) AS c FROM ma_lead
         WHERE tenant_id = ? AND stage != 'lost' GROUP BY reached`
      ), tid);
    const funnel = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0])) as Record<LeadStage, number> & {
      lost: number;
    };
    (funnel as Record<string, number>).lost = 0;
    for (const row of reachedRows) {
      const rr = stageRank(row.reached as LeadStage);
      const c = Number(row.c);
      for (let i = 0; i <= rr; i++) funnel[STAGE_ORDER[i] ?? 'lost'] += c;
    }
    (funnel as Record<string, number>).lost = Number(
      (await getRow(db.prepare(`SELECT COUNT(*) AS c FROM ma_lead WHERE tenant_id = ? AND stage = 'lost'`), tid))?.c ?? 0
    );

    const channelDist: Record<string, number> = {};
    for (const row of await allRows(db.prepare(
      `SELECT channel, COUNT(*) AS c FROM ma_lead WHERE tenant_id = ? AND stage != 'lost' GROUP BY channel`
    ), tid)) {
      channelDist[String(row.channel)] = Number(row.c);
    }

    const gradeDist: Record<string, number> = {};
    for (const row of await allRows(db.prepare(
      `SELECT grade, COUNT(*) AS c FROM ma_lead WHERE tenant_id = ? AND grade IS NOT NULL GROUP BY grade`
    ), tid)) {
      gradeDist[String(row.grade)] = Number(row.c);
    }

    const crmSync: Record<CrmSyncState, number> = { pending: 0, synced: 0, failed: 0, disabled: 0 };
    for (const row of await allRows(db.prepare(
      'SELECT crm_sync_state AS s, COUNT(*) AS c FROM ma_lead WHERE tenant_id = ? GROUP BY crm_sync_state'
    ), tid)) {
      crmSync[(row.s as CrmSyncState) ?? 'pending'] = Number(row.c);
    }

    const followupQueue = (await allRows(db.prepare(
        `SELECT * FROM ma_lead WHERE tenant_id = ? AND handed_off = 0
         AND (grade = 'C' OR stage = 'lost') ORDER BY updated_at DESC LIMIT 100`
      ), tid)).map(rowToLead);

    const handoffQueue = (await allRows(db.prepare(
        `SELECT * FROM ma_lead WHERE tenant_id = ? AND handed_off = 1 AND consulted_by IS NULL
         ORDER BY updated_at DESC LIMIT 100`
      ), tid))
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
export async function assignConsultant(leadId: string, consultant: string): Promise<boolean> {
  return await dbCall(async () => {
    const res = await runStmt((await getDb()).prepare(
        `UPDATE ma_lead SET consulted_by = ?, updated_at = ?
         WHERE tenant_id = ? AND lead_id = ? AND handed_off = 1 AND consulted_by IS NULL`
      ), consultant || 'anonymous', Date.now(), getConfig().tenantId, leadId);
    return res.changes === 1;
  }, '认领线索');
}

/** 供发件箱 worker 使用：更新 CRM 同步结果。 */
export async function markCrmSync(leadId: string, state: CrmSyncState, crmId?: string): Promise<void> {
  dbCall(async () => {
    (await getDb())
      .prepare(
        // P1 租户隔离修复：UPDATE 补 tenant_id 条件，与 getLead/listLeads 的过滤口径对齐。
        'UPDATE ma_lead SET crm_sync_state = ?, crm_id = COALESCE(?, crm_id), crm_synced_at = ?, updated_at = ? WHERE tenant_id = ? AND lead_id = ?'
      )
      .run(state, crmId ?? null, Date.now(), Date.now(), getConfig().tenantId, leadId);
  }, '更新 CRM 同步状态');
}

/** 事务内推进阶段（供 schedule-service 预约成功后原子更新）。 */
export async function advanceStageTx(
  conn: SqliteDatabase,
  leadId: string,
  patch: LeadPatch & { stage: LeadStage }
): Promise<void> {
  const now = Date.now();
  const cur = await getRow(conn.prepare('SELECT stage, reached FROM ma_lead WHERE lead_id = ?'), leadId);
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
