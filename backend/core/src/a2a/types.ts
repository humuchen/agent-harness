/**
 * A2A（Agent-to-Agent）统一通信协议类型（P1-④）。
 *
 * 设计目标：用一份可 JSON 序列化的 TaskEnvelope，桥接「工具级 MCP（已有）」与
 * 「agent 级 A2A（新增）」，让异构远端行业 agent 以标准协议入驻本平台。
 *
 * 约束（与既有约定一致）：
 * - 全部字段可 JSON 序列化，不得引入函数 / 类实例（见实现计划 §5 风险 3）；
 * - 不传 endpoint 的 local agent 仍在进程内 handoff，零额外网络开销（向后兼容）。
 */

import type { AgentCard } from '../agents/types';

/** 任务结果状态。 */
export type TaskStatus = 'success' | 'failed';

/** A2A 任务信封：一个 agent 委托另一个 agent 完成一项工作的标准载体。 */
export interface TaskEnvelope {
  /** 全局唯一任务 id（建议用 crypto.randomUUID，便于幂等/去重）。 */
  taskId: string;
  /** 租户隔离维度（贯穿记忆分区与护栏策略，P0.3）。 */
  tenantId: string;
  /** 跨 agent 调用链追踪 id（OTel span 关联，P1-⑤ 已铺 channel）。 */
  traceId?: string;
  /** 发起方 agent id（进程内默认 'default'）。 */
  fromAgent: string;
  /** 目标 agent id（解析为本地 AgentCard 或远端 endpoint）。 */
  toAgent: string;
  /** 任务输入（任意 JSON 可序列化值）。 */
  input: unknown;
  /** 可选输入 JSON Schema（用于校验 / 与 AgentCapability.inputSchema 对齐）。 */
  inputSchema?: Record<string, unknown>;
  /** 服务等级目标：超时后派发方主动 abort。 */
  sla?: { timeoutMs?: number };
  /** 完成后回调地址（异步结果回填，可选）。 */
  callback?: string;
}

/** A2A 任务执行结果。 */
export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  /** 成功时的输出（任意 JSON 可序列化值）。 */
  output?: unknown;
  /** 失败时的错误信息。 */
  error?: string;
}

/** 远端 agent 提交给本平台的任务体：可携带 AgentCard 自注册（首次入驻）。 */
export interface A2ARequest {
  envelope: TaskEnvelope;
  /** 可选：随任务一起注册/更新目标 agent 的能力卡片（远端 agent 自描述入驻）。 */
  card?: AgentCard;
}

/** 生成一个任务 id（优先用 node:rypto.randomUUID，缺失时回退时间戳+随机）。 */
export function makeTaskId(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { randomUUID } = require('node:crypto');
    return `task-${randomUUID()}`;
  } catch {
    return `task-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}
