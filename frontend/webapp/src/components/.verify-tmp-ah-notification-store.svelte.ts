import { state, derived, effect, snapshot } from 'svelte/internal/client';
/**
 * 通知状态机（原 AhNotificationHost 的类逻辑，Svelte 5 迁移为模块级 runes 状态）。
 * ----------------------------------------------------------------
 * Lit 时代状态在 host 组件实例上；Svelte 时代提升为模块级 state：
 *  - 任意模块 import 即用，无需 DOM 宿主先行创建；
 *  - ah-notification.svelte 宿主只负责渲染本模块的 items；
 *  - 原 `notify` 命令式 API（ah-notification.ts）行为逐一保留。
 */
export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export type NotificationPlacement =
  | 'top-right'
  | 'top-center'
  | 'bottom-right'
  | 'bottom-center';

export interface NotificationOptions {
  /** 通知正文（必填）。 */
  message: string;
  /** 加粗标题，可选。 */
  title?: string;
  /** 语义类型，默认 info。 */
  type?: NotificationType;
  /** 自动关闭毫秒数；0 = 常驻不自动关闭。默认按类型取。 */
  duration?: number;
  /** 去重键：同 key 的通知复用同一条，适合轮询 / 高频接口。 */
  key?: string;
  /** 是否显示关闭按钮，默认 true。 */
  closable?: boolean;
}

/** 各类型的默认停留时长（ms）：错误留久一点，成功一闪而过。 */
const DEFAULT_DURATION: Record<NotificationType, number> = {
  success: 2600,
  info: 3200,
  warning: 4200,
  error: 5200
};

/** 离场动画时长（ms），与 CSS .leaving 保持一致。 */
const LEAVE_MS = 180;

/** 未指定 key 时，相同 type + message 视为「同一轮」的合并时间窗（ms）。 */
const MERGE_WINDOW_MS = 4000;

interface NotificationSeed {
  type: NotificationType;
  title: string | null;
  message: string;
  duration: number;
  key: string | null;
  closable: boolean;
}

export interface NotificationItem extends NotificationSeed {
  id: number;
  /** 同内容合并计数（>1 时展示 ×N）。 */
  repeat: number;
  /** 是否已进入离场动画。 */
  leaving: boolean;
  /** 创建 / 最近一次刷新时间戳，用于合并窗口判断。 */
  createdAt: number;
  /** 渲染身份键：刷新时递增，强制重建 DOM 节点以重启入场动画与进度条。 */
  renderKey: string;
}

/** 全局通知状态（宿主组件与命令式 API 共享同一数据源）。 */
export const notifState = state({
  items: [] as NotificationItem[],
  placement: 'top-right' as NotificationPlacement,
  max: 5
});

/** 超出 max 的待展示队列（FIFO）。 */
let queue: NotificationSeed[] = [];
/** id → 关闭计时器。 */
const timers = new Map<number, number>();
/** id → 本轮计时的总时长（ms）。 */
const remaining = new Map<number, number>();
/** id → 本轮计时的起始时刻（ms）。 */
const startedAt = new Map<number, number>();
let seq = 0;
/** 渲染键自增尾号：与 id 组合成 renderKey，保证同一毫秒内多次刷新也不撞键。 */
let refreshSeq = 0;

