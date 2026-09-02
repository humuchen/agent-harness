/**
 * CRM 同步发件箱仓储（至少一次投递，避免上游抖动丢客资）。
 *
 * 投递语义：enqueue 落库（pending）→ worker 扫描 due 记录 → 真实 POST 到 CRM →
 * 成功 markSent（synced）/失败 markFailed（递增 attempts，到上限置 failed）。
 * 幂等键（idempotency_key UNIQUE）保证重投不会造成上游重复建单。
 */

import { getDb, getDbAsync, dbCall, allRows, getRow, runStmt, type SqliteDatabase } from '../infra/db';
import { getConfig } from '../config';

export type OutboxState = 'pending' | 'sent' | 'failed';

export interface OutboxRow {
  id: number;
  topic: string;
  idempotencyKey: string;
  payload: unknown;
  state: OutboxState;
  attempts: number;
  lastError?: string;
  nextRetryAt: number;
  createdAt: number;
  updatedAt: number;
}

function rowToOutbox(r: Record<string, unknown>): OutboxRow {
  let payload: unknown = null;
  try {
    payload = r.payload ? JSON.parse(String(r.payload)) : null;
  } catch {
    payload = r.payload;
  }
  return {
    id: Number(r.id),
    topic: String(r.topic),
    idempotencyKey: String(r.idempotency_key),
    payload,
    state: r.state as OutboxState,
    attempts: Number(r.attempts),
    lastError: (r.last_error as string) ?? undefined,
    nextRetryAt: Number(r.next_retry_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** 入队（幂等键冲突则忽略，避免重复建单）。 */
export async function enqueue(topic: string, idempotencyKey: string, payload: unknown): Promise<void> {
  await dbCall(async () => {
    (await getDb())
      .prepare(
        `INSERT INTO ma_outbox (tenant_id, topic, idempotency_key, payload, state, attempts, next_retry_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`
      )
      .run(getConfig().tenantId, topic, idempotencyKey, JSON.stringify(payload), Date.now(), Date.now());
  }, '入队发件箱');
}

/** 扫描到期待投递记录（next_retry_at <= now）。 */
export async function dueBatch(limit: number, now: number): Promise<OutboxRow[]> {
  return await dbCall(async () => {
    const rows = await allRows((await getDb()).prepare(
        `SELECT * FROM ma_outbox WHERE tenant_id = ? AND state = 'pending' AND next_retry_at <= ?
         ORDER BY next_retry_at ASC LIMIT ?`
      ), getConfig().tenantId, now, limit);
    return rows.map(rowToOutbox);
  }, '扫描待投递');
}

/** 标记已投递（state=sent）。 */
export async function markSent(id: number): Promise<void> {
  await dbCall(async () => {
    await runStmt((await getDb()).prepare(`UPDATE ma_outbox SET state = 'sent', attempts = attempts + 1, updated_at = ? WHERE id = ?`), Date.now(), id);
  }, '标记已投递');
}

/** 标记失败：递增 attempts，到上限置 failed，否则排期下一次重试。 */
export async function markFailed(id: number, err: string, maxAttempts: number, nextDelayMs: number): Promise<void> {
  await dbCall(async () => {
    const db = await getDb();
    const row = await getRow(db.prepare('SELECT attempts FROM ma_outbox WHERE id = ?'), id) as Record<string, unknown> | undefined;
    const attempts = Number(row?.attempts ?? 0) + 1;
    const state: OutboxState = attempts >= maxAttempts ? 'failed' : 'pending';
    const next = state === 'failed' ? Number.MAX_SAFE_INTEGER : Date.now() + nextDelayMs;
    await runStmt(db.prepare(
      `UPDATE ma_outbox SET state = ?, attempts = ?, last_error = ?, next_retry_at = ?, updated_at = ? WHERE id = ?`
    ), state, attempts, String(err).slice(0, 500), next, Date.now(), id);
  }, '标记投递失败');
}

/** 发件箱健康（看板同步状态用）。 */
export async function outboxStats(): Promise<{ pending: number; sent: number; failed: number }> {
  return await dbCall(async () => {
    const rows = await allRows((await getDb()).prepare('SELECT state, COUNT(*) AS c FROM ma_outbox WHERE tenant_id = ? GROUP BY state'), getConfig().tenantId);
    const out = { pending: 0, sent: 0, failed: 0 };
    for (const r of rows) {
      const s = String(r.state);
      if (s === 'pending') out.pending = Number(r.c);
      else if (s === 'sent') out.sent = Number(r.c);
      else if (s === 'failed') out.failed = Number(r.c);
    }
    return out;
  }, '发件箱统计');
}
