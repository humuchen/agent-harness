/**
 * 定时任务仓储（B3 调度器的持久层）。
 *
 * 语义：
 * - scheduled_key UNIQUE 保证同一（线索, 节点）只排一次（幂等，重复规划自动去重）；
 * - 到期任务由 scheduler tick 消费：产出对客消息进 ma_outbox（topic=outreach.send），
 *   投递交给 outbox worker（至少一次 + 指数退避）；
 * - 终态：done（已产出消息）/ skipped（线索已转化或已转人工，不再触达）/ failed（重试耗尽）/
 *   cancelled（运营手动取消）。skipped/cancelled 不再重试。
 */

import { getDb, dbCall, allRows, getRow, runStmt } from '../infra/db';
import { getConfig } from '../config';

export type ScheduleJobType = 'welcome' | 'recall' | 'birthday' | 'repurchase';
export type ScheduleJobState = 'pending' | 'done' | 'skipped' | 'failed' | 'cancelled';

export interface ScheduleJobRow {
  id: number;
  jobType: ScheduleJobType;
  leadId: string;
  scheduledKey: string;
  dueAt: number;
  status: ScheduleJobState;
  attempts: number;
  lastError?: string;
  payload: unknown;
  createdAt: number;
  updatedAt: number;
}

function rowToJob(r: Record<string, unknown>): ScheduleJobRow {
  let payload: unknown = null;
  try {
    payload = r.payload ? JSON.parse(String(r.payload)) : null;
  } catch {
    payload = r.payload;
  }
  return {
    id: Number(r.id),
    jobType: String(r.job_type) as ScheduleJobType,
    leadId: String(r.lead_id),
    scheduledKey: String(r.scheduled_key),
    dueAt: Number(r.due_at),
    status: String(r.status) as ScheduleJobState,
    attempts: Number(r.attempts),
    lastError: (r.last_error as string) ?? undefined,
    payload,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** 入队（scheduled_key 冲突则忽略）。返回是否真正插入（false = 已存在，幂等去重）。 */
export async function enqueueJob(input: {
  jobType: ScheduleJobType;
  leadId: string;
  scheduledKey: string;
  dueAt: number;
  payload?: unknown;
}): Promise<boolean> {
  return await dbCall(async () => {
    const r = await runStmt(
      (await getDb()).prepare(
        `INSERT INTO ma_schedule_job (tenant_id, job_type, lead_id, scheduled_key, due_at, status, attempts, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
         ON CONFLICT(scheduled_key) DO NOTHING`
      ),
      getConfig().tenantId,
      input.jobType,
      input.leadId,
      input.scheduledKey,
      input.dueAt,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      Date.now(),
      Date.now()
    );
    return Number(r.changes) > 0;
  }, '入队定时任务');
}

/** 扫描到期任务（status=pending 且 due_at <= now）。 */
export async function dueBatch(limit: number, now: number): Promise<ScheduleJobRow[]> {
  return await dbCall(async () => {
    const rows = await allRows(
      (await getDb()).prepare(
        `SELECT * FROM ma_schedule_job WHERE tenant_id = ? AND status = 'pending' AND due_at <= ?
         ORDER BY due_at ASC LIMIT ?`
      ),
      getConfig().tenantId,
      now,
      limit
    );
    return rows.map(rowToJob);
  }, '扫描到期任务');
}

/** 任务终态：done / skipped（附原因写 last_error 字段复用为备注）。 */
export async function markJobFinished(id: number, status: 'done' | 'skipped', note?: string): Promise<void> {
  await dbCall(async () => {
    await runStmt(
      (await getDb()).prepare(
        `UPDATE ma_schedule_job SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`
      ),
      status,
      note ? String(note).slice(0, 500) : null,
      Date.now(),
      id
    );
  }, '标记任务完成');
}

/** 任务失败：递增 attempts，未到上限保持 pending 并顺延 due_at，到上限置 failed。 */
export async function markJobFailed(id: number, err: string, maxAttempts: number, nextDelayMs: number): Promise<void> {
  await dbCall(async () => {
    const db = await getDb();
    const row = (await getRow(db.prepare('SELECT attempts FROM ma_schedule_job WHERE id = ?'), id)) as
      | Record<string, unknown>
      | undefined;
    const attempts = Number(row?.attempts ?? 0) + 1;
    const failed = attempts >= maxAttempts;
    await runStmt(
      db.prepare(
        `UPDATE ma_schedule_job SET status = ?, attempts = ?, last_error = ?, due_at = ?, updated_at = ? WHERE id = ?`
      ),
      failed ? 'failed' : 'pending',
      attempts,
      String(err).slice(0, 500),
      failed ? Date.now() : Date.now() + nextDelayMs,
      Date.now(),
      id
    );
  }, '标记任务失败');
}

/** 取消某线索的全部 pending 任务（转人工/成交后调用，防打扰）。 */
export async function cancelPendingForLead(leadId: string): Promise<number> {
  return await dbCall(async () => {
    const r = await runStmt(
      (await getDb()).prepare(
        `UPDATE ma_schedule_job SET status = 'cancelled', updated_at = ? WHERE tenant_id = ? AND lead_id = ? AND status = 'pending'`
      ),
      Date.now(),
      getConfig().tenantId,
      leadId
    );
    return Number(r.changes);
  }, '取消线索待办任务');
}

/** 任务统计（按状态 / 按类型），看板与 /scheduler 路由用。 */
export async function jobStats(): Promise<{
  byState: Record<string, number>;
  byType: Record<string, number>;
  dueNow: number;
}> {
  return await dbCall(async () => {
    const db = await getDb();
    const tid = getConfig().tenantId;
    const byState: Record<string, number> = {};
    for (const r of await allRows(db.prepare('SELECT status, COUNT(*) AS c FROM ma_schedule_job WHERE tenant_id = ? GROUP BY status'), tid)) {
      byState[String(r.status)] = Number(r.c);
    }
    const byType: Record<string, number> = {};
    for (const r of await allRows(db.prepare('SELECT job_type, COUNT(*) AS c FROM ma_schedule_job WHERE tenant_id = ? GROUP BY job_type'), tid)) {
      byType[String(r.job_type)] = Number(r.c);
    }
    const due = (await getRow(
      db.prepare(`SELECT COUNT(*) AS c FROM ma_schedule_job WHERE tenant_id = ? AND status = 'pending' AND due_at <= ?`),
      tid,
      Date.now()
    )) as Record<string, unknown> | undefined;
    return { byState, byType, dueNow: Number(due?.c ?? 0) };
  }, '定时任务统计');
}
