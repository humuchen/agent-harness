/**
 * 会话仓储：参数化 SQL，真实落库（node:sqlite）。
 */
import { getDb } from '../infra/db';
import { getConfig } from '../config';

export interface SessionRow {
  sessionId: string;
  tenantId: string;
  channel?: string | null;
  customerId?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** 取得或创建会话（幂等）。 */
export function upsertSession(input: {
  sessionId: string;
  channel?: string;
  customerId?: string;
}): SessionRow {
  const db = getDb();
  const tenantId = getConfig().tenantId;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cs_session (session_id, tenant_id, channel, customer_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET channel=excluded.channel, customer_id=excluded.customer_id, updated_at=excluded.updated_at`
  ).run(input.sessionId, tenantId, input.channel ?? null, input.customerId ?? null, now);
  return getSession(input.sessionId)!;
}

/** 更新会话状态（open | handoff | closed）。 */
export function setSessionStatus(sessionId: string, status: string): SessionRow | null {
  const db = getDb();
  db.prepare(`UPDATE cs_session SET status=?, updated_at=? WHERE session_id=?`).run(
    status,
    new Date().toISOString(),
    sessionId
  );
  return getSession(sessionId);
}

/** 按 id 取会话。 */
export function getSession(sessionId: string): SessionRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT session_id AS sessionId, tenant_id AS tenantId, channel, customer_id AS customerId, status, created_at AS createdAt, updated_at AS updatedAt FROM cs_session WHERE session_id=?`
    )
    .get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

/** 列出最近会话（默认 50 条）。 */
export function listSessions(limit = 50): SessionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT session_id AS sessionId, tenant_id AS tenantId, channel, customer_id AS customerId, status, created_at AS createdAt, updated_at AS updatedAt FROM cs_session ORDER BY updated_at DESC LIMIT ?`
    )
    .all(limit) as SessionRow[];
}
