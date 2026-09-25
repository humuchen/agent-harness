/**
 * 账户路由模块（自 server.ts 外迁的第一批，验证「路由模块化」拆分模式）。
 *
 * 覆盖 /api/account/* 的公开端点（login-salt / register / login / forgot-password /
 * reset-password / me / change-password / logout / refresh / DELETE /api/account）。
 * OAuth（github/google）回调仍留在 server.ts（依赖 views / provider 配置，耦合更重）。
 *
 * 拆分约定（后续批次照此办理）：
 *  - 模块导出 `handleXxxRoutes(req, res, url, path, deps)`，命中返回 true（已写响应），
 *    未命中返回 false 由主分发器继续匹配；
 *  - 与 server.ts 强耦合的闭包（guard / audit / cookie 构造器 / clientIp）经 deps 注入，
 *    不 import server.ts（避免环）；
 *  - 纯通用助手从 http-helpers / accounts / rate-limit / config-defaults 直接 import。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import {
  DUMMY_SALT,
  getSalt,
  registerUser,
  registerWithDerivedHex,
  loginUser,
  loginWithDerivedHex,
  requestPasswordReset,
  resetPassword,
  resetPasswordWithDerivedHex,
  usernameFromCookie,
  getProfile,
  changePassword,
  changePasswordWithDerivedHex,
  revokeAllTokens,
  deleteUser,
  upsertGithubUser,
  upsertGoogleUser,
  rotateTokens,
  clearAuthCookie,
  authCookieValue,
  cookieValue,
  CSRF_COOKIE,
  csrfCookieValue,
  issueCsrfToken,
  REFRESH_TTL_MS,
  type AccountResult
} from '../accounts';
import {
  readBody,
  sendJsonError,
  securityHeaders,
  safeEqualString
} from '../http-helpers';
import { renderOAuthTransitionHtml } from '../views';
import { rateLimited } from '../rate-limit';
import { cfgNum } from '../config-defaults';
import { isCookieAuth, type Action, type AuthContext } from '../authz';

/** 主分发器注入的闭包依赖（见文件头「拆分约定」）。 */
export interface AccountRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action
  ) => Promise<AuthContext | null>;
  audit: (rec: Record<string, unknown>) => void;
  clientIp: (req: IncomingMessage) => string;
}

// ── cookie / OAuth 辅助（自 server.ts 外迁，第六批；仅本模块与 OAuth 回调使用）──
const OAUTH_STATE_COOKIE = 'ah_oauth_state';

/** 请求是否来自 localhost（dev 可走 http，不置 Secure）。 */
function isReqLocalhost(req: { headers?: Record<string, unknown> }): boolean {
  const host = String(req?.headers?.host ?? '');
  return (
    host.startsWith('localhost') ||
    host.startsWith('127.') ||
    host.startsWith('[::1]')
  );
}

/** 构造 refresh cookie 串（HttpOnly；30 天有效，与 REFRESH_TTL_MS 对齐）。无 token 时返回 null。 */
function refreshCookieValue(
  req: { headers?: Record<string, unknown> },
  refreshToken: string | undefined
): string | null {
  if (!refreshToken) return null;
  const parts = [
    `ah_refresh=${refreshToken}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${REFRESH_TTL_MS / 1000}`,
    `Expires=${new Date(Date.now() + REFRESH_TTL_MS).toUTCString()}`
  ];
  if (!isReqLocalhost(req)) parts.push('Secure');
  return parts.join('; ');
}

/** 构造 set-cookie 头数组：过滤掉 null，产出「每元素一个 Set-Cookie 头」数组。 */
function setCookies(...cookies: (string | null)[]): string[] {
  return cookies.filter((c): c is string => !!c);
}

/**
 * 构造 OAuth state cookie 串：HttpOnly + SameSite=None + Secure + 10min。
 * OAuth 跨站回调需要 None 才能被 WebView 携带；非 localhost 追加 Secure。
 */
function oauthStateCookie(
  req: { headers?: Record<string, unknown> },
  name: string,
  value: string
): string {
  const parts = [
    `${name}=${value}`,
    'HttpOnly',
    'SameSite=None',
    'Path=/',
    'Max-Age=600'
  ];
  if (!isReqLocalhost(req)) parts.push('Secure');
  return parts.join('; ');
}

