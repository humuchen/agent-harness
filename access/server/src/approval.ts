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
 *
 * 多副本支持（P0.3）：
 * - 默认使用内存态 InMemoryApprovalPolicy（单实例场景，零依赖）。
 * - 若配置 APPROVAL_BACKEND=redis，则使用 Redis 持久化票据，支持多副本共享。
 * - 票据 ID 全局唯一（Redis INCR 计数器），避免多实例 ID 冲突。
 */
import type { AuthContext, Action } from './authz';
import { randomBytes } from 'node:crypto';

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
  consume(ticketId: string, action: Action, ctx: AuthContext): ApprovalTicket | null | Promise<ApprovalTicket | null>;
  /** 创建待审批票据。 */
  create(action: Action, ctx: AuthContext, summary: string): ApprovalTicket | Promise<ApprovalTicket>;
  /** 审批人裁决。返回更新后的 ticket，或 null（不存在/已决）。 */
  decide(id: string, decision: 'approve' | 'reject', by: string): ApprovalTicket | null | Promise<ApprovalTicket | null>;
  /** 列出票据（可按状态过滤），新的在前。 */
  list(filter?: { status?: TicketStatus }): ApprovalTicket[] | Promise<ApprovalTicket[]>;
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
  'mcp:remove',
  'shell:approve',
  'memory:clear',
];

// ---------------------------------------------------------------------------
// 内存态审批策略（单实例，零依赖）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Redis 持久化审批策略（多副本共享，零知识：仅操作 JSON 字符串）
// ---------------------------------------------------------------------------

interface RedisApprovalAdapter {
  /** 获取票据 JSON，不存在则返回 null。 */
  get(id: string): Promise<string | null>;
  /** 写入票据 JSON（覆盖）。 */
  set(id: string, value: string): Promise<void>;
  /** 删除票据。 */
  del(id: string): Promise<void>;
  /** 按键前缀列出所有票据 JSON。 */
  list(pattern: string): Promise<string[]>;
  /** 递增全局计数器，返回新值（用于生成唯一 ID）。 */
  incr(key: string): Promise<number>;
}

/**
 * Redis 审批策略。
 *
 * 票据存储键：`approval:{id}`（完整票据 JSON）。
 * 全局序列键：`approval:seq`（INCR 计数器，保证多实例 ID 唯一）。
 *
 * 依赖：运行时需注入一个具备上述接口的 Redis 适配器（可使用 ioredis / @upstash/redis
 * 或任何符合该最小接口的客户端）。未注入时退化为 InMemoryApprovalPolicy。
 */
export class RedisApprovalPolicy implements ApprovalPolicy {
  private readonly db: RedisApprovalAdapter | null;
  private readonly bypass: Set<string>;
  private readonly prefix: string;

  constructor(opts: {
    db?: RedisApprovalAdapter;
    bypassRoles?: string[];
    prefix?: string;
  } = {}) {
    this.db = opts.db ?? null;
    this.bypass = new Set(opts.bypassRoles ?? ['admin']);
    this.prefix = opts.prefix ?? 'approval';
  }

  requiresApproval(action: Action, ctx: AuthContext): boolean {
    if (this.bypass.has(ctx.role)) return false;
    return SENSITIVE_ACTIONS.includes(action);
  }

  private async _load(id: string): Promise<ApprovalTicket | null> {
    if (!this.db) return null;
    const raw = await this.db.get(`${this.prefix}:${id}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ApprovalTicket;
    } catch {
      return null;
    }
  }

  private async _save(t: ApprovalTicket): Promise<void> {
    if (!this.db) return;
    await this.db.set(`${this.prefix}:${t.id}`, JSON.stringify(t));
  }

  private async _delete(id: string): Promise<void> {
    if (!this.db) return;
    await this.db.del(`${this.prefix}:${id}`);
  }

  private nextId(): string {
    return `apr_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  }

  private async nextSeqId(): Promise<string> {
    if (!this.db) return this.nextId();
    const seq = await this.db.incr(`${this.prefix}:seq`);
    return `apr_${seq}_${Date.now().toString(36)}`;
  }

  async create(action: Action, ctx: AuthContext, summary: string): Promise<ApprovalTicket> {
    const id = await this.nextSeqId();
    const t: ApprovalTicket = {
      id,
      action,
      sub: ctx.sub,
      role: ctx.role,
      summary,
      status: 'pending',
      createdAt: Date.now(),
    };
    await this._save(t);
    return t;
  }

  async consume(ticketId: string, action: Action, ctx: AuthContext): Promise<ApprovalTicket | null> {
    const t = await this._load(ticketId);
    if (!t) return null;
    if (t.action !== action) return null;
    if (t.status !== 'approved') return null;
    return t;
  }

  async decide(id: string, decision: 'approve' | 'reject', by: string): Promise<ApprovalTicket | null> {
    const t = await this._load(id);
    if (!t || t.status !== 'pending') return null;
    t.status = decision === 'approve' ? 'approved' : 'rejected';
    t.decidedAt = Date.now();
    t.decidedBy = by;
    await this._save(t);
    return t;
  }

  async list(filter?: { status?: TicketStatus }): Promise<ApprovalTicket[]> {
    if (!this.db) return [];
    const keys = await this.db.list(`${this.prefix}:*`);
    const all: ApprovalTicket[] = [];
    for (const key of keys) {
      const raw = await this.db.get(key);
      if (!raw) continue;
      try {
        all.push(JSON.parse(raw) as ApprovalTicket);
      } catch {
        /* 跳过损坏记录 */
      }
    }
    all.sort((a, b) => b.createdAt - a.createdAt);
    return filter?.status ? all.filter((t) => t.status === filter.status) : all;
  }
}

/**
 * 组合工厂：从环境变量装配 ApprovalPolicy。
 * - UI_APPROVAL_BYPASS_ROLES：逗号分隔，可绕过审批的角色（默认 "admin"）。
 * - APPROVAL_BACKEND：审批后端（memory | redis；默认 memory）。
 * - 要接入外部审批系统：在此返回实现了 ApprovalPolicy 的对象（如 WebhookApprovalPolicy），
 *   server 其余代码无需改动。
 */
export function createApprovalPolicy(): ApprovalPolicy {
  const bypass = (process.env.UI_APPROVAL_BYPASS_ROLES ?? 'admin')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const backend = (process.env.APPROVAL_BACKEND ?? 'memory').toLowerCase();
  if (backend === 'redis') {
    const redisAdapter = resolveRedisAdapter();
    if (redisAdapter) {
      return new RedisApprovalPolicy({ bypassRoles: bypass, db: redisAdapter } as never);
    }
    console.warn(
      '[approval] APPROVAL_BACKEND=redis 但未注入 Redis 适配器，降级为内存态审批票据。'
    );
  }
  return new InMemoryApprovalPolicy({ bypassRoles: bypass });
}

/**
 * 解析 Redis 适配器。
 * 优先使用全局注入的 Redis 客户端（容器运行时由编排层注入）。
 * 未找到时返回 null（降级为内存态）。
 */
function resolveRedisAdapter(): RedisApprovalAdapter | null {
  const globalRedis = (globalThis as Record<string, unknown>).__APPROVAL_REDIS__;
  if (globalRedis && typeof (globalRedis as { get?: unknown; set?: unknown; del?: unknown; list?: unknown; incr?: unknown }).get === 'function') {
    return globalRedis as RedisApprovalAdapter;
  }
  return null;
}
