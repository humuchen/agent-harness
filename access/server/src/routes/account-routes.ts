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
import { readBody, sendJsonError, securityHeaders } from '../http-helpers';
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
  /** server.ts 的 cookie 构造器（OAuth 回调等处也在用，保持单一定义）。 */
  refreshCookieValue: (
    req: { headers?: Record<string, unknown> },
    refreshToken: string | undefined
  ) => string | null;
  setCookies: (...cookies: (string | null)[]) => string[];
  clientIp: (req: IncomingMessage) => string;
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
      'set-cookie': deps.setCookies(
        authCookieValue(req, lr.token),
        deps.refreshCookieValue(req, lr.refreshToken),
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
      'set-cookie': deps.setCookies(
        authCookieValue(req, r.token),
        deps.refreshCookieValue(req, r.refreshToken),
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
    res.end(JSON.stringify({ ok: true, resetToken: r.resetToken ?? null }));
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
        ? { 'set-cookie': deps.setCookies(...extraCookies) }
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
      'set-cookie': deps.setCookies(authCookie, refreshCookie, csrfCookieValue(req, issueCsrfToken())),
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