/** 构造 PKCE code_verifier cookie 串（Google OAuth 专用）：与 oauthStateCookie 同策略。 */
function oauthCodeVerifierCookie(
  req: { headers?: Record<string, unknown> },
  value: string
): string {
  const parts = [
    `ah_oauth_cv=${value}`,
    'HttpOnly',
    'SameSite=None',
    'Path=/',
    'Max-Age=600'
  ];
  if (!isReqLocalhost(req)) parts.push('Secure');
  return parts.join('; ');
}

/** GitHub OAuth 回调 URL 构造：authorize 跳转与 callback 换 token 必须返回完全一致的值。 */
function githubRedirectUri(req: IncomingMessage): string {
  const cfg =
    process.env.GITHUB_OAUTH_REDIRECT || '/api/account/oauth/github/callback';
  if (cfg.startsWith('http')) return cfg; // 完整 URL，直接采用，不走协议推断
  const host = req.headers.host ? String(req.headers.host) : '';
  if (!host) return `${cfg.startsWith('/') ? '' : '/'}${cfg}`; // 无 host 兜底（保持原行为）
  const xfp = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    ?.trim();
  const proto =
    xfp || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}${cfg.startsWith('/') ? '' : '/'}${cfg}`;
}

/** Google OAuth 回调 URL 构造：与 githubRedirectUri 同理。 */
function googleRedirectUri(req: IncomingMessage): string {
  const cfg =
    process.env.GOOGLE_OAUTH_REDIRECT || '/api/account/oauth/google/callback';
  if (cfg.startsWith('http')) return cfg;
  const host = req.headers.host ? String(req.headers.host) : '';
  if (!host) return `${cfg.startsWith('/') ? '' : '/'}${cfg}`;
  const xfp = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    ?.trim();
  const proto =
    xfp || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}${cfg.startsWith('/') ? '' : '/'}${cfg}`;
}

// ── auth 端点独立严格限流（自 server.ts 迁入，仅账户路由使用）────────────────
// P1 安全加固：防撞库/批量注册/枚举。默认 20 次/分钟/IP（全局限流默认 120，对登录仍太宽）；
// 0=关闭。独立桶键前缀 auth: 避免与全局 IP 桶互相污染。
const AUTH_RATE_LIMIT = cfgNum('AUTH_RATE_LIMIT', 20);
const AUTH_RATE_WINDOW_MS = cfgNum('AUTH_RATE_WINDOW_MS', 60_000);

function authRateLimited(
  deps: AccountRouteDeps,
  req: IncomingMessage
): { limited: boolean; retryAfter: number } {
  const ip = deps.clientIp(req);
  if (!ip || !(AUTH_RATE_LIMIT > 0)) return { limited: false, retryAfter: 0 };
  return rateLimited(`auth:${ip}`, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_MS);
}

function authRateLimitExceeded(res: ServerResponse, retryAfterMs: number): void {
  res.writeHead(429, {
    'content-type': 'application/json',
    'retry-after': String(Math.ceil(retryAfterMs / 1000)),
    ...securityHeaders()
  });
  res.end(JSON.stringify({ ok: false, error: '请求过于频繁，请稍后重试' }));
}

/**
 * CSRF 双重提交校验（本模块专用兜底）。
 *
 * 为什么需要：server.ts 的 CSRF 门禁在 guard() 内，而 refresh / logout 是
 * 「cookie 鉴权 + 不经 guard」的状态变更端点——实测存在覆盖缺口（无 token 仍 200）。
 * change-password 经 guard 已覆盖；forgot/reset 为匿名 token 端点无 CSRF 面。
 * 缺失/不匹配时写 403 并返回 false（调用方直接 return true 结束）。
 */
