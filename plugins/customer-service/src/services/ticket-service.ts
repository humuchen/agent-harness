/**
 * 工单服务：建单 / 查询 / 改状态（状态机）/ 认领 / CSAT 评分 / SLA 扫描。
 */
import {
  createTicket,
  updateTicket,
  getTicket,
  listTickets,
  rateTicket,
  listSlaBreachedIds,
  type TicketRow,
} from '../repo/ticket-repo';

/** 创建工单（返回工单号；SLA 按 priority 分级写入）。 */
export function openTicket(input: {
  sessionId?: string;
  subject: string;
  channel?: string;
  priority?: string;
  assignee?: string;
}): TicketRow {
  return createTicket(input);
}

/** 查询工单（按 id 或状态列表；status='overdue' → 未结单超 SLA）。 */
export function queryTicket(input: { ticketId?: string; status?: string }): TicketRow | TicketRow[] | null {
  if (input.ticketId) return getTicket(input.ticketId);
  return listTickets(input.status);
}

/** 改状态（状态机校验，非法流转抛错）。 */
export function changeStatus(input: { ticketId: string; status: string }): TicketRow | null {
  return updateTicket(input.ticketId, { status: input.status });
}

/** 认领/指派。 */
export function assign(input: { ticketId: string; assignee: string }): TicketRow | null {
  return updateTicket(input.ticketId, { assignee: input.assignee });
}

/** CSAT 评分（仅已结单、一次性）。 */
export function rate(input: { ticketId: string; rating: number; comment?: string }): TicketRow | null {
  return rateTicket(input.ticketId, input.rating, input.comment);
}

/**
 * SLA 超时升级（框架 cron 每 5min 调用）：未结单且超时的工单 priority 提到 urgent
 * 并重算 SLA。返回升级数量。已是 urgent 的保持（SLA 不再重推）。
 */
export function escalateSlaBreached(): number {
  let n = 0;
  for (const row of listSlaBreachedIds()) {
    if (row.priority === 'urgent') continue;
    updateTicket(row.ticketId, { priority: 'urgent' });
    n++;
  }
  return n;
}
