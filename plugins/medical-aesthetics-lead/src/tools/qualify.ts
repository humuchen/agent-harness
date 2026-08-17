import type { ToolRegistry } from '@agent-harness/core';
import { upsertLead, attachCurrentRunTranscript } from '../store';
import type { LeadGrade } from '../store';

/**
 * lead_qualify：结构化抽取抖音/小红书私信中的客资要素，并做 A/B/C/D 分级，写回共享存储。
 * 工具名用短名，loader 启用时自动加 `medical-aesthetics-lead__` 前缀合并进共享工具表。
 */
export function registerQualifyTool(tools: ToolRegistry): void {
  tools.register(
    'lead_qualify',
    '从用户私信/对话中抽取客资关键信息（项目/预算/城市/诉求），判定意向等级 A/B/C/D 并写回客资库。',
    {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: '客资唯一 id（可用 channel_sessionId 或手机号）' },
        channel: { type: 'string', description: '获客渠道：抖音/小红书/微信/美团/官网/其它' },
        project: { type: 'string', description: '意向项目，如 双眼皮/玻尿酸/热玛吉' },
        budget: { type: 'string', description: '预算区间，如 1-3万' },
        city: { type: 'string', description: '所在城市' },
        intent: { type: 'string', description: '核心诉求 / 一句话画像' },
        grade: { type: 'string', description: '意向等级 A(高意向)/B(有意向)/C(观望)/D(无效)', enum: ['A', 'B', 'C', 'D'] },
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
      // 把「当前这次对话」的 transcript 补录到线索上（仅当线索已存在时；绝不凭空建档）。
      attachCurrentRunTranscript(leadId);
      return {
        ok: true,
        leadId,
        grade,
        stage: 'qualified',
        nextStep:
          grade === 'A' || grade === 'B'
            ? '主动私信引导留资 / 预约到店'
            : '进入观望池，定期内容触达',
      };
    }
  );
}
