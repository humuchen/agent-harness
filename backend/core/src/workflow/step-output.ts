/**
 * 工作流 step 产出有效性检视（P4.5 共享基座：引擎出口闸门 + 黑板注记 + 确定性断言）。
 *
 * 背景：DagEngine 原语义是「executor 有返回即 done」——空串、护栏兜底话术、模型中断
 * 的 partial 产出都会以「成功」写入共享黑板并透明传播下游（计划任务显示 5/5 ✅
 * 而最终交付物缺失）。本模块提供纯函数检测器，把「无效产出」识别为一等信号：
 * - inspectStepOutput：产出五态分类（empty / partial / fallback / failed / ok）；
 * - 标记常量：harness 追加的异常前缀 / 兜底话术的单一事实源（harness.ts 引用本模块
 *   常量，检测器直接用，消灭字面量散落漂移）。
 *
 * 纪律：
 * - 纯函数、零运行时依赖（不碰 LLM / I/O），可独立单测（随 workflow 桶导出）；
 * - 只判「无效」（空 / 中断 / 兜底话术 / 异常前缀），不判「正确性」（那是 verify 门禁职责）；
 * - 非字符串产出（对象 / 数组）一律 ok（不越界做内容判断）；
 * - 检测顺序：empty > fallback > failed > partial（空优先；partial 与其余理论不共存）。
 */

/**
 * 模型因 provider 空闲超时中断生成的标记（harness 中段断流兜底时追加的固定前缀，
 * 见 harness.ts「生成已中断」提示）。下游注记 / 引擎闸门 / 确定性断言只认本常量。
 */
export const PARTIAL_NOTICE = '⚠️ 生成已中断';

/**
 * 护栏兜底话术前缀（开头子串）：harness 对注入信号重试仍拦截时的中性安全兜底
 * （完整句「抱歉，我暂时无法提供该内容的回复。如有进一步需求…」。以该前缀开头
 * 即视为「被护栏拦截、无实质产出」。
 */
export const GUARDRAIL_FALLBACK_PREFIX = '抱歉，我暂时无法提供该内容的回复';

/**
 * 「异常但非空」产出前缀（harness 异常路径 return 的固定文案，单一事实源）。
 *
 * 根因（P4.5 加固）：harness 的异常 / 超时 / 验证失败路径全部是**正常 return 带前缀
 * 的字符串**（不 throw），旧版 inspectStepOutput 只认 empty / fallback / partial，
 * 这些前缀全判 ok → 引擎出口闸门放行 → step 照样 done → 摘要 5/5 ✅ 而产出实为失败
 * （t4 [timeout]、t1 [verify:failed] 的同型问题）。现在统一识别为 failed 态。
 * 检测顺序在 partial 之前（前缀判定比标记判定更确定）。
 */
/** 运行期验证门禁未通过时 harness 追加的固定前缀（harness.ts「[verify:failed]」）。 */
export const VERIFY_FAILED_PREFIX = '[verify:failed]';
/** 看门狗 / 外部超时中止时 harness return 的固定文案（abortedMessage('timeout')）。 */
export const TIMEOUT_NOTICE = '[timeout] run exceeded time limit';
/** 运行抛异常时 harness return 的固定前缀（'[error] <msg>'）。 */
export const ERROR_PREFIX = '[error]';
/** 外部取消 / 无原因中止时 harness return 的固定前缀（'[aborted] ...'）。 */
export const ABORTED_PREFIX = '[aborted]';
/** 熔断打开时 harness return 的固定前缀（'[circuit-breaker] <msg>'）。 */
export const CIRCUIT_BREAKER_PREFIX = '[circuit-breaker]';
/** 达到 maxSteps 无最终回答时 harness 的初始哨兵 / 终止文案。 */
export const MAX_STEPS_NOTICE = '[agent] reached max steps without a final answer';

/** 产出有效性分类。 */
export type OutputIssue = 'ok' | 'empty' | 'partial' | 'fallback' | 'failed';

export interface OutputInspection {
  issue: OutputIssue;
  /** 说明（供失败信息 / 审计 / 执行详情抽屉），issue != 'ok' 时给出。 */
  detail?: string;
}

/** 「异常前缀」判定表（开头匹配，最确定的信号；partial 的「包含」判定排在其后）。 */
const FAILED_PREFIXES: Array<{ prefix: string; detail: string }> = [
  { prefix: VERIFY_FAILED_PREFIX, detail: '产出未通过运行期验证门禁（verify:failed）' },
  { prefix: TIMEOUT_NOTICE, detail: 'step 超时中止（看门狗掐断，无最终产出）' },
  { prefix: ERROR_PREFIX, detail: 'step 运行抛异常（[error] 前缀）' },
  { prefix: ABORTED_PREFIX, detail: 'step 被外部取消（[aborted] 前缀）' },
  { prefix: CIRCUIT_BREAKER_PREFIX, detail: 'step 被熔断拦截（[circuit-breaker] 前缀）' },
];

/**
 * 判定 step 产出是否有效：
 * - null / undefined（executor 未返回任何值）→ empty；
 * - 字符串：trim 后为空 → empty；以护栏兜底话术开头 → fallback；
 *   以异常前缀开头（verify:failed / timeout / error / aborted / circuit-breaker）
 *   或为 maxSteps 哨兵文案 → failed；含中断标记 → partial；
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
  // 异常前缀判定（开头匹配）——P4.5 加固：异常但非空的产出不再被当成功。
  for (const { prefix, detail } of FAILED_PREFIXES) {
    if (t.startsWith(prefix)) return { issue: 'failed', detail };
  }
  if (t === MAX_STEPS_NOTICE || t.startsWith(MAX_STEPS_NOTICE)) {
    return { issue: 'failed', detail: '达到最大步数无最终回答（[agent] max steps 哨兵）' };
  }
  if (t.includes(PARTIAL_NOTICE)) {
    return { issue: 'partial', detail: '产出含生成中断标记（模型流式超时，仅部分内容）' };
  }
  return { issue: 'ok' };
}
