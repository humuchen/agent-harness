// 计划 propose 强制收尾段（runInner 段 E10，P5 优化）：预算耗尽时补一次「无工具」
// 收尾 LLM 调用，基于已获取的信息直接输出计划/澄清 JSON，避免整轮调研白烧。
// P1#21 自 runInner 迁出，语句顺序与语义逐字等价。
import type { LLM, LLMResponse } from '../../types';
import type { CircuitBreaker } from '../../circuit-breaker';
import type { Memory } from '../../memory';
import { sanitizeToolPairing } from '../message-sanitizer';
import { structLog } from '../../telemetry';

export interface PlanFinalizeInput {
  memory: Memory;
  llm: LLM;
  circuitBreaker?: CircuitBreaker;
  signal: AbortSignal;
  /** run 级中止竞速 promise（resolve '__aborted__'）；收尾调用同走竞速。 */
  abortPromise: Promise<'__aborted__'>;
  runId: string;
}

/**
 * 返回收尾产出的计划/澄清 JSON 文本；调用失败或仍无内容时返回 null
 * （调用方回退 MAX_STEPS_NOTICE，与拆分前一致）。
 */
export async function planProposeFinalize(input: PlanFinalizeInput): Promise<string | null> {
  const { memory, llm, circuitBreaker, signal, abortPromise, runId } = input;
  try {
    memory.add({
      role: 'user',
      content:
        '（系统提示）规划预算已用尽，请立即停止调研。基于以上已获取的信息直接输出最终结果：' +
        '需求清晰时输出计划 JSON（信息不足的任务在 expectedOutput 中显式标注数据缺口），' +
        '需求不清时输出澄清 JSON（{"clarify": true, "goalDraft": string, "questions": string[]}）。' +
        '只输出一个 JSON 对象，不要任何其他文字。'
    });
    // P1 可靠性修复：收尾调用与主循环对齐——纳入 abortPromise 竞速 + 兜底
    // catch（旧实现裸 await：适配器不尊重 signal 时硬超时看门狗无法打断；
    // catch 静默吞错且无遥测留痕）。
    const finCall = llm(sanitizeToolPairing(memory.history()), [], {
      signal,
      circuitBreaker
    });
    void finCall.catch(() => {});
    const finResult = await Promise.race([
      finCall,
      abortPromise.then((v) => {
        if (v === '__aborted__') throw new DOMException('aborted', 'AbortError');
        return v as never;
      })
    ]);
    const finResp = finResult as LLMResponse | undefined;
    if (finResp?.content && finResp.content.trim()) {
      memory.add({ role: 'assistant', content: finResp.content });
      return finResp.content;
    }
    structLog('warn', 'plan propose finalize produced no content; fallback to notice', {
      runId
    });
  } catch (e) {
    // 收尾调用失败（网络/熔断/中止）：回退到默认 MAX_STEPS_NOTICE；留痕便于排查。
    structLog('warn', 'plan propose finalize failed; fallback to notice', {
      runId,
      error: e instanceof Error ? e.message : String(e)
    });
  }
  return null;
}
