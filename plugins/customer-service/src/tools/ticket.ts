import type { ToolRegistry } from '@agent-harness/core';
import { markHandoff, recordSatisfaction } from '../store';

/**
 * 注册客服工单类工具：转人工（ticket_create）+ 满意度（satisfaction_record）。
 * 同样用短名，由 loader 自动加 `customer-service__` 前缀合并进共享工具表。
 */
export function registerTicketTools(tools: ToolRegistry): void {
  // 转人工 / 创建工单
  tools.register(
    'ticket_create',
    '当用户问题无法解决、明确要求人工、或涉及敏感操作时，创建工单并转接人工客服。',
    {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '当前会话 id' },
        reason: { type: 'string', description: '转人工原因（如「退款金额确认」/「无法解决」）' },
        priority: { type: 'string', description: '优先级 low|normal|high', enum: ['low', 'normal', 'high'] },
      },
      required: ['sessionId', 'reason'],
    },
    async (args: Record<string, unknown>) => {
      const sessionId = String(args.sessionId ?? 'anonymous');
      const reason = String(args.reason ?? '用户要求转人工');
      markHandoff(sessionId);
      return { ok: true, handedOff: true, ticketId: `TK_${Date.now().toString(36)}`, reason };
    }
  );

  // 记录满意度评分
  tools.register(
    'satisfaction_record',
    '对话结束前记录用户对本次服务的满意度评分（1-5）。',
    {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '当前会话 id' },
        score: { type: 'number', description: '满意度评分 1-5' },
      },
      required: ['sessionId', 'score'],
    },
    async (args: Record<string, unknown>) => {
      const sessionId = String(args.sessionId ?? 'anonymous');
      const score = Number(args.score ?? 0);
      recordSatisfaction(sessionId, score);
      return { ok: true, score };
    }
  );
}
