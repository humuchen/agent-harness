/**
 * ah-notification：全应用统一的通知（Notification）组件
 * ----------------------------------------------------------------
 * 项目内所有「接口错误 / 操作结果」提示的唯一出口，取代此前散落各处的
 * 内联 `.error` 红条、`run.ts` 局部 toast、登录页 `.notice` 等自绘提示。
 *
 * 组成：
 *  - `<ah-notification-host>`：常驻 document.body 的宿主（单例），负责堆叠
 *    渲染、计时关闭、hover 暂停、去重合并、超出上限排队。
 *  - `notify`：命令式 API（模块级单例），任意模块 import 即用，无需模板侵入。
 *
 * 设计要点：
 *  - 四种语义类型：success / error / warning / info，各有图标、配色与默认时长。
 *  - 自动关闭 + 底部进度条；鼠标悬停暂停计时与进度条，移出继续（不重置）。
 *  - `duration: 0` 表示常驻，仅可手动关闭。
 *  - 去重：传 `key` 时同 key 复用同一条（刷新文案与计时）；未传 key 时，
 *    相同 type + message 的连续通知合并为一条并累加 `×N`，避免接口抖动刷屏。
 *  - 堆叠上限 `max`（默认 5），超出进入队列，关闭一条后自动补位。
 *  - 无障碍：`aria-live` 区域常驻；error 用 role="alert"，其余 role="status"；
 *    关闭按钮带 aria-label。
 *  - 主题：仅引用 --ah-* 令牌，dark/light 自动跟随；prefers-reduced-motion 禁动效。
 *  - 层级 z-index 1200：高于 ah-modal(1000)，保证模态里的操作也能看到结果提示。
 *
 * 用法：
 *   import { notify } from './components/ah-notification';
 *   notify.success('已保存');
 *   notify.error('保存失败', { title: '自定义模型' });
 *   notify.warning(msg, { key: 'chat-upload', duration: 0 });
 *   notify.close(id); notify.clear();
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

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

interface NotificationItem extends NotificationSeed {
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

/** 各类型图标（内联 SVG，继承 currentColor）。 */
function iconSvg(type: NotificationType) {
  switch (type) {
    case 'success':
      return html`<svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" />
        <path
          d="M7.8 12.3l2.7 2.7 5.7-5.7"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>`;
    case 'error':
      return html`<svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" />
        <path
          d="M9.5 9.5l5 5m0-5l-5 5"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </svg>`;
    case 'warning':
      return html`<svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M12 4.8l8.2 14.2H3.8L12 4.8Z"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
        <path
          d="M12 10v4.2"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
        <circle cx="12" cy="16.8" r="1" fill="currentColor" />
      </svg>`;
    default:
      return html`<svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" />
        <path
          d="M12 11v5.5"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
        <circle cx="12" cy="7.9" r="1" fill="currentColor" />
      </svg>`;
  }
}

