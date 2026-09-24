import type { ToolRegistry } from '@agent-harness/core';
import { handoffLead } from '../services/lead-service';
import { errorResult } from '../infra/errors';
import { resolveLeadIdForSession } from '../infra/lead-binding';

/**
 * lead_handoff：把高意向/复杂诉求客资转给真人咨询师（标记 handedOff + 推进到 arrived），
 * 并异步同步 CRM。不再"无论结果都返回 ok"，同步状态如实反映（pending/disabled）。
 * P1 安全：leadId 经 session 绑定校验，防注入对任意他人客资触发 handoff 骚扰。
 */
export function registerHandoffTool(tools: ToolRegistry): void {
  tools.register(
    'lead_handoff',
    '当客资意向高、诉求复杂或需真人跟进时，转接咨询师/医助，标记 handedOff 并推进到 arrived 阶段（真实落库，异步同步 CRM）。',
    {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: '客资 id' },
        reason: {
          type: 'string',
          description: '转人工原因，如 高意向需面诊设计 / 价格敏感需专属报价 / 诉求复杂',
        },
      },
      required: ['leadId'],
    },
    async (args: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      try {
        const bound = resolveLeadIdForSession(ctx, String(args.leadId ?? ''));
        if (!bound.ok) return errorResult(new Error(bound.reason), 'INVALID_ARGUMENT');
        return await handoffLead({
          leadId: bound.leadId,
          reason: args.reason ? String(args.reason) : undefined,
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
