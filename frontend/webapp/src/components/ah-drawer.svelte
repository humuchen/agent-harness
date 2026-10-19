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
   *    showFooter / fullscreen / swipeToClose
   *  - 回调：onclose(reason: 'esc'|'mask'|'button'|'swipe') / onahOpen / onahConfirm
   *  - 插槽：默认（body）、header、footer（Svelte snippet）
   *
   * 路由联动：订阅 window `ah:close-overlays`（app 壳在 Tab 切换 / 浏览器
   * 后退前进时广播），收到后跳过离场动画立即关闭并回调 onclose。
   *
   * 移动端侧滑关闭（swipeToClose，默认开）：从面板内缘（自由缘）沿关闭方向拖拽，
   * 面板跟手；松手按「距离阈值 + 甩动速度」双通道决策——过阈值/快甩则沿打开动画
   * 同一条曲线滑出并走离场流程，未过则同曲线回弹。设计细节见 utils/drawer-gesture.ts
   * 与文件底部「侧滑关闭」CSS 注释。
   */
  import { onMount, onDestroy } from 'svelte';
  import type { Snippet } from 'svelte';
  import { APP_EVENTS } from '../app-events';
  import {
    clampDrawerOffset,
    closingDelta,
    detectDrawerSwipe,
    drawerDragTransform,
    drawerSwipeProgress,
    inSwipeEdgeZone,
    isVerticalPlacement,
    shouldCloseDrawer,
    updateDrawerSwipeVelocity
  } from '../utils/drawer-gesture';
  import type {
    DrawerSwipePlacement,
    DrawerSwipeVelocitySample
  } from '../utils/drawer-gesture';
  import {
    acquireDrawerGestureExclusion,
    releaseDrawerGestureExclusion
  } from '../utils/system-gesture';
  // 触感反馈：侧滑关闭是纯手势（无 click），在手势确认/回弹处显式补震。
  import { hapticSelection, hapticTap } from '../utils/haptics';

  export type DrawerPlacement = 'left' | 'right' | 'top' | 'bottom';
  export type DrawerCloseReason = 'esc' | 'mask' | 'button' | 'swipe';

  /** 离场动画时长（ms），与 mac-ui 保持一致。 */
  const LEAVE_MS = 220;
  /** 打开动画曲线（@keyframes ahd-slide-in）：侧滑的跟手收尾（回弹/滑出）复用它，
   *  保证「滑关闭」与「打开」的过渡手感一致。 */
  const OPEN_EASE = 'cubic-bezier(0.2, 0.8, 0.3, 1)';
  /** 拖拽结束后吞「合成 click」的窗口（ms）：指尖拖完松手若落在按钮上，浏览器会补发
   *  一次 click，这里拦掉，避免误触（与 ah-swipe-item 同一问题域）。 */
  const CLICK_SWALLOW_MS = 400;
  /** 不启用手势的目标：输入类元素（文本选择/拖动）与宿主显式声明的排除区。 */
  const SWIPE_IGNORE_SELECTOR =
    'input, textarea, select, [contenteditable="true"], [data-no-swipe]';

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
    swipeToClose = true,
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
    /** 侧滑关闭手势开关（默认开）。仅触屏有效——鼠标拖拽不产生 touch 事件。 */
    swipeToClose?: boolean;
    onclose?: (reason: DrawerCloseReason) => void;
    onahOpen?: () => void;
    onahConfirm?: () => void;
    children?: Snippet;
    header?: Snippet;
    footer?: Snippet;
  } = $props();

  let leaving = $state(false);
  let panelEl: HTMLElement | undefined = $state();
  let scrimEl: HTMLElement | undefined = $state();
  let lastFocus: HTMLElement | null = null;

  /* ------------------------------------------------------------------ *
   * 侧滑关闭手势状态（非响应式：直接驱动 DOM，保证跟手无重渲染滞后）
   * ------------------------------------------------------------------ */

  /** 一次触摸手势的生命周期状态。 */
  interface SwipeState {
    x0: number;
    y0: number;
    /** 轴是否已确认为关闭拖拽（未确认=普通点按/纵向滚动，不拦截）。 */
    confirmed: boolean;
    /** 当前关闭向拖动量（px，已含橡皮筋衰减）。 */
    offset: number;
    /** 面板在关闭轴上的尺寸（px）。 */
    size: number;
    /** 速度采样点（松手甩动判定用）。 */
    sample: DrawerSwipeVelocitySample | null;
    /** 最近一次采样速度（px/ms，正=朝关闭方向）。 */
    velocity: number;
  }
  let swipe: SwipeState | null = null;
  /** 回弹收尾定时器（清内联 transition 用）。 */
  let snapTimer: number | null = null;


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

  /**
   * 打开期间向原生壳申请「系统返回手势排除区」（引用计数，见 utils/system-gesture.ts）。
   *
   * 为什么需要：移动端抽屉常为全屏，其内缘即屏幕对侧边缘，与 Android 10+ 的系统
   * 返回手势同带——不排除则「抽屉内右滑关闭」会同时触发系统返回。iOS 壳内无
   * UINavigationController，该系统手势不存在，无需对称处理（详见该文件头注释）。
   * cleanup 挂在 $effect 上：open 翻转或组件销毁时必然配平释放。
   */
  $effect(() => {
    if (open && swipeToClose) {
      acquireDrawerGestureExclusion();
      return () => releaseDrawerGestureExclusion();
    }
  });

  onMount(() => {
    // 订阅全局「关闭所有覆盖层」信号（Tab 切换 / 浏览器后退前进），见文件头「路由联动」。
    window.addEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);
  });

  onDestroy(() => {
    if (mask) document.body.style.overflow = '';
    window.removeEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);
    if (snapTimer !== null) window.clearTimeout(snapTimer);
    snapTimer = null;
    swipe = null;
  });

  /** 路由变化时的强制关闭：跳过离场动画，但仍回调 onclose 让宿主同步自身状态。 */
  function onCloseOverlays(): void {
    if (open) finish('button', true);
  }

  function finish(reason: DrawerCloseReason, skipAnimation = false): void {
    if (!open || leaving) return;
    // 手势进行中被命令式关闭（esc/mask/按钮/路由）：中止跟手并清掉内联位移，
    // 否则 .leaving 的过渡会从「半开位移」这个错误起点播放。
    // （swipe 路径松手时已把 swipe 置空并写好目标 transform，不受此处影响。）
    if (swipe) resetSwipe();
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

  /* ------------------------------------------------------------------ *
   * 侧滑关闭手势（移动端）
   * ------------------------------------------------------------------ */

  /** 清掉跟手期写在面板上的全部内联样式，回到样式表定义的「全开」态。 */
  function clearSwipeStyles(node: HTMLElement): void {
    node.style.transform = '';
    node.style.transition = '';
    node.style.animation = '';
    node.style.willChange = '';
    node.style.userSelect = '';
    node.style.webkitUserSelect = '';
  }

  /** 中断进行中的手势：清状态 + 清内联样式（面板与遮罩）。 */
  function resetSwipe(): void {
    swipe = null;
    if (snapTimer !== null) {
      window.clearTimeout(snapTimer);
      snapTimer = null;
    }
    if (panelEl) clearSwipeStyles(panelEl);
    if (scrimEl) {
      scrimEl.style.opacity = '';
      scrimEl.style.transition = '';
      scrimEl.style.animation = '';
    }
  }

  /** 吞掉拖拽松手后落在面板上的合成 click（防误触按钮）。 */
  function swallowClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * 触摸起点是否落在「可横向滚动且确有溢出」的内容上（代码块 / 宽表等）。
   * 命中则让位给原生横向滚动——否则从该处右滑会关掉抽屉而非滚动内容。
   * 仅左右抽屉需要判定（垂直抽屉的关闭拖拽是纵向的，不抢横向滚动）。
   */
  function inHorizontalScroller(el: HTMLElement | null, panel: HTMLElement): boolean {
    let node: HTMLElement | null = el;
    while (node && node !== panel) {
      const ox = getComputedStyle(node).overflowX;
      if (
        (ox === 'auto' || ox === 'scroll') &&
        node.scrollWidth > node.clientWidth + 1
      ) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  /** 触摸起点：记录候选手势（未确认前不拦截任何行为）。 */
  const onSwipeTouchStart = (e: TouchEvent) => {
    if (!swipeToClose || !open || leaving || swipe || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!t) return;
    const el = e.target as HTMLElement | null;
    // 输入类元素（文本选择/拖动）与宿主显式排除区不启用手势
    if (el?.closest?.(SWIPE_IGNORE_SELECTOR)) return;
    const node = panelEl;
    if (!node) return;
    // 垂直方位抽屉：body 内是原生纵向滚动，只允许从头部/尾部「chrome 区」发起
    if (isVerticalPlacement(placement) && el?.closest?.('.body')) return;
    // 左右抽屉：起点在可横向滚动的内容（代码块/宽表）上时让位给原生横向滚动
    if (!isVerticalPlacement(placement) && inHorizontalScroller(el, node)) return;
    // 只认「面板内缘带」发起：与系统返回手势所在的屏幕最外侧边缘带错开
    if (!inSwipeEdgeZone(placement, t.clientX, t.clientY, node.getBoundingClientRect())) {
      return;
    }
    const size = isVerticalPlacement(placement) ? node.offsetHeight : node.offsetWidth;
    if (size <= 0) return; // 未布局（如 display:none）：无可跟随尺寸，放弃
    swipe = {
      x0: t.clientX,
      y0: t.clientY,
      confirmed: false,
      offset: 0,
      size,
      sample: null,
      velocity: 0
    };
  };

  /** 触摸移动：确认轴向后跟手（面板位移 + 遮罩等比例衰减）。 */
  const onSwipeTouchMove = (e: TouchEvent) => {
    const s = swipe;
    const node = panelEl;
    if (!s || !node || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - s.x0;
    const dy = t.clientY - s.y0;
    // 未确认且不满足轴向条件 → 交回原生行为（纵向滚动等），不拦截
    if (detectDrawerSwipe(placement, s.confirmed, dx, dy) !== 'drag') return;
    if (!s.confirmed) {
      s.confirmed = true;
      // 掐掉入场动画：CSS 动画（含 forwards fill）优先级高于内联样式，
      // 不掐则跟手 transform / 遮罩 opacity 都不生效。
      node.style.animation = 'none';
      node.style.transition = 'none';
      node.style.willChange = 'transform';
      // 拖拽期间禁止文本选择（长按选择会被横向拖动误启动）
      node.style.userSelect = 'none';
      node.style.webkitUserSelect = 'none';
      if (scrimEl) {
        scrimEl.style.animation = 'none';
        scrimEl.style.opacity = '1'; // 掐掉 fill 后基础值是 0，先补齐全显
      }
      // 手势确认的刻度感（纯手势无 click，显式补一次）
      hapticSelection();
    }
    // 非 passive 监听：阻止浏览器横向平移/overscroll，并抑制后续合成鼠标事件
    e.preventDefault();
    s.offset = clampDrawerOffset(closingDelta(placement, dx, dy), s.size);
    const v = updateDrawerSwipeVelocity(s.sample, s.offset, Date.now());
    s.velocity = v.velocity;
    s.sample = v.sample;
    node.style.transform = drawerDragTransform(placement, s.offset);
    if (scrimEl) {
      scrimEl.style.opacity = String(1 - drawerSwipeProgress(s.offset, s.size));
    }
  };

  /** 松手 / 手势取消：按「距离阈值 + 甩动速度」决策关闭或回弹。 */
  const onSwipeTouchEnd = () => {
    const s = swipe;
    const node = panelEl;
    if (!s || !node) return;
    swipe = null;
    if (!s.confirmed) return; // 未确认：普通点按/纵向滚动，click 正常派发
    // 吞掉本次松手落在按钮上产生的合成 click（400ms 窗口内无人点击则自销）
    node.addEventListener('click', swallowClick, true);
    window.setTimeout(
      () => node.removeEventListener('click', swallowClick, true),
      CLICK_SWALLOW_MS
    );
    if (shouldCloseDrawer(s.offset, s.size, s.velocity)) {
      // 过阈值 / 快甩：沿打开动画同一条曲线推到全关位，再走既有离场流程
      // （finish 回调 onclose，由父级把 open 置 false 完成卸载）。
      node.style.transition = `transform ${LEAVE_MS}ms ${OPEN_EASE}, opacity ${LEAVE_MS}ms ease`;
      node.style.transform = drawerDragTransform(placement, s.size);
      if (scrimEl) {
        scrimEl.style.transition = `opacity ${LEAVE_MS}ms ease`;
        scrimEl.style.opacity = '0';
      }
      finish('swipe');
    } else {
      // 未过阈值：回弹到全开（同曲线），轻震提示「没关成」
      node.style.transition = `transform ${LEAVE_MS}ms ${OPEN_EASE}`;
      node.style.transform = '';
      if (scrimEl) {
        scrimEl.style.transition = `opacity ${LEAVE_MS}ms ease`;
        scrimEl.style.opacity = '1';
      }
      hapticTap('light');
      // 回弹收尾后清掉内联 transition/will-change，避免残留影响后续离场动画
      snapTimer = window.setTimeout(() => {
        snapTimer = null;
        if (node.isConnected) {
          node.style.transition = '';
          node.style.willChange = '';
        }
      }, LEAVE_MS + 60);
    }
  };

  /** 手势被系统接管（来电/多指）：按当前位移就近吸附，语义同松手。 */
  const onSwipeTouchCancel = () => onSwipeTouchEnd();

  /**
   * 侧滑关闭手势（Svelte action，挂在面板上）。
   *
   * 为什么用 action 而非模板 ontouchmove：Svelte 5 把 touchstart/touchmove 委派为
   * passive 监听（svelte 的 PASSIVE_EVENTS），passive 内 preventDefault 不生效——
   * 而「阻止浏览器横向平移 / 抑制合成 click」正是本手势的必需项。这里显式
   * addEventListener('touchmove', …, { passive: false })。面板随 {#if open}
   * 反复重建，action 随之反复挂载，监听器天然随之生灭。
   */
  function drawerSwipeGesture(node: HTMLElement) {
    node.addEventListener('touchstart', onSwipeTouchStart, { passive: true });
    node.addEventListener('touchmove', onSwipeTouchMove, { passive: false });
    node.addEventListener('touchend', onSwipeTouchEnd);
    node.addEventListener('touchcancel', onSwipeTouchCancel);
    return {
      destroy() {
        node.removeEventListener('touchstart', onSwipeTouchStart);
        node.removeEventListener('touchmove', onSwipeTouchMove);
        node.removeEventListener('touchend', onSwipeTouchEnd);
        node.removeEventListener('touchcancel', onSwipeTouchCancel);
        node.removeEventListener('click', swallowClick, true);
        if (snapTimer !== null) {
          window.clearTimeout(snapTimer);
          snapTimer = null;
        }
        swipe = null;
      }
    };
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- 全屏定位层：默认不拦截指针，仅遮罩与面板各自开启 pointer-events，
      这样 mask=false 时抽屉为非模态，外部点击可穿透到下层页面。

      overlay 根上的 touch 停止冒泡：抽屉是模态覆盖层，落在其上的触摸不应继续
      冒泡到 app 壳——否则「从抽屉内缘右滑关闭」会被壳的边缘手势（左缘右滑开侧栏）
      同时捕获，出现关抽屉的同时把侧栏拽出来的手势冲突。mask=false 时外部触摸
      本就穿透（pointer-events:none），不受影响。 -->
  <div
    class="overlay no-pill {placement}{leaving ? ' leaving' : ''}{fullscreen ? ' fullscreen' : ''}"
    ontouchstart={(e: TouchEvent) => e.stopPropagation()}
    ontouchmove={(e: TouchEvent) => e.stopPropagation()}
    ontouchend={(e: TouchEvent) => e.stopPropagation()}
    ontouchcancel={(e: TouchEvent) => e.stopPropagation()}
  >
    {#if mask}
      <div
        bind:this={scrimEl}
        class="scrim"
        role="presentation"
        onclick={(e: MouseEvent) => {
          if (maskClosable && e.target === e.currentTarget) finish('mask');
        }}
      ></div>
    {/if}
    <div
      bind:this={panelEl}
      class="panel"
      style="--ahd-size: {size}"
      role="dialog"
      aria-modal="true"
      aria-label={title || '抽屉'}
      tabindex="-1"
      onkeydown={onKeydown}
      use:drawerSwipeGesture
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
    </div>
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

  /* ── 侧滑关闭的触摸策略 ──
     左右抽屉：pan-y = 纵向原生滚动交还 body（抽屉内容可上下滑），横向交还手势。
     面板一旦声明非 auto 的 touch-action，浏览器便不再对该区域做原生横向平移
     （含 Chrome 的 overscroll 返回导航），手势处理器拿到可 preventDefault 的
     touchmove——这是「侧滑关闭不误触发浏览器/系统返回」的 web 层第一道闸。
     第二道闸是原生壳的系统手势排除区（见 utils/system-gesture.ts）。 */
  .left .panel,
  .right .panel {
    touch-action: pan-y;
  }
  /* 头部/尾部不参与原生平移：垂直方位抽屉的关闭拖拽从这两条 chrome 区发起
     （body 内是原生纵向滚动，不能抢）；水平方位抽屉的横向拖拽也常从这里经过。
     注意不能给垂直方位抽屉的面板设 pan-x——那会与 body 的纵向滚动取交集后
     把滚动禁掉。 */
  .head,
  .foot {
    touch-action: none;
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
