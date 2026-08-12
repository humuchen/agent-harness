/**
 * SSO / 外部身份源集成（零依赖，仅用 Node 内置 crypto + fetch）。
 *
 * 本文件实现两类可插拔身份源，二者都产出统一的 AuthContext（角色由组/群组成员映射），
 * 最终复用 authz.ts 的 Authorizer 接口（authenticate / can / describe），server 其余代码零改动：
 *
 *  1) OIDC（Bearer JWT）：校验 `Authorization: Bearer <JWT>`。用 IdP 的 JWKS 验证签名
 *     （支持 RS256/384/512、PS256/384/512、ES256/384/512、HS256/384/512），校验
 *     iss / aud / exp，再从 claims（默认 groups）映射 admin/operator/viewer。
 *     适用：Keycloak / Okta / Azure AD / Auth0 / 任意标准 OIDC IdP 向客户端签发 JWT、
 *     客户端（Web/CLI/SDK）持 JWT 直接调用本服务资源服务器的场景。
 *
 *  2) proxy（Header 注入）：适用于 LDAP / SSO 网关（Authelia / OAuth2 Proxy /
 *     Keycloak / nginx auth_request / Traefik forward-auth）。网关完成认证后注入
 *     X-Forwarded-User / X-Forwarded-Email / X-Forwarded-Groups，本服务据组→角色映射。
 *     可选 HMAC 校验（PROXY_HMAC_SECRET）防止非受信网络下的头伪造。
 *     这是企业落地 LDAP/SSO 的**最低成本路径**：把 agent-harness 部署在网关之后即可。
 *
 * 两类 provider 都支持 break-glass：即使启用 OIDC/proxy，只要配置了 UI_TOKENS /
 * UI_AUTH_TOKEN，静态令牌仍可越过外部 IdP 直接鉴权（运维逃生通道）。
 *
 * 注意：本文件仅 `import type` 引用 authz（类型），运行时单向依赖 authz→sso，避免循环依赖。
 */
import { createPublicKey, createVerify, createHmac, timingSafeEqual, constants } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Authorizer, AuthContext, Role, Action } from './authz';

export type SsoProvider = 'token' | 'oidc' | 'proxy';

// ---------------------------------------------------------------------------
// 角色映射（OIDC 与 proxy 共用）
// ---------------------------------------------------------------------------

export interface RoleMapping {
  admin: string[];
  operator: string[];
  viewer: string[];
  defaultRole?: Role;
}

/** 从环境变量装配组→角色映射。OIDC 与 proxy 都消费同一份映射。 */
export function loadRoleMapping(): RoleMapping {
  const csv = (v: string | undefined): string[] =>
    (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const raw = (process.env.SSO_DEFAULT_ROLE || '').trim().toLowerCase();
  const defaultRole = (['admin', 'operator', 'viewer'] as Role[]).includes(raw as Role)
    ? (raw as Role)
    : undefined;
  return {
    admin: csv(process.env.SSO_ADMIN_GROUPS),
    operator: csv(process.env.SSO_OPERATOR_GROUPS),
    viewer: csv(process.env.SSO_VIEWER_GROUPS),
    defaultRole,
  };
}

/** 按组集合映射角色：admin > operator > viewer；都不命中且无 default 则拒绝（返回 null）。 */
export function mapGroupsToRole(groups: string[], m: RoleMapping): Role | null {
  const want = new Set(groups.map((g) => g.toLowerCase()));
  const hit = (set: string[]): boolean => set.some((g) => want.has(g.toLowerCase()));
  if (hit(m.admin)) return 'admin';
  if (hit(m.operator)) return 'operator';
  if (hit(m.viewer)) return 'viewer';
  return m.defaultRole ?? null;
}

// 非密码学哈希，仅用于日志/展示截断（sub 已是从 IdP 来的真实身份，不泄露密钥）。
function fingerprint(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, '0').slice(0, 8);
}

// ---------------------------------------------------------------------------
// JWT 解析 / 验签（零依赖）
// ---------------------------------------------------------------------------

interface JWK {
  kty: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Buffer;
  signingInput: string;
}

function b64urlToBuf(s: string): Buffer {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 === 0 ? '' : '='.repeat(4 - (t.length % 4));
  return Buffer.from(t + pad, 'base64');
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8')) as Record<string, unknown>;
    return { header, payload, signature: b64urlToBuf(parts[2]), signingInput: `${parts[0]}.${parts[1]}` };
  } catch {
    return null;
  }
}