@customElement('ah-notification-host')
export class AhNotificationHost extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1200;
      /* 容器不吃事件，只有卡片本身可交互，避免遮挡页面点击。 */
      pointer-events: none;
      font-family: var(--ah-font-sans);
      color: var(--ah-text);
    }

    .layer {
      position: absolute;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 100%;
      max-height: 100%;
      box-sizing: border-box;
      padding: 16px;
      overflow: hidden;
    }
    /* 新通知永远插在数组最前（视觉上最靠近触发点）。 */
    :host([placement='top-right']) .layer {
      top: 0;
      right: 0;
      align-items: flex-end;
    }
    :host([placement='top-center']) .layer {
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      align-items: center;
    }
    :host([placement='bottom-right']) .layer {
      bottom: 0;
      right: 0;
      align-items: flex-end;
      flex-direction: column-reverse;
    }
    :host([placement='bottom-center']) .layer {
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      align-items: center;
      flex-direction: column-reverse;
    }

    .item {
      position: relative;
      pointer-events: auto;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      width: min(380px, calc(100vw - 32px));
      box-sizing: border-box;
      padding: 11px 12px;
      border-radius: var(--ah-radius-md);
      background: var(--ah-surface-2);
      border: 1px solid var(--ah-border);
      box-shadow: var(--ah-shadow);
      font-size: 13px;
      line-height: 1.5;
      overflow: hidden;
      animation: ahn-in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.1);
    }
    .item.leaving {
      animation: ahn-out ${LEAVE_MS}ms ease forwards;
    }
    /* 左侧语义色条：一眼区分类型，不依赖图标颜色。 */
    .item::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--ahn-tone, var(--ah-accent));
    }
    .item.success {
      --ahn-tone: var(--ah-success);
    }
    .item.error {
      --ahn-tone: var(--ah-danger);
    }
    .item.warning {
      --ahn-tone: var(--ah-warning);
    }
    .item.info {
      --ahn-tone: var(--ah-accent);
    }

    .icon {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      margin-top: 1px;
      color: var(--ahn-tone, var(--ah-accent));
    }

    .body {
      flex: 1 1 auto;
      min-width: 0;
      /* 长文案 / 长路径换行，避免撑破卡片。 */
      overflow-wrap: anywhere;
    }
    .title {
      font-weight: 600;
      margin-bottom: 2px;
    }
    .msg.only {
      color: var(--ah-text-muted);
    }

    .repeat {
      flex: none;
      align-self: center;
      padding: 1px 6px;
      border-radius: var(--ah-radius-pill);
      background: var(--ah-surface-3);
      color: var(--ah-text-muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }

    .close {
      flex: none;
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-left: 2px;
      padding: 0;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--ah-text-faint);
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .close:hover {
      background: var(--ah-surface-3);
      color: var(--ah-text);
    }
    .close:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: 1px;
    }

    /* 倒计时进度条：hover 时与计时器一起暂停（animation-play-state）。 */
    .bar {
      position: absolute;
      left: 0;
      bottom: 0;
      width: 100%;
      height: 2px;
      transform-origin: left center;
      background: var(--ahn-tone, var(--ah-accent));
      opacity: 0.55;
      animation: ahn-bar linear forwards;
      animation-duration: 3000ms;
    }
    .item:hover .bar,
    .item:focus-within .bar {
      animation-play-state: paused;
    }

    @keyframes ahn-in {
      from {
        opacity: 0;
        transform: translateY(-6px) scale(0.98);
      }
    }
    @keyframes ahn-out {
      to {
        opacity: 0;
        transform: translateX(8px) scale(0.98);
      }
    }
    @keyframes ahn-bar {
      from {
        transform: scaleX(1);
      }
      to {
        transform: scaleX(0);
      }
    }

    /* 无障碍：用户偏好减少动效时关闭全部动画（进度条降级为静态细线）。 */
    @media (prefers-reduced-motion: reduce) {
      .item,
      .item.leaving,
      .bar {
        animation: none;
      }
      .item.leaving {
        opacity: 0;
      }
    }
  `;

  /** 弹出位置，作为 attribute 供 CSS 选择器使用。 */
  @property({ type: String, reflect: true })
  placement: NotificationPlacement = 'top-right';

  /** 同屏最大堆叠数量，超出排队。 */
  @property({ type: Number })
  max = 5;

  @state() private items: NotificationItem[] = [];

  /** 超出 max 的待展示队列（FIFO）。 */
  private queue: NotificationSeed[] = [];
  /** id → 关闭计时器。 */
  private timers = new Map<number, number>();
  /** id → 本轮计时的总时长（ms）。 */
  private remaining = new Map<number, number>();
  /** id → 本轮计时的起始时刻（ms）。 */
  private startedAt = new Map<number, number>();
  private seq = 0;
  /** 渲染键自增尾号：与 id 组合成 renderKey，保证同一毫秒内多次刷新也不撞键。 */
  private refreshSeq = 0;

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
  }

  /* ------------------------------ 对外 API ------------------------------ */

  /** 弹出一条通知，返回其 id（可用于 notify.close(id)）；进入排队时返回 -1。 */
  show(opts: NotificationOptions): number {
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
      const idx = this.items.findIndex(
        (it) => !it.leaving && it.key && it.key === seed.key
      );
      if (idx >= 0) {
        const prev = this.items[idx];
        const merged: NotificationItem = {
          ...seed,
          id: prev.id,
          repeat: 1,
          leaving: false,
          createdAt: Date.now(),
          renderKey: `${prev.id}:${++this.refreshSeq}`
        };
        this.items = this.items.map((it, i) => (i === idx ? merged : it));
        this.restartTimer(merged.id);
        return merged.id;
      }
    }

    // ② 同 type + message 合并：短时间内的重复提示累加 ×N（不指定 key 时生效）。
    const dupIdx = this.items.findIndex(
      (it) =>
        !it.leaving &&
        !seed.key &&
        it.type === seed.type &&
        it.message === seed.message &&
        Date.now() - it.createdAt < MERGE_WINDOW_MS
    );
    if (dupIdx >= 0) {
      const prev = this.items[dupIdx];
      const merged: NotificationItem = {
        ...prev,
        ...seed,
        repeat: prev.repeat + 1,
        createdAt: Date.now(),
        renderKey: `${prev.id}:${++this.refreshSeq}`
      };
      this.items = this.items.map((it, i) => (i === dupIdx ? merged : it));
      this.restartTimer(merged.id);
      return merged.id;
    }

    // ③ 新条目：超出堆叠上限则排队，否则立即展示（新条目置顶）。
    if (this.items.filter((it) => !it.leaving).length >= this.max) {
      this.queue.push(seed);
      this.trimQueue();
      return -1;
    }
    const id = ++this.seq;
    const item: NotificationItem = {
      ...seed,
      id,
      repeat: 1,
      leaving: false,
      createdAt: Date.now(),
      renderKey: `${id}:0`
    };
    this.items = [item, ...this.items];
    this.restartTimer(id);
    return id;
  }

  /** 关闭指定 id 的通知。 */
  close(id: number): void {
    const item = this.items.find((it) => it.id === id);
    if (!item || item.leaving) return;
    this.clearTimer(id);
    this.items = this.items.map((it) =>
      it.id === id ? { ...it, leaving: true } : it
    );
    window.setTimeout(() => {
      this.items = this.items.filter((it) => it.id !== id);
      this.drainQueue();
    }, LEAVE_MS);
  }

  /** 清空全部通知（含队列）。 */
  clear(): void {
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
    this.remaining.clear();
    this.startedAt.clear();
    this.queue = [];
    this.items = [];
  }

  /* ------------------------------ 计时内部实现 ------------------------------ */

  private clearTimer(id: number): void {
    const t = this.timers.get(id);
    if (t !== undefined) window.clearTimeout(t);
    this.timers.delete(id);
    this.startedAt.delete(id);
  }

  /** （重新）启动倒计时；duration<=0 表示常驻，仅可手动关闭。 */
  private restartTimer(id: number, remain?: number): void {
    this.clearTimer(id);
    const item = this.items.find((it) => it.id === id);
    if (!item || item.duration <= 0) {
      this.remaining.delete(id);
      return;
    }
    const ms = remain ?? item.duration;
    this.remaining.set(id, ms);
    this.startedAt.set(id, Date.now());
    this.timers.set(
      id,
      window.setTimeout(() => this.close(id), ms)
    );
  }

  /** 悬停暂停：记录剩余时间并撤掉计时器（进度条由 CSS :hover 暂停）。 */
  private onEnter(id: number): void {
    const start = this.startedAt.get(id);
    const total = this.remaining.get(id);
    if (start === undefined || total === undefined) return;
    this.remaining.set(id, Math.max(0, total - (Date.now() - start)));
    this.clearTimer(id);
  }

  /** 移出恢复：用剩余时间续跑。 */
  private onLeave(id: number): void {
    if (this.timers.has(id)) return;
    const left = this.remaining.get(id);
    if (left === undefined) return;
    this.restartTimer(id, left);
  }

  /** 队列只保留最近 max 条，避免长时间离线后一次性倾泻。 */
  private trimQueue(): void {
    if (this.queue.length > this.max) this.queue = this.queue.slice(-this.max);
  }

  private drainQueue(): void {
    while (this.queue.length) {
      if (this.items.filter((it) => !it.leaving).length >= this.max) return;
      const next = this.queue.shift();
      if (!next) return;
      const id = ++this.seq;
      this.items = [
        {
          ...next,
          id,
          repeat: 1,
          leaving: false,
          createdAt: Date.now(),
          renderKey: `${id}:0`
        },
        ...this.items
      ];
      this.restartTimer(id);
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */

  private renderItem(item: NotificationItem) {
    return html`
      <div
        class="item ${item.type} ${item.leaving ? 'leaving' : ''}"
        role=${item.type === 'error' ? 'alert' : 'status'}
        @mouseenter=${() => this.onEnter(item.id)}
        @mouseleave=${() => this.onLeave(item.id)}
      >
        <span class="icon">${iconSvg(item.type)}</span>
        <div class="body">
          ${item.title ? html`<div class="title">${item.title}</div>` : nothing}
          <div class="msg ${item.title ? '' : 'only'}">${item.message}</div>
        </div>
        ${item.repeat > 1 ? html`<span class="repeat">×${item.repeat}</span>` : nothing}
        ${item.closable
          ? html`<button
              class="close"
              type="button"
              aria-label="关闭通知"
              @click=${() => this.close(item.id)}
            >
              ✕
            </button>`
          : nothing}
        ${item.duration > 0
          ? html`<i class="bar" style=${`animation-duration:${item.duration}ms`}></i>`
          : nothing}
      </div>
    `;
  }

  render() {
    return html`
      <div class="layer" aria-live="polite" aria-label="通知">
        ${repeat(
          this.items,
          (it) => it.renderKey,
          (it) => this.renderItem(it)
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ah-notification-host': AhNotificationHost;
  }
}