function csrfGuard(req: IncomingMessage, res: ServerResponse): boolean {
  // 与 server.ts 的 CSRF_ENFORCE 同语义：off 时跳过（老客户端平滑过渡开关）。
  if (process.env.CSRF_ENFORCE === 'off') return true;
  if (!isCookieAuth(req)) return true; // 非 cookie 来源（机器客户端）无 CSRF 面
  const cookieTok = cookieValue(req, CSRF_COOKIE) ?? '';
  const raw = req.headers['x-csrf-token'];
  const headerTok = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  const ok =
    cookieTok.length > 0 &&
    cookieTok.length === headerTok.length &&
    timingSafeEqual(Buffer.from(cookieTok), Buffer.from(headerTok));
  if (ok) return true;
  res.writeHead(403, {
    'content-type': 'application/json',
    ...securityHeaders()
  });
  res.end(
    JSON.stringify({
      ok: false,
      error: 'CSRF 校验失败：缺少或无效的 x-csrf-token 头，请刷新页面后重试'
    })
  );
  return false;
}

/**
 * 账户路由入口：命中任一端点并完成响应后返回 true。
 * 该块位于主分发器鉴权 guard **之前**（登录/注册等必须匿名可达），
 * 各端点的鉴权要求在 handler 内自行保证（me/change-password 等经 deps.guard）。
 */