/** EC 原始 R||S 签名 → DER（Node crypto.verify 对 EC 期望 DER 编码）。 */
function ecRawToDer(raw: Buffer): Buffer {
  const half = raw.length / 2;
  const strip = (b: Buffer): Buffer => (b.length > 1 && b[0] === 0 ? b.subarray(1) : b);
  const r = strip(raw.subarray(0, half));
  const s = strip(raw.subarray(half));
  const intBytes = (b: Buffer): Buffer => {
    const lead = b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b;
    return Buffer.concat([Buffer.from([0x02]), Buffer.from([lead.length]), lead]);
  };
  const body = Buffer.concat([intBytes(r), intBytes(s)]);
  const len = body.length;
  const lenBytes = len < 128 ? Buffer.from([len]) : Buffer.from([0x81, len]);
  return Buffer.concat([Buffer.from([0x30]), lenBytes, body]);
}

function verifyJwtSignature(jwt: ParsedJwt, jwk: JWK, clientSecret?: string): boolean {
  const alg = String(jwt.header.alg ?? '');
  try {
    if (alg === 'HS256' || alg === 'HS384' || alg === 'HS512') {
      if (!clientSecret) return false;
      const expected = createHmac(alg.replace('HS', 'sha'), clientSecret).update(jwt.signingInput).digest();
      return expected.length === jwt.signature.length && timingSafeEqual(expected, jwt.signature);
    }
    const key = createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' });
    if (alg === 'RS256' || alg === 'RS384' || alg === 'RS512') {
      const v = createVerify(alg.replace('RS', 'sha'));
      v.update(jwt.signingInput);
      return v.verify(key, jwt.signature);
    }
    if (alg === 'PS256' || alg === 'PS384' || alg === 'PS512') {
      const v = createVerify(alg.replace('PS', 'sha'));
      v.update(jwt.signingInput);
      return v.verify(
        { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
        jwt.signature
      );
    }
    if (alg === 'ES256' || alg === 'ES384' || alg === 'ES512') {
      const v = createVerify(alg.replace('ES', 'sha'));
      v.update(jwt.signingInput);
      return v.verify(key, ecRawToDer(jwt.signature));
    }
    return false;
  } catch {
    return false;
  }
}

function validateClaims(
  payload: Record<string, unknown>,
  issuer?: string,
  audience?: string
): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) return false;
  if (typeof payload.nbf === 'number' && now < payload.nbf) return false;
  if (issuer) {
    if (Array.isArray(payload.iss)) {
      if (!(payload.iss as unknown[]).includes(issuer)) return false;
    } else if (payload.iss !== issuer) {
      return false;
    }
  }
  if (audience) {
    const aud = Array.isArray(payload.aud) ? (payload.aud as unknown[]) : [payload.aud];
    if (!aud.includes(audience)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// JWKS 获取（优先内联 OIDC_JWKS，其次 OIDC_JWKS_URI，最后 issuer 发现）
// ---------------------------------------------------------------------------

let jwksCache: JWK[] | null = null;
let jwksCachedAt = 0;
const JWKS_TTL_MS = 3_600_000;

function inlineJwks(): JWK[] | null {
  const raw = process.env.OIDC_JWKS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { keys?: JWK[] } | JWK[];
    if (Array.isArray(parsed)) return parsed;
    return parsed.keys ?? null;
  } catch {
    return null;
  }
}

/** 同步取 JWKS：内联优先，其次用已缓存的远端结果（由 warmJwks 后台刷新）。 */
function getJwksSync(): JWK[] {
  const inline = inlineJwks();
  if (inline && inline.length) return inline;
  if (jwksCache && Date.now() - jwksCachedAt < JWKS_TTL_MS) return jwksCache;
  return jwksCache ?? [];
}

async function resolveJwksUri(): Promise<string | null> {
  const explicit = process.env.OIDC_JWKS_URI;
  if (explicit) return explicit;
  const issuer = process.env.OIDC_ISSUER;
  if (!issuer) return null;
  try {
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const cfg = (await res.json()) as { jwks_uri?: string };
    return cfg.jwks_uri ?? null;
  } catch {
    return null;
  }
}

/** 异步刷新 JWKS 缓存（后台定时 + 启动预热）。内联模式无需网络，直接返回。 */
export async function warmJwks(): Promise<void> {
  if (inlineJwks()) return;
  const uri = await resolveJwksUri();
  if (!uri) return;
  try {
    const res = await fetch(uri, { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const data = (await res.json()) as { keys?: JWK[] };
    jwksCache = data.keys ?? [];
    jwksCachedAt = Date.now();
  } catch {
    /* 保留旧缓存；IdP 不可达时 fail-closed（无密钥即拒绝） */
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function hdr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = hdr(req, 'authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const q = url.searchParams.get('token');
  return q ?? null;
}

/** OIDC 的 groups/roles claim 可能是数组，也可能是逗号/空格分隔字符串。 */
function groupsFromClaim(payload: Record<string, unknown>, claim: string): string[] {
  const v = payload[claim];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.length) return v.split(/[ ,]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

// ---------------------------------------------------------------------------
// OIDC Authorizer（Bearer JWT 资源服务器）
// ---------------------------------------------------------------------------

export interface SsoAuthorizerOpts {
  mapping: RoleMapping;
  /** 持有 RBAC 权限矩阵的 policy（can/describe 委托给它）。 */
  policy: Authorizer;
  /** break-glass：静态令牌鉴权器（配置了 UI_TOKENS/UI_AUTH_TOKEN 时才传入）。 */
  fallback?: Authorizer;
}

export class OidcAuthorizer implements Authorizer {
  private readonly mapping: RoleMapping;
  private readonly policy: Authorizer;
  private readonly fallback?: Authorizer;

  constructor(opts: SsoAuthorizerOpts) {
    this.mapping = opts.mapping;
    this.policy = opts.policy;
    this.fallback = opts.fallback;
    if (!process.env.OIDC_ISSUER && !process.env.OIDC_JWKS_URI && !process.env.OIDC_JWKS) {
      console.warn(
        '   ⚠️  AUTH_PROVIDER=oidc 但未配置 OIDC_ISSUER / OIDC_JWKS_URI / OIDC_JWKS，所有请求将被拒绝（fail-closed）。'
      );
    }
  }

  authenticate(req: IncomingMessage): AuthContext | null {
    const token = bearerToken(req);
    if (!token) return this.fallback?.authenticate(req) ?? null;

    const jwt = parseJwt(token);
    if (!jwt) return this.fallback?.authenticate(req) ?? null;

    const keys = getJwksSync();
    if (!keys.length) return this.fallback?.authenticate(req) ?? null;

    // 选候选密钥：优先 kid 匹配；若 IdP/内联 JWKS 的密钥未带 kid（常见），回退尝试全部密钥。
    // 逐把尝试验签也天然兼容 IdP 的密钥轮换（多密钥并存）。
    const kid = jwt.header.kid as string | undefined;
    const candidates = kid ? keys.filter((k) => k.kid === kid) : keys;
    const tried = candidates.length ? candidates : keys;
    const clientSecret = process.env.OIDC_CLIENT_SECRET || undefined;
    let sigOk = false;
    for (const k of tried) {
      if (verifyJwtSignature(jwt, k, clientSecret)) {
        sigOk = true;
        break;
      }
    }
    if (!sigOk) return this.fallback?.authenticate(req) ?? null;

    const issuer = process.env.OIDC_ISSUER;
    const audience = process.env.OIDC_AUDIENCE || process.env.OIDC_CLIENT_ID || undefined;
    if (!validateClaims(jwt.payload, issuer, audience)) return this.fallback?.authenticate(req) ?? null;

    const groupsClaim = process.env.OIDC_ROLE_CLAIM || 'groups';
    const groups = groupsFromClaim(jwt.payload, groupsClaim);
    const role = mapGroupsToRole(groups, this.mapping);
    if (!role) return this.fallback?.authenticate(req) ?? null;

    const usernameClaim = process.env.OIDC_USERNAME_CLAIM || 'preferred_username';
    const sub =
      String(jwt.payload[usernameClaim] ?? jwt.payload.sub ?? 'unknown');
    const emailClaim = process.env.OIDC_EMAIL_CLAIM || 'email';
    const email = jwt.payload[emailClaim] ? String(jwt.payload[emailClaim]) : undefined;
    const name = jwt.payload.name ? String(jwt.payload.name) : undefined;

    return { token: fingerprint(token), sub, role, email, name, groups };
  }

  can(ctx: AuthContext, action: Action): boolean {
    return this.policy.can(ctx, action);
  }

  describe() {
    return {
      ...this.policy.describe(),
      mode: 'on' as const,
      provider: 'oidc' as const,
      idp: {
        kind: 'oidc' as const,
        issuer: process.env.OIDC_ISSUER,
        groupsClaim: process.env.OIDC_ROLE_CLAIM || 'groups',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Proxy Authorizer（LDAP / SSO 网关头注入）
// ---------------------------------------------------------------------------

export class ProxyAuthorizer implements Authorizer {
  private readonly mapping: RoleMapping;
  private readonly policy: Authorizer;
  private readonly fallback?: Authorizer;

  constructor(opts: SsoAuthorizerOpts) {
    this.mapping = opts.mapping;
    this.policy = opts.policy;
    this.fallback = opts.fallback;
  }

  authenticate(req: IncomingMessage): AuthContext | null {
    const userHeader = (process.env.PROXY_USER_HEADER || 'x-forwarded-user').toLowerCase();
    const groupsHeader = (process.env.PROXY_GROUPS_HEADER || 'x-forwarded-groups').toLowerCase();
    const emailHeader = (process.env.PROXY_EMAIL_HEADER || 'x-forwarded-email').toLowerCase();
    const sigHeader = (process.env.PROXY_HMAC_HEADER || 'x-forwarded-signature').toLowerCase();
    const sep = process.env.PROXY_GROUPS_SEPARATOR || ',';

    const user = hdr(req, userHeader);
    if (!user) return this.fallback?.authenticate(req) ?? null;

    // 可选 HMAC：仅在配置了 PROXY_HMAC_SECRET 时强制校验，防非受信网络头伪造。
    const secret = process.env.PROXY_HMAC_SECRET;
    if (secret) {
      const sig = hdr(req, sigHeader);
      if (!sig) return null;
      const expected = createHmac('sha256', secret).update(user).digest('hex');
      if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        return null;
      }
    }

    const groupsRaw = hdr(req, groupsHeader);
    const groups = groupsRaw ? groupsRaw.split(sep).map((s) => s.trim()).filter(Boolean) : [];
    const role = mapGroupsToRole(groups, this.mapping);
    if (!role) return this.fallback?.authenticate(req) ?? null;

    return {
      token: fingerprint(user),
      sub: user,
      role,
      email: hdr(req, emailHeader) || undefined,
      groups,
    };
  }

  can(ctx: AuthContext, action: Action): boolean {
    return this.policy.can(ctx, action);
  }

  describe() {
    return {
      ...this.policy.describe(),
      mode: 'on' as const,
      provider: 'proxy' as const,
      idp: {
        kind: 'proxy' as const,
        userHeader: process.env.PROXY_USER_HEADER || 'x-forwarded-user',
        groupsHeader: process.env.PROXY_GROUPS_HEADER || 'x-forwarded-groups',
        hmac: !!process.env.PROXY_HMAC_SECRET,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 供前端取用的鉴权元信息（公开端点 /api/auth/config）
// ---------------------------------------------------------------------------

export function getAuthConfig(): {
  provider: SsoProvider;
  oidc?: {
    issuer?: string;
    clientId?: string;
    scopes: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
  };
  proxy?: {
    headers: { user: string; email: string; groups: string; signature?: string };
  };
} {
  const provider = ((process.env.AUTH_PROVIDER || 'token').toLowerCase() as SsoProvider);
  if (provider === 'oidc') {
    return {
      provider,
      oidc: {
        issuer: process.env.OIDC_ISSUER,
        clientId: process.env.OIDC_CLIENT_ID || process.env.OIDC_AUDIENCE,
        scopes: process.env.OIDC_SCOPES || 'openid profile email groups',
        authorizationEndpoint: process.env.OIDC_AUTH_ENDPOINT,
        tokenEndpoint: process.env.OIDC_TOKEN_ENDPOINT,
      },
    };
  }
  if (provider === 'proxy') {
    const hmac = !!process.env.PROXY_HMAC_SECRET;
    return {
      provider,
      proxy: {
        headers: {
          user: process.env.PROXY_USER_HEADER || 'x-forwarded-user',
          email: process.env.PROXY_EMAIL_HEADER || 'x-forwarded-email',
          groups: process.env.PROXY_GROUPS_HEADER || 'x-forwarded-groups',
          signature: hmac ? process.env.PROXY_HMAC_HEADER || 'x-forwarded-signature' : undefined,
        },
      },
    };
  }
  return { provider: 'token' };
}
