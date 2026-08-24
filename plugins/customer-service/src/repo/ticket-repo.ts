/**
 * 工单仓储：参数化 SQL，真实落库（node:sqlite）。
 */
import { getDb } from '../infra/db';
import { getConfig } from '../config';

export interface TicketRow {
  ticketId: string;
  sessionId?: string | null;
  tenantId: string;
  subject: string;
  channel?: string | null;
  priority: string;
  status: string;
  assignee?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 生成工单号（cs-<timestamp36>-<rand>）。 */
export function newTicketId(): string {
  return `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 创建工单。 */
export function createTicket(input: {
  sessionId?: string;
  subject: string;
  channel?: string;
  priority?: string;
  assignee?: string;
}): TicketRow {
  const db = getDb();
  const tenantId = getConfig().tenantId;
  const ticketId = newTicketId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cs_ticket (ticket_id, session_id, tenant_id, subject, channel, priority, status, assignee, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
  ).run(
    ticketId,
    input.sessionId ?? null,
    tenantId,
    input.subject,
    input.channel ?? null,
    input.priority ?? 'normal',
    input.assignee ?? null,
    now,
    now
  );
  return getTicket(ticketId)!;
}

/** 更新工单状态/指派人。 */
export function updateTicket(
  ticketId: string,
  patch: { status?: string; assignee?: string }
): TicketRow | null {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status) {
    sets.push('status=?');
    params.push(patch.status);
  }
  if (patch.assignee !== undefined) {
    sets.push('assignee=?');
    params.push(patch.assignee);
  }
  if (sets.length === 0) return getTicket(ticketId);
  sets.push('updated_at=?');
  params.push(new Date().toISOString());
  params.push(ticketId);
  db.prepare(`UPDATE cs_ticket SET ${sets.join(', ')} WHERE ticket_id=?`).run(...params);
  return getTicket(ticketId);
}

/** 按 id 取工单。 */
export function getTicket(ticketId: string): TicketRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT ticket_id AS ticketId, session_id AS sessionId, tenant_id AS tenantId, subject, channel, priority, status, assignee, created_at AS createdAt, updated_at AS updatedAt FROM cs_ticket WHERE ticket_id=?`
    )
    .get(ticketId) as TicketRow | undefined;
  return row ?? null;
}

/** 按状态过滤工单（默认全部，最近 50 条）。 */
export function listTickets(status?: string, limit = 50): TicketRow[] {
  const db = getDb();
  const base =
    `SELECT ticket_id AS ticketId, session_id AS sessionId, tenant_id AS tenantId, subject, channel, priority, status, assignee, created_at AS createdAt, updated_at AS updatedAt FROM cs_ticket`;
  const rows = status
    ? db.prepare(`${base} WHERE status=? ORDER BY updated_at DESC LIMIT ?`).all(status, limit)
    : db.prepare(`${base} ORDER BY updated_at DESC LIMIT ?`).all(limit);
  return rows as TicketRow[];
}
