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
// 账户密码身份源（注册/登录 + 服务端签发 7 天 token + cookie）。与 OIDC/proxy/静态令牌共存，
// 作为 Authorizer 的 fallback 档。accounts 仅依赖 node 内置模块，无循环依赖风险。
import {
  parseToken,
  isTokenValidLocally,
  cookieValue,
  AUTH_COOKIE
} from './accounts';

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
  /** 身份源：token（静态令牌）/ oidc（Bearer JWT）/ proxy（SSO 网关头注入）/ account（账户密码）。 */
  provider: 'token' | 'oidc' | 'proxy' | 'account';
  roles: Role[];
  permissions: Record<Role, Action[]>;
  idp?: {
    kind: 'oidc' | 'proxy';
    issuer?: string;
    groupsClaim?: string;
    userHeader?: string;
    groupsHeader?: string;
    hmac?: boolean;
  };
  /** 降级模式：未接入 RBAC 时，OPEN_API_KEY 作为权限判断唯一凭证。 */
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
    'agent:run:mock',
    'agent:run:real',
    'agent:run:real-mcp',
    'verify',
    'env:create',
    'env:destroy',
    'mcp:read',
    'mcp:add',
    'mcp:preset',
    'mcp:reconnect',
    'shell:approve',
    'memory:read',
    'memory:clear',
    'metrics:read',
    'errors:read',
    'jobs:read',
    'sessions:read',
    'eval:run',
    'recipe:save',
    'recipe:read',
    'policy:read',
    'approvals:review',
    'agent:read',
    'agent:register',
    'workflow:run',
    'workflow:read',
    'a2a:receive',
    'a2a:send',
    'plugin:manage',
    'chat:read',
    'chat:write',
    'chat:delete',
    'env:read',
    'upload:file'
  ],
  operator: [
    'agent:run:mock',
    'agent:run:real',
    'agent:run:real-mcp',
    'verify',
    'env:create',
    'env:destroy',
    'mcp:read',
    'mcp:add',
    'mcp:preset',
    'mcp:reconnect',
    'shell:approve',
    'memory:read',
    'metrics:read',
    'jobs:read',
    'sessions:read',
    'eval:run',
    'recipe:save',
    'recipe:read',
    'policy:read',
    'agent:read',
    'agent:register',
    'workflow:run',
    'workflow:read',
    'a2a:receive',
    'a2a:send',
    'plugin:manage',
    'chat:read',
    'chat:write',
    'chat:delete',
    'env:read',
    'upload:file'
  ],
  viewer: [
    'agent:run:mock',
    'mcp:read',
    'memory:read',
    'metrics:read',
    'errors:read',
    'jobs:read',
    'sessions:read',
    'recipe:read',
    'policy:read',
    'agent:read',
    'workflow:run',
    'workflow:read',
    'a2a:receive',
    'a2a:send',
    'chat:read',
    'env:read'
  ]
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
    permissions: DEFAULT_MATRIX
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

  constructor(
    opts: {
      tokens?: Record<string, Role>;
      fallbackToken?: string;
      fallbackRole?: Role;
      apiKeyToken?: string;
      degraded?: boolean;
    } = {}
  ) {
    this.matrix = loadMatrix();
    if (opts.tokens)
      for (const [t, r] of Object.entries(opts.tokens)) this.tokens.set(t, r);
    // OPEN_API_KEY 统一作为 admin 凭证（逃生通道），跨模式始终生效。
    if (opts.apiKeyToken) this.tokens.set(opts.apiKeyToken, 'admin');
    if (opts.fallbackToken && opts.fallbackRole)
      this.tokens.set(opts.fallbackToken, opts.fallbackRole);
    this.degraded = !!opts.degraded;
  }

  authenticate(req: IncomingMessage): AuthContext | null {
    const auth = req.headers['authorization'];
    let token: string | null = null;
    if (
      auth &&
      typeof auth === 'string' &&
      auth.toLowerCase().startsWith('bearer ')
    ) {
      token = auth.slice(7).trim();
    }
    if (!token) {
      const url = new URL(
        req.url ?? '/',
        `http://${req.headers.host ?? 'localhost'}`
      );
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
      degraded: this.degraded
    };
  }
}

