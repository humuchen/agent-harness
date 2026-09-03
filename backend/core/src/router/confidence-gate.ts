/**
 * 置信度阀门（P0）：在 AgentSelector 打分基础上增加置信度阈值判断。
 *
 * 设计目标：
 * - 当最佳 agent 的置信度分数低于阈值时，强制 fallback 到 default agent
 * - 可选：返回低置信度信号，供上层触发澄清对话
 * - 与现有 selector 完全兼容，仅增加阈值判断逻辑
 */

import type { AgentCard } from '../agents/types';
import type { AgentRegistry } from '../agents/registry';
import type { Intent, SelectorContext } from './types';
import { scoreAgent, type ScoredAgent } from './selector';

/**
 * 置信度阀门配置。
 */
export interface ConfidenceGateOptions {
  /**
   * 置信度阈值（0~1）。
   * - 当最佳 agent 的 score >= threshold 时，正常路由
   * - 当最佳 agent 的 score < threshold 时，触发 fallback 或返回低置信度信号
   * 默认 0.5（较为宽松），生产环境建议 0.7~0.8
   */
  threshold?: number;
  /**
   * 低置信度时的行为：
   * - 'fallback'：直接回退到 default agent（默认）
   * - 'signal'：返回低置信度信号，由调用方决定后续处理（如触发澄清对话）
   */
  behavior?: 'fallback' | 'signal';
}

/**
 * 低置信度信号（behavior='signal' 时返回）。
 */
export interface LowConfidenceSignal {
  /** 决策来源标记（区别于正常路由） */
  decidedBy: 'fallback_low_confidence';
  /** 最佳候选的 agent（供参考，不实际使用） */
  bestAgent: AgentCard;
  /** 最佳候选的置信度分数 */
  confidence: number;
  /** 阈值 */
  threshold: number;
  /** 建议的澄清问题（可选，由调用方生成） */
  suggestedClarification?: string;
}

/**
 * 置信度阀门：在 selector 选出最佳 agent 后，检查其置信度是否达标。
 */
export class ConfidenceGate {
  private threshold: number;
  private behavior: 'fallback' | 'signal';

  constructor(opts: ConfidenceGateOptions = {}) {
    this.threshold = opts.threshold ?? 0.5;
    this.behavior = opts.behavior ?? 'fallback';
  }

  /**
   * 检查候选 agent 的置信度。
   * @returns 通过时返回最佳 agent，不通过时返回 LowConfidenceSignal
   */
  check(best: ScoredAgent | null, intent: Intent, ctx: SelectorContext): AgentCard | LowConfidenceSignal | null {
    if (!best) {
      return null; // 无候选，由上层 fallback
    }

    if (best.score >= this.threshold) {
      return best.card; // 置信度达标，正常路由
    }

    // 置信度不足
    if (this.behavior === 'signal') {
      return {
        decidedBy: 'fallback_low_confidence',
        bestAgent: best.card,
        confidence: best.score,
        threshold: this.threshold,
        suggestedClarification: this.generateClarification(intent, best.card),
      };
    }

    // fallback 模式：返回 null，由上层处理
    return null;
  }

  /**
   * 生成建议的澄清问题（基于意图和最佳候选的差异）。
   */
  private generateClarification(intent: Intent, bestAgent: AgentCard): string {
    // 简化版：基于领域差异生成
    if (intent.domain !== 'generic' && bestAgent.domain !== intent.domain) {
      return `您的请求涉及【${intent.domain}】领域，但最佳匹配的 agent 是【${bestAgent.domain}】领域。请确认您希望使用哪个领域的 agent？`;
    }
    return '您的请求可能涉及多个领域，请进一步明确您的需求。';
  }
}

/**
 * 封装后的路由函数：带置信度阀门的任务路由。
 * 如果置信度不足，自动 fallback 到 default agent。
 */
export async function resolveWithConfidenceGate(
  registry: AgentRegistry,
  intent: Intent,
  ctx: SelectorContext,
  gate: ConfidenceGate,
  defaultAgentId: string
): Promise<{ agentId: string; card: AgentCard; decidedBy: string; confidence?: number }> {
  // 1. 选出最佳 agent
  const pool = await registry.list();
  if (pool.length === 0) {
    return { agentId: defaultAgentId, card: null as any, decidedBy: 'fallback' };
  }

  let best: ScoredAgent | null = null;
  for (const card of pool) {
    const s = scoreAgent(card, intent, ctx);
    if (!best || s.score > best.score) best = s;
  }

  // 2. 检查置信度
  const result = gate.check(best, intent, ctx);

  if (result === null) {
    // fallback 模式：返回 default
    const defaultCard = await registry.get(defaultAgentId);
    return {
      agentId: defaultAgentId,
      card: defaultCard ?? (null as any),
      decidedBy: 'fallback_low_confidence',
      confidence: best?.score,
    };
  }

  if ('decidedBy' in result && result.decidedBy === 'fallback_low_confidence') {
    // signal 模式：返回低置信度信号（调用方需自行处理）
    throw new Error(`LOW_CONFIDENCE:${JSON.stringify(result)}`);
  }

  // 正常路由
  return {
    agentId: (result as AgentCard).id,
    card: result as AgentCard,
    decidedBy: 'classify',
    confidence: best?.score,
  };
}

/** 进程内共享单例（默认 threshold=0.7, behavior='fallback'） */
let _defaultGate: ConfidenceGate | null = null;
export function getConfidenceGate(): ConfidenceGate {
  if (!_defaultGate) {
    _defaultGate = new ConfidenceGate({ threshold: 0.7, behavior: 'fallback' });
  }
  return _defaultGate;
}
