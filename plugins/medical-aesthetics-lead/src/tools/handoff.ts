import type { ToolRegistry } from '@agent-harness/core';
import { handoffLead } from '../services/lead-service';
import { errorResult } from '../infra/errors';

/**
 * lead_handoff：把高意向/复杂诉求客资转给真人咨询师（标记 handedOff + 推进到 arrived），
 * 并异步同步 CRM。不再"无论结果都返回 ok"，同步状态如实反映（pending/disabled）。
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
    async (args: Record<string, unknown>) => {
      try {
        return handoffLead({
          leadId: String(args.leadId ?? ''),
          reason: args.reason ? String(args.reason) : undefined,
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