// ---------------------------------------------------------------------------
// 账户密码身份源（注册/登录 + 服务端签发 7 天 token + cookie）
// ---------------------------------------------------------------------------

/** 从请求读取账户 token：优先 Cookie（浏览器自动带），其次 Authorization Bearer，再次 ?token=（API 客户端兼容）。 */
function accountTokenRaw(req: IncomingMessage): string | null {
  const fromCookie = cookieValue(req, AUTH_COOKIE);
  if (fromCookie) return fromCookie;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const q = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams.get('token');
  return q;
}

/**
 * AccountAuthorizer：账户密码档的鉴权器。
 * - token 取自 Cookie / Authorization / ?token；
 * - 必须同时存在 x-ah-username 头，且头中 username 与 token 内签名 username 一致
 *   （防客户端只伪造 username 头绕过；服务端以签名为准）；
 * - 验签 + 服务端 token 记录仍有效（7 天 TTL / 吊销）。
 * 失败返回 null（调用方 401）。
 */
export class AccountAuthorizer implements Authorizer {
  private readonly policy: Authorizer;
  private readonly fallback?: Authorizer;

  constructor(policy: Authorizer, fallback?: Authorizer) {
    this.policy = policy;
    this.fallback = fallback;
  }

  authenticate(req: IncomingMessage): AuthContext | null {
    const raw = accountTokenRaw(req);
    if (raw) {
      const t = parseToken(raw);
      // 头中的 username 必须存在且与 token 内 username 一致（签名不可伪造，头仅作双因子校验）。
      const headerUser = req.headers['x-ah-username'];
      const username = Array.isArray(headerUser) ? headerUser[0] : headerUser;
      if (t && username && username === t.username && isTokenValidLocally(t)) {
        return { token: t.jti, sub: t.username, role: 'admin' };
      }
    }
    // 账户档未命中（无 cookie / 签错 / 过期）→ 回退到 OIDC / proxy / 静态令牌等其它身份源。
    return this.fallback?.authenticate(req) ?? null;
  }

  can(ctx: AuthContext, action: Action): boolean {
    return this.policy.can(ctx, action);
  }

  describe() {
    return {
      ...this.policy.describe(),
      mode: 'on' as const,
      provider: 'account' as const
    };
  }
}

/**
 * 组合工厂：从环境变量装配 Authorizer。
 *
 * 认证依据（按优先级）：
 * 1. OPEN_API_KEY —— 统一认证凭证。本地启动后所有权限校验均接受它（admin 角色）；
 *    部署到现场若未接入 RBAC，则自动降级为「唯一凭证」，保证无 RBAC 场景下服务不中断、权限校验不挂。
 * 2. RBAC 体系 —— UI_TOKENS / UI_AUTH_TOKEN / UI_ROLE_PERMISSIONS / AUTH_PROVIDER(oidc|proxy)。
 *    接入后按角色判定，但 OPEN_API_KEY 仍作为 admin 逃生通道并行生效。
 *
 * 降级判定：当未配置任何 RBAC 凭证（无 UI_TOKENS / UI_AUTH_TOKEN / UI_ROLE_PERMISSIONS 且
 * AUTH_PROVIDER 为默认 token）→ 视为「未接入 RBAC」，OPEN_API_KEY 即权限判断唯一凭证：
 *   - 配置了 key：仅接受该 key（admin，全权限），其余一律 401/403。
 *   - 连 key 都缺失：fail-open（全放行），确保服务即便零配置也能启动、权限校验不中断。
 *
 * requireAuth=false（且无 key 无 RBAC）时同样全放行，保持本地/演示的开放语义（向后兼容）。
 */
