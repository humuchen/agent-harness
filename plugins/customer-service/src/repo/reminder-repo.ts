/**
 * 客服提醒仓储：cs_reminder 表 CRUD。
 * 存储 agent 分析产出的提醒项，供看板轮询 + SSE 推送。
 */
import { getDb } from '../infra/db';
import { getConfig } from '../config';

export interface CsReminderRow {
  id: string;
  tenantId: string;
  leadId: string;
  name: string | null;
  phone: string | null;
  project: string | null;
  lastVisit: string | null;
  daysSince: number | null;
  activityTitle: string | null;
  activityId: string | null;
  status: 'pending' | 'reminded' | 'ignored';
  sourceSlot: number | null;
  createdAt: string;
  updatedAt: string;
}

export function newReminderId(): string {
  return `rmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 批量插入提醒项（来自 agent 分析输出）。
 * 同一 leadId + sourceSlot 去重（UNIQUE 约束）。
 */
export function insertReminders(
  items: Array<{
    leadId: string;
    name?: string | null;
    phone?: string | null;
    project?: string | null;
    lastVisit?: string | null;
    daysSince?: number | null;
    activityTitle?: string | null;
    activityId?: string | null;
    sourceSlot?: number | null;
  }>
): number {
  const db = getDb();
  const tenantId = getConfig().tenantId;
  const now = new Date().toISOString();
  let count = 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO cs_reminder
       (id, tenant_id, lead_id, name, phone, project, last_visit, days_since,
        activity_title, activity_id, status, source_slot, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  );
  for (const item of items) {
    const id = newReminderId();
    stmt.run(
      id,
      tenantId,
      item.leadId,
      item.name ?? null,
      item.phone ?? null,
      item.project ?? null,
      item.lastVisit ?? null,
      item.daysSince ?? null,
      item.activityTitle ?? null,
      item.activityId ?? null,
      item.sourceSlot ?? null,
      now,
      now
    );
    count++;
  }
  return count;
}

/** 查询待处理提醒（最近 50 条）。 */
export function listPendingReminders(limit = 50): CsReminderRow[] {
  const db = getDb();
  const tenantId = getConfig().tenantId;
  const rows = db
    .prepare(
      `SELECT id, tenant_id AS tenantId, lead_id AS leadId, name, phone, project,
              last_visit AS lastVisit, days_since AS daysSince,
              activity_title AS activityTitle, activity_id AS activityId,
              status, source_slot AS sourceSlot,
              created_at AS createdAt, updated_at AS updatedAt
       FROM cs_reminder
       WHERE tenant_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(tenantId, limit) as CsReminderRow[];
  return rows;
}

/** 更新提醒状态。 */
export function updateReminderStatus(
  id: string,
  status: 'reminded' | 'ignored'
): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(`UPDATE cs_reminder SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, now, id);
  return (result as unknown as { changes: number }).changes > 0;
}

/** 按 id 取提醒。 */
export function getReminder(id: string): CsReminderRow | null {
  const db = getDb();
  const tenantId = getConfig().tenantId;
  const row = db
    .prepare(
      `SELECT id, tenant_id AS tenantId, lead_id AS leadId, name, phone, project,
              last_visit AS lastVisit, days_since AS daysSince,
              activity_title AS activityTitle, activity_id AS activityId,
              status, source_slot AS sourceSlot,
              created_at AS createdAt, updated_at AS updatedAt
       FROM cs_reminder
       WHERE tenant_id = ? AND id = ?`
    )
    .get(tenantId, id) as CsReminderRow | undefined;
  return row ?? null;
}
