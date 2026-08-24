/**
 * 业务层 · 基于角色的访问控制（RBAC）。
 *
 * 设计原则（与核心 framework 隔离）：
 * - 本文件属于「业务编排层」（access/server），核心 `@agent-harness/core` 不感知任何
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
  | 'errors:read'
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
  | 'plugin:manage'
  | 'chat:read'
  | 'chat:write'
  | 'chat:delete'
  | 'env:read'
  | 'upload:file';

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
  /** 降级模式：未接入 RBAC 时，OPENROUTER_API_KEY 作为权限判断唯一凭证。 */
  degraded?: boolean;
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
    'shell:approve', 'memory:read', 'memory:clear', 'metrics:read', 'errors:read',
    'jobs:read', 'sessions:read',     'eval:run', 'recipe:save', 'recipe:read',
    'policy:read', 'approvals:review', 'agent:read', 'agent:register', 'workflow:run', 'workflow:read',
    'a2a:receive', 'a2a:send', 'plugin:manage',
    'chat:read', 'chat:write', 'chat:delete', 'env:read',
    'upload:file',
  ],
  operator: [
    'agent:run:mock', 'agent:run:real', 'agent:run:real-mcp', 'verify',
    'env:create', 'env:destroy', 'mcp:read', 'mcp:add', 'mcp:preset', 'mcp:reconnect',
    'shell:approve', 'memory:read', 'metrics:read', 'jobs:read', 'sessions:read',
    'eval:run', 'recipe:save', 'recipe:read', 'policy:read', 'agent:read', 'agent:register', 'workflow:run', 'workflow:read',
    'a2a:receive', 'a2a:send', 'plugin:manage',
    'chat:read', 'chat:write', 'chat:delete', 'env:read',
    'upload:file',
  ],
  viewer: [
    'agent:run:mock', 'mcp:read', 'memory:read', 'metrics:read', 'errors:read', 'jobs:read', 'sessions:read',
    'recipe:read', 'policy:read', 'agent:read', 'workflow:run', 'workflow:read',
    'a2a:receive', 'a2a:send',
    'chat:read', 'env:read',
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

/**
 * 默认（未强制鉴权 / 开放 / 降级 fallback）模式的配置概览。
 * 即便当前不强制鉴权，也把「默认角色权限矩阵」作为参考一并返回，
 * 避免 /api/roles 在开放模式下返回空 roles / 空 permissions，导致前端角色与权限列表
 * 整列缺失（即「数据展示不全」）。前端会依据 mode==='off' 标注「未强制」提示。
 */
function defaultDescribe(): AuthDescribe {
  return {
    mode: 'off',
    provider: 'token',
    roles: Object.keys(DEFAULT_MATRIX) as Role[],
    permissions: DEFAULT_MATRIX,
  };
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
  private readonly degraded: boolean;

  constructor(opts: { tokens?: Record<string, Role>; fallbackToken?: string; fallbackRole?: Role; apiKeyToken?: string; degraded?: boolean } = {}) {
    this.matrix = loadMatrix();
    if (opts.tokens) for (const [t, r] of Object.entries(opts.tokens)) this.tokens.set(t, r);
    // OPENROUTER_API_KEY 统一作为 admin 凭证（逃生通道），跨模式始终生效。
    if (opts.apiKeyToken) this.tokens.set(opts.apiKeyToken, 'admin');
    if (opts.fallbackToken && opts.fallbackRole) this.tokens.set(opts.fallbackToken, opts.fallbackRole);
    this.degraded = !!opts.degraded;
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
    // 角色列表以权限矩阵（权限数据的权威来源）的键为准派生，确保接口返回的 roles
    // 与 permissions 永远一致、完整。避免「硬编码角色列表」与「实际权限矩阵」两处维护
    // 导致不同步、从而在 UI 上漏列某些角色的权限数据。
    const roles = Object.keys(this.matrix) as Role[];
    return {
      mode: this.tokens.size > 0 ? 'on' : 'off',
      provider: 'token',
      roles,
      permissions: this.matrix,
      degraded: this.degraded,
    };
  }
}

/**
 * 组合工厂：从环境变量装配 Authorizer。
 *
 * 认证依据（按优先级）：
 * 1. OPENROUTER_API_KEY —— 统一认证凭证。本地启动后所有权限校验均接受它（admin 角色）；
 *    部署到现场若未接入 RBAC，则自动降级为「唯一凭证」，保证无 RBAC 场景下服务不中断、权限校验不挂。
 * 2. RBAC 体系 —— UI_TOKENS / UI_AUTH_TOKEN / UI_ROLE_PERMISSIONS / AUTH_PROVIDER(oidc|proxy)。
 *    接入后按角色判定，但 OPENROUTER_API_KEY 仍作为 admin 逃生通道并行生效。
 *
 * 降级判定：当未配置任何 RBAC 凭证（无 UI_TOKENS / UI_AUTH_TOKEN / UI_ROLE_PERMISSIONS 且
 * AUTH_PROVIDER 为默认 token）→ 视为「未接入 RBAC」，OPENROUTER_API_KEY 即权限判断唯一凭证：
 *   - 配置了 key：仅接受该 key（admin，全权限），其余一律 401/403。
 *   - 连 key 都缺失：fail-open（全放行），确保服务即便零配置也能启动、权限校验不中断。
 *
 * requireAuth=false（且无 key 无 RBAC）时同样全放行，保持本地/演示的开放语义（向后兼容）。
 */
export function createAuthorizer(requireAuth: boolean): Authorizer {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  const rbacConfigured = !!(
    process.env.UI_TOKENS ||
    process.env.UI_AUTH_TOKEN ||
    process.env.UI_ROLE_PERMISSIONS
  );

  // 全放行（开放语义）：本地无 key 且无 RBAC 的演示态，或 requireAuth=false。
  // describe() 仍返回默认角色权限矩阵作为参考（见 defaultDescribe），保证前端列表完整。
  const openAuth: Authorizer = {
    authenticate: () => ({ token: '', sub: 'anon', role: 'admin' }),
    can: () => true,
    describe: defaultDescribe,
  };

  // ── 降级模式：requireAuth 触发、但未接入任何 RBAC 凭证 ──
  // 现场环境若未接入 RBAC，则自动降级：OPENROUTER_API_KEY 作为权限判断的唯一凭证。
  if (requireAuth && !rbacConfigured) {
    if (apiKey) {
      // 仅接受 OPENROUTER_API_KEY（admin 全权限）；其余一律拒绝（保证权限校验不挂、不越权）。
      return new RoleBasedAuthorizer({
        fallbackToken: apiKey,
        fallbackRole: 'admin',
        degraded: true,
      });
    }
    // 连唯一凭证都缺失 → fail-open，服务不中断（仅本地/演示，权限校验开放）。
    return openAuth;
  }

  // 完全开放语义（requireAuth=false 且无 key 也无 RBAC）。
  if (!requireAuth) return openAuth;

  // ── RBAC 已接入：token / oidc / proxy 模式 ──
  // OPENROUTER_API_KEY 始终作为 admin 逃生通道（统一认证依据），与 RBAC 角色并行生效。
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
  // 业务令牌鉴权器；若配置了 OPENROUTER_API_KEY 则追加为 admin 逃生通道。
  const staticAuth: RoleBasedAuthorizer | undefined = hasStatic
    ? new RoleBasedAuthorizer({ tokens, fallbackToken: fallback, fallbackRole: 'operator', apiKeyToken: apiKey })
    : apiKey
      ? new RoleBasedAuthorizer({ fallbackToken: apiKey, fallbackRole: 'admin' })
      : undefined;

  const provider = (process.env.AUTH_PROVIDER || 'token').toLowerCase();

  if (provider === 'oidc') {
    // policy 持有 RBAC 权限矩阵（can/describe 委托给它）；fallback 提供静态令牌/key 逃生通道。
    return new OidcAuthorizer({
      mapping: loadRoleMapping(),
      policy: staticAuth ?? new RoleBasedAuthorizer({ apiKeyToken: apiKey }),
      fallback: staticAuth,
    });
  }
  if (provider === 'proxy') {
    return new ProxyAuthorizer({
      mapping: loadRoleMapping(),
      policy: staticAuth ?? new RoleBasedAuthorizer({ apiKeyToken: apiKey }),
      fallback: staticAuth,
    });
  }

  // token 模式（默认）：必须有静态令牌或 OPENROUTER_API_KEY，否则全拒绝（fail-closed）。
  // 无任何凭证时的 describe 同样返回默认矩阵参考，保证前端角色列表完整。
  return staticAuth ?? {
    authenticate: () => null,
    can: () => false,
    describe: defaultDescribe,
  };
}
