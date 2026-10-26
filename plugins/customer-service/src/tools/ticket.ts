import type { ToolRegistry } from '@agent-harness/core';
import { openTicket, queryTicket, changeStatus, assign, rate } from '../services/ticket-service';
import { errorResult } from '../infra/errors';

/**
 * cs_ticket_create / cs_ticket_query / cs_ticket_rate：工单创建、查询与 CSAT 评分。
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
    '按工单号查询单条工单，或不传 ticketId 时按状态列出工单（open/in_progress/resolved/closed；overdue=未结单且超 SLA）。结果带 slaDueAt/slaBreached/rating 字段。',
    {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: '工单号（与 status 二选一）' },
        status: { type: 'string', description: '状态过滤：open/in_progress/resolved/closed/overdue' },
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

  tools.register(
    'cs_ticket_rate',
    '客户满意度评价（CSAT）：对已结单（resolved/closed）的工单提交 1-5 分评分，一次性不可复评；结单前调用会失败。',
    {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: '工单号' },
        rating: { type: 'number', description: '满意度 1-5（5 = 非常满意）' },
        comment: { type: 'string', description: '评价附言（可选）' },
      },
      required: ['ticketId', 'rating'],
    },
    async (args: Record<string, unknown>) => {
      try {
        const t = rate({
          ticketId: String(args.ticketId ?? ''),
          rating: Number(args.rating),
          comment: args.comment ? String(args.comment) : undefined,
        });
        if (!t) return { error: true, message: 'ticket not found' };
        return { ticketId: t.ticketId, rating: t.rating, status: t.status };
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
