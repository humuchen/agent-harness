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
  /** 增强坐席池：转人工指派的坐席 id（null = 等待认领）。 */
  assignedSeat?: string | null;
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
      `SELECT session_id AS sessionId, tenant_id AS tenantId, channel, customer_id AS customerId, status, assigned_seat AS assignedSeat, created_at AS createdAt, updated_at AS updatedAt FROM cs_session WHERE session_id=?`
    )
    .get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

/** 列出最近会话（默认 50 条）。 */
export function listSessions(limit = 50): SessionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT session_id AS sessionId, tenant_id AS tenantId, channel, customer_id AS customerId, status, assigned_seat AS assignedSeat, created_at AS createdAt, updated_at AS updatedAt FROM cs_session ORDER BY updated_at DESC LIMIT ?`
    )
    .all(limit) as SessionRow[];
}

/** 指派坐席（handoff 自动指派 / 认领；坐席负载 +1，online→busy 联动）。 */
export function assignSeat(sessionId: string, seatId: string): SessionRow | null {
  const db = getDb();
  db.prepare(`UPDATE cs_session SET assigned_seat=?, updated_at=? WHERE session_id=?`).run(
    seatId,
    new Date().toISOString(),
    sessionId
  );
  // 坐席负载联动（延迟 require 避免模块初始化顺序耦合）。
  const { incrementSeatLoad } = require('./seat-repo') as typeof import('./seat-repo');
  incrementSeatLoad(seatId);
  return getSession(sessionId);
}

/** 释放坐席（会话关闭/重新 bot 接管；坐席负载 -1）。 */
export function releaseSeat(sessionId: string): SessionRow | null {
  const db = getDb();
  const current = getSession(sessionId);
  if (current?.assignedSeat) {
    // 延迟 require 避免与 seat-repo 循环依赖（seat-repo 不引 session-repo，此处仅为一致习惯）。
    const { decrementSeatLoad } = require('./seat-repo') as typeof import('./seat-repo');
    decrementSeatLoad(current.assignedSeat);
  }
  db.prepare(`UPDATE cs_session SET assigned_seat=NULL, updated_at=? WHERE session_id=?`).run(
    new Date().toISOString(),
    sessionId
  );
  return getSession(sessionId);
}
