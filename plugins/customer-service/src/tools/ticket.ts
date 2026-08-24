import type { ToolRegistry } from '@agent-harness/core';
import { openTicket, queryTicket, changeStatus, assign } from '../services/ticket-service';
import { errorResult } from '../infra/errors';

/**
 * cs_ticket_create / cs_ticket_query：工单创建与查询。
 * 工具名用短名，loader 启用时自动加 `customer-service__` 前缀合并进共享工具表。
 */
export function registerTicketTools(tools: ToolRegistry): void {
  tools.register(
    'cs_ticket_create',
    '当客户问题无法当场解决时创建工单，返回工单号；可选关联会话、渠道、优先级。',
    {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '关联会话 id（可选）' },
        subject: { type: 'string', description: '工单主题 / 客户诉求摘要' },
        channel: { type: 'string', description: '来源渠道：web/app/wechat/phone/其它' },
        priority: { type: 'string', description: '优先级 low/normal/high/urgent', enum: ['low', 'normal', 'high', 'urgent'] },
        assignee: { type: 'string', description: '指派坐席（可选）' },
      },
      required: ['subject'],
    },
    async (args: Record<string, unknown>) => {
      try {
        const t = openTicket({
          sessionId: args.sessionId ? String(args.sessionId) : undefined,
          subject: String(args.subject ?? ''),
          channel: args.channel ? String(args.channel) : undefined,
          priority: args.priority ? String(args.priority) : undefined,
          assignee: args.assignee ? String(args.assignee) : undefined,
        });
        return { ticketId: t.ticketId, status: t.status };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  tools.register(
    'cs_ticket_query',
    '按工单号查询单条工单，或不传 ticketId 时按状态列出工单（open/pending/resolved/closed）。',
    {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: '工单号（与 status 二选一）' },
        status: { type: 'string', description: '状态过滤：open/pending/resolved/closed' },
      },
      required: [],
    },
    async (args: Record<string, unknown>) => {
      try {
        const ticketId = args.ticketId ? String(args.ticketId) : undefined;
        const status = args.status ? String(args.status) : undefined;
        if (!ticketId && !status) return { error: true, message: 'provide ticketId or status' };
        return queryTicket({ ticketId, status });
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
