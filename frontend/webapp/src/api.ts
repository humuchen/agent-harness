/**
 * 与 @agent-harness/client 的薄封装：同源单例 + 会话本地持久化。
 * 所有面板都从这里拿 client，不再手写 fetch / SSE。
 *
 * 鉴权说明（账户密码模式，P1-13 双 token 模式）：
 *  - ah_auth cookie：HttpOnly，前端不可读，由浏览器自动随同源请求带上。
 *  - ah_refresh cookie：HttpOnly，服务端签发，前端不可读（用于 POST /api/account/refresh）。
 *  - localStorage['ah_token']：access token 副本（仅用于调度刷新定时器，不用于鉴权）。
 *  - localStorage['ah_user']：登录用户名（用于 x-ah-username 双因子头）。
 *  - 任何 401 会触发全局 ah-session-expired → 清会话并重回登录页。
 */
import { AgentClient } from '@agent-harness/client';

const baseUrl =
  typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4173';

// ─── Token 存储键（P1-13）─────────────────────────────────────────────────────
const TOKEN_KEY = 'ah_token';      // access token（仅用于调度刷新定时器）
const USER_KEY = 'ah_user';        // 登录用户名

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 从 localStorage 读取 access token（无则空串）。 */
export function getToken(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(TOKEN_KEY) || '';
}

/** 写入本地 token 副本（用于会话存在性判断）。
 * 账户密码模式下后端仅返回 refresh token，故此存 refresh token；
 * 实际鉴权由 ah_auth cookie 承担。 */
export function setToken(token: string): void {
  if (typeof localStorage === 'undefined') return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** 清除所有本地会话数据（登出 / 会话失效时调用）。 */
export function clearSession(): void {
  setSession('');
  setToken('');
}

function initialUser(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(USER_KEY) || '';
}

// ─── 全局 401 处理 ────────────────────────────────────────────────────────────

function handleUnauthorized(): void {
  clearSession();
  window.dispatchEvent(new CustomEvent('ah-session-expired'));
}

// ─── P1-14: 质询式密码保护（客户端 scrypt，不传输明文密码）────────────────────

/** scrypt 参数，必须与服务端 accounts.ts 保持一致。 */
export const SCRYPT_PARAMS = { n: 16384, r: 8, p: 1, keyLength: 64 };

/**
 * 浏览器端 scrypt 派生，参数必须与服务端 Node `scryptSync(pw, salt, 64)` 一致。
 * 输出 hex，供登录/注册/重置时发送 derivedHex 代替明文密码。
 */
export async function scryptDerive(
  password: string,
  saltHex: string
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'scrypt' },
    false,
    []
  );
  const saltBytes = hexToBytes(saltHex);
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'scrypt',
      salt: saltBytes as BufferSource,
      N: SCRYPT_PARAMS.n,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p
    } as any,
    key,
    SCRYPT_PARAMS.keyLength * 8
  );
  return bytesToHex(new Uint8Array(derived));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** 字节数组转 hex 字符串。 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Client 实例 ──────────────────────────────────────────────────────────────

export const client = new AgentClient({
  baseUrl,
  username: initialUser() || undefined,
  onUnauthorized: handleUnauthorized,
});