export async function handleAccountRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: AccountRouteDeps
): Promise<boolean> {
  // P1-14: 质询式密码保护 — 客户端先获取 salt，本地 PBKDF2 派生哈希，
  // 服务器仅比对哈希，不接触明文密码。
  if (req.method === 'GET' && path === '/api/account/login-salt') {
    const username = (url.searchParams.get('username') || '').trim();
    if (!username || !/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ salt: DUMMY_SALT }));
      return true;
    }
    const result = await getSalt(username);
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(
      JSON.stringify({ salt: result?.salt ?? DUMMY_SALT })
    );
    return true;
  }
  if (path === '/api/account/register' && req.method === 'POST') {
    // P1 安全加固：auth 端点独立严格限流（防批量注册）。
    const arl = authRateLimited(deps, req);
    if (arl.limited) {
      authRateLimitExceeded(res, arl.retryAfter);
      return true;
    }
    const b = await readBody(req);
    const u = typeof b?.username === 'string' ? b.username : '';
    const p = typeof b?.password === 'string' ? b.password : '';
    const dhx = typeof b?.derivedHex === 'string' ? b.derivedHex : '';
    // P1-14: 质询式注册 —— 客户端本地 PBKDF2 派生后发送 derivedHex + salt，而非明文密码。
    let r: AccountResult;
    if (dhx) {
      const salt = typeof b?.salt === 'string' ? b.salt : '';
      r = await registerWithDerivedHex(u, salt, dhx, b.email);
    } else {
      r = await registerUser(u, p, b.email);
    }
    if (!r.ok) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: r.error }));
      return true;
    }
    // 注册成功顺带登录，直接下发 cookie token，减少一次往返。
    const lr: AccountResult = dhx
      ? await loginWithDerivedHex(u, dhx)
      : await loginUser(u, p);
    if (!lr.ok || !lr.token) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: false, error: '注册成功但签发登录态失败' })
      );
      return true;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': setCookies(
        authCookieValue(req, lr.token),
        refreshCookieValue(req, lr.refreshToken),
        csrfCookieValue(req, issueCsrfToken())
      ),
      'cache-control': 'no-store'
    });
    res.end(
      JSON.stringify({
        ok: true,
        username: lr.username,
        accessExpiresAt: lr.accessExpiresAt,
        refreshToken: lr.refreshToken
      })
    );
    return true;
  }
  if (path === '/api/account/login' && req.method === 'POST') {
    // P1 安全加固：auth 端点独立严格限流（防撞库）。
    const arl = authRateLimited(deps, req);
    if (arl.limited) {
      authRateLimitExceeded(res, arl.retryAfter);
      return true;
    }
    const b = await readBody(req);
    const u = typeof b?.username === 'string' ? b.username : '';
    const p = typeof b?.password === 'string' ? b.password : '';
    const dhx = typeof b?.derivedHex === 'string' ? b.derivedHex : '';
    // P1-14: 质询式登录 —— 客户端本地 PBKDF2 派生后发送 derivedHex，服务器不接触明文密码。
    const r: AccountResult = dhx
      ? await loginWithDerivedHex(u, dhx)
      : await loginUser(u, p);
    if (!r.ok || !r.token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: r.error ?? '登录失败' }));
      return true;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': setCookies(
        authCookieValue(req, r.token),
        refreshCookieValue(req, r.refreshToken),
        csrfCookieValue(req, issueCsrfToken())
      ),
      'cache-control': 'no-store'
    });
    res.end(
      JSON.stringify({
        ok: true,
        username: r.username,
        accessExpiresAt: r.accessExpiresAt,
        refreshToken: r.refreshToken
      })
    );
    return true;
  }
  // ── 忘记密码 / 重置密码（公开，放在 guard 之前，与 register/login 同区）──
  if (req.method === 'POST' && path === '/api/account/forgot-password') {
    // P1 安全加固：auth 端点独立严格限流（防枚举/邮件轰炸）。
    const arl = authRateLimited(deps, req);
    if (arl.limited) {
      authRateLimitExceeded(res, arl.retryAfter);
      return true;
    }
    const b = await readBody(req);
    const identifier =
      typeof b?.identifier === 'string' ? b.identifier : '';
    const r = await requestPasswordReset(identifier);
    if (!r.ok) {
      res.writeHead(400, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ ok: false, error: r.error }));
      return true;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    // P0 安全修复：重置凭证默认带外下发（邮件/管理员转交），不再回传 HTTP 响应体——
    // 此前任何知道用户名的人调用本端点即可拿到 resetToken 接管任意账户（含 admin）。
    // 本地演示/联调可显式 PASSWORD_RESET_INLINE_TOKEN=on 恢复回传（仅限非公网环境）。
    const inline = ['1', 'true', 'on', 'yes'].includes(
      (process.env.PASSWORD_RESET_INLINE_TOKEN ?? '').trim().toLowerCase()
    );
    res.end(
      JSON.stringify(
        inline
          ? { ok: true, resetToken: r.resetToken ?? null }
          : {
              ok: true,
              message:
                '如果该账号存在，重置凭证已生成；请通过邮件或管理员获取（本部署未开启演示回显 PASSWORD_RESET_INLINE_TOKEN）。'
            }
      )
    );
    return true;
  }
  if (req.method === 'POST' && path === '/api/account/reset-password') {
    // P1 安全加固：auth 端点独立严格限流（防重置凭证爆破）。
    const arl = authRateLimited(deps, req);
    if (arl.limited) {
      authRateLimitExceeded(res, arl.retryAfter);
      return true;
    }
    const b = await readBody(req);
    const token = typeof b?.token === 'string' ? b.token : '';
    const newPw = typeof b?.newPassword === 'string' ? b.newPassword : '';
    const dhx = typeof b?.derivedHex === 'string' ? b.derivedHex : '';
    // P1-14: 质询式重置 —— 客户端本地 PBKDF2 派生后发送 derivedHex + salt。
    let r: { ok: boolean; error?: string };
    if (dhx) {
      const salt = typeof b?.salt === 'string' ? b.salt : '';
      r = await resetPasswordWithDerivedHex(token, salt, dhx);
    } else {
      r = await resetPassword(token, newPw);
    }
    if (!r.ok) {
      res.writeHead(400, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ ok: false, error: r.error }));
      return true;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  if (req.method === 'GET' && path === '/api/account/me') {
    // 当前会话：仅依赖 ah_auth cookie（不要求 x-ah-username 双因子，避免鸡生蛋）。
    // 前端在 OAuth 回调后回填用户名（setSession）时调用。
    const u = await usernameFromCookie(req);
    if (!u) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '未登录' }));
      return true;
    }
    const profile = await getProfile(u);
    // CSRF 懒播种：升级部署后已登录的旧会话没有 ah_csrf cookie，
    // 在首次 me 探测时补发，避免旧会话被门禁强制登出。
    const existingCsrf = cookieValue(req, CSRF_COOKIE);
    const extraCookies = existingCsrf
      ? undefined
      : [csrfCookieValue(req, issueCsrfToken())];
    res.writeHead(200, {
      'content-type': 'application/json',
      ...(extraCookies
        ? { 'set-cookie': setCookies(...extraCookies) }
        : {}),
      'cache-control': 'no-store'
    });
    res.end(
      JSON.stringify({
        ok: true,
        username: u,
        role: profile?.role ?? 'viewer', // P0-A: 兜底改为 viewer
        email: profile?.email ?? null
      })
    );
    return true;
  }
  if (req.method === 'POST' && path === '/api/account/change-password') {
    // 改密：需先登录（cookie 有效且 x-ah-username 双因子一致，由 guard 保证）。
    const ctx = await deps.guard(req, res, 'chat:write');
    if (!ctx) return true;
    const b = await readBody(req);
    const oldPw = typeof b?.oldPassword === 'string' ? b.oldPassword : '';
    const newPw = typeof b?.newPassword === 'string' ? b.newPassword : '';
    const dhx = typeof b?.derivedHex === 'string' ? b.derivedHex : '';
    // P1-14: 质询式改密 —— 客户端本地 PBKDF2 派生后发送 derivedHex + salt。
    let r: { ok: boolean; error?: string };
    if (dhx) {
      const salt = typeof b?.salt === 'string' ? b.salt : '';
      r = await changePasswordWithDerivedHex(ctx.sub, oldPw, salt, dhx);
    } else {
      r = await changePassword(ctx.sub, oldPw, newPw);
    }
    if (!r.ok) {
      res.writeHead(400, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ ok: false, error: r.error }));
      return true;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  if (req.method === 'POST' && path === '/api/account/logout') {
    // 登出：清除服务端 token 记录 + 让浏览器丢弃 ah_auth cookie（HttpOnly 只能由服务端清除）。
    // cookie 鉴权但不经 guard → CSRF 双重提交校验在此兜底。
    if (!csrfGuard(req, res)) return true;
    const u = await usernameFromCookie(req);
    if (u) await revokeAllTokens(u);
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': clearAuthCookie(req),
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  // P1-13: Refresh token 旋转 — 消耗旧 refresh token，签发新 access + refresh token 对。
  if (req.method === 'POST' && path === '/api/account/refresh') {
    // cookie 鉴权但不经 guard → CSRF 双重提交校验在此兜底。
    if (!csrfGuard(req, res)) return true;
    const b = await readBody(req);
    // refresh token 优先取 HttpOnly cookie（登录时下发、前端不可读、防 XSS 窃取），
    // 兼容旧客户端从请求体携带 refresh_token 的方式。
    const refreshToken =
      (typeof b?.refresh_token === 'string' && b.refresh_token) ||
      cookieValue(req, 'ah_refresh') ||
      '';
    if (!refreshToken) {
      sendJsonError(res, 400, { error: 'refresh_token 必填' }, req);
      return true;
    }
    const result = await rotateTokens(refreshToken);
    if (!('accessToken' in result)) {
      sendJsonError(res, 401, { error: result.error ?? 'refresh token 无效' }, req);
      return true;
    }
    const { accessToken, refreshToken: newRefreshToken, accessExpiresAt } = result;
    // 注意：authCookieValue 第三参为「剩余时长(ms)」，必须是相对值，不能是绝对时间戳。
    const authCookie = authCookieValue(req, accessToken, accessExpiresAt - Date.now());
    const refreshCookie = `ah_refresh=${newRefreshToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${REFRESH_TTL_MS / 1000}; Expires=${new Date(Date.now() + REFRESH_TTL_MS).toUTCString()}`;
    res.writeHead(200, {
      'content-type': 'application/json',
      // 刷新会话同时轮换 CSRF 令牌（旧行为只轮换 auth/refresh）。
      'set-cookie': setCookies(authCookie, refreshCookie, csrfCookieValue(req, issueCsrfToken())),
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true, username: result.username, accessExpiresAt }));
    return true;
  }
  // P1-11: 账户删除（事务原子性，删除 users/auth_tokens/password_resets）
  if (req.method === 'DELETE' && path === '/api/account') {
    const u = await usernameFromCookie(req);
    if (!u) {
      sendJsonError(res, 401, { error: 'unauthorized' }, req);
      return true;
    }
    const result = await deleteUser(u);
    if (!result.ok) {
      sendJsonError(res, 500, { error: result.error ?? '删除失败' }, req);
      return true;
    }
    // 删除成功后清除 cookie
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': clearAuthCookie(req),
      ...securityHeaders()
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  return false;
}

