import type { ToolRegistry } from '@agent-harness/core';
import { upsertLead } from '../store';
import type { LeadGrade } from '../store';

/**
 * lead_qualify：从抖音/小红书私信、微信对话中抽取客资要素，打 A/B/C/D 意向等级并写回客资库。
 * 工具名用短名 `lead_qualify`，loader 启用时自动加 `medical-aesthetics-lead__` 前缀合并进共享工具表，
 * server 的 assembleAgent 再把它并运行，模型即可调用。
 */
export function registerQualifyTool(tools: ToolRegistry): void {
  tools.register(
    'lead_qualify',
    '从用户私信/对话中抽取客资关键信息（项目/预算/城市/诉求），判定意向等级 A/B/C/D 并写回客资库。',
    {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: '客资唯一 id（建议 channel_sessionId 或手机号）' },
        channel: { type: 'string', description: '获客渠道：抖音/小红书/微信/美团/官网/其它' },
        project: { type: 'string', description: '意向项目，如 双眼皮/玻尿酸/热玛吉' },
        budget: { type: 'string', description: '预算区间，如 1-3万' },
        city: { type: 'string', description: '所在城市' },
        intent: { type: 'string', description: '核心诉求 / 一句话画像' },
        grade: {
          type: 'string',
          description: '意向等级：A(高意向,已明确项目+预算) / B(有意向) / C(观望) / D(无效/同行)',
          enum: ['A', 'B', 'C', 'D'],
        },
      },
      required: ['leadId', 'channel', 'grade'],
    },
    async (args: Record<string, unknown>) => {
      const leadId = String(args.leadId ?? '').trim();
      if (!leadId) return { ok: false, error: 'leadId required' };
      const grade = (['A', 'B', 'C', 'D'].includes(String(args.grade)) ? String(args.grade) : 'C') as LeadGrade;
      upsertLead(leadId, {
        channel: String(args.channel ?? 'unknown'),
        project: args.project ? String(args.project) : undefined,
        budget: args.budget ? String(args.budget) : undefined,
        city: args.city ? String(args.city) : undefined,
        source: args.intent ? String(args.intent) : undefined,
        grade,
        stage: 'qualified',
      });
      return {
        ok: true,
        leadId,
        grade,
        stage: 'qualified',
        nextStep:
          grade === 'A' || grade === 'B'
            ? '主动私信引导留资 / 预约到店'
            : '进入观望池，以科普内容定期触达',
      };
    }
  );
}
