/**
 * 聊天实时同步（跨设备 / 跨标签页）。
 *
 * 登录后由 chat.ts 调用 startChatSync(username) 建立一条常驻 SSE 连接到
 * /api/chat/stream：服务端按 owner 把本账户其它端写入的消息/标题/删除事件实时推回。
 * 本模块只负责「接收 + 去重 + 派发」，不触碰 UI 状态；收到事件后派发
 * window 级 CustomEvent('ah-chat-sync', { detail })，由 chat.ts 订阅并更新视图。
 *
 * 去重：每条消息带 origin（发送端设备指纹）。本设备所有标签页共享同一 deviceId，
 * 因此本地已乐观插入的消息回声会被忽略；其它设备 origin 不同，正常增量插入。
 * 断线重连：SSE 断开后指数退避重连；重连期间服务端仍会落库，前端在重连成功后
 * 对「当前会话」触发一次全量重拉（由 chat.ts 的 session:list / 进入会话逻辑兜底）。
 */

import { parseSse } from '@agent-harness/client';
import { authedFetch } from './api';

/** 设备指纹：整设备稳定（localStorage），跨标签页共享，用于忽略本端回声。 */
function deviceId(): string {
  const KEY = 'ah_device_id';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id =
        (crypto && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'dev_fallback';
  }
}

export const MY_ORIGIN = deviceId();

export type ChatSyncEvent =
  | { type: 'chat:ready'; owner: string }
  | { type: 'message:append'; session: string; message: unknown; origin: string }
  | {
      type: 'session:meta';
      session: string;
      title: string;
      updatedAt: number;
      interactionMode?: 'qa' | 'plan';
      model?: string;
      agentId?: string;
    }
  | { type: 'session:remove'; session: string }
  | { type: 'session:list' };

let es: { abort?: () => void } | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let stopped = false;

function dispatch(e: ChatSyncEvent): void {
  window.dispatchEvent(new CustomEvent<ChatSyncEvent>('ah-chat-sync', { detail: e }));
}

/**
 * 建立常驻聊天同步通道。重复调用幂等（先停旧连接）。
 * @param username 当前登录用户名（owner）。
 */
export function startChatSync(username: string): void {
  if (!username) return;
  stopChatSync();
  stopped = false;
  retries = 0;
  open(username);
}

function open(username: string): void {
  if (stopped) return;
  const ctrl = new AbortController();
  es = { abort: () => ctrl.abort() };
  void (async () => {
    let res: Response;
    try {
      res = await authedFetch('/api/chat/stream', {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: ctrl.signal
      });
    } catch {
      scheduleReconnect(username);
      return;
    }
    if (!res.ok || !res.body) {
      scheduleReconnect(username);
      return;
    }
    retries = 0;
    try {
      for await (const e of parseSse(res, { signal: ctrl.signal })) {
        if (e && typeof e === 'object') dispatch(e as ChatSyncEvent);
      }
    } catch {
      /* 流中断（网络/服务端重启）：重连 */
    }
    if (!stopped) scheduleReconnect(username);
  })();
}

function scheduleReconnect(username: string): void {
  if (stopped) return;
  retries += 1;
  // 指数退避，封顶 15s，避免密集重连打爆服务端。
  const delay = Math.min(15_000, 500 * 2 ** (retries - 1));
  retryTimer = setTimeout(() => open(username), delay);
}

/** 停止同步通道（登出 / 切换账户时调用）。 */
export function stopChatSync(): void {
  stopped = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (es?.abort) {
    try {
      es.abort();
    } catch {
      /* 已断开 */
    }
  }
  es = null;
  retries = 0;
}
