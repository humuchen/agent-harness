/**
 * 工单服务：建单 / 查询 / 改状态 / 认领。
 */
import {
  createTicket,
  updateTicket,
  getTicket,
  listTickets,
  type TicketRow,
} from '../repo/ticket-repo';

/** 创建工单（返回工单号）。 */
export function openTicket(input: {
  sessionId?: string;
  subject: string;
  channel?: string;
  priority?: string;
  assignee?: string;
}): TicketRow {
  return createTicket(input);
}

/** 查询工单（按 id 或状态列表）。 */
export function queryTicket(input: { ticketId?: string; status?: string }): TicketRow | TicketRow[] | null {
  if (input.ticketId) return getTicket(input.ticketId);
  return listTickets(input.status);
}

/** 改状态。 */
export function changeStatus(input: { ticketId: string; status: string }): TicketRow | null {
  return updateTicket(input.ticketId, { status: input.status });
}

/** 认领/指派。 */
export function assign(input: { ticketId: string; assignee: string }): TicketRow | null {
  return updateTicket(input.ticketId, { assignee: input.assignee });
}