/**
 * OAuth 路由（自 server.ts 外迁，P2 模块化第六批）：GitHub / Google 授权码流。
 * 注意：/api/account/oauth/callback、/config、/exchange 属 OpenRouter PKCE 流（provider-keys），
 * 不在此处理——返回 false 由 server.ts 的 PKCE 分发块接手。
 */
export async function handleAccountOauthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): Promise<boolean> {
  if (!path.startsWith('/api/account/oauth/github') &&
      !path.startsWith('/api/account/oauth/google')) return false;
      // ── GitHub OAuth 授权码流（后端持有 client_secret）──
      // 1) 前端按钮跳转这里 → 302 到 GitHub 授权页（带 CSRF state，存于 HttpOnly cookie）。
      if (req.method === 'GET' && path === '/api/account/oauth/github') {
        const clientId = process.env.GITHUB_CLIENT_ID;
        if (!clientId || !process.env.GITHUB_CLIENT_SECRET) {
          res.writeHead(500, {
            'content-type': 'application/json',
            'cache-control': 'no-store'
          });
          res.end(
            JSON.stringify({
              ok: false,
              error:
                '服务端未配置 GitHub OAuth（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）。'
            })
          );
          return true;
        }
        const redirectUri = githubRedirectUri(req);
        const state = randomBytes(16).toString('hex');
        const ghUrl =
          `https://github.com/login/oauth/authorize` +
          `?client_id=${encodeURIComponent(clientId || '')}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&scope=${encodeURIComponent('read:user user:email')}` +
          `&state=${encodeURIComponent(state)}`;
        res.writeHead(302, {
          'set-cookie': oauthStateCookie(req, OAUTH_STATE_COOKIE, state),
          'cache-control': 'no-store',
          location: ghUrl
        });
        res.end();
        return true;
      }
      // 2) GitHub 回调：校验 state → 用 code 换 token → 拉 user + 主邮箱 → 本地 upsert → 下发 cookie → 回首页。
      if (
        req.method === 'GET' &&
        path === '/api/account/oauth/github/callback'
      ) {
        const fail = (code: number, msg: string) => {
          if (
            code === 500 &&
            process.env.GITHUB_CLIENT_ID &&
            process.env.GITHUB_CLIENT_SECRET
          ) {
            // 配置正常但处理异常：返回 HTML 错误页
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store'
            });
            res.end(renderOAuthTransitionHtml({ ok: false, message: msg }));
            return true;
          }
          res.writeHead(code, {
            'content-type': 'application/json',
            'cache-control': 'no-store'
          });
          res.end(JSON.stringify({ ok: false, error: msg }));
          return true;
        };
        if (
          !process.env.GITHUB_CLIENT_ID ||
          !process.env.GITHUB_CLIENT_SECRET
        ) {
          fail(
            500,
            '服务端未配置 GitHub OAuth（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）。'
          );
          return true;
        }
        const url = new URL(
          req.url ?? '/',
          `http://${req.headers.host ?? 'localhost'}`
        );
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const expect = cookieValue(req, OAUTH_STATE_COOKIE);
        if (!state || !expect || !safeEqualString(state, expect)) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(
            renderOAuthTransitionHtml({
              ok: false,
              message:
                'OAuth state 校验失败（可能是 CSRF 或过期），请重新登录。'
            })
          );
          return true;
        }
        if (!code) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(
            renderOAuthTransitionHtml({
              ok: false,
              message: 'GitHub 未回传授权码，请重试。'
            })
          );
          return true;
        }
        try {
          const redirectUri = githubRedirectUri(req);
          // 换 access_token（GitHub 接受 Accept: application/json）。
          const tokRes = await fetch(
            'https://github.com/login/oauth/access_token',
            {
              method: 'POST',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json'
              },
              body: JSON.stringify({
                client_id: process.env.GITHUB_CLIENT_ID,
                client_secret: process.env.GITHUB_CLIENT_SECRET,
                code,
                redirect_uri: redirectUri
              })
            }
          );
          const tok = (await tokRes.json()) as {
            access_token?: string;
            error?: string;
          };
          if (!tok.access_token) {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store'
            });
            res.end(
              renderOAuthTransitionHtml({
                ok: false,
                message: `GitHub 换 token 失败：${tok.error ?? '未知错误'}`
              })
            );
            return true;
          }
          // 拉用户基本信息。
          const userRes = await fetch('https://api.github.com/user', {
            headers: {
              authorization: `Bearer ${tok.access_token}`,
              accept: 'application/vnd.github+json',
              'user-agent': 'agent-harness'
            }
          });
          const user = (await userRes.json()) as {
            login?: string;
            id?: number;
            email?: string;
          };
          if (!user.login) {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store'
            });
            res.end(
              renderOAuthTransitionHtml({
                ok: false,
                message: '无法获取 GitHub 用户信息。'
              })
            );
            return true;
          }
          // 拉主邮箱（user.email 常常为空，需单独调 /user/emails 取 primary/verified）。
          let email = user.email;
          if (!email) {
            try {
              const emRes = await fetch('https://api.github.com/user/emails', {
                headers: {
                  authorization: `Bearer ${tok.access_token}`,
                  accept: 'application/vnd.github+json',
                  'user-agent': 'agent-harness'
                }
              });
              const ems = (await emRes.json()) as Array<{
                email?: string;
                primary?: boolean;
                verified?: boolean;
              }>;
              // 仅接受 GitHub 已 verified 的邮箱；未验证邮箱一律不采用，避免冒用他人邮箱身份。
              const primary = ems.find((e) => e.verified);
              email = primary?.email;
            } catch {
              /* 邮箱可选，失败不阻断登录 */
            }
          }
          const r: AccountResult = await upsertGithubUser(
            user.login,
            Number(user.id ?? 0),
            email
          );
          if (!r.ok || !r.token) {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store'
            });
            res.end(
              renderOAuthTransitionHtml({
                ok: false,
                message: '创建/登录本地账户失败，请稍后重试。'
              })
            );
            return true;
          }
          const home = process.env.GITHUB_OAUTH_SUCCESS_REDIRECT || '/';
          // 先下发 cookie，再返回 HTML 过渡页（带自动跳转），避免空白页
          res.writeHead(200, {
            'set-cookie': setCookies(
              authCookieValue(req, r.token),
              refreshCookieValue(req, r.refreshToken),
              csrfCookieValue(req, issueCsrfToken())
            ),
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(
            renderOAuthTransitionHtml({
              ok: true,
              message: `欢迎回来，${r.username}！正在跳转到工作台…`,
              redirect: `${home}${home.includes('?') ? '&' : '?'}oauth=success`
            })
          );
          return true;
        } catch (err) {
          fail(
            500,
            `GitHub OAuth 处理异常：${(err as Error)?.message ?? String(err)}`
          );
          return true;
        }
      }
      // ── Google OAuth 授权码流（后端持有 client_secret）──
      // 1) 前端按钮跳转这里 → 302 到 Google 授权页（带 CSRF state + PKCE code_challenge）。
      if (req.method === 'GET' && path === '/api/account/oauth/google') {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
          res.writeHead(500, {
            'content-type': 'application/json',
            'cache-control': 'no-store'
          });
          res.end(
            JSON.stringify({
              ok: false,
              error:
                '服务端未配置 Google OAuth（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）。'
            })
          );
          return true;
        }
        const redirectUri = googleRedirectUri(req);
        const state = randomBytes(16).toString('hex');
        const codeVerifier = randomBytes(32).toString('base64url');
        const codeChallenge = createHash('sha256')
          .update(codeVerifier)
          .digest('base64url');
        const googleUrl =
          `https://accounts.google.com/o/oauth2/v2/auth` +
          `?client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code` +
          `&scope=${encodeURIComponent('openid email profile')}` +
          `&state=${encodeURIComponent(state)}` +
          `&code_challenge=${encodeURIComponent(codeChallenge)}` +
          `&code_challenge_method=S256` +
          `&access_type=online` +
          `&prompt=consent`;
        res.writeHead(302, {
          'set-cookie': [
            oauthStateCookie(req, OAUTH_STATE_COOKIE, state),
            oauthCodeVerifierCookie(req, codeVerifier)
          ],
          'cache-control': 'no-store',
          location: googleUrl
        });
        res.end();
        return true;
      }
      // 2) Google 回调：校验 state → 用 code + code_verifier 换 token → 解析 id_token → 本地 upsert → 下发 cookie → 回首页。
      if (
        req.method === 'GET' &&
        path === '/api/account/oauth/google/callback'
      ) {
        if (
          !process.env.GOOGLE_CLIENT_ID ||
          !process.env.GOOGLE_CLIENT_SECRET
        ) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(
            renderOAuthTransitionHtml({
              ok: false,
              message: '服务端未配置 Google OAuth。'
            })
          );
          return true;
        }
        const url = new URL(
          req.url ?? '/',
          `http://${req.headers.host ?? 'localhost'}`
        );
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const expect = cookieValue(req, OAUTH_STATE_COOKIE);
        const codeVerifier = cookieValue(req, 'ah_oauth_cv');
        if (!state || !expect || !safeEqualString(state, expect)) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(
            renderOAuthTransitionHtml({
              ok: false,
              message:
                'OAuth state 校验失败（可能是 CSRF 或过期），请重新登录。'
            })
          );
          return true;
        }
        if (!code) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(
            renderOAuthTransitionHtml({
              ok: false,
              message: 'Google 未回传授权码，请重试。'
            })
          );
          return true;
        }
        if (!codeVerifier) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(
            renderOAuthTransitionHtml({
              ok: false,
              message: 'PKCE code_verifier 丢失，请重新登录。'
            })
          );
          return true;
        }
        try {
          const redirectUri = googleRedirectUri(req);
          // 换 token
          const tokRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID,
              client_secret: process.env.GOOGLE_CLIENT_SECRET,
              code,
              redirect_uri: redirectUri,
              grant_type: 'authorization_code',
              code_verifier: codeVerifier
            }).toString()
          });
          const tok = (await tokRes.json()) as {
            id_token?: string;
            access_token?: string;
            error?: string;
          };
          if (!tok.id_token) {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store'
            });
            res.end(
              renderOAuthTransitionHtml({
                ok: false,
                message: `Google 换 token 失败：${tok.error ?? '未知错误'}`
              })
            );
            return true;
          }
          // 解析 JWT id_token（不验签，已来自 Google 直连 + 后续用 access_token 拉 userinfo 复核）
          const parts = tok.id_token.split('.');
          if (parts.length !== 3 || !parts[1]) {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store'
            });
            res.end(
              renderOAuthTransitionHtml({
                ok: false,
                message: 'Google 返回的 id_token 格式异常。'
              })
            );
            return true;
          }
          const payload = JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf-8')
          ) as {
            sub?: string;
            email?: string;
            name?: string;
            email_verified?: boolean;
          };
          if (
            !payload.sub ||
            !payload.email ||
            payload.email_verified === false
          ) {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store'
            });
            res.end(
              renderOAuthTransitionHtml({
                ok: false,
                message: 'Google 账号未验证邮箱或信息不完整。'
              })
            );
            return true;
          }
          // 用 access_token 拉 userinfo 做最终复核（防 id_token 被重放）
          const infoRes = await fetch(
            'https://www.googleapis.com/oauth2/v3/userinfo',
            {
              headers: { authorization: `Bearer ${tok.access_token}` }
            }
          );
          const info = (await infoRes.json()) as {
            sub?: string;
            email?: string;
          };
          if (info.sub && info.sub !== payload.sub) {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store'
            });
            res.end(
              renderOAuthTransitionHtml({
                ok: false,
                message: 'Google 用户信息校验不一致。'
              })
            );
            return true;
          }
          const r: AccountResult = await upsertGoogleUser(
            payload.sub,
            payload.email,
            payload.name
          );
          if (!r.ok || !r.token) {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store'
            });
            res.end(
              renderOAuthTransitionHtml({
                ok: false,
                message: '创建/登录本地账户失败，请稍后重试。'
              })
            );
            return true;
          }
          const home = process.env.GOOGLE_OAUTH_SUCCESS_REDIRECT || '/';
          res.writeHead(200, {
            'set-cookie': setCookies(
              authCookieValue(req, r.token),
              refreshCookieValue(req, r.refreshToken),
              csrfCookieValue(req, issueCsrfToken())
            ),
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(
            renderOAuthTransitionHtml({
              ok: true,
              message: `欢迎回来，${r.username}！正在跳转到工作台…`,
              redirect: `${home}${home.includes('?') ? '&' : '?'}oauth=success`
            })
          );
          return true;
        } catch (err) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(
            renderOAuthTransitionHtml({
              ok: false,
              message: `Google OAuth 处理异常：${
                (err as Error)?.message ?? String(err)
              }`
            })
          );
          return true;
        }
      }
  return false;
}
