<script lang="ts">
  /**
   * ah-drawer：通用抽屉组件（mac-ui 适配层）—— Svelte 迁移版
   * -------------------------------------------------------------------
   * 基于 @humuchen/mac-ui 的视觉令牌（--md-drawer-*）自行渲染抽屉面板
   * （Lit 原版即如此：MacDrawer 的 portal 会丢失 shadow 样式）。
   *
   * 公开 API（保持原 AhDrawer 契约）：
   *  - props：open（受控，父级持状态）/ placement / title / size / mask /
   *    maskClosable / escClosable / showClose / confirmText / cancelText /
   *    showFooter / fullscreen
   *  - 回调：onclose(reason: 'esc'|'mask'|'button') / onahOpen / onahConfirm
   *  - 插槽：默认（body）、header、footer（Svelte snippet）
   *
   * 路由联动：订阅 window `ah:close-overlays`（app 壳在 Tab 切换 / 浏览器
   * 后退前进时广播），收到后跳过离场动画立即关闭并回调 onclose。
   */
  import { onMount, onDestroy } from 'svelte';
  import type { Snippet } from 'svelte';
  import { APP_EVENTS } from '../app-events';

  export type DrawerPlacement = 'left' | 'right' | 'top' | 'bottom';
  export type DrawerCloseReason = 'esc' | 'mask' | 'button';

  /** 离场动画时长（ms），与 mac-ui 保持一致。 */
  const LEAVE_MS = 220;

  let {
    open = false,
    placement = 'right' as DrawerPlacement,
    title = '',
    size = '320px',
    mask = true,
    maskClosable = true,
    escClosable = true,
    showClose = true,
    confirmText = '确定',
    cancelText = '取消',
    showFooter = false,
    fullscreen = false,
    onclose,
    onahOpen,
    onahConfirm,
    children,
    header,
    footer
  }: {
    open?: boolean;
    placement?: DrawerPlacement;
    title?: string;
    size?: string;
    mask?: boolean;
    maskClosable?: boolean;
    escClosable?: boolean;
    showClose?: boolean;
    confirmText?: string;
    cancelText?: string;
    showFooter?: boolean;
    fullscreen?: boolean;
    onclose?: (reason: DrawerCloseReason) => void;
    onahOpen?: () => void;
    onahConfirm?: () => void;
    children?: Snippet;
    header?: Snippet;
    footer?: Snippet;
  } = $props();

  let leaving = $state(false);
  let panelEl: HTMLElement | undefined = $state();
  let lastFocus: HTMLElement | null = null;

  /** open 属性变化：打开时锁滚动 + 聚焦关闭键 + 回调 ah-open；关闭时还原焦点与滚动。 */
  $effect(() => {
    if (open) {
      lastFocus = document.activeElement as HTMLElement | null;
      if (mask) document.body.style.overflow = 'hidden';
      requestAnimationFrame(() => {
        const target =
          panelEl?.querySelector<HTMLElement>('.close') ?? panelEl;
        target?.focus();
      });
      onahOpen?.();
    } else if (lastFocus) {
      try {
        lastFocus.focus();
      } catch {
        /* 焦点目标已销毁时忽略 */
      }
      lastFocus = null;
      if (mask) document.body.style.overflow = '';
    }
  });

  onMount(() => {
    // 订阅全局「关闭所有覆盖层」信号（Tab 切换 / 浏览器后退前进），见文件头「路由联动」。
    window.addEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);
  });

  onDestroy(() => {
    if (mask) document.body.style.overflow = '';
    window.removeEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);
  });

  /** 路由变化时的强制关闭：跳过离场动画，但仍回调 onclose 让宿主同步自身状态。 */
  function onCloseOverlays(): void {
    if (open) finish('button', true);
  }

  function finish(reason: DrawerCloseReason, skipAnimation = false): void {
    if (!open || leaving) return;
    leaving = true;
    const dispatch = () => {
      leaving = false;
      onclose?.(reason);
    };
    if (skipAnimation) {
      dispatch();
    } else {
      window.setTimeout(dispatch, LEAVE_MS);
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (!escClosable) return;
      e.stopPropagation();
      finish('esc');
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = getFocusableElements();
    if (!focusables.length) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    const activeIn = active !== null && focusables.includes(active);
    if (e.shiftKey && (active === first || !activeIn)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !activeIn)) {
      e.preventDefault();
      first.focus();
    }
  }

  /** 焦点圈闭环：面板内 + snippet 投影内容中的可聚焦元素（Svelte 无 light/shadow 之分，统一查面板内）。 */
  function getFocusableElements(): HTMLElement[] {
    const els = Array.from(
      panelEl?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]'
      ) ?? []
    );
    return els.filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
  }
</script>

