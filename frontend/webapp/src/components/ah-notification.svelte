<script lang="ts">
  /**
   * ah-notification：全应用统一的通知（Notification）宿主组件
   * ----------------------------------------------------------------
   * 项目内所有「接口错误 / 操作结果」提示的唯一出口。Svelte 迁移后：
   *  - 状态机在 ah-notification.svelte.ts（模块级 runes），本组件只负责渲染；
   *  - 命令式 API（notify）在 ah-notification.ts，任意模块 import 即用；
   *  - 常驻 document.body（main.ts 挂载），pointer-events:none 不挡页面点击。
   *
   * 设计要点（原 Lit 版逐条保留）：
   *  - 四种语义类型：success / error / warning / info，各有图标、配色与默认时长。
   *  - 自动关闭 + 底部进度条；鼠标悬停暂停计时与进度条，移出继续（不重置）。
   *  - duration: 0 常驻；同 key 复用；同 type+message 合并 ×N；堆叠上限 max 默认 5。
   *  - aria-live 常驻；error role="alert"，其余 role="status"；z-index 1200。
   */
  import {
    notifState,
    closeNotification,
    notificationEnter,
    notificationLeave,
    type NotificationItem,
    type NotificationPlacement,
    type NotificationType
  } from './ah-notification-store.svelte';

  let {
    placement = 'top-right',
    max = 5
  }: { placement?: NotificationPlacement; max?: number } = $props();

  // 配置下发：props 变化时同步到状态机（原 @property reflect 语义）。
  $effect(() => {
    notifState.placement = placement;
    notifState.max = max;
  });

  /** 各类型图标（内联 SVG，继承 currentColor）。 */
  function iconSvg(type: NotificationType): string {
    switch (type) {
      case 'success':
        return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M7.8 12.3l2.7 2.7 5.7-5.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      case 'error':
        return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M9.5 9.5l5 5m0-5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
      case 'warning':
        return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><path d="M12 4.8l8.2 14.2H3.8L12 4.8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 10v4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16.8" r="1" fill="currentColor"/></svg>`;
      default:
        return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 11v5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.9" r="1" fill="currentColor"/></svg>`;
    }
  }
</script>

<!-- 宿主铺满视口（inset:0），容器不吃事件；位置由 data-placement 驱动（原 :host([placement]) 语义）。 -->
<div
  class="notif-host no-pill"
  data-placement={notifState.placement}
  role="region"
  aria-label="通知"
>
  <div class="layer" aria-live="polite">
    {#each notifState.items as item (item.renderKey)}
      <div
        class="item {item.type}{item.leaving ? ' leaving' : ''}"
        role={item.type === 'error' ? 'alert' : 'status'}
        onmouseenter={() => notificationEnter(item.id)}
        onmouseleave={() => notificationLeave(item.id)}
      >
        <span class="icon">{@html iconSvg(item.type)}</span>
        <div class="body">
          {#if item.title}<div class="title">{item.title}</div>{/if}
          <div class="msg{item.title ? '' : ' only'}">{item.message}</div>
        </div>
        {#if item.repeat > 1}<span class="repeat">×{item.repeat}</span>{/if}
        {#if item.closable}
          <button
            class="close"
            type="button"
            aria-label="关闭通知"
            onclick={() => closeNotification(item.id)}
          >
            ✕
          </button>
        {/if}
        {#if item.duration > 0}
          <i class="bar" style="animation-duration: {item.duration}ms"></i>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .notif-host {
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
  .notif-host[data-placement='top-right'] .layer {
    top: 0;
    right: 0;
    align-items: flex-end;
    /* 顶部弹出：含顶部安全区，卡片不顶进原生状态栏（时钟/电量），不劫持顶栏点击 */
    padding-top: calc(16px + env(safe-area-inset-top, 0px));
  }
  .notif-host[data-placement='top-center'] .layer {
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    align-items: center;
    /* 顶部弹出：含顶部安全区 */
    padding-top: calc(16px + env(safe-area-inset-top, 0px));
  }
  .notif-host[data-placement='bottom-right'] .layer {
    bottom: 0;
    right: 0;
    align-items: flex-end;
    flex-direction: column-reverse;
    /* 底部弹出：含底部安全区，卡片不贴手势条 */
    padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  }
  .notif-host[data-placement='bottom-center'] .layer {
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    align-items: center;
    flex-direction: column-reverse;
    /* 底部弹出：含底部安全区 */
    padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  }
  /* 通知宿主铺满视口（inset:0）：顶/底两端补安全区，顶部卡片不顶进状态栏、
     底部卡片不贴手势条（否则 pointer-events:auto 的卡片会挡住原生头部/手势区点击） */
  .notif-host[data-placement='top-right'] .layer,
  .notif-host[data-placement='top-center'] .layer {
    padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  }
  .notif-host[data-placement='bottom-right'] .layer,
  .notif-host[data-placement='bottom-center'] .layer {
    padding-top: calc(16px + env(safe-area-inset-top, 0px));
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
    animation: ahn-out 180ms ease forwards;
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
</style>