/** 弹出一条通知，返回其 id（可用于 notify.close(id)）；进入排队时返回 -1。 */
export function showNotification(opts: NotificationOptions): number {
  const type = opts.type ?? 'info';
  const seed: NotificationSeed = {
    type,
    title: opts.title ?? null,
    message: opts.message,
    duration: opts.duration ?? DEFAULT_DURATION[type],
    key: opts.key ?? null,
    closable: opts.closable !== false
  };

  // ① 同 key 复用：更新文案并重置计时（渲染键递增 → 动画与进度条重启）。
  if (seed.key) {
    const idx = notifState.items.findIndex(
      (it) => !it.leaving && it.key && it.key === seed.key
    );
    if (idx >= 0) {
      const prev = notifState.items[idx];
      if (!prev) return -1;
      const merged: NotificationItem = {
        ...seed,
        id: prev.id,
        repeat: 1,
        leaving: false,
        createdAt: Date.now(),
        renderKey: `${prev.id}:${++refreshSeq}`
      };
      notifState.items = notifState.items.map((it, i) => (i === idx ? merged : it));
      restartTimer(merged.id);
      return merged.id;
    }
  }

  // ② 同 type + message 合并：短时间内的重复提示累加 ×N（不指定 key 时生效）。
  const dupIdx = notifState.items.findIndex(
    (it) =>
      !it.leaving &&
      !seed.key &&
      it.type === seed.type &&
      it.message === seed.message &&
      Date.now() - it.createdAt < MERGE_WINDOW_MS
  );
  if (dupIdx >= 0) {
    const prev = notifState.items[dupIdx];
    if (!prev) return -1;
    const merged: NotificationItem = {
      ...prev,
      ...seed,
      repeat: prev.repeat + 1,
      createdAt: Date.now(),
      renderKey: `${prev.id}:${++refreshSeq}`
    };
    notifState.items = notifState.items.map((it, i) => (i === dupIdx ? merged : it));
    restartTimer(merged.id);
    return merged.id;
  }

  // ③ 新条目：超出堆叠上限则排队，否则立即展示（新条目置顶）。
  if (notifState.items.filter((it) => !it.leaving).length >= notifState.max) {
    queue.push(seed);
    trimQueue();
    return -1;
  }
  const id = ++seq;
  const item: NotificationItem = {
    ...seed,
    id,
    repeat: 1,
    leaving: false,
    createdAt: Date.now(),
    renderKey: `${id}:0`
  };
  notifState.items = [item, ...notifState.items];
  restartTimer(id);
  return id;
}

/** 关闭指定 id 的通知。 */
export function closeNotification(id: number): void {
  const item = notifState.items.find((it) => it.id === id);
  if (!item || item.leaving) return;
  clearTimer(id);
  notifState.items = notifState.items.map((it) =>
    it.id === id ? { ...it, leaving: true } : it
  );
  window.setTimeout(() => {
    notifState.items = notifState.items.filter((it) => it.id !== id);
    drainQueue();
  }, LEAVE_MS);
}

/** 清空全部通知（含队列）。 */
export function clearNotifications(): void {
  for (const t of timers.values()) window.clearTimeout(t);
  timers.clear();
  remaining.clear();
  startedAt.clear();
  queue = [];
  notifState.items = [];
}

/** 全局配置（位置 / 同屏上限）。 */
export function configureNotifications(cfg: {
  placement?: NotificationPlacement;
  max?: number;
}): void {
  if (cfg.placement) notifState.placement = cfg.placement;
  if (typeof cfg.max === 'number') notifState.max = cfg.max;
}

/* ------------------------------ 计时内部实现 ------------------------------ */

function clearTimer(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) window.clearTimeout(t);
  timers.delete(id);
  startedAt.delete(id);
}

/** （重新）启动倒计时；duration<=0 表示常驻，仅可手动关闭。 */
function restartTimer(id: number, remain?: number): void {
  clearTimer(id);
  const item = notifState.items.find((it) => it.id === id);
  if (!item || item.duration <= 0) {
    remaining.delete(id);
    return;
  }
  const ms = remain ?? item.duration;
  remaining.set(id, ms);
  startedAt.set(id, Date.now());
  timers.set(
    id,
    window.setTimeout(() => closeNotification(id), ms)
  );
}

/** 悬停暂停：记录剩余时间并撤掉计时器（进度条由 CSS :hover 暂停）。 */
export function notificationEnter(id: number): void {
  const start = startedAt.get(id);
  const total = remaining.get(id);
  if (start === undefined || total === undefined) return;
  remaining.set(id, Math.max(0, total - (Date.now() - start)));
  clearTimer(id);
}

/** 移出恢复：用剩余时间续跑。 */
export function notificationLeave(id: number): void {
  if (timers.has(id)) return;
  const left = remaining.get(id);
  if (left === undefined) return;
  restartTimer(id, left);
}

/** 队列只保留最近 max 条，避免长时间离线后一次性倾泻。 */
function trimQueue(): void {
  if (queue.length > notifState.max) queue = queue.slice(-notifState.max);
}

function drainQueue(): void {
  while (queue.length) {
    if (notifState.items.filter((it) => !it.leaving).length >= notifState.max) return;
    const next = queue.shift();
    if (!next) return;
    const id = ++seq;
    notifState.items = [
      {
        ...next,
        id,
        repeat: 1,
        leaving: false,
        createdAt: Date.now(),
        renderKey: `${id}:0`
      },
      ...notifState.items
    ];
    restartTimer(id);
  }
}
