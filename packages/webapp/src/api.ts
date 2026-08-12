/**
 * 与 @agent-harness/client 的薄封装：同源单例 + 令牌本地持久化。
 * 所有面板都从这里拿 client，不再手写 fetch / SSE。
 */
import { AgentClient } from '@agent-harness/client';

const baseUrl =
  typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4173';

const STORAGE_KEY = 'ah_token';

function initialToken(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(STORAGE_KEY) || '';
}

export const client = new AgentClient({ baseUrl, token: initialToken() });

export function setToken(token: string): void {
  client.setToken(token || undefined);
  if (typeof localStorage !== 'undefined') {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  }
}

export function getToken(): string {
  return client instanceof AgentClient ? initialToken() : '';
}
