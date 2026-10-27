// 单步 LLM 调用 + 溢出自愈 + 智能兜底（runInner 段 E4）。
// P1#21 H3 自 runInner 迁出：溢出重试循环、abort 竞速、未知工具 schema 扩展、
// 流式增量缓冲，数值与语义逐字等价。实例字段（overflowShrink / maxAcceptedPrompt）
// 经返回值写回（与 usage-accounting 同模式），杜绝跨函数的实例字段隐式写。
import type { LLM, LLMResponse, ToolSchema } from '../../types';
import type { Message } from '../../types';
import type { CircuitBreaker } from '../../circuit-breaker';
import type { Memory } from '../../memory';
import { isContextOverflowError } from '../context-window';
import { sanitizeToolPairing } from '../message-sanitizer';
import { withSpan, structLog } from '../../telemetry';
import type { HarnessEvent } from '../types';

export interface LoopLlmInput {
  llm: LLM;
  circuitBreaker?: CircuitBreaker;
  streamTokens?: boolean;
  /** 进入本步时的记忆快照（溢出自愈可能重建，经返回值写回）。 */
  messages: Message[];
  /** 发送给 LLM 的 schema 子集（未知工具兜底可能扩为全量，经返回值写回）。 */
  stepTools: ToolSchema[];
  allSchemas: ToolSchema[];
  /** 动态工具选择是否开启（未知工具兜底的前置条件）。 */
  dynamicOn: boolean;
  signal: AbortSignal;
  abortPromise: Promise<'__aborted__'>;
  memory: Memory;
  overflowShrink: boolean;
  maxAcceptedPrompt: number;
  steps: number;
  runId: string;
  emit: (e: HarnessEvent) => void;
  /**
   * 中止结果文本（调用方闭包：abortedMessage / salvagePartial 依赖外部 streamBuffer——
   * 中止路径调用方须先把返回的 streamBuffer 写回再调用本回调）。
   */
  abortedResult: () => string;
}

export interface LoopLlmState {
  resp: LLMResponse | null;
  /** 溢出自愈可能重建后的 messages（写回 runLoop 局部）。 */
  messages: Message[];
  /** 未知工具扩展可能扩为全量后的 stepTools（写回 runLoop 局部）。 */
  stepTools: ToolSchema[];
  streamedTokens: boolean;
  /** 本次 LLM 调用已流式产出的内容（硬中止抢救用；调用方写回 runLoop 局部）。 */
  streamBuffer: string;
  overflowShrink: boolean;
  maxAcceptedPrompt: number;
  /** 任一中止出口命中——调用方据此 `return abortedResult()`。 */
  aborted: boolean;
}

export async function callLlmWithSelfHeal(input: LoopLlmInput): Promise<LoopLlmState> {
  const { llm, signal, abortPromise, memory, emit, runId, steps } = input;
  let messages = input.messages;
  let stepTools = input.stepTools;
  let streamedTokens = false;
  let streamBuffer = '';
  let overflowShrink = input.overflowShrink;
  // 只读透传（溢出分支读 basis、返回写回），溢出时写的是 overflowShrink。
  const maxAcceptedPrompt = input.maxAcceptedPrompt;
  let resp: LLMResponse | null = null;
  let aborted = false;

  // 上下文溢出自愈：LLM 返回「超出上下文窗口」类错误（免费模型真实窗口常远小于
  // 配置/回退值 128K）时，逐步压缩历史后重试，而非让整轮运行失败、卡死无回应。
  const OVERFLOW_MAX_RETRIES = 4;
  for (let llmAttempt = 0; llmAttempt <= OVERFLOW_MAX_RETRIES; llmAttempt++) {
    if (signal.aborted) {
      aborted = true;
      break;
    }
    try {
      const llmCall = llm(messages, stepTools, {
        signal,
        circuitBreaker: input.circuitBreaker,
        ...(input.streamTokens
          ? {
              onToken: (delta: string) => {
                streamedTokens = true;
                streamBuffer += delta; // P4.8：留存增量，供硬中止抢救
                emit({ type: 'llm:token', step: steps, delta });
              },
              onReasoning: (delta: string) => {
                emit({ type: 'llm:reasoning', step: steps, delta });
              }
            }
          : {})
      });
      // 防御：abort/超时竞速获胜后，底层调用 rejection 无人接住会触发
      // unhandledRejection（Node ≥15 默认 crash）。挂一条兜底 catch，
      // 不影响竞速正常路径的异常传播（race 仍会收到原始 rejection）。
      void llmCall.catch(() => {});
      const raceResult = await withSpan('llm.call', () =>
        Promise.race([llmCall, abortPromise])
      );
      if (raceResult === '__aborted__') {
        aborted = true;
        break;
      }
      resp = raceResult as LLMResponse;
      // 智能兜底：动态选择只发了子集时，模型可能「点名」一个未发出的工具。
      //  - 该工具在全量注册表（执行注册表始终全量）中存在：直接交给执行分支即可，
      //    绝不可重发 schema 重试——否则会丢弃模型已给出的有效 tool_call（曾经的
      //    实现因此让 builtin__jev_decide 等核心工具「点了名却没执行」）。
      //  - 该工具全量注册表中也不存在（模型幻觉的未知工具名）：扩展到全量 schema
      //    重试一次，让模型改选真实工具。至多扩展一次（扩展后 stepTools === allSchemas
      //    条件不再成立），不会死循环。
      const requestedOutside = (resp.tool_calls ?? []).filter(
        (tc) => !stepTools.find((s) => s.name === tc.name)
      );
      if (requestedOutside.length > 0 && input.dynamicOn && stepTools !== input.allSchemas) {
        const unknown = requestedOutside.filter(
          (tc) => !input.allSchemas.find((s) => s.name === tc.name)
        );
        if (unknown.length > 0) {
          stepTools = input.allSchemas;
          structLog('info', 'model requested unknown tool(s); expanding to full schema and retrying', {
            unknown: unknown.map((t) => t.name),
            runId
          });
          continue;
        }
        // 否则：工具已注册但不在子集——不重发，直接执行（见上方说明）。
      }
      break;
    } catch (llmErr) {
      if (isContextOverflowError(llmErr) && llmAttempt < OVERFLOW_MAX_RETRIES) {
        overflowShrink = true;
        // 自适应收窄：有成功样本用「样本 × 0.6」，否则用当前历史估算的一半，逐次收敛。
        const basis =
          maxAcceptedPrompt > 0 ? maxAcceptedPrompt : memory.historyTokens();
        const newBudget = Math.max(256, Math.floor(basis * 0.6));
        const shrank = memory.fitToBudget(newBudget);
        structLog('warn', 'context overflow, shrinking history and retrying LLM call', {
          attempt: llmAttempt,
          newBudget,
          shrank,
          runId
        });
        messages = sanitizeToolPairing(memory.history());
        continue;
      }
      throw llmErr;
    }
  }

  return { resp, messages, stepTools, streamedTokens, streamBuffer, overflowShrink, maxAcceptedPrompt, aborted };
}
