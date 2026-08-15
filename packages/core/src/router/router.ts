/**
 * 任务路由器（P0.2）：把一次运行意图解析为「目标 AgentCard」。
 *
 * 决策优先级（最短路径优先、可预测）：
 *   1. 显式 agentId  → 直接取该 agent 的卡片（绕过自动路由；router 关闭时仍生效，视为直接寻址）；
 *   2. 显式 domain    → 过滤该领域候选，再经 AgentSelector 打分取最高；
 *   3. 否则 classify  → IntentRouter 分类 + AgentSelector 打分；
 *   4. 兜底           → 回退 default 通用 agent（保留今天万能 harness 行为）。
 *
 * 开关：env TASK_ROUTER=off 时关闭自动路由（第 2/3 步不执行），仅保留「显式 agentId 直接寻址」
 * 与「兜底 default」，保证默认开关注释掉后零行为变更。
 */

import { getAgentRegistry, DEFAULT_AGENT_ID } from '../agents/registry';
import { makeDefaultAgentCard, type AgentCard } from '../agents/types';
import { getIntentRouter } from './intent';
import { getAgentSelector } from './selector';
import type { Intent, RouteInput, RouteResult, SelectorContext } from './types';

export class TaskRouter {
  /** 解析单次运行的目标 agent。详见文件头决策优先级。 */
  async resolve(job: RouteInput): Promise<RouteResult> {
    const reg = getAgentRegistry();
    const routerOff = (process.env.TASK_ROUTER || '').toLowerCase() === 'off';

    // 1) 显式 agentId：直接寻址，优先级最高（即使 router 关闭也应尊重用户明确目标）。
    if (job.agentId) {
      const card = await reg.get(job.agentId);
      if (card) {
        return { agentId: card.id, card, decidedBy: 'explicit', intent: null };
      }
      // 未知的 agentId：优雅回退 default（不抛错，符合「一切降级可用」）。
    }

    if (routerOff) {
      return this.fallback(reg);
    }

    const ctx: SelectorContext = {
      domain: job.domain,
      tenantId: job.tenantId,
      tenantAffinity: 1,
    };

    // 2) 显式 domain（非 generic）→ 领域内候选 + 选择器打分。
    if (job.domain && job.domain !== 'generic') {
      const candidates = await reg.query({ domain: job.domain });
      if (candidates.length > 0) {
        const intent: Intent = {
          domain: job.domain,
          intent: 'task',
          requiredCapabilities: job.requiredCapabilities ?? [],
          source: 'rule',
        };
        const card = await getAgentSelector().select(reg, intent, ctx, candidates);
        if (card) {
          return { agentId: card.id, card, decidedBy: 'domain', intent };
        }
      }
    }

    // 3) 无显式领域或领域内无候选 → 分类 + 全量选择器打分。
    const intent = await getIntentRouter().classify(job.prompt ?? '');
    const candidates = job.domain ? await reg.query({ domain: job.domain }) : undefined;
    const card = await getAgentSelector().select(reg, intent, ctx, candidates);
    if (card && card.id !== DEFAULT_AGENT_ID) {
      return { agentId: card.id, card, decidedBy: 'classify', intent };
    }

    // 4) 兜底：无更优专属 agent → default 通用 agent。
    return this.fallback(reg, intent);
  }

  /** 取 default 通用 agent 卡片（registery 不存在时现场构造）。 */
  private async fallback(reg = getAgentRegistry(), intent: Intent | null = null): Promise<RouteResult> {
    const def: AgentCard = (await reg.get(DEFAULT_AGENT_ID)) ?? makeDefaultAgentCard();
    return { agentId: DEFAULT_AGENT_ID, card: def, decidedBy: 'fallback', intent };
  }
}

/** 进程内共享单例。 */
let _defaultRouter: TaskRouter | null = null;
export function getTaskRouter(): TaskRouter {
  if (!_defaultRouter) _defaultRouter = new TaskRouter();
  return _defaultRouter;
}

/** 便捷函数：直接解析一次运行意图。 */
export async function resolveTask(job: RouteInput): Promise<RouteResult> {
  return getTaskRouter().resolve(job);
}
