import type { ToolRegistry } from '@agent-harness/core';
import { handoffLead } from '../store';

/**
 * lead_handoff：把高意向/复杂诉求客资转给真人咨询师（A2A 或工单），标记 handedOff。
 */
export function registerHandoffTool(tools: ToolRegistry): void {
  tools.register(
    'lead_handoff',
    '当客资意向高、诉求复杂或需真人跟进时，转接咨询师/医助，并标记 handedOff。',
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
    async (args: Record<string, unknown>) => {
      const leadId = String(args.leadId ?? '').trim();
      if (!leadId) return { ok: false, error: 'leadId required' };
      handoffLead(leadId, args.reason ? String(args.reason) : undefined);
      return { ok: true, leadId, handedOff: true, message: '已转交咨询师跟进' };
    }
  );
}
