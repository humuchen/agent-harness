/**
 * 工作流 step 产出有效性检视（P4.5 共享基座：引擎出口闸门 + 黑板注记 + 确定性断言）。
 *
 * 背景：DagEngine 原语义是「executor 有返回即 done」——空串、护栏兜底话术、模型中断
 * 的 partial 产出都会以「成功」写入共享黑板并透明传播下游（计划任务显示 5/5 ✅
 * 而最终交付物缺失）。本模块提供纯函数检测器，把「无效产出」识别为一等信号：
 * - inspectStepOutput：产出四态分类（empty / partial / fallback / ok）；
 * - 标记常量：harness 追加分隔 / 兜底话术的单一事实源（harness.ts 改引用本常量，
 *   检测器直接用，消灭字面量散落漂移）。
 *
 * 纪律：
 * - 纯函数、零运行时依赖（不碰 LLM / I/O），可独立单测（随 workflow 桶导出）；
 * - 只判「无效」（空 / 中断标记 / 兜底话术），不判「正确性」（那是 verify 门禁职责）；
 * - 非字符串产出（对象 / 数组）一律 ok（不越界做内容判断）；
 * - 检测顺序：empty > fallback > partial（空优先；partial 与 fallback 理论不共存）。
 */

/**
 * 模型因 provider 空闲超时中断生成的标记（harness 中段断流兜底时追加的固定前缀，
 * 见 harness.ts「生成已中断」提示）。下游注记 / 引擎闸门 / 确定性断言只认本常量。
 */
export const PARTIAL_NOTICE = '⚠️ 生成已中断';

/**
 * 护栏兜底话术前缀（开头子串）：harness 对注入信号重试仍拦截时的中性安全兜底
 * （完整句「抱歉，我暂时无法提供该内容的回复。如有进一步需求…」）。以该前缀开头
 * 即视为「被护栏拦截、无实质产出」。
 */
export const GUARDRAIL_FALLBACK_PREFIX = '抱歉，我暂时无法提供该内容的回复';

/** 产出有效性分类。 */
export type OutputIssue = 'ok' | 'empty' | 'partial' | 'fallback';

export interface OutputInspection {
  issue: OutputIssue;
  /** 说明（供失败信息 / 审计 / 执行详情抽屉），issue != 'ok' 时给出。 */
  detail?: string;
}

/**
 * 判定 step 产出是否有效：
 * - null / undefined（executor 未返回任何值）→ empty；
 * - 字符串：trim 后为空 → empty；以护栏兜底话术开头 → fallback；含中断标记 → partial；
 * - 其它（对象 / 数组 / 数字）→ ok（不越界判断内容）。
 */
export function inspectStepOutput(result: unknown): OutputInspection {
  if (result == null) return { issue: 'empty', detail: 'step 未返回任何产出（null/undefined）' };
  if (typeof result !== 'string') return { issue: 'ok' };
  const t = result.trim();
  if (t === '') return { issue: 'empty', detail: 'step 产出为空' };
  if (t.startsWith(GUARDRAIL_FALLBACK_PREFIX)) {
    return { issue: 'fallback', detail: '产出为护栏兜底话术（被注入护栏拦截，无实质内容）' };
  }
  if (t.includes(PARTIAL_NOTICE)) {
    return { issue: 'partial', detail: '产出含生成中断标记（模型流式超时，仅部分内容）' };
  }
  return { issue: 'ok' };
}