{#if open}
  <!-- 全屏定位层：默认不拦截指针，仅遮罩与面板各自开启 pointer-events，
      这样 mask=false 时抽屉为非模态，外部点击可穿透到下层页面。 -->
  <div
    class="overlay no-pill {placement}{leaving ? ' leaving' : ''}{fullscreen ? ' fullscreen' : ''}"
  >
    {#if mask}
      <div
        class="scrim"
        role="presentation"
        onclick={(e: MouseEvent) => {
          if (maskClosable && e.target === e.currentTarget) finish('mask');
        }}
      ></div>
    {/if}
    <aside
      bind:this={panelEl}
      class="panel"
      style="--ahd-size: {size}"
      role="dialog"
      aria-modal="true"
      aria-label={title || '抽屉'}
      tabindex="-1"
      onkeydown={onKeydown}
    >
      {#if title || showClose}
        <div class="head">
          {#if title}<div class="title">{title}</div>{/if}
          {@render header?.()}
          {#if showClose}
            <button
              type="button"
              class="close"
              title="关闭"
              onclick={() => finish('button')}
            >
              <span class="lbl-close">关闭</span><span class="lbl-back">返回</span>
              <span class="ico-close" aria-hidden="true">×</span>
              <span class="ico-back" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M15 18l-6-6 6-6"></path>
                </svg>
              </span>
            </button>
          {/if}
        </div>
      {/if}
      <div class="body">{@render children?.()}</div>
      {#if showFooter}
        {#if footer}
          <div class="foot">{@render footer()}</div>
        {:else}
          <div class="foot">
            <button
              type="button"
              class="btn ghost"
              onclick={() => finish('button')}
            >
              {cancelText}
            </button>
            <button type="button" class="btn primary" onclick={() => onahConfirm?.()}>
              {confirmText}
            </button>
          </div>
        {/if}
      {/if}
    </aside>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: var(--ahd-z, 1060);
    display: flex;
    pointer-events: none;
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: var(--md-drawer-mask-bg, rgba(0, 0, 0, 0.45));
    pointer-events: auto;
    opacity: 0;
    animation: ahd-scrim-in 0.22s ease forwards;
  }
  .leaving .scrim {
    opacity: 0;
    transition: opacity 220ms ease;
  }
  @keyframes ahd-scrim-in {
    to {
      opacity: 1;
    }
  }

  /* 方向布局：overlay 用 flex 把面板贴到对应边缘；面板非动画态 transform 为 none。 */
  .left {
    align-items: stretch;
    justify-content: flex-start;
    --ahd-from: translateX(-100%);
  }
  .right {
    align-items: stretch;
    justify-content: flex-end;
    --ahd-from: translateX(100%);
  }
  .top {
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
    --ahd-from: translateY(-100%);
  }
  .bottom {
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-end;
    --ahd-from: translateY(100%);
  }

  .panel {
    position: relative;
    z-index: 1;
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    background: var(--md-drawer-bg, var(--ah-surface-1));
    color: var(--ah-text);
    border: 1px solid var(--md-drawer-border, var(--ah-border));
    box-shadow: var(--ah-shadow);
    overflow: hidden;
    /* 安全区内边距要算进面板总高，避免大屏刘海机因 padding 顶出视口、
       底部内容被面板自身 overflow:hidden 裁掉。 */
    box-sizing: border-box;
    max-height: 100dvh;
    animation: ahd-slide-in 0.22s cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  .left .panel,
  .right .panel {
    width: var(--ahd-size, 320px);
    max-width: 100vw;
    height: 100%;
    /* 全屏定位的左右抽屉：顶/底含安全区，标题不顶进原生状态栏、
       底边不贴手势条（覆盖层 inset:0 铺满视口）。 */
    padding: calc(env(safe-area-inset-top, 0px)) 0
      calc(env(safe-area-inset-bottom, 0px));
    border: none;
  }
  .top .panel,
  .bottom .panel {
    width: 100%;
    height: var(--ahd-size, 320px);
    max-height: 100dvh;
    /* 上下抽屉：对应端含安全区（top 抽屉贴状态栏、bottom 抽屉贴手势条） */
    padding: calc(env(safe-area-inset-top, 0px)) 0
      calc(env(safe-area-inset-bottom, 0px));
  }
  @keyframes ahd-slide-in {
    from {
      transform: var(--ahd-from);
    }
  }
  .leaving .panel {
    transform: var(--ahd-from);
    transition: transform 220ms cubic-bezier(0.4, 0, 0.2, 1),
      opacity 220ms ease;
    opacity: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .scrim,
    .panel,
    .leaving .scrim,
    .leaving .panel {
      animation: none !important;
      transition: none !important;
    }
  }

  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7.5px 16px;
    border-bottom: 1px solid
      var(--md-drawer-header-border, var(--ah-border));
    flex: 0 0 auto;
  }
  .title {
    font-family: var(--ah-font-display);
    font-weight: 600;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
    color: var(--md-drawer-title-color, var(--ah-text));
  }
  .close {
    flex: none;
    margin-left: auto;
    border: none;
    background: none;
    color: var(--md-drawer-close-color, var(--ah-text-faint));
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    padding: 0 8px;
    border-radius: var(--ah-radius-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .close:hover {
    background: var(--md-drawer-close-hover-bg, var(--ah-surface-2));
  }
  .close svg {
    width: 20px;
    height: 20px;
    display: block;
  }
  /* 两枚图标并存、按断点切换：避免用 JS 匹配媒体查询（渲染前闪烁 + 需订阅变更）。
     display:none 会同时把节点移出无障碍树，故非当前态的图标不会被读屏念出。 */
  .ico-back {
    display: none;
    align-items: center;
    justify-content: center;
  }
  /* 「关闭 / 返回」文案仅供无障碍树（按钮视觉上是纯图标）。两端各留一份，
     按断点互换，保证移动端箭头图标配的仍是准确的名称。 */
  .lbl-close,
  .lbl-back {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .lbl-back {
    display: none;
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    padding: 16px;
    font-size: 14px;
    line-height: 1.6;
    color: var(--ah-text);
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 12px 16px;
    border-top: 1px solid var(--md-drawer-footer-border, var(--ah-border));
    flex: 0 0 auto;
  }
  .foot .btn {
    min-width: 76px;
    padding: 8px 16px;
    font-size: 13px;
    font-family: var(--ah-font-sans);
    cursor: pointer;
    border-radius: var(--ah-radius-md);
    border: 1px solid var(--ah-border);
    transition: background 120ms ease, border-color 120ms ease,
      color 120ms ease;
  }
  .foot .btn.ghost {
    background: transparent;
    color: var(--ah-text-muted);
  }
  .foot .btn.ghost:hover {
    color: var(--ah-text);
    border-color: var(--ah-text-faint);
  }
  .foot .btn.primary {
    background: var(--ah-accent);
    border-color: var(--ah-accent);
    color: #fff;
    font-weight: 600;
  }
  .foot .btn.primary:hover {
    background: var(--ah-accent-strong);
    border-color: var(--ah-accent-strong);
  }
  .foot .btn:focus-visible {
    outline: 2px solid var(--ah-accent);
    outline-offset: 2px;
  }

  @media (max-width: 600px) {
    .left .panel,
    .right .panel {
      width: min(100vw, var(--ahd-size, 320px));
    }
    .top .panel,
    .bottom .panel {
      height: min(70dvh, var(--ahd-size, 320px));
    }
    .foot {
      flex-direction: row-reverse;
    }
    .foot > * {
      flex: 1;
    }
    .foot .btn {
      flex: 1;
    }
    /* 移动端隐藏滚动条（Firefox scrollbar-width + WebKit 伪元素），保留可滚动 */
    * {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    ::-webkit-scrollbar {
      display: none;
      width: 0;
      height: 0;
    }
  }
  /* 断点扩展到 760px（与 app 壳移动断点一致）：抽屉 .panel 在 601–760px
   （Android 大机型）仍会显示滚动条，补齐。 */
  @media (max-width: 760px), (pointer: coarse) {
    * {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    ::-webkit-scrollbar {
      display: none;
      width: 0;
      height: 0;
    }

    /* ── 移动端：标题居中 + 返回键在左 + × 换箭头 ──
       原布局为「标题在左、× 在右」。移动端改为返回键在左、标题居中：
       拇指可达区在屏幕左侧，返回是高频动作；同时把 × 换成箭头，
       与 iOS/Android 的「返回」语义一致（而非「关闭弹层」）。

       标题「真居中」的实现要点：close 必须 position:absolute 脱离流，
       再由 .head justify-content:center 居中 title。若只给 title 设
       text-align:center，它居中的是「扣掉左侧 44px 按钮后」的剩余区域，
       整体会偏右约 30px（视觉上明显没居中）。title 左右等量 padding
       为按钮留出等宽空间，长标题被挤到中间也不会压到按钮下面。
       实现用 CSS 而非改 DOM 顺序——DOM 顺序影响读屏与 Tab 焦点次序，
       保持 close 在后不影响可访问性。 */
    .head {
      position: relative;
      flex-direction: row;
      justify-content: center;
    }
    .close {
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      margin-left: 0;
      /* 触控目标放大到 44px（移动端可点区域下限） */
      min-width: 44px;
      min-height: 44px;
      padding: 0 4px;
    }
    .title {
      order: 1;
      margin-right: 0;
      text-align: center;
      /* 左右留白对称，使标题相对面板中心居中（面板 padding 也是 16px） */
      padding: 0 48px;
    }
    .ico-back {
      display: inline-flex;
    }
    .ico-close {
      display: none;
    }
    .lbl-close {
      display: none;
    }
    .lbl-back {
      display: block;
    }
  }

  /* 全屏模式：用更高特异度（三 class）覆盖基础与移动端媒体查询的 88vw / 70dvh 限制，
    实现真正整页覆盖；同时去除圆角与边框，贴合「整屏抽屉」语义。 */
  .fullscreen.left .panel,
  .fullscreen.right .panel {
    width: 100vw;
    max-width: 100vw;
  }
  .fullscreen.top .panel,
  .fullscreen.bottom .panel {
    height: 100dvh;
    max-height: 100dvh;
  }
  .fullscreen .panel {
    border: none;
    border-radius: 0;
  }
</style>
