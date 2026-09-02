import type { LLM, Message, ToolSchema, LLMResponse, LLMCallOptions } from '../types';
import { createOpenRouterLLM, type OpenRouterConfig } from './openrouter';
import { incCounter, structLog } from '../telemetry';

export interface MultiKeyOptions extends Omit<OpenRouterConfig, 'apiKey'> {
  /**
   * 单 Key 连续失败达到该次数后判定为不可用，进入冷却（默认 3）。
   */
  failThreshold?: number;
  /**
   * 判定不可用的 Key 冷却恢复时长（毫秒，默认 60_000）。冷却期内跳过该 Key，
   * 到期后再探活一次，成功则重新启用。
   */
  cooldownMs?: number;
  /**
   * 命中这些错误时立即把该 Key 标记冷却（不等 failThreshold 累计）：
   * 401/403（Key 失效）、429（限流）、quota/rate 类错误（按 Key 隔离，不拖垮整租户）。
   */
  immediateKillOnStatus?: number[];
}

interface KeyState {
  fails: number;
  deadUntil: number;
}

/**
 * 多 Key 负载均衡 / 故障转移 LLM 包装器（P2.4）。
 *
 * 设计：
 *  - 入参 keys 每个 Key 各自构造一个 OpenRouter LLM 实例（独立 apiKey）。
 *  - 调用时在「健康 Key」之间 round-robin 分发，实现负载均摊（多 Key 共享一个额度池时
 *    也能把请求摊薄到不同 Key，降低单 Key 触发限流的概率）。
 *  - 每个 Key 维护独立熔断状态：连续失败达阈值或命中 401/403/429 立即冷却，冷却期内跳过；
 *    到期后探活一次，成功则恢复。
 *  - 单次调用若当前 Key 失败，按顺序尝试其余健康 Key 兜底，全部失败才抛出最后一个错误。
 *
 * 对 harness 主循环完全透明——调用方（runner）只看到一个 LLM 契约。
 */
export function createMultiKeyLLM(keys: string[], opts: MultiKeyOptions = {}): LLM {
  const failThreshold = Math.max(1, opts.failThreshold ?? 3);
  const cooldownMs = Math.max(0, opts.cooldownMs ?? 60_000);
  const killStatuses = new Set<number>(
    opts.immediateKillOnStatus ?? [401, 403, 429]
  );
  const base: Omit<OpenRouterConfig, 'apiKey'> = { ...opts };
  const llms = keys.map((k) => createOpenRouterLLM({ ...base, apiKey: k }));
  const states: KeyState[] = keys.map(() => ({ fails: 0, deadUntil: 0 }));
  let rr = 0;

  function isDead(i: number): boolean {
    return states[i]!.deadUntil > Date.now();
  }
  function markDead(i: number): void {
    if (states[i]!.deadUntil === 0) {
      states[i]!.deadUntil = Date.now() + cooldownMs;
      incCounter('llm.key.dead');
      structLog('warn', 'multi-key: key marked dead, cooling down', {
        index: i,
        cooldownMs,
      });
    }
  }
  function recover(i: number): void {
    if (states[i]!.deadUntil !== 0) {
      states[i]!.deadUntil = 0;
      states[i]!.fails = 0;
      incCounter('llm.key.recover');
    }
  }
  /** 从 start 起找下一个健康 Key 下标；全死返回 -1。 */
  function nextHealthy(start: number): number {
    for (let k = 0; k < keys.length; k++) {
      const idx = (start + k) % keys.length;
      if (!isDead(idx)) return idx;
    }
    return -1;
  }
  function statusOf(e: unknown): number | null {
    const msg = e instanceof Error ? e.message : String(e ?? '');
    const m = /(?:HTTP\s*)?(\d{3})/.exec(msg);
    if (m) {
      const code = Number(m[1]);
      if (killStatuses.has(code)) return code;
    }
    if (/quota|rate limit|rate_limit|too many requests/i.test(msg)) return 429;
    if (/unauthorized|invalid api key|api key|authentication/i.test(msg)) return 401;
    return null;
  }

  return async function multiKeyLLM(
    messages: Message[],
    tools: ToolSchema[],
    options?: LLMCallOptions
  ): Promise<LLMResponse> {
    if (keys.length === 0) {
      throw new Error('createMultiKeyLLM requires at least one key');
    }
    if (keys.length === 1) {
      return llms[0]!(messages, tools, options);
    }
    let firstErr: unknown = null;
    const tried = new Set<number>();
    for (let n = 0; n < keys.length; n++) {
      const idx = nextHealthy((rr + n) % keys.length);
      if (idx < 0) break; // 全部冷却中
      if (tried.has(idx)) continue;
      tried.add(idx);
      try {
        const resp = await llms[idx]!(messages, tools, options);
        // 成功 → 该 Key 恢复健康
        recover(idx);
        rr = (idx + 1) % keys.length; // 下一次从下一个 Key 起 round-robin
        return resp;
      } catch (e) {
        firstErr = firstErr ?? e;
        states[idx]!.fails += 1;
        incCounter('llm.key.fail');
        const st = statusOf(e);
        if (st !== null) {
          markDead(idx); // 401/403/429/quota → 立即冷却该 Key
        } else if (states[idx]!.fails >= failThreshold) {
          markDead(idx); // 其它错误累计达阈值也冷却
        }
        structLog('warn', 'multi-key: key failed, trying next', {
          index: idx,
          status: st ?? 'unknown',
          fails: states[idx]!.fails,
        });
      }
    }
    throw firstErr ?? new Error('all provider keys failed');
  };
}
