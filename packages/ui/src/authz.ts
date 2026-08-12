/**
 * 业务层 · 基于角色的访问控制（RBAC）。
 *
 * 设计原则（与核心 framework 隔离）：
 * - 本文件属于「业务编排层」（packages/ui），核心 `@agent-harness/core` 不感知任何
 *   角色 / 权限 / 令牌概念。核心只提供 AgentHarness 等框架原语。
 * - 一切以「接口 + 默认实现 + 组合工厂」形式存在，便于替换为 OIDC / LDAP /
 *   SPIFFE 等外部身份源，而无需改动 server 其它代码（即插即用、可组合）。
 */
import type { IncomingMessage } from 'node:http';

export type Role = 'admin' | 'operator' | 'viewer';

// 授权单元（动作）。完全在业务层定义；核心不引用。
export type Action =
  | 'agent:run:mock'
  | 'agent:run:real'
  | 'agent:run:real-mcp'
  | 'verify'
  | 'env:create'
  | 'env:destroy'
  | 'mcp:read'
  | 'mcp:add'
  | 'mcp:preset'
  | 'mcp:reconnect'
  | 'shell:approve'
  | 'memory:read'
  | 'memory:clear'
  | 'metrics:read'
  | 'jobs:read'
  | 'sessions:read'
  | 'eval:run'
  | 'recipe:save'
  | 'recipe:read'
  | 'approvals:review';

export interface AuthContext {
  /** 归一化后的令牌（仅用于审计，不向客户端泄露明文）。 */
  token: string;
  /** 主体标识（令牌哈希前 8 位），避免把明文令牌写进日志/响应。 */
  sub: string;
  role: Role;
}

export interface Authorizer {
  /** 从请求中提取主体；失败返回 null（调用方应回 401）。 */
  authenticate(req: IncomingMessage): AuthContext | null;
  /** 该角色是否允许执行动作。 */
  can(ctx: AuthContext, action: Action): boolean;
  /** 当前授权配置概览（供 /api/roles 运维展示，不泄露令牌）。 */
  describe(): { mode: 'off' | 'on'; roles: Role[]; permissions: Record<Role, Action[]> };
}

// 默认角色-权限矩阵。可被 UI_ROLE_PERMISSIONS 覆盖（JSON：
// {"admin":[...],"operator":[...],"viewer":[...]}），实现策略可配置。
const DEFAULT_MATRIX: Record<Role, Action[]> = {
  admin: [
    'agent:run:mock', 'agent:run:real', 'agent:run:real-mcp', 'verify',
    'env:create', 'env:destroy', 'mcp:read', 'mcp:add', 'mcp:preset', 'mcp:reconnect',
    'shell:approve', 'memory:read', 'memory:clear', 'metrics:read',
    'jobs:read', 'sessions:read', 'eval:run', 'recipe:save', 'recipe:read', 'approvals:review',
  ],
  operator: [
    'agent:run:mock', 'agent:run:real', 'agent:run:real-mcp', 'verify',
    'env:create', 'env:destroy', 'mcp:read', 'mcp:add', 'mcp:preset', 'mcp:reconnect',
    'shell:approve', 'memory:read', 'metrics:read', 'jobs:read', 'sessions:read',
    'eval:run', 'recipe:save', 'recipe:read',
  ],
  viewer: [
    'agent:run:mock', 'mcp:read', 'memory:read', 'metrics:read', 'jobs:read', 'sessions:read',
    'recipe:read',
  ],
};

function loadMatrix(): Record<Role, Action[]> {
  const raw = process.env.UI_ROLE_PERMISSIONS;
  if (!raw) return DEFAULT_MATRIX;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<Role, Action[]>>;
    const out: Record<Role, Action[]> = { ...DEFAULT_MATRIX };
    for (const r of ['admin', 'operator', 'viewer'] as Role[]) {
      if (Array.isArray(parsed[r])) out[r] = parsed[r] as Action[];
    }
    return out;
  } catch {
    return DEFAULT_MATRIX;
  }
}

// 非密码学哈希，仅用于日志/展示截断，安全校验走下面的常量比较。
function tokenFingerprint(t: string): string {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, '0').slice(0, 8);
}

export class RoleBasedAuthorizer implements Authorizer {
  private readonly matrix: Record<Role, Action[]>;
  private readonly tokens = new Map<string, Role>(); // 明文令牌 → 角色

  constructor(opts: { tokens?: Record<string, Role>; fallbackToken?: string; fallbackRole?: Role } = {}) {
    this.matrix = loadMatrix();
    if (opts.tokens) for (const [t, r] of Object.entries(opts.tokens)) this.tokens.set(t, r);
    if (opts.fallbackToken && opts.fallbackRole) this.tokens.set(opts.fallbackToken, opts.fallbackRole);
  }

  authenticate(req: IncomingMessage): AuthContext | null {
    const auth = req.headers['authorization'];
    let token: string | null = null;
    if (auth && typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      token = auth.slice(7).trim();
    }
    if (!token) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const q = url.searchParams.get('token');
      if (q) token = q;
    }
    if (!token) return null;
    const role = this.tokens.get(token);
    if (!role) return null;
    return { token, sub: tokenFingerprint(token), role };
  }

  can(ctx: AuthContext, action: Action): boolean {
    return this.matrix[ctx.role]?.includes(action) ?? false;
  }

  describe(): { mode: 'off' | 'on'; roles: Role[]; permissions: Record<Role, Action[]> } {
    return { mode: this.tokens.size > 0 ? 'on' : 'off', roles: ['admin', 'operator', 'viewer'], permissions: this.matrix };
  }
}

/**
 * 组合工厂：从环境变量装配 Authorizer。
 * - UI_TOKENS：JSON `{ "<token>": "admin" }`，支持多令牌多角色（企业典型用法）。
 * - UI_AUTH_TOKEN：兼容旧版单令牌，默认映射为 operator。
 * - requireAuth=false 时返回「全放行」实现，保持本地/演示的开放语义（向后兼容）。
 *
 * 要接入外部身份源（如 OIDC）：只需在此返回一个实现了 Authorizer 的对象，
 * server 其余代码无需任何改动 —— 这就是可插拔/可组合的关键约束点。
 */
export function createAuthorizer(requireAuth: boolean): Authorizer {
  if (!requireAuth) {
    return {
      authenticate: () => ({ token: '', sub: 'anon', role: 'admin' }),
      can: () => true,
      describe: () => ({ mode: 'off', roles: [], permissions: {} as Record<Role, Action[]> }),
    };
  }
  const tokens: Record<string, Role> = {};
  const tokensRaw = process.env.UI_TOKENS;
  if (tokensRaw) {
    try {
      Object.assign(tokens, JSON.parse(tokensRaw) as Record<string, Role>);
    } catch {
      /* 忽略错误配置，回退到单令牌 */
    }
  }
  const fallback = process.env.UI_AUTH_TOKEN;
  return new RoleBasedAuthorizer({ tokens, fallbackToken: fallback, fallbackRole: 'operator' });
}
