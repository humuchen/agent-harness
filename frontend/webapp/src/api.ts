/**
 * 与 @agent-harness/client 的薄封装：同源单例 + 会话本地持久化。
 * 所有面板都从这里拿 client，不再手写 fetch / SSE。
 *
 * 鉴权说明（账户密码模式）：
 *  - 站点鉴权 100% 走服务端下发的 HttpOnly cookie `ah_auth`（浏览器自动随同源请求带上），
 *    前端【不】在 localStorage 存任何 token，也不构造 Bearer。
 *  - 前端只把「登录用户名」记到 localStorage，用于给 client 传 x-ah-username 双因子头
 *    （AccountAuthorizer 要求 cookie + header 用户名一致）。
 *  - 鉴权门 isAuthed()/getToken() 以「本地是否存有用户名」为准；cookie 是否仍有效由服务端判定，
 *    任何 401 都会触发全局 onUnauthorized → 清会话并重回登录页。
 */
import { AgentClient } from '@agent-harness/client';

const baseUrl =
  typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4173';

// 仅持久化用户名（cookie 由浏览器托管，前端不触碰其值）。
const USER_KEY = 'ah_user';

function initialUser(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(USER_KEY) || '';
}

// 全局 401 → 回到登录页（幂等：main.ts 注册的监听器负责清会话 + 挂载登录页）。
function handleUnauthorized(): void {
  window.dispatchEvent(new CustomEvent('ah-session-expired'));
}

export const client = new AgentClient({
  baseUrl,
  username: initialUser() || undefined,
  onUnauthorized: handleUnauthorized,
});

/** 写入登录会话：仅存用户名（cookie 由浏览器托管）。 */
export function setSession(username: string): void {
  client.setUsername(username || undefined);
  if (typeof localStorage !== 'undefined') {
    if (username) localStorage.setItem(USER_KEY, username);
    else localStorage.removeItem(USER_KEY);
  }
}

/** 清除登录会话（登出 / 登录失效）。cookie 由服务端在 /api/account/logout 清除。 */
export function clearSession(): void {
  setSession('');
}

/** 是否已登录（本地视角）：存在用户名即视为已登录；cookie 有效性由服务端 401 兜底。 */
export function isAuthed(): boolean {
  return !!initialUser();
}

/**
 * 同源鉴权 fetch 封装：自动带上 cookie（same-origin）与 x-ah-username 双因子头，
 * 使账户密码鉴权链路（AccountAuthorizer）放行。任意 401 会触发全局 ah-session-expired。
 * 用于那些不便走 client 单例的原始 fetch（如 upload FormData、插件管理、自定义模型 CRUD）。
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
  });
}

/**
 * 兼容旧调用点：getToken() 旧语义是「是否有 token」。
 * 现在站点鉴权不再依赖前端持有 token（cookie 由浏览器托管），
 * 仅当存在登录会话时返回占位符（使所有基于 getToken() 的鉴权门、header 拼装继续工作）。
 */
export function getToken(): string {
  return isAuthed() ? 'ah-session' : '';
}
