import type { ToolRegistry } from '@agent-harness/core';
import { bookConsultation } from '../services/schedule-service';
import { errorResult } from '../infra/errors';

/**
 * consultation_book：预约线下面诊/咨询（院区、日期、时段）。
 * 真实校验号源可用性（ma_clinic / ma_slot），事务内锁号 + 建预约单 + 推进 booked 阶段，
 * 并（若 HIS 已配置）真实同步预约单。号源满/不存在均据实报错，不再"假成功"。
 */
export function registerBookTool(tools: ToolRegistry): void {
  tools.register(
    'consultation_book',
    '为用户预约线下面诊/咨询（院区、日期、时段），真实校验号源可用性并锁号建单，推进到 booked 阶段。',
    {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: '客资 id' },
        clinic: { type: 'string', description: '院区 / 门店，如 上海静安院区（须为已导入的真实院区）' },
        date: { type: 'string', description: '预约日期 YYYY-MM-DD' },
        time: { type: 'string', description: '预约时段，如 14:30（须为该院区当日余位时段）' },
      },
      required: ['leadId', 'clinic', 'date', 'time'],
    },
    async (args: Record<string, unknown>) => {
      try {
        return bookConsultation({
          leadId: String(args.leadId ?? ''),
          clinic: String(args.clinic ?? ''),
          date: String(args.date ?? ''),
          time: String(args.time ?? ''),
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
