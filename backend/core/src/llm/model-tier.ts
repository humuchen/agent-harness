import type { Message, ToolSchema } from '../types';

/**
 * 模型分级路由（P1-④，补齐医美参考架构「轻量↔高阶按任务路由」缺口）。
 *
 * 设计要点：
 *  - 路由在 LLM 适配器层完成，harness 的调用形态（`opts.llm(messages, tools, opts)`）
 *    完全不变；成本记账走实际响应 `resp.model`，与现有 usage-accounting 一致。
 *  - 默认关闭（env `AH_MODEL_TIERING=off`）。开启后仅在**低风险**步降级到轻量模型，
 *    绝不把首轮复杂推理 / 工具决策步降级，避免质量回退：
 *      1) 工具结果「合成步」：上一条 assistant 已带 tool_calls，且累计 prompt 字符
 *         不超过 `lightMaxChars`（默认 4000）——这类步只做归纳，mini 模型足够。
 *      2) 首轮极短问答 / 问候：消息数 ≤ 2、无工具 schema、字符 ≤ `greetingMaxChars`
 *         （默认 256）。
 *  - 降级比例与真实降本幅度取决于轻量模型单价，本模块只负责「路由机制」，
 *    不对具体百分比做承诺（原设计文档的 ~30% 为预期区间，非保证）。
 */

export type ModelTier = 'light' | 'high';

export interface TierConfig {
  /** 是否启用分级路由。 */
  enabled: boolean;
  /** 轻量模型标识（如 openai/gpt-4o-mini）。未配置则等同关闭。 */
  lightModel?: string;
  /** 合成步降级字符上限。 */
  lightMaxChars: number;
  /** 首轮问候/短问答降级字符上限。 */
  greetingMaxChars: number;
}

interface TierEnv {
  AH_MODEL_TIERING?: string;
  AH_LIGHT_MODEL?: string;
  AH_TIER_LIGHT_MAX_CHARS?: string;
  AH_TIER_GREETING_MAX_CHARS?: string;
}

function clampInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 三源解析：配置对象（显式传入） → 环境变量 → 内置默认（关闭）。 */
export function resolveTierConfig(
  input?: { lightModel?: string; modelTiering?: 'auto' | 'off' },
  env: TierEnv = process.env as TierEnv
): TierConfig {
  const enabled =
    (input?.modelTiering ?? env.AH_MODEL_TIERING ?? 'off').trim().toLowerCase() === 'auto';
  const lightModel = (input?.lightModel ?? env.AH_LIGHT_MODEL)?.trim() || undefined;
  return {
    enabled,
    lightModel,
    lightMaxChars: clampInt(env.AH_TIER_LIGHT_MAX_CHARS, 4000),
    greetingMaxChars: clampInt(env.AH_TIER_GREETING_MAX_CHARS, 256),
  };
}

function messageChars(m: Message): number {
  const c = m.content;
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) {
    let n = 0;
    for (const p of c) {
      if (!p || typeof p !== 'object') continue;
      const text = (p as { text?: unknown }).text;
      const content = (p as { content?: unknown }).content;
      if (typeof text === 'string') n += text.length;
      else if (typeof content === 'string') n += content.length;
    }
    return n;
  }
  return 0;
}

export interface TierDecision {
  /** 实际选用的模型标识（light 或 high）。 */
  model: string;
  tier: ModelTier;
  reason: string;
  /** 本次请求累计 prompt 字符数（用于观测/调参）。 */
  promptChars: number;
}

/**
 * 依据当前步的消息特征决定使用轻量还是高阶模型。
 * 纯函数、无副作用，便于单测。
 */
export function resolveTierModel(args: {
  messages: Message[];
  tools: ToolSchema[];
  /** 高阶（默认）模型标识。 */
  model: string;
  cfg: TierConfig;
}): TierDecision {
  const { messages, tools, model, cfg } = args;
  const promptChars = messages.reduce((s, m) => s + messageChars(m), 0);

  if (!cfg.enabled || !cfg.lightModel || cfg.lightModel === model) {
    return { model, tier: 'high', reason: 'tiering disabled or no distinct light model', promptChars };
  }

  // 工具结果「合成步」：历史中最后一条 assistant 已发出 tool_calls，本轮只做归纳
  // （此时消息尾部通常是 tool 结果，故按「最后一条 assistant」判断而非末条消息）。
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastAssistantHadToolCalls =
    !!lastAssistant &&
    Array.isArray((lastAssistant as { tool_calls?: unknown }).tool_calls) &&
    ((lastAssistant as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0;

  if (lastAssistantHadToolCalls && promptChars <= cfg.lightMaxChars) {
    return {
      model: cfg.lightModel,
      tier: 'light',
      reason: 'synthesis step within char budget',
      promptChars,
    };
  }

  // 首轮极短问答 / 问候：无工具 schema 需求、字符极少。
  if (messages.length <= 2 && tools.length === 0 && promptChars <= cfg.greetingMaxChars) {
    return {
      model: cfg.lightModel,
      tier: 'light',
      reason: 'short first-turn without tools',
      promptChars,
    };
  }

  return { model, tier: 'high', reason: 'complex step kept on high tier', promptChars };
}
