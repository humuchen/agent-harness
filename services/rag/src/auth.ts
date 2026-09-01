/**
 * auth.ts — RAG 鉴权（P2：完整鉴权 / JWT / 租户 secret 派生）。
 *
 * 零依赖（仅 node:crypto）。提供两种 bearer 凭证解析：
 *   1. 静态令牌：RAG_TOKENS="tenant:secret" 映射 secret->tenant（既有能力）。
 *   2. JWT（HS256）：RAG_JWT_SECRET 配置后启用；令牌 `tenant` 声明（或 sub）即租户。
 *      agent-harness 侧可据此为不同租户签发短期 JWT，避免长期共享 secret。
 *
 * 无论哪种凭证，tenant_id 都「服务端重写」——请求体里的 tenant_id 一律被覆盖，
 * 杜绝客户端伪造跨租户读写（设计文档第 7/8 节「权限隔离」）。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export type TenantResolution =
  | { tenantId: string }
  | { error: number; message: string };

export interface ResolveOptions {
  /** secret -> tenantId 映射（多租户静态令牌）。 */
  tokens?: Map<string, string>;

  /** 开放模式（无令牌/JWT）时的默认租户。 */
  defaultTenant?: string;

  /** 启用 JWT 校验的 HMAC 密钥；未配置则仅静态令牌可用。 */
  jwtSecret?: string;

  /** JWT 中承载租户的声明名，默认 "tenant"。 */
  jwtTenantClaim?: string;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** 签发 HS256 JWT（零依赖）。 */
export function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  opts?: { expiresInSec?: number; kid?: string }
): string {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
    ...(opts?.kid ? { kid: opts.kid } : {})
  };
  const now = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {
    ...payload,
    iat: payload.iat ?? now,
    ...(opts?.expiresInSec ? { exp: now + opts.expiresInSec } : {})
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = createHmac('sha256', secret)
    .update(`${h}.${p}`)
    .digest('base64url');
  return `${h}.${p}.${sig}`;
}

/** 校验 HS256 JWT；失败（签名/过期/格式）返回 null。 */
export function verifyJwt(
  token: string,
  secret: string
): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const h = parts[0];
  const p = parts[1];
  const s = parts[2];
  if (!h || !p || !s) return null;
  const expected = createHmac('sha256', secret)
    .update(`${h}.${p}`)
    .digest('base64url');
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(p, 'base64url').toString('utf8')
    ) as Record<string, unknown>;
    if (
      typeof payload.exp === 'number' &&
      payload.exp < Math.floor(Date.now() / 1000)
    )
      return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * 从请求 Authorization 头解析租户。优先级：
 *   JWT 启用且令牌是合法 JWT -> 取 tenant 声明；
 *   否则尝试静态令牌映射；
 *   都失败 -> 401（缺令牌）/ 403（令牌无效）。
 * 若既无 tokens 也无 jwtSecret（开放模式），返回默认租户（仅限可信内网）。
 */
export function resolveTenant(
  req: IncomingMessage,
  opts: ResolveOptions
): TenantResolution {
  const tokens = opts.tokens;
  const jwtSecret = opts.jwtSecret;

  if ((!tokens || tokens.size === 0) && !jwtSecret) {
    return { tenantId: opts.defaultTenant || 'default' };
  }

  const auth = (req.headers['authorization'] as string | undefined) || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return { error: 401, message: 'missing bearer token' };
  const raw = (m[1] ?? '').trim();

  // 1) JWT 优先（若启用）
  if (jwtSecret) {
    const payload = verifyJwt(raw, jwtSecret);
    if (payload) {
      const tenant = String(
        payload[opts.jwtTenantClaim || 'tenant'] ?? payload.sub ?? ''
      );
      if (tenant) return { tenantId: tenant };
      return { error: 403, message: 'jwt missing tenant claim' };
    }
    // 校验失败：继续尝试静态令牌（若该令牌其实是静态 secret）
  }

  // 2) 静态令牌
  if (tokens && tokens.size) {
    const tenant = tokens.get(raw);
    if (tenant) return { tenantId: tenant };
  }

  return { error: 403, message: 'invalid token' };
}