/* ------------------------------ 模块级命令式 API ------------------------------ */

const HOST_TAG = 'ah-notification-host';

let hostRef: AhNotificationHost | null = null;

/**
 * 取（必要时创建）全局宿主单例并挂到 document.body。
 * 幂等：任意模块首次调用 notify.* 时才会创建，从未弹过通知则 DOM 中无此节点。
 */
function ensureHost(): AhNotificationHost {
  if (hostRef?.isConnected) return hostRef;
  const found = document.querySelector(HOST_TAG) as AhNotificationHost | null;
  const host = found ?? (document.createElement(HOST_TAG) as AhNotificationHost);
  if (!host.isConnected) document.body.appendChild(host);
  hostRef = host;
  return host;
}

/** 去掉 message 字段的选项（各语法糖方法用）。 */
type MessageOptions = Omit<NotificationOptions, 'message' | 'type'>;

export interface NotificationConfig {
  placement?: NotificationPlacement;
  max?: number;
}

export const notify = {
  /** 通用入口。 */
  show(opts: NotificationOptions): number {
    return ensureHost().show(opts);
  },
  success(message: string, opts?: MessageOptions): number {
    return ensureHost().show({ ...opts, message, type: 'success' });
  },
  error(message: string, opts?: MessageOptions): number {
    return ensureHost().show({ ...opts, message, type: 'error' });
  },
  warning(message: string, opts?: MessageOptions): number {
    return ensureHost().show({ ...opts, message, type: 'warning' });
  },
  info(message: string, opts?: MessageOptions): number {
    return ensureHost().show({ ...opts, message, type: 'info' });
  },
  /** 关闭指定通知。 */
  close(id: number): void {
    hostRef?.close(id);
  },
  /** 清空全部通知。 */
  clear(): void {
    hostRef?.clear();
  },
  /** 全局配置（位置 / 同屏上限）。 */
  configure(cfg: NotificationConfig): void {
    const host = ensureHost();
    if (cfg.placement) host.placement = cfg.placement;
    if (typeof cfg.max === 'number') host.max = cfg.max;
  }
};