export function createAuthorizer(requireAuth: boolean): Authorizer {
  const apiKey = process.env.OPEN_API_KEY || '';
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
    describe: defaultDescribe
  };

  // 严格拒绝档：无任何身份源命中即 401/403（fail-closed）。账户档未命中时回退到此，
  // 而不是 fail-open 的 openAuth —— 否则「账户 + 无其它凭证」部署下会退化为全员放行。
  const strictClosed: Authorizer = {
    authenticate: () => null,
    can: () => false,
    describe: defaultDescribe
  };

  // 统一收口：把账户档包进 AccountAuthorizer。policy 用完整 RBAC 矩阵（can 委托，账户登录即 admin 全权限）；
  // fallback 为「严格链」——账户未命中时回退到 OIDC / proxy / 静态令牌等原有身份源（严格拒绝）。
  // 注意：fallback 永远用 strictClosed，绝不用 openAuth（fail-open），否则账户档形同虚设。
  const accountOf = (fallback: Authorizer): Authorizer =>
    new AccountAuthorizer(new RoleBasedAuthorizer(), fallback);

  // ── 降级模式：requireAuth 触发、但未接入任何 RBAC 凭证 ──
  // 现场环境若未接入 RBAC，则自动降级：OPEN_API_KEY 作为权限判断的唯一凭证。
  if (requireAuth && !rbacConfigured) {
    if (apiKey) {
      // 仅接受 OPEN_API_KEY（admin 全权限）；其余一律拒绝（保证权限校验不挂、不越权）。
      return accountOf(
        new RoleBasedAuthorizer({
          fallbackToken: apiKey,
          fallbackRole: 'admin',
          degraded: true
        })
      );
    }
    // 连唯一凭证都缺失：启用账户密码档作为唯一身份源（严格回退，无 cookie 即 401），
    // 不再 fail-open（fail-open 仅限 requireAuth=false 的显式开放语义）。
    return accountOf(strictClosed);
  }

  // 完全开放语义（requireAuth=false 且无 key 也无 RBAC）：显式放行。
  // 仍包一层 AccountAuthorizer —— 有合法账户 cookie 时按账户身份放行，无 cookie 则失败开放。
  if (!requireAuth) return accountOf(openAuth);

  // ── RBAC 已接入：token / oidc / proxy 模式 ──
  // OPEN_API_KEY 始终作为 admin 逃生通道（统一认证依据），与 RBAC 角色并行生效。
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
  // 业务令牌鉴权器；若配置了 OPEN_API_KEY 则追加为 admin 逃生通道。
  const staticAuth: RoleBasedAuthorizer | undefined = hasStatic
    ? new RoleBasedAuthorizer({
        tokens,
        fallbackToken: fallback,
        fallbackRole: 'operator',
        apiKeyToken: apiKey
      })
    : apiKey
    ? new RoleBasedAuthorizer({ fallbackToken: apiKey, fallbackRole: 'admin' })
    : undefined;

  const provider = (process.env.AUTH_PROVIDER || 'token').toLowerCase();

  if (provider === 'oidc') {
    // policy 持有 RBAC 权限矩阵（can/describe 委托给它）；fallback 提供静态令牌/文章逃生通道。
    return accountOf(
      new OidcAuthorizer({
        mapping: loadRoleMapping(),
        policy: staticAuth ?? new RoleBasedAuthorizer({ apiKeyToken: apiKey }),
        fallback: staticAuth
      })
    );
  }
  if (provider === 'proxy') {
    return accountOf(
      new ProxyAuthorizer({
        mapping: loadRoleMapping(),
        policy: staticAuth ?? new RoleBasedAuthorizer({ apiKeyToken: apiKey }),
        fallback: staticAuth
      })
    );
  }

  // token 模式（默认）：必须有静态令牌或 OPEN_API_KEY，否则全拒绝（fail-closed）。
  // 无任何凭证时的 describe 同样返回默认矩阵参考，保证前端角色列表完整。
  return accountOf(staticAuth ?? strictClosed);
}
