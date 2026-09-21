import type { ToolRegistry } from '@agent-harness/core';
import { buildLeadBriefing } from '../services/assist-service';
import { errorResult } from '../infra/errors';

/**
 * lead_briefing：咨询师辅助简报（C7）。
 *
 * 给定 leadId，产出结构化简报：画像 / 授权 / 脱敏联系方式 / 最近对话摘录 /
 * 预约与 SOP 触达记录 / 规则化跟进建议（建议为确定性规则推导，非模型生成）。
 * 联系方式默认脱敏；完整号码仅运营经 reveal 接口（管理令牌）获取。
 */
export function registerAssistTool(tools: ToolRegistry): void {
  tools.register(
    'lead_briefing',
    '生成指定客资的咨询师简报：画像、授权状态、脱敏联系方式、最近对话摘录、预约与自动触达记录、跟进建议。数据全部来自真实客资库，不存在则返回 NOT_FOUND。',
    {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: '客资线索 ID' },
      },
      required: ['leadId'],
    },
    async (args: Record<string, unknown>) => {
      const leadId = String(args.leadId ?? '').trim();
      if (!leadId) return { ok: false, code: 'INVALID_ARGUMENT', error: 'leadId required' };
      try {
        const briefing = await buildLeadBriefing(leadId);
        return { ok: true, briefing };
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
