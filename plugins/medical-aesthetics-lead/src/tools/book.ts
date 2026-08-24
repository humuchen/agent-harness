import type { ToolRegistry } from '@agent-harness/core';
import { bookConsultation } from '../services/schedule-service';
import { toMaError } from '../infra/errors';
import { handoffLead } from '../services/lead-service';

/**
 * consultation_book：预约线下面诊/咨询（院区、日期、时段）。
 * 真实校验号源可用性（ma_clinic / ma_slot），事务内锁号 + 建预约单 + 推进 booked 阶段，
 * 并（若 HIS 已配置）真实同步预约单。号源满/不存在均据实报错，不再"假成功"。
 *
 * 【硬兜底（防"口头承诺转人工但队列为空"）】：
 * 非 INVALID_ARGUMENT 的失败（NOT_CONFIGURED / NOT_FOUND / CONFLICT / UPSTREAM_* / DB_ERROR）
 * = 系统/号源侧不可自愈——模型重试同一参数不会成功，且高意向客资不能无人跟进。
 * 因此工具层在返回错误的同时**自动调用 lead_handoff 落库**，并把 autoHandoff 结果回灌模型，
 * 让模型据实告知用户"已转交咨询师"，而不是编造跟进方式或只口头承诺。
 * INVALID_ARGUMENT（模型参数传错）不触发：属于模型可自愈的调用错误，应修正参数重试。
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
      const leadId = String(args.leadId ?? '').trim();
      const clinic = String(args.clinic ?? '').trim();
      const date = String(args.date ?? '').trim();
      const time = String(args.time ?? '').trim();
      try {
        return bookConsultation({ leadId, clinic, date, time });
      } catch (e) {
        const err = toMaError(e, 'UPSTREAM_ERROR');
        // 硬兜底：系统/号源侧不可自愈的失败 → 自动转人工落库（幂等，同 leadId 重复调用无害）
        if (err.code !== 'INVALID_ARGUMENT' && leadId) {
          try {
            const h = handoffLead({
              leadId,
              reason:
                `booking-failed:${err.code} 用户选定院区=${clinic || '?'} ` +
                `日期=${date || '?'} 时段=${time || '?'}（${err.message}）`,
            });
            return {
              ...err.toJSON(),
              autoHandoff: { handedOff: true, leadId: h.leadId, stage: h.stage },
            };
          } catch {
            // 兜底失败（如 DB 异常）不阻断原错误返回，由模型按提示词纪律处理
          }
        }
        return err.toJSON();
      }
    }
  );
}
