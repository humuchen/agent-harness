/**
 * 工单仓储：参数化 SQL，真实落库（node:sqlite / turso 双后端）。
 *
 * 增强（运营闭环）：
 * - **状态机**：合法流转白名单（open→in_progress→resolved→closed，resolved/closed 可 reopen
 *   回 in_progress），非法流转抛错——此前 status 任意字符串直写 DB，无治理语义；
 * - **SLA**：按 priority 分级响应时限（urgent 2h / high 4h / normal 24h / low 72h），
 *   建单时写 sla_due_at，优先级调整时重算；未结单且超时 → slaBreached 标记（读时计算）；
 * - **CSAT**：rating(1-5) / rating_comment / rated_at，仅 resolved|closed 可评、一次性
 *   （复评抛错），评分不可篡改。
 */
import { randomBytes } from 'node:crypto';
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
  /** SLA 到期时间（priority 分级时限；优先级调整时重算）。 */
  slaDueAt?: string | null;
  /** 读时计算：未结单且已超 SLA。 */
  slaBreached?: boolean;
  /** CSAT 评分（1-5；一次性，复评抛错）。 */
  rating?: number | null;
  ratingComment?: string | null;
  ratedAt?: string | null;
}

/** 工单合法状态。 */
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
/** 工单合法优先级。 */
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

/** 状态机：合法流转白名单（非法流转在 transitionTicket 抛错）。 */
export const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ['in_progress', 'resolved', 'closed'],
  in_progress: ['resolved', 'closed', 'open'],
  resolved: ['closed', 'in_progress'], // resolved → in_progress 语义为 reopen
  closed: ['in_progress'], // closed → in_progress 语义为 reopen
};

export const TICKET_STATUSES: readonly TicketStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
export const TICKET_PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

/** SLA 响应时限（小时，按 priority 分级）。 */
export const SLA_HOURS: Record<TicketPriority, number> = {
  urgent: 2,
  high: 4,
  normal: 24,
  low: 72,
};

/** 生成工单号（cs-<timestamp36>-<rand>；P1 弱随机修复：crypto 随机替代 Math.random）。 */
export function newTicketId(): string {
  return `cs-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

/** 按 priority 计算 SLA 到期时间（ISO 字符串）。 */
function slaDueFrom(priority: string, fromIso: string): string {
  const p = (TICKET_PRIORITIES as readonly string[]).includes(priority) ? (priority as TicketPriority) : 'normal';
  return new Date(new Date(fromIso).getTime() + SLA_HOURS[p] * 3_600_000).toISOString();
}

function isTerminal(status: string): boolean {
  return status === 'resolved' || status === 'closed';
}

/** 读时附加计算字段（slaBreached）。 */
function decorate(row: TicketRow): TicketRow {
  const breached =
    !!row.slaDueAt && !isTerminal(row.status) && new Date(row.slaDueAt).getTime() < Date.now();
  return { ...row, slaBreached: breached };
}

const SELECT_COLS = `SELECT ticket_id AS ticketId, session_id AS sessionId, tenant_id AS tenantId, subject,
  channel, priority, status, assignee, created_at AS createdAt, updated_at AS updatedAt,
  sla_due_at AS slaDueAt, rating, rating_comment AS ratingComment, rated_at AS ratedAt FROM cs_ticket`;

/** 创建工单（status=open；SLA 按 priority 分级写入）。 */
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
  const priority = (TICKET_PRIORITIES as readonly string[]).includes(input.priority ?? '')
    ? (input.priority as TicketPriority)
    : 'normal';
  db.prepare(
    `INSERT INTO cs_ticket (ticket_id, session_id, tenant_id, subject, channel, priority, status, assignee, created_at, updated_at, sla_due_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  ).run(
    ticketId,
    input.sessionId ?? null,
    tenantId,
    input.subject,
    input.channel ?? null,
    priority,
    input.assignee ?? null,
    now,
    now,
    slaDueFrom(priority, now)
  );
  return getTicket(ticketId)!;
}

/**
 * 状态机流转：校验 current → target 合法后落库；非法流转抛错（附当前状态与合法目标）。
 * resolved/closed → in_progress 即 reopen（updated_at 刷新，SLA 不重算——考核口径保持创建时刻）。
 */
