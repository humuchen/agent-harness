/**
 * 任务路由类型（统一基座平台 P0.2）。
 *
 * Task Router 把 RunQueue 从「统一 harness 队列」升级为「按能力选 agent 再分发」的调度器。
 * 本文件定义路由层的中间数据类型：意图（Intent）、选择器上下文（SelectorContext）、路由结果（RouteResult）。
 *
 * 设计约定：
 * - 所有类型可 JSON 序列化（RouteInput 需落盘进 JobDescriptor，见 server/queue-backend.ts）。
 * - 路由层只读取 AgentCard 的声明元数据（domain/capabilities/health/sla），不触碰装配细节。
 * - 显式 agentId 优先于一切自动推断（最短路径、可预测）；domain 次之；最后才 classify+select。
 */

import type { IndustryDomain, AgentCard } from '../agents/types';

/**
 * 路由输入：RunQueue 在 execute() 时构造并交给 TaskRouter.resolve。
 * 字段全部可选，保证「默认开关关闭 / 无路由信息」时退化为 default agent（零行为变更）。
 */
export interface RouteInput {
  /** 显式指定目标 agent（绕过路由，直达该 agent 的装配配方）。 */
  agentId?: string;
  /** 客户端/上游声明的领域（比 classify 更可信，可直接过滤候选）。 */
  domain?: IndustryDomain;
  /** 任务提示词（用于规则引擎 / LLM 分类）。 */
  prompt?: string;
  /** 租户标识（P0.3 接入后用于 per-tenant 策略亲和与记忆分区）。 */
  tenantId?: string;
  /** 调用方给出的能力暗示（可选，提升 classify 精度）。 */
  requiredCapabilities?: string[];
  /** 工作流标识（可观测性，随 run:meta 透出）。 */
  workflowId?: string;
  /** 链路追踪标识（可观测性）。 */
  traceId?: string;
}

/** 意图分类结果。 */
export interface Intent {
  domain: IndustryDomain;
  /** 简单意图标签：qa / task / lookup / conversation 等（供 selector 与可观测性）。 */
  intent: string;
  /** 该任务所需的领域能力 id 列表（供 AgentSelector 做能力匹配）。 */
  requiredCapabilities: string[];
  /** 分类来源：rule（规则引擎）/ llm（小模型分类），便于追踪与缓存。 */
  source: 'rule' | 'llm';
}

/** 选择器上下文：影响评分的额外信号（租户亲和、目标 domain 等）。 */
export interface SelectorContext {
  domain?: IndustryDomain;
  requiredCapabilities?: string[];
  tenantId?: string;
  /**
   * 租户策略亲和系数（P0.3 的 policyRef 落点）：默认 1.0 中性。
   * 若某 card 携带匹配租户/行业的装配，可将该系数调高（>1 加权、<1 降权）。
   * 当前 card 未含 policyRef 字段，故默认中性；此处预留钩子，P0.3 接入策略引擎后填值。
   */
  tenantAffinity?: number;
}

/** 路由结果。 */
export interface RouteResult {
  agentId: string;
  card: AgentCard;
  /**
   * 路由决策来源：
   * - 'explicit'  显式 agentId 命中；
   * - 'domain'    按 domain 过滤 + selector 命中；
   * - 'classify'  经 intent.classify + selector + 置信度阀门命中；
   * - 'fallback'  selector 无候选 / 置信度不足 / 出错，回退 default 通用 agent。
   */
  decidedBy: 'explicit' | 'domain' | 'classify' | 'fallback';
  /** 当 decidedBy 为 classify/domain 时附带的意图（fallback/explicit 时为 null）。 */
  intent: Intent | null;
  /** 路由置信度分数（0~1），fallback/explicit 时为 undefined。 */
  confidence?: number;
}