/** P1-14: 获取 scrypt salt，用于浏览器端预先派生密码哈希。 */
export async function getLoginSalt(
  username: string
): Promise<string | null> {
  try {
    const res = await fetch(`/api/account/login-salt?username=${encodeURIComponent(username)}`, {
      method: 'GET',
      credentials: 'same-origin'
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { salt?: string };
    return data.salt || null;
  } catch {
    return null;
  }
}

/** 写入登录会话：存用户名到 localStorage（cookie 由浏览器托管）。 */
export function setSession(username: string): void {
  client.setUsername(username || undefined);
  if (typeof localStorage !== 'undefined') {
    if (username) localStorage.setItem(USER_KEY, username);
    else localStorage.removeItem(USER_KEY);
  }
}

/** 读取当前本地已登录用户名（无则返回空串）。 */
export function getUsername(): string {
  return initialUser();
}

/** 是否已登录（本地视角）：存在用户名即视为已登录。 */
export function isAuthed(): boolean {
  return !!initialUser();
}

/** 当前会话资料（供用户菜单展示）。 */
export interface MeInfo {
  username: string;
  role: string;
  email: string | null;
}

/**
 * 拉取当前登录态资料：GET /api/account/me（仅依赖 ah_auth cookie）。
 * 返回 null 表示未登录 / 会话失效。
 */
export async function fetchMe(): Promise<MeInfo | null> {
  try {
    const res = await fetch('/api/account/me', {
      method: 'GET',
      credentials: 'same-origin'
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<MeInfo> & { ok?: boolean };
    if (!data.username) return null;
    return {
      username: data.username,
      role: data.role ?? 'viewer',
      email: data.email ?? null
    };
  } catch {
    return null;
  }
}

// ─── Refresh Token（P1-13）────────────────────────────────────────────────────

/**
 * 用 refresh token 旋转 access token。
 * POST /api/account/refresh（同源 cookie 自动带上 ah_refresh）。
 * 成功后：更新 localStorage token，调度新的刷新定时器。
 * 失败：派发 ah-session-expired 强制登出。
 */
export async function refreshToken(): Promise<boolean> {
  try {
    const res = await fetch('/api/account/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      // refresh token 由 HttpOnly cookie(ah_refresh) 随同源请求自动携带，无需 body。
      body: JSON.stringify({})
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean; username?: string; accessExpiresAt?: number };
    if (!data.ok) return false;
    // accessExpiresAt 用于调度下一次刷新
    if (data.accessExpiresAt) scheduleAutoRefresh(data.accessExpiresAt);
    return true;
  } catch {
    return false;
  }
}

/**
 * 调度自动刷新：在 access token 到期前 10% 时间触发 refreshToken()。
 * 每次调用均覆盖上一次的定时器。
 */
export function scheduleAutoRefresh(accessExpiresAtMs: number): void {
  clearTimeout((window as unknown as Record<string, unknown>).__ah_refresh_timer as number | undefined);
  const delay = Math.max(0, accessExpiresAtMs - Date.now() - (accessExpiresAtMs - Date.now()) * 0.1);
  if (delay <= 0) return;  // 即将过期，立即刷新
  (window as unknown as Record<string, unknown>).__ah_refresh_timer = window.setTimeout(async () => {
    const ok = await refreshToken();
    if (!ok) {
      handleUnauthorized();
    }
  }, delay);
}

// ─── API 函数 ─────────────────────────────────────────────────────────────────

/**
 * 修改密码：POST /api/account/change-password（需登录）。
 * 返回 { ok, error? }；error 区分「旧密码错误」与「新密码太弱」。
 */
export async function changePassword(
  oldPassword: string,
  newPassword: string,
  opts?: { salt?: string; derivedHex?: string }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: Record<string, unknown> = { oldPassword };
    if (opts?.salt && opts.derivedHex) {
      // P1-14: 质询式改密 —— 新密码客户端派生后发送。
      body.salt = opts.salt;
      body.derivedHex = opts.derivedHex;
    } else {
      body.newPassword = newPassword;
    }
    const res = await authedFetch('/api/account/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || '修改失败' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: '网络异常，请稍后重试。' };
  }
}

/**
 * 申请重置密码：POST /api/account/forgot-password（公开，无需登录）。
 * 返回 { ok, error?, resetToken? }。
 */
export async function requestPasswordReset(
  identifier: string
): Promise<{ ok: boolean; error?: string; resetToken?: string }> {
  try {
    const res = await fetch('/api/account/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier }),
      credentials: 'same-origin'
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      resetToken?: string;
    };
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || '申请失败' };
    }
    return { ok: true, resetToken: data.resetToken };
  } catch {
    return { ok: false, error: '网络异常，请稍后重试。' };
  }
}

/**
 * 用重置凭证重设密码：POST /api/account/reset-password（公开）。
 * 成功会吊销该用户所有已登录会话。返回 { ok, error? }。
 */
export async function resetPassword(
  token: string,
  newPassword: string,
  opts?: { salt?: string; derivedHex?: string }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: Record<string, unknown> = { token };
    if (opts?.salt && opts.derivedHex) {
      // P1-14: 质询式重置 —— 客户端本地 scrypt 派生后发送 derivedHex + salt。
      body.salt = opts.salt;
      body.derivedHex = opts.derivedHex;
    } else {
      body.newPassword = newPassword;
    }
    const res = await fetch('/api/account/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin'
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || '重置失败' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: '网络异常，请稍后重试。' };
  }
}

/**
 * 登出：POST /api/account/logout（服务端清 cookie + 吊销 token）。
 * 成功后清本地会话并派发 ah-session-expired 让 main.ts 回到登录页。
 */
export async function logout(): Promise<void> {
  try {
    await authedFetch('/api/account/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    });
  } catch {
    /* 即便请求失败也强制本地登出 */
  }
  clearSession();
  window.dispatchEvent(new CustomEvent('ah-session-expired'));
}

/**
 * 同源鉴权 fetch 封装：自动带上 cookie（same-origin）与 x-ah-username 双因子头。
 * 任意 401 触发全局 ah-session-expired。
 */
export function authedFetch(
  input: string | URL | Request,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  const u = initialUser();
  if (u) headers.set('x-ah-username', u);
  return fetch(input, {
    ...init,
    headers,
    credentials: init.credentials ?? 'same-origin'
  }).then((res) => {
    if (res.status === 401) handleUnauthorized();
    return res;
  });
}
