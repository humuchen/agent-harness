/**
 * 业务层 · 审批工作流（Approval Workflow）。
 *
 * 设计原则（与核心 framework 隔离）：
 * - 审批是「业务策略」，不属于核心 AgentHarness。核心不感知 ticket / 审批概念。
 * - 以「接口 + 默认实现 + 组合工厂」形式存在，便于替换为外部审批系统
 *   （如工单平台、Slack/Teams webhook、对接 ITSM），server 其余代码无需改动。
 *
 * 工作模型（gate + re-submit，避免存储/执行回调耦合）：
 *   1. 敏感动作被策略判定为「需审批」→ 服务端创建 ticket，返回 202 { ticketId }。
 *   2. 审批人在 /api/approvals 查看并 approve/reject。
 *   3. 原请求方（或自动化）携带 approvalTicket 重发同一请求 → 校验已批准 → 放行执行。
 * 这样执行始终在「重发」这一同步调用内完成，无需在内存里挂等待中的回调，天然可组合。
 */
import type { AuthContext, Action } from './authz';

export type TicketStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalTicket {
  id: string;
  action: Action;
  sub: string; // 请求者主体指纹
  role: string;
  summary: string; // 人类可读摘要（已脱敏）
  status: TicketStatus;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
}

export interface ApprovalPolicy {
  /** 该动作（结合角色）是否需要审批。 */
  requiresApproval(action: Action, ctx: AuthContext): boolean;
  /**
   * 校验随请求携带的审批票据：动作一致且已批准则返回 ticket，否则 null。
   * 调用方凭返回的 ticket 继续执行业务动作。
   */
  consume(ticketId: string, action: Action, ctx: AuthContext): ApprovalTicket | null;
  /** 创建待审批票据。 */
  create(action: Action, ctx: AuthContext, summary: string): ApprovalTicket;
  /** 审批人裁决。返回更新后的 ticket，或 null（不存在/已决）。 */
  decide(id: string, decision: 'approve' | 'reject', by: string): ApprovalTicket | null;
  /** 列出票据（可按状态过滤），新的在前。 */
  list(filter?: { status?: TicketStatus }): ApprovalTicket[];
}

// 敏感动作（需审批）。只读/低危动作不在列，天然免审批。
const SENSITIVE_ACTIONS: Action[] = [
  'agent:run:real',
  'agent:run:real-mcp',
  'verify',
  'env:create',
  'env:destroy',
  'mcp:add',
  'mcp:preset',
  'mcp:reconnect',
  'shell:approve',
  'memory:clear',
];

export class InMemoryApprovalPolicy implements ApprovalPolicy {
  private readonly tickets = new Map<string, ApprovalTicket>();
  private readonly bypass: Set<string>;
  private seq = 0;

  constructor(opts: { bypassRoles?: string[] } = {}) {
    // 这些角色可绕过审批（默认 admin）。可通过 UI_APPROVAL_BYPASS_ROLES 调整。
    this.bypass = new Set(opts.bypassRoles ?? ['admin']);
  }

  requiresApproval(action: Action, ctx: AuthContext): boolean {
    if (this.bypass.has(ctx.role)) return false;
    return SENSITIVE_ACTIONS.includes(action);
  }

  consume(ticketId: string, action: Action, _ctx: AuthContext): ApprovalTicket | null {
    const t = this.tickets.get(ticketId);
    if (!t) return null;
    if (t.action !== action) return null; // 票据与动作必须一致，防越权复用
    if (t.status !== 'approved') return null;
    return t;
  }

  create(action: Action, ctx: AuthContext, summary: string): ApprovalTicket {
    const id = `apr_${++this.seq}_${Date.now().toString(36)}`;
    const t: ApprovalTicket = {
      id,
      action,
      sub: ctx.sub,
      role: ctx.role,
      summary,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.tickets.set(id, t);
    return t;
  }

  decide(id: string, decision: 'approve' | 'reject', by: string): ApprovalTicket | null {
    const t = this.tickets.get(id);
    if (!t || t.status !== 'pending') return null;
    t.status = decision === 'approve' ? 'approved' : 'rejected';
    t.decidedAt = Date.now();
    t.decidedBy = by;
    return t;
  }

  list(filter?: { status?: TicketStatus }): ApprovalTicket[] {
    const all = [...this.tickets.values()].sort((a, b) => b.createdAt - a.createdAt);
    return filter?.status ? all.filter((t) => t.status === filter.status) : all;
  }
}

/**
 * 组合工厂：从环境变量装配 ApprovalPolicy。
 * - UI_APPROVAL_BYPASS_ROLES：逗号分隔，可绕过审批的角色（默认 "admin"）。
 * - 要接入外部审批系统：在此返回实现了 ApprovalPolicy 的对象（如 WebhookApprovalPolicy），
 *   server 其余代码无需改动。
 */
export function createApprovalPolicy(): ApprovalPolicy {
  const bypass = (process.env.UI_APPROVAL_BYPASS_ROLES ?? 'admin')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new InMemoryApprovalPolicy({ bypassRoles: bypass });
}
