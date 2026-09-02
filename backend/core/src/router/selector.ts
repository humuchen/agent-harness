/**
 * 智能体选择器（P0.2）：在候选 agent 中按综合评分挑选最合适的目标。
 *
 * 评分模型（各因子相乘，值域 0..1，再乘租户亲和）：
 *   score = domainScore × capabilityScore × healthFactor × slaFactor × tenantAffinity
 *
 * - domainScore：card.domain 命中意图领域 = 1；未命中但意图有明确领域 = 0.15（允许跨域兜底）；
 *   意图为 generic 时所有领域中性 = 1。
 * - capabilityScore：意图所需能力（requiredCapabilities）与 card 能力声明交集占比；
 *   无所需能力时 = 1；有所需但完全不交 = 0.1（弱保留，不彻底清零，避免全部归零无法区分）。
 * - healthFactor：down 状态 = 0；否则 1 - load（load∈[0,1]）。
 * - slaFactor：未声明 SLA = 1；声明 p95 时按 2000ms 基准归一（越低越好），下限 0.2。
 * - tenantAffinity：来自 SelectorContext（P0.3 策略引擎填值），默认 1。
 *
 * 取最高分；候选为空（理论上不会，default 常驻）返回 null，由 router 回退 default。
 */

import type { AgentCard } from '../agents/types';
import type { AgentRegistry } from '../agents/registry';
import type { Intent, SelectorContext } from './types';

/** 单个候选的评分明细（供测试与可观测性）。 */
export interface ScoredAgent {
  card: AgentCard;
  score: number;
  domainScore: number;
  capabilityScore: number;
  healthFactor: number;
  slaFactor: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 计算单个候选评分明细（纯函数，便于单测）。 */
export function scoreAgent(card: AgentCard, intent: Intent, ctx: SelectorContext = {}): ScoredAgent {
  const domainScore =
    card.domain === intent.domain ? 1 : intent.domain === 'generic' ? 1 : 0.15;

  const cardCaps = new Set(card.capabilities.map((c) => c.id));
  const req = intent.requiredCapabilities ?? [];
  const capabilityScore =
    req.length === 0
      ? 1
      : (() => {
          let hit = 0;
          for (const r of req) if (cardCaps.has(r)) hit += 1;
          return hit === 0 ? 0.1 : hit / req.length;
        })();

  const healthFactor =
    card.health.status === 'down' ? 0 : clamp(1 - clamp(card.health.load, 0, 1), 0, 1);

  const slaFactor = card.sla?.p95LatencyMs
    ? clamp(2000 / Math.max(1, card.sla.p95LatencyMs), 0.2, 1)
    : 1;

  const tenantAffinity = ctx.tenantAffinity ?? 1;

  const score = domainScore * capabilityScore * healthFactor * slaFactor * tenantAffinity;
  return { card, score, domainScore, capabilityScore, healthFactor, slaFactor };
}

/** 智能体选择器。 */
export class AgentSelector {
  /**
   * 在 registry 中挑选最匹配 intent 的 agent。
   * @param candidates 已按 domain 过滤的候选（router 负责先过滤）；不传则取 registry 全量。
   */
  async select(
    registry: AgentRegistry,
    intent: Intent,
    ctx: SelectorContext = {},
    candidates?: AgentCard[]
  ): Promise<AgentCard | null> {
    const pool = candidates ?? (await registry.list());
    if (pool.length === 0) return null;
    let best: ScoredAgent | null = null;
    for (const card of pool) {
      const s = scoreAgent(card, intent, ctx);
      if (!best || s.score > best.score) best = s;
    }
    return best ? best.card : null;
  }
}

/** 进程内共享单例。 */
let _defaultSelector: AgentSelector | null = null;
export function getAgentSelector(): AgentSelector {
  if (!_defaultSelector) _defaultSelector = new AgentSelector();
  return _defaultSelector;
}
