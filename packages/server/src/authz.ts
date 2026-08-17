/**
 * 业务层 · 基于角色的访问控制（RBAC）。
 *
 * 设计原则（与核心 framework 隔离）：
 * - 本文件属于「业务编排层」（packages/server），核心 `@agent-harness/core` 不感知任何
 *   角色 / 权限 / 令牌概念。核心只提供 AgentHarness 等框架原语。
 * - 一切以「接口 + 默认实现 + 组合工厂」形式存在，便于替换为 OIDC / LDAP /
 *   SPIFFE 等外部身份源，而无需改动 server 其它代码（即插即用、可组合）。
 */
import type { IncomingMessage } from 'node:http';
// 外部身份源实现（OIDC Bearer JWT / proxy 头注入）。authz 单向依赖 sso，sso 仅 import type 引用本文件类型。
import { OidcAuthorizer, ProxyAuthorizer, loadRoleMapping } from './sso';

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
  | 'policy:read'
  | 'approvals:review'
  | 'agent:read'
  | 'agent:register'
  | 'workflow:run'
  | 'workflow:read'
  | 'a2a:receive'
  | 'a2a:send'
  | 'plugin:manage';

export interface AuthContext {
  /** 归一化后的令牌（仅用于审计，不向客户端泄露明文）。SSO 下为 JWT/身份指纹。 */
  token: string;
  /** 主体标识：静态令牌模式为令牌哈希前 8 位；SSO 模式为 IdP 用户名 / 邮箱 / 头注入用户名。 */
  sub: string;
  role: Role;
  /** SSO 模式下的扩展身份字段（静态令牌模式不填）。 */
  email?: string;
  name?: string;
  groups?: string[];
  /** P0.3 租户隔离：认证身份派生的租户标识（权威来源，不可客户端伪造）。SSO 网关 / IdP claim 注入；静态令牌模式不填。 */
  tenantId?: string;
}

/** 鉴权配置概览（供 /api/roles、/api/auth/config 运维展示，不泄露令牌）。 */
export interface AuthDescribe {
  mode: 'off' | 'on';
  /** 身份源：token（静态令牌）/ oidc（Bearer JWT）/ proxy（SSO 网关头注入）。 */
  provider: 'token' | 'oidc' | 'proxy';
  roles: Role[];
  permissions: Record<Role, Action[]>;
  idp?: { kind: 'oidc' | 'proxy'; issuer?: string; groupsClaim?: string; userHeader?: string; groupsHeader?: string; hmac?: boolean };
}

export interface Authorizer {
  /** 从请求中提取主体；失败返回 null（调用方应回 401）。 */
  authenticate(req: IncomingMessage): AuthContext | null;
  /** 该角色是否允许执行动作。 */
  can(ctx: AuthContext, action: Action): boolean;
  /** 当前授权配置概览（供 /api/roles 运维展示，不泄露令牌）。 */
  describe(): AuthDescribe;
}

// 默认角色-权限矩阵。可被 UI_ROLE_PERMISSIONS 覆盖（JSON：
// {"admin":[...],"operator":[...],"viewer":[...]}），实现策略可配置。
const DEFAULT_MATRIX: Record<Role, Action[]> = {
  admin: [
    'agent:run:mock', 'agent:run:real', 'agent:run:real-mcp', 'verify',
    'env:create', 'env:destroy', 'mcp:read', 'mcp:add', 'mcp:preset', 'mcp:reconnect',
    'shell:approve', 'memory:read', 'memory:clear', 'metrics:read',
    'jobs:read', 'sessions:read',     'eval:run', 'recipe:save', 'recipe:read',
    'policy:read', 'approvals:review', 'agent:read', 'agent:register', 'workflow:run', 'workflow:read',
    'a2a:receive', 'a2a:send', 'plugin:manage',
  ],
  operator: [
    'agent:run:mock', 'agent:run:real', 'agent:run:real-mcp', 'verify',
    'env:create', 'env:destroy', 'mcp:read', 'mcp:add', 'mcp:preset', 'mcp:reconnect',
    'shell:approve', 'memory:read', 'metrics:read', 'jobs:read', 'sessions:read',
    'eval:run', 'recipe:save', 'recipe:read', 'policy:read', 'agent:read', 'agent:register', 'workflow:run', 'workflow:read',
    'a2a:receive', 'a2a:send', 'plugin:manage',
  ],
  viewer: [
    'agent:run:mock', 'mcp:read', 'memory:read', 'metrics:read', 'jobs:read', 'sessions:read',
    'recipe:read', 'policy:read', 'agent:read', 'workflow:run', 'workflow:read',
    'a2a:receive', 'a2a:send',
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

  describe(): AuthDescribe {
    return {
      mode: this.tokens.size > 0 ? 'on' : 'off',
      provider: 'token',
      roles: ['admin', 'operator', 'viewer'],
      permissions: this.matrix,
    };
  }
}

/**
 * 组合工厂：从环境变量装配 Authorizer。
 * - AUTH_PROVIDER：身份源，默认 `token`（静态令牌）/ `oidc`（Bearer JWT）/ `proxy`（SSO 网关头注入）。
 * - UI_TOKENS：JSON `{ "<token>": "admin" }`，支持多令牌多角色（企业典型用法）。
 * - UI_AUTH_TOKEN：兼容旧版单令牌，默认映射为 operator。
 * - requireAuth=false 时返回「全放行」实现，保持本地/演示的开放语义（向后兼容）。
 *
 * 身份源可插拔：oidc / proxy 模式下，仍可用 UI_TOKENS / UI_AUTH_TOKEN 作为 break-glass
 * 静态令牌（IdP 不可用时运维逃生通道）。无论选哪种 provider，server 其余代码（guard/can）
 * 均不变 —— 这就是可插拔/可组合的关键约束点。
 */
export function createAuthorizer(requireAuth: boolean): Authorizer {
  if (!requireAuth) {
    return {
      authenticate: () => ({ token: '', sub: 'anon', role: 'admin' }),
      can: () => true,
      describe: () => ({ mode: 'off', provider: 'token', roles: [], permissions: {} as Record<Role, Action[]> }),
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
  const fallback = process.env.UI_AUTH_TOKEN || undefined;
  const hasStatic = Object.keys(tokens).length > 0 || !!fallback;
  // break-glass：静态令牌鉴权器，仅在配置了 UI_TOKENS / UI_AUTH_TOKEN 时才有意义。
  const staticAuth: RoleBasedAuthorizer | undefined = hasStatic
    ? new RoleBasedAuthorizer({ tokens, fallbackToken: fallback, fallbackRole: 'operator' })
    : undefined;

  const provider = (process.env.AUTH_PROVIDER || 'token').toLowerCase();

  if (provider === 'oidc') {
    // policy 持有 RBAC 权限矩阵（can/describe 委托给它）；fallback 提供静态令牌逃生通道。
    return new OidcAuthorizer({
      mapping: loadRoleMapping(),
      policy: staticAuth ?? new RoleBasedAuthorizer({}),
      fallback: staticAuth,
    });
  }
  if (provider === 'proxy') {
    return new ProxyAuthorizer({
      mapping: loadRoleMapping(),
      policy: staticAuth ?? new RoleBasedAuthorizer({}),
      fallback: staticAuth,
    });
  }

  // token 模式（默认）：必须有静态令牌，否则全拒绝（fail-closed）。
  return staticAuth ?? {
    authenticate: () => null,
    can: () => false,
    describe: () => ({ mode: 'off', provider: 'token', roles: [], permissions: {} as Record<Role, Action[]> }),
  };
}
