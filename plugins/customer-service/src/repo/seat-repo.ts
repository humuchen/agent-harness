/**
 * 坐席池仓储（增强：转人工自动指派）。
 *
 * 设计：
 * - 坐席档案（cs_agent_seat）：name / status(online|busy|offline) / active_sessions 负载计数；
 * - 指派策略：最闲优先（online 中 active_sessions 最小；平局取最近空闲者）——
 *   比轮询更平均，且天然把新手（结束快）让给后续会话的语义留给了负载计数；
 * - 负载联动：assign +1、release -1；+1 后进入 busy，归 0 回 online（仅对 online/busy 语义坐席）；
 * - offline 坐席不参与指派，已挂在其名下的会话保留（重新上线后继续处理）。
 */

import { getDb } from '../infra/db';
import { getConfig } from '../config';

export interface SeatRow {
  seatId: string;
  tenantId: string;
  name: string;
  /** online = 可接新会话；busy = 有进行中会话；offline = 不参与指派。 */
  status: 'online' | 'busy' | 'offline';
  activeSessions: number;
  /** 并发上限（指派时过滤满载坐席；默认 3）。 */
  maxConcurrent: number;
  createdAt: string;
  updatedAt: string;
}

const SEAT_SELECT = `SELECT seat_id AS seatId, tenant_id AS tenantId, name, status,
  active_sessions AS activeSessions, max_concurrent AS maxConcurrent, created_at AS createdAt, updated_at AS updatedAt FROM cs_agent_seat`;

function toSeat(r: Record<string, unknown>): SeatRow {
  const status = String(r.status ?? 'offline');
  return {
    seatId: String(r.seatId ?? ''),
    tenantId: String(r.tenantId ?? ''),
    name: String(r.name ?? ''),
    status: status === 'online' ? 'online' : status === 'busy' ? 'busy' : 'offline',
    activeSessions: Number(r.activeSessions ?? 0),
    maxConcurrent: Number(r.maxConcurrent ?? 3),
    createdAt: String(r.createdAt ?? ''),
    updatedAt: String(r.updatedAt ?? ''),
  };
}

/** 注册或更新坐席（幂等 upsert；已存在时仅改名，状态/负载不动）。 */
export function upsertSeat(input: { seatId: string; name: string }): SeatRow {
  const db = getDb();
  const tenantId = getConfig().tenantId;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cs_agent_seat (seat_id, tenant_id, name, status, active_sessions, created_at, updated_at)
     VALUES (?, ?, ?, 'offline', 0, ?, ?)
     ON CONFLICT(seat_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`
  ).run(input.seatId, tenantId, input.name, now, now);
  return getSeat(input.seatId)!;
}

/** 按 id 取坐席。 */
export function getSeat(seatId: string): SeatRow | null {
  const db = getDb();
  const row = db.prepare(`${SEAT_SELECT} WHERE seat_id=?`).get(seatId) as Record<string, unknown> | undefined;
  return row ? toSeat(row) : null;
}

/** 设置坐席状态（online/offline；busy 由负载联动自动管理，此处不接受）。 */
export function setSeatStatus(seatId: string, status: 'online' | 'offline'): SeatRow | null {
  const db = getDb();
  db.prepare(`UPDATE cs_agent_seat SET status=?, updated_at=? WHERE seat_id=?`).run(
    status,
    new Date().toISOString(),
    seatId
  );
  return getSeat(seatId);
}

/** 列出租户坐席（按负载升序：最闲在前）。 */
export function listSeats(limit = 100): SeatRow[] {
  const db = getDb();
  return db
    .prepare(`${SEAT_SELECT} WHERE tenant_id=? ORDER BY active_sessions ASC, updated_at ASC LIMIT ?`)
    .all(getConfig().tenantId, limit) as SeatRow[];
}

/** 最闲优先挑一个在线且未满载的坐席；无可用坐席返回 null（会话仍标 handoff 等待认领）。 */
export function pickLeastBusySeat(): SeatRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `${SEAT_SELECT} WHERE tenant_id=? AND status IN ('online','busy')
       AND active_sessions < max_concurrent
       ORDER BY active_sessions ASC, updated_at ASC LIMIT 1`
    )
    .get(getConfig().tenantId) as Record<string, unknown> | undefined;
  return row ? toSeat(row) : null;
}

/** 设置坐席并发上限（min 1）。 */
export function setSeatMaxConcurrent(seatId: string, maxConcurrent: number): SeatRow | null {
  const n = Math.max(1, Math.floor(Number(maxConcurrent) || 0));
  if (!Number.isFinite(n)) throw new Error(`max_concurrent 非法：${maxConcurrent}`);
  const db = getDb();
  db.prepare(`UPDATE cs_agent_seat SET max_concurrent=?, updated_at=? WHERE seat_id=?`).run(
    n,
    new Date().toISOString(),
    seatId
  );
  return getSeat(seatId);
}

/** 负载 +1（指派会话）；online → busy 联动。 */
export function incrementSeatLoad(seatId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE cs_agent_seat SET active_sessions = active_sessions + 1,
       status = CASE WHEN status='online' THEN 'busy' ELSE status END,
       updated_at=? WHERE seat_id=?`
  ).run(new Date().toISOString(), seatId);
}

/** 负载 -1（会话结束/关闭）；归 0 时 busy → online。 */
export function decrementSeatLoad(seatId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE cs_agent_seat SET active_sessions = MAX(active_sessions - 1, 0),
       status = CASE WHEN status='busy' AND active_sessions - 1 <= 0 THEN 'online' ELSE status END,
       updated_at=? WHERE seat_id=?`
  ).run(new Date().toISOString(), seatId);
}
