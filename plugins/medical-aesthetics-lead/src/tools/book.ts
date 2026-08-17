import type { ToolRegistry } from '@agent-harness/core';
import { bookLead } from '../store';

/**
 * consultation_book：预约线下面诊/咨询（院区、日期、时段），推进到 booked 阶段。
 */
export function registerBookTool(tools: ToolRegistry): void {
  tools.register(
    'consultation_book',
    '为用户预约线下面诊/咨询（院区、日期、时段），推进到 booked 阶段。',
    {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: '客资 id' },
        clinic: { type: 'string', description: '院区 / 门店，如 上海静安院区' },
        date: { type: 'string', description: '预约日期 YYYY-MM-DD' },
        time: { type: 'string', description: '预约时段，如 14:30' },
      },
      required: ['leadId', 'clinic', 'date', 'time'],
    },
    async (args: Record<string, unknown>) => {
      const leadId = String(args.leadId ?? '').trim();
      if (!leadId) return { ok: false, error: 'leadId required' };
      bookLead(leadId, {
        clinic: String(args.clinic),
        date: String(args.date),
        time: String(args.time),
      });
      return {
        ok: true,
        leadId,
        stage: 'booked',
        booking: { clinic: args.clinic, date: args.date, time: args.time },
      };
    }
  );
}