export function transitionTicket(ticketId: string, status: string): TicketRow | null {
  const target = status as TicketStatus;
  if (!(TICKET_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`非法工单状态：${status}（合法值：${TICKET_STATUSES.join('/')}）`);
  }
  const current = getTicket(ticketId);
  if (!current) return null;
  const from = current.status as TicketStatus;
  if (from === target) return current; // 幂等：同状态重复提交视为无操作
  const allowed = TICKET_TRANSITIONS[from] ?? [];
  if (!allowed.includes(target)) {
    throw new Error(`非法状态流转：${from} → ${target}（合法目标：${allowed.join('/') || '无'}）`);
  }
  const db = getDb();
  db.prepare(`UPDATE cs_ticket SET status=?, updated_at=? WHERE ticket_id=?`).run(
    target,
    new Date().toISOString(),
    ticketId
  );
  return getTicket(ticketId);
}

/** 更新工单（状态走状态机；优先级调整重算 SLA；评分不可经此修改）。 */
export function updateTicket(
  ticketId: string,
  patch: { status?: string; assignee?: string; priority?: string }
): TicketRow | null {
  const db = getDb();
  // 1) 状态机校验优先（先于其它字段落地，保证非法流转零副作用）。
  if (patch.status && !transitionTicket(ticketId, patch.status)) return null;
  // 2) 其余字段（assignee / priority+SLA 重算）。
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.assignee !== undefined) {
    sets.push('assignee=?');
    params.push(patch.assignee);
  }
  if (patch.priority !== undefined) {
    if (!(TICKET_PRIORITIES as readonly string[]).includes(patch.priority)) {
      throw new Error(`非法优先级：${patch.priority}（合法值：${TICKET_PRIORITIES.join('/')}）`);
    }
    sets.push('priority=?');
    params.push(patch.priority);
    sets.push('sla_due_at=?');
    params.push(slaDueFrom(patch.priority, new Date().toISOString()));
  }
  if (sets.length > 0) {
    sets.push('updated_at=?');
    params.push(new Date().toISOString());
    params.push(ticketId);
    db.prepare(`UPDATE cs_ticket SET ${sets.join(', ')} WHERE ticket_id=?`).run(...params);
  }
  return getTicket(ticketId);
}

/**
 * CSAT 评分：仅 resolved|closed 可评；一次性（已评复评抛错，评分不可篡改）。
 * rating 取整 1-5。
 */
export function rateTicket(ticketId: string, rating: number, comment?: string): TicketRow | null {
  const current = getTicket(ticketId);
  if (!current) return null;
  if (!isTerminal(current.status)) {
    throw new Error(`工单尚未结单（status=${current.status}），仅 resolved/closed 可评分`);
  }
  if (current.rating != null) {
    throw new Error(`工单已评分（${current.rating} 分），评分不可重复提交`);
  }
  const r = Math.round(Number(rating));
  if (!Number.isFinite(r) || r < 1 || r > 5) {
    throw new Error(`rating 必须为 1-5 的整数，收到：${rating}`);
  }
  const db = getDb();
  db.prepare(
    `UPDATE cs_ticket SET rating=?, rating_comment=?, rated_at=?, updated_at=? WHERE ticket_id=?`
  ).run(r, comment ?? null, new Date().toISOString(), new Date().toISOString(), ticketId);
  return getTicket(ticketId);
}

/** 按 id 取工单（含 SLA/CSAT 字段与 breached 计算）。 */
export function getTicket(ticketId: string): TicketRow | null {
  const db = getDb();
  const row = db.prepare(`${SELECT_COLS} WHERE ticket_id=?`).get(ticketId) as TicketRow | undefined;
  return row ? decorate(row) : null;
}

/** 按状态过滤工单（默认全部，最近 limit 条）；status='overdue' → 未结单且超 SLA。 */
export function listTickets(status?: string, limit = 50): TicketRow[] {
  const db = getDb();
  const lim = Math.min(Math.max(limit, 1), 500);
  if (status === 'overdue') {
    const rows = db
      .prepare(`${SELECT_COLS} WHERE status IN ('open','in_progress') AND sla_due_at < ? ORDER BY sla_due_at ASC LIMIT ?`)
      .all(new Date().toISOString(), lim);
    return (rows as TicketRow[]).map((r) => decorate(r));
  }
  const rows = status
    ? db.prepare(`${SELECT_COLS} WHERE status=? ORDER BY updated_at DESC LIMIT ?`).all(status, lim)
    : db.prepare(`${SELECT_COLS} ORDER BY updated_at DESC LIMIT ?`).all(lim);
  return (rows as TicketRow[]).map((r) => decorate(r));
}

/** SLA 超时扫描（cron 升级用）：未结单且超时的工单号列表。 */
export function listSlaBreachedIds(): Array<{ ticketId: string; priority: string }> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT ticket_id AS ticketId, priority FROM cs_ticket WHERE status IN ('open','in_progress') AND sla_due_at < ?`)
    .all(new Date().toISOString()) as Array<{ ticketId: string; priority: string }>;
  return rows;
}
