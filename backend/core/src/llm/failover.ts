import type { LLM, Message, ToolSchema, LLMResponse, LLMCallOptions } from '../types';
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

  let consecutiveFails = 0;
  let openedAt = 0; // 0 = 电路闭合

  function circuitOpen(): boolean {
    return openedAt > 0 && Date.now() - openedAt < cooldownMs;
  }
  function openCircuit(): void {
    if (openedAt === 0) {
      openedAt = Date.now();
      incCounter('llm.circuit.open');
      structLog('warn', 'llm circuit opened, routing to secondary', {
        primary: primaryLabel,
        secondary: secondaryLabel,
        cooldownMs,
      });
    }
  }
  function closeCircuit(): void {
    if (openedAt !== 0) {
      openedAt = 0;
      consecutiveFails = 0;
      incCounter('llm.circuit.close');
      structLog('info', 'llm circuit closed, primary recovered', { primary: primaryLabel });
    }
  }

  return async function failoverLLM(
    messages: Message[],
    tools: ToolSchema[],
    options?: LLMCallOptions
  ): Promise<LLMResponse> {
    // half-open：冷却期已过，试 primary 一次探活。
    const halfOpen = openedAt > 0 && !circuitOpen();

    if (!circuitOpen() || halfOpen) {
      try {
        const resp = await primary(messages, tools, options);
        closeCircuit();
        return resp;
      } catch (primaryErr: any) {
        consecutiveFails += 1;
        incCounter('llm.primary.fail');
        structLog('warn', 'primary llm failed', {
          primary: primaryLabel,
          attempt: consecutiveFails,
          error: primaryErr?.message ?? String(primaryErr),
        });
        if (consecutiveFails >= failThreshold) openCircuit();
        else if (halfOpen) openCircuit(); // half-open 探活失败，重新打开

        if (!immediateFallback && !circuitOpen()) {
          throw primaryErr;
        }
        // 落到下面的 secondary 兜底。
        return trySecondary(messages, tools, options, primaryErr);
      }
    }

    // 电路打开：直接走 secondary。
    return trySecondary(messages, tools, options, undefined);
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
