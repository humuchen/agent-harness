/**
 * 聊天实时广播总线（跨设备 / 跨标签页 / 跨实例）。
 *
 * 解决的问题：同一账户在手机端与电脑端同时登录时，一端写入的聊天消息、会话
 * 标题、删除动作需要实时推送到另一端 —— 现有 SSE 仅服务于「单次 run 的 LLM
 * 流式回传」且只回推给发起请求的那个标签页，没有「按用户 fanout」的通道。
 *
 * 设计（复用 run-queue 的跨实例事件桥范式，零新依赖）：
 * - 进程内：`Map<owner, Set<(e) => void>>` 持有某用户的所有在线 SSE 订阅，
 *   publish 时本地直推，无需经过网络。
 * - 跨实例：有 Redis 时（与 run-queue 共用 REDIS_URL 判定）额外 pub 到
 *   `chatuser:<owner>` 频道；每个实例启动时订阅自己关心的频道，回推本地订阅。
 *   无 Redis（单实例 memory 后端）时仅进程内直推，完全够用。
 *
 * 事件形状（与前端 chat-sync.ts 约定）：
 * - { type: 'message:append', session, message, origin } 增量落库消息
 * - { type: 'session:meta', session, title, updatedAt, interactionMode?, model?, agentId? } 标题/时间/按会话设置变更
 * - { type: 'session:remove', session } 会话删除
 * - { type: 'session:list' } 触发列表重拉（新建会话/批量变更）
 * `origin` 为发送端的设备指纹，前端据此忽略自己发出的回声，避免重复插入。
 */

import { createQueueBackend } from './queue-backend';

/** 广播事件（与前端契约一致）。 */
export type ChatBusEvent =
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

type Subscriber = (e: ChatBusEvent) => void;

const CHANNEL_PREFIX = 'chatuser:';

// 复用 run-queue 的工厂：REDIS_URL 设置即 redis 后端，否则 memory。
// 单实例场景下 memory 后端无 pub/sub 能力，仅进程内 fanout（满足需求）。
const backend = createQueueBackend();
const shared = backend.kind === 'redis';

// 进程内订阅表：owner → 该用户的全部在线 SSE 连接。
const subscribers = new Map<string, Set<Subscriber>>();

// Redis pub/sub 桥（仅 shared 后端启用）。
let busSub: { subscribe(ch: string): void; on(ev: 'message', cb: (ch: string, msg: string) => void): void } | null = null;
const busListeners = new Map<string, Set<(msg: string) => void>>();

if (shared) {
  // 复用 RedisQueueBackend 自带的 pub/sub 连接（其构造时已 duplicate + 监听 message）。
  // 这里通过 checked 形态取内部 sub：RedisQueueBackend 暴露 listeners —— 但我们不依赖
  // 其私有结构，改为直接用同一 client 的 duplicate 订阅。由于 createQueueBackend 已封装，
  // 这里借助 queue-backend 暴露的最小契约复用一个 pub/sub 连接。
  const maybeSub = (backend as unknown as {
    sub?: { subscribe(ch: string): void; on(ev: 'message', cb: (ch: string, msg: string) => void): void };
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
 * 向某 owner 广播一个聊天事件。
 * - 进程内：直推该 owner 的所有在线订阅。
 * - 跨实例：有 Redis 时额外 pub 到 `chatuser:<owner>`，其它实例订阅后回推其本地订阅。
 */
export function publishChatEvent(owner: string, e: ChatBusEvent): void {
  if (!owner) return;
  // 进程内直推。
  const local = subscribers.get(owner);
  if (local && local.size) {
    for (const fn of [...local]) {
      try {
        fn(e);
      } catch {
        /* 忽略单个订阅者异常 */
      }
    }
  }
  // 跨实例桥。
  if (shared && busSub) {
    void (backend as unknown as { publishEvent?(id: string, e: unknown): Promise<void> })
      .publishEvent?.(CHANNEL_PREFIX + owner, e)
      .catch(() => {});
  }
}

/**
 * 订阅某 owner 的聊天事件流，返回取消订阅函数。
 * 单实例：仅进程内 fanout。多实例：同时订阅 Redis 频道，回推来自其它实例的写入。
 */
export function subscribeChatEvents(owner: string, fn: Subscriber): () => void {
  if (!owner) return () => {};
  let unsubBus: (() => void) | null = null;
  if (shared && busSub) {
    const ch = CHANNEL_PREFIX + owner;
    const wrapped = (msg: string) => {
      try {
        fn(JSON.parse(msg) as ChatBusEvent);
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
      if (s.size === 0) {
        busListeners.delete(ch);
      }
    };
  }
  let set = subscribers.get(owner);
  if (!set) {
    set = new Set();
    subscribers.set(owner, set);
  }
  set.add(fn);
  return () => {
    const s = subscribers.get(owner);
    if (s) {
      s.delete(fn);
      if (s.size === 0) subscribers.delete(owner);
    }
    if (unsubBus) unsubBus();
  };
}

/** 当前某 owner 的在线连接数（可观测 / 调试用）。 */
export function chatSubscriberCount(owner: string): number {
  return subscribers.get(owner)?.size ?? 0;
}
