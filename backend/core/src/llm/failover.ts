import type { LLM, Message, ToolSchema, LLMResponse, LLMCallOptions } from '../types';
import { CircuitBreaker, type CircuitState } from '../circuit-breaker';
import { incCounter, structLog } from '../telemetry';

export interface FailoverOptions {
  // 连续失败多少次后熔断（打开电路，转走 secondary）。默认 3。
  failThreshold?: number;
  // 熔断打开后多久进入 half-open（尝试 primary 一次）。默认 60_000ms。
  cooldownMs?: number;
  // 是否在 primary 抛错时立即用 secondary 兜底本次调用（默认 true）。
  // 关闭后仅靠熔断切换，primary 单次失败会直接抛给调用方。
  immediateFallback?: boolean;
  // primary 的可观测标签（用于日志 / 指标）。
  primaryLabel?: string;
  secondaryLabel?: string;
}

/**
 * 带「熔断 + 故障转移」的 LLM 包装器（P1-11）。
 *
 * - 电路闭合：调 primary；成功 → 复位失败计数；失败 → 计数+1，达阈值即打开电路，
 *   并（若 immediateFallback）本次改用 secondary 兜底。
 * - 电路打开：超过 cooldownMs 后进入 half-open，试 primary 一次；成功 → 闭合，失败 → 重新打开。
 *   未到 cooldown 则直接走 secondary。
 * - secondary 也失败时抛出最后一个错误（保留 primary 的错误信息以便排查）。
 *
 * 用于在 OpenRouter 抖动 / 限流时自动回落到原生 OpenAI 端点，对 harness 主循环透明。
 */
export function createFailoverLLM(primary: LLM, secondary: LLM, opts: FailoverOptions = {}): LLM {
  const failThreshold = Math.max(1, opts.failThreshold ?? 3);
  const cooldownMs = Math.max(0, opts.cooldownMs ?? 60_000);
  const immediateFallback = opts.immediateFallback ?? true;
  const primaryLabel = opts.primaryLabel ?? 'primary';
  const secondaryLabel = opts.secondaryLabel ?? 'secondary';

  // P1#23 统一熔断：状态机收敛到共享 CircuitBreaker（此前手写 openedAt 状态机，
  // 与 circuit-breaker.ts / multi-key.ts 三处各写一遍且行为细节不一致——本项目
  // 三处都曾出现过状态机边缘 bug 的修复注释，正是该模式易错明的实证）。
  // 指标/日志经 onTransition 挂接，语义与旧版一致。
  const breaker = new CircuitBreaker({
    failureThreshold: failThreshold,
    timeoutMs: cooldownMs,
    name: `failover:${primaryLabel}`,
    onTransition: (from: CircuitState, to: CircuitState) => {
      if (to === 'open') {
        const reopen = from === 'half-open';
        incCounter('llm.circuit.open');
        structLog('warn', 'llm circuit opened, routing to secondary', {
          primary: primaryLabel,
          secondary: secondaryLabel,
          cooldownMs,
          reopen,
        });
      } else if (to === 'closed') {
        incCounter('llm.circuit.close');
        structLog('info', 'llm circuit closed, primary recovered', { primary: primaryLabel });
      }
    },
  });

  const circuitOpen = (): boolean => breaker.currentState === 'open';

  return async function failoverLLM(
    messages: Message[],
    tools: ToolSchema[],
    options?: LLMCallOptions
  ): Promise<LLMResponse> {
    // 电路打开：直接走 secondary。
    if (circuitOpen()) {
      return trySecondary(messages, tools, options, undefined);
    }
    // 电路闭合 / 半开（探活）：试 primary。失败计数、阈值开关、half-open 探活失败
    // 重新打开均由共享 CircuitBreaker 处理（含其历史边缘 bug 的修复语义）。
    let primaryErr: unknown;
    try {
      const resp = await breaker.withRequest(() => primary(messages, tools, options));
      return resp;
    } catch (e) {
      primaryErr = e;
    }
    incCounter('llm.primary.fail');
    structLog('warn', 'primary llm failed', {
      primary: primaryLabel,
      attempt: breaker.snapshot().consecutiveFailures,
      error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
    });
    // immediateFallback=false 且电路仍闭合（未达阈值 / 并发打开瞬间）：原样上抛。
    if (!immediateFallback && !circuitOpen()) {
      throw primaryErr;
    }
    // 落到 secondary 兜底。
    return trySecondary(messages, tools, options, primaryErr);
  };

  async function trySecondary(
    messages: Message[],
    tools: ToolSchema[],
    options: LLMCallOptions | undefined,
    primaryErr: unknown
  ): Promise<LLMResponse> {
    try {
      const resp = await secondary(messages, tools, options);
      incCounter('llm.secondary.success');
      return resp;
    } catch (secondaryErr: any) {
      incCounter('llm.secondary.fail');
      structLog('error', 'secondary llm also failed', {
        secondary: secondaryLabel,
        error: secondaryErr?.message ?? String(secondaryErr),
      });
      // 抛出 primary 的错误（更可能是根因），便于排查；若 primary 无错（电路打开直接走 secondary）则抛 secondary。
      throw primaryErr ?? secondaryErr;
    }
  }
}
