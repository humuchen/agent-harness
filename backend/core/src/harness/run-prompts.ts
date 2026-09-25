/**
 * 运行收尾提示与中止文案（P1-2：从 harness.ts 拆出）。
 *
 * 职责：
 *   - WRAP_UP_PROMPT：软截止（P4.8）收尾提示，接近时间预算时注入，
 *     让模型基于已有信息直接给最终结果（把「硬超时砍掉产出」变成「主动收尾交付」）；
 *   - abortedMessage：根据中止原因生成人类可读的结果提示。
 *
 * 纯常量 + 纯函数，无副作用。
 */
import { TIMEOUT_NOTICE, ABORTED_PREFIX } from '../workflow/step-output';

/**
 * P4.8 软截止收尾提示：接近时间预算时注入，让模型基于已有信息直接给最终结果。
 * 目的是把「硬超时砍掉产出」变成「主动收尾交付」；同时要求显式标注数据缺口，
 * 保持与 planner/executor 既有「数据不足如实说明、禁止编造」约定一致。
 */
export const WRAP_UP_PROMPT =
  '（系统提示）本次运行的时间预算即将耗尽，请立即停止进一步调研与工具调用，' +
  '基于已获取的信息直接输出最终结果：把已确认的内容完整写出，' +
  '尚未获取到的部分在结果中显式标注「数据缺口」说明，不要编造。';

/** 根据中止原因生成人类可读的结果提示。 */
export function abortedMessage(signal: AbortSignal): string {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason === 'timeout') return TIMEOUT_NOTICE;
  if (reason === 'external') return `${ABORTED_PREFIX} run cancelled by caller`;
  return `${ABORTED_PREFIX} run cancelled`;
}
