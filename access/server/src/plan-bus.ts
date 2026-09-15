/**
 * Plan 协同事件总线（P2-3）。
 *
 * 复用 chat-bus 的双层模式（进程内 fanout + Redis 跨实例桥），
 * 专注于 Plan 文档的实时协同事件。
 */
import { createQueueBackend } from './queue-backend';

/** Plan 协同事件。 */
export type PlanBusEvent =
  | { type: 'plan:ready'; planId: string; owner: string }
  | { type: 'plan:update'; planId: string; owner: string; patch: unknown }
  | { type: 'plan:node'; planId: string; owner: string; action: 'add' | 'update' | 'remove'; nodeId: string }
  | { type: 'plan:comment'; planId: string; owner: string; nodeId: string; text: string }
  | { type: 'plan:cursor'; planId: string; owner: string; userId: string; nodeId: string | null };

type PlanSubscriber = (e: PlanBusEvent) => void;

const CHANNEL_PREFIX = 'plan:';

// 复用 run-queue 的工厂：REDIS_URL 设置即 redis 后端，否则 memory。
const backend = createQueueBackend();
const shared = backend.kind === 'redis';

// 进程内订阅表：planId → 该计划的所有在线订阅。
const subscribers = new Map<string, Set<PlanSubscriber>>();

// Redis pub/sub 桥（仅 shared 后端启用）。
let busSub: { subscribe(ch: string): void; on(ev: 'message', cb: (ch: string, msg: string) => void): void } | null = null;
const busListeners = new Map<string, Set<(msg: string) => void>>();

if (shared) {
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

/** 向某 planId 广播一个协同事件。 */
export function publishPlanEvent(planId: string, owner: string, event: Record<string, unknown>): void {
  if (!planId || !owner) return;
  const e: PlanBusEvent = {
    ...event,
    planId,
    owner
  } as PlanBusEvent;

  // 进程内直推（仅推给本计划的其他订阅者，不推给发送者）。
  const local = subscribers.get(planId);
  if (local && local.size) {
    for (const fn of [...local]) {
      try {
        fn(e);
      } catch {
        /* 忽略单个订阅者异常 */
      }
    }
  }

  // 跨实例桥：发布到 Redis 频道 `plan:<planId>`。
  if (shared && busSub) {
    void (backend as unknown as { publishEvent?(id: string, e: unknown): Promise<void> })
      .publishEvent?.(CHANNEL_PREFIX + planId, JSON.stringify(event))
      .catch(() => {});
  }
}

/** 订阅某 planId 的协同事件流，返回取消订阅函数。 */
export function subscribePlanEvents(planId: string, owner: string, fn: PlanSubscriber): () => void {
  if (!planId) return () => {};
  let unsubBus: (() => void) | null = null;

  // 订阅 Redis 频道（跨实例）。
  if (shared && busSub) {
    const ch = CHANNEL_PREFIX + planId;
    const wrapped = (msg: string) => {
      try {
        const e = JSON.parse(msg) as PlanBusEvent;
        // 跳过自己发送的回声。
        if (e.owner === owner) return;
        fn(e);
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

  // 进程内订阅。
  let set = subscribers.get(planId);
  if (!set) {
    set = new Set();
    subscribers.set(planId, set);
  }
  set.add(fn);
  return () => {
    const s = subscribers.get(planId);
    if (s) {
      s.delete(fn);
      if (s.size === 0) subscribers.delete(planId);
    }
    if (unsubBus) unsubBus();
  };
}

/** 当前某 planId 的在线订阅数（可观测 / 调试用）。 */
export function planSubscriberCount(planId: string): number {
  return subscribers.get(planId)?.size ?? 0;
}
