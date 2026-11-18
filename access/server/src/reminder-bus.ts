/**
 * 备忘提醒实时广播总线。
 *
 * 与 chat-bus / plan-bus 同源双层模式（进程内 fanout + Redis 跨实例桥）：
 * 备忘数据已按 owner（登录用户）落库隔离，提醒事件携带 owner，只有同 owner
 * 的在线 SSE 连接才收到——跨用户不互见。多副本部署时经 Redis 频道
 * `reminder:<owner>` 跨实例转发，SSE fanout 在各实例本地完成。
 *
 * 推送投递去重：push-dispatch 只在**原始发布实例**调用（FCM 幂等性不保证，
 * 多实例重复投递会导致用户收多条推送），跨实例回调仅做 SSE fanout。
 *
 * 事件形状（与 memo 插件 fire 回调约定）：
 *   { type: 'memo:reminder', plugin: 'memo', noteId, text, tag, remindAt, owner }
 * 前端 /api/events SSE 订阅后实时收到，立即弹 ah-notification + 桌面通知。
 */

import { createQueueBackend } from './queue-backend.js';

type ReminderSubscriber = (e: unknown) => void;

interface ReminderConn {
  owner: string;
  /** 订阅者角色：'user' = 普通登录用户（备忘提醒），'service' = 客服（业务提醒）。 */
  role: 'user' | 'service';
  fn: ReminderSubscriber;
}

// 进程内订阅表：每条在线 SSE 连接记录其归属 owner + role，转发时按 owner/role 过滤。
const subscribers = new Set<ReminderConn>();

// 跨实例 pub/sub 桥（复用 run-queue 工厂，与 chat-bus/plan-bus 同款）。
const backend = createQueueBackend();
const shared = backend.kind === 'redis';
const CHANNEL_PREFIX = 'reminder:';

let busSub: {
  subscribe(ch: string): void;
  on(ev: 'message', cb: (ch: string, msg: string) => void): void;
} | null = null;
const busListeners = new Map<string, Set<(msg: string) => void>>();

if (shared) {
  const maybeSub = (backend as unknown as {
    sub?: {
      subscribe(ch: string): void;
      on(ev: 'message', cb: (ch: string, msg: string) => void): void;
    };
  }).sub;
  if (maybeSub) {
    busSub = maybeSub;
    busSub.on('message', (channel, message) => {
      const set = busListeners.get(channel);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(message);
        } catch {
          /* 单订阅者异常不影响其他 */
        }
      }
    });
  }
}

/**
 * 从事件中读取归属 owner（兼容早期无 owner 字段的事件：视为 'legacy'，
 * 仅推给同样标记为 legacy 的订阅方——即旧客户端/无登录态连接，正常登录用户不会收到）。
 */
function ownerOf(e: unknown): string {
  const o = (e as { owner?: unknown })?.owner;
  return typeof o === 'string' && o ? o : 'legacy';
}

/**
 * 向所有同 owner 订阅者转发一条提醒事件（备忘提醒，按 owner 隔离）。
 * P2-1：同时向该 owner 的已注册移动设备投递推送（fire-and-forget，失败不影响
 * SSE 通道；无设备/未配 FCM 凭据时由 push-dispatch 侧自然 no-op / 日志兜底）。
 */
export function publishReminder(e: unknown): void {
  const owner = ownerOf(e);
  for (const conn of [...subscribers]) {
    if (conn.role !== 'user') continue; // 备忘提醒只推给普通用户
    if (conn.owner !== owner) continue; // 跨用户不互见
    try {
      conn.fn(e);
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  }
  // 推送投递（异步旁路）：不阻塞 SSE fanout，失败只计数告警。
  // 仅原始发布实例调用 push-dispatch —— 跨实例回调只做 SSE fanout，避免 FCM 重复投递。
  // 延迟 require 避免 push-dispatch → device-store 与本模块潜在的加载环。
  const ev = e as { text?: unknown; tag?: unknown; type?: unknown };
  const body = typeof ev.text === 'string' ? ev.text : '您有一条到点提醒';
  const kind = typeof ev.type === 'string' ? ev.type : 'memo:reminder';
  void import('./push-dispatch.js')
    .then(({ dispatchPushToOwner }) =>
      dispatchPushToOwner(owner, { title: '备忘提醒', body, kind })
    )
    .catch(() => {
      /* 投递层自身已兜底；此处仅防模块加载异常冒泡 */
    });
  // 跨实例桥：pub 到 `reminder:<owner>`，其它实例的订阅回调仅做 SSE fanout（不推送）。
  if (shared && busSub) {
    void (backend as unknown as {
      publishEvent?(id: string, e: unknown): Promise<void>;
    })
      .publishEvent?.(CHANNEL_PREFIX + owner, e)
      .catch(() => {});
  }
}

/**
 * 向所有指定角色的订阅者转发事件（业务提醒，如客服提醒）。
 * 事件不携带 owner 时推给该角色所有连接。
 */
export function publishToRole(role: 'user' | 'service', e: unknown): void {
  for (const conn of [...subscribers]) {
    if (conn.role !== role) continue;
    try {
      conn.fn(e);
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  }
}

/**
 * 订阅某 owner 的提醒事件流，返回取消订阅函数。
 * @param owner 归属用户
 * @param fn 回调
 * @param role 角色（默认 'user'）
 */
export function subscribeReminders(
  owner: string,
  fn: ReminderSubscriber,
  role: 'user' | 'service' = 'user'
): () => void {
  const conn: ReminderConn = { owner, role, fn };
  let unsubBus: (() => void) | null = null;

  // 跨实例订阅：收到其它实例 pub 的消息时仅做 SSE fanout（不推送，避免 FCM 重复）。
  if (shared && busSub && role === 'user') {
    const ch = CHANNEL_PREFIX + owner;
    const wrapped = (msg: string) => {
      try {
        const e = JSON.parse(msg);
        const eOwner = ownerOf(e);
        if (eOwner !== owner) return; // 频道按 owner 隔离，双重保险
        try {
          fn(e);
        } catch {
          /* 单个订阅者异常不影响其他 */
        }
      } catch {
        /* 坏消息跳过 */
      }
    };
    let set = busListeners.get(ch);
    if (!set) {
      set = new Set();
      busListeners.set(ch, set);
      busSub.subscribe(ch);
    }
    set.add(wrapped);
    unsubBus = () => {
      const s = busListeners.get(ch);
      if (!s) return;
      s.delete(wrapped);
      if (s.size === 0) busListeners.delete(ch);
    };
  }

  subscribers.add(conn);
  return () => {
    subscribers.delete(conn);
    if (unsubBus) unsubBus();
  };
}

/** 当前在线连接数（可观测 / 调试用）。 */
export function reminderSubscriberCount(): number {
  return subscribers.size;
}
