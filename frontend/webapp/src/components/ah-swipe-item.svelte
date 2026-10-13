
<script lang="ts">
/**
 * ah-swipe-item：通用「滑动露出操作」列表项组件 —— Svelte 迁移版。
 * ---------------------------------------------------------------
 * 设计定位（通用约定，后续同类需求直接复用）：
 * 任何列表行想获得「横向滑动露出编辑/删除等操作按钮」的能力，把行包一层
 * <AhSwipeItem id=… group=…>，默认内容放 children snippet、操作按钮放
 * actions snippet 即可。组件封装了全部手势与状态，宿主零状态管理：
 *
 *   <AhSwipeItem id="s-1" group="chat-sessions">
 *     <div class="session-row">…行内容，onclick=选择…</div>
 *     {#snippet actions()}
 *       <button class="swipe-act" onclick=重命名>✎ 重命名</button>
 *       <button class="swipe-act danger" onclick=删除>🗑 删除</button>
 *     {/snippet}
 *   </AhSwipeItem>
 *
 * 手势规则：
 * - 触屏（pointer:coarse / hover:none）启用：横向拖动露出右侧操作区，
 *   松手按 45% 阈值吸附（展开/回弹）；已展开时点按行内容自动收起；
 *   纵向位移占优则立即交回原生滚动（列表可正常上下滑）。
 * - 鼠标/触屏两用的 hover 设备：操作区默认隐藏（宿主自行用 hover 浮现
 *   等价入口，如本仓会话列表的 .acts），组件不响应横向拖拽，避免
 *   与原生滚轮/拖选冲突。
 *
 * 组排他（同一 group 内同时只允许一个项展开）：
 * 展开某项时，向 `ah:swipe-close` 全局事件广播；同组兄弟项收到后收起。
 * 宿主删除/重排行 DOM 时，组件卸载自动注销监听，无需宿主清理。
 *
 * 事件（宿主订阅，detail 均含 { id, group }；在根元素上冒泡）：
 * - @ah-swipe-open   展开后（手势吸附 / 属性设置 / 宿主命令式 open=true）
 * - @ah-swipe-close  收起后（tap-close / 组排他 / close() / 路由切换）
 *
 * 点击语义（宿主无需处理）：
 * - 操作区按钮由宿主在 actions snippet 内容上直接绑 onclick 做业务；
 *   点击后组件自动收起（「操作完立即还原行」），宿主按钮 onclick 先于收起执行；
 * - 展开态点按行内容 = 仅收起（tap-close）：组件在 touchend 上 preventDefault
 *   抑制合成 click，宿主的行 onclick（如「选中会话」）不会误触发；
 *   再次点按才走宿主原有选中语义；
 * - 横向滑动收尾的 click 同样被抑制（touchmove preventDefault 后浏览器
 *   不派发 click），宿主零状态管理。
 *
 * 接入约定：根元素（.swipe-item-root）已声明 `touch-action: pan-y` ——
 * 纵向列表滚动仍交原生，横向拖动归手势。
 *
 * 样式：原 :host 规则改写为根类 .swipe-item-root；原 :host([open]) 改写为
 * .swipe-item-root[data-open]（根元素以 data-open 反射展开态，
 * 见 styles/swipe-act.ts / session-swipe.ts 等宿主侧全局样式的约定）。
 */
  import { onDestroy, onMount, tick } from 'svelte';
  import type { Snippet } from 'svelte';
  import {
    clampSwipeOffset,
    detectSwipeAxis,
    shouldSnapOpen
  } from '../utils/swipe-gesture';
  import type { SwipeAxisState } from '../utils/swipe-gesture';
  import { APP_EVENTS } from '../app-events';

  /** 全局组排他信号：detail.group 为组名，同组其他 AhSwipeItem 收起自身。 */
  const SWIPE_GROUP_CLOSE_EVENT = APP_EVENTS.swipeClose;

  let {
    /** 行 id（宿主事件 detail 与组排他注销用；由宿主传入，组件不自造）。 */
    id = '',
    /** 组名：同组同时仅一个展开。缺省 'default'。 */
    group = 'default',
    /** 展开态（宿主可命令式设置，如「长按呼出编辑模式」；手势也会写它）。 */
    open = $bindable(false),
    children,
    actions
  }: {
    id?: string;
    group?: string;
    open?: boolean;
    children?: Snippet;
    actions?: Snippet;
  } = $props();

  let rootEl: HTMLElement | undefined = $state();
  let bgEl: HTMLElement | undefined = $state();
  let contentEl: HTMLElement | undefined = $state();

  let dragging = $state(false);

  /** 操作区量测宽度（px）：位移上限与吸附都基于它。0=未量测。 */
  let maxOffset = 0;

  /** 手势（触屏拖动期间非空；非响应式，直接驱动 DOM，保证跟手无重渲染滞后）。 */
  let gesture: (SwipeAxisState & { swiped: boolean }) | null = null;
  /** 上一次手势的位移缓存（touchend / touchcancel 吸附判定用）。 */
  let lastOffset = 0;

  onMount(() => {
    // 订阅全局组排他信号：同组其他项展开时收起自己。
    window.addEventListener(SWIPE_GROUP_CLOSE_EVENT, onGroupClose);
  });

  onDestroy(() => {
    window.removeEventListener(SWIPE_GROUP_CLOSE_EVENT, onGroupClose);
  });

  const onGroupClose = (e: Event) => {
    const d = (e as CustomEvent<{ group?: string; id?: string }>).detail;
    if (!d || d.group !== group) return;
    // 自身豁免：展开广播里带 id 的（自己发的）；不带 id 的「全组关闭」信号不豁免。
    if (d.id !== undefined && d.id === id) return;
    if (open) close();
  };

  /**
   * open 变化（含首次挂载，与 Lit 首次 update 语义一致）：
   * 展开时量测操作区宽度；同步内容位移；展开时向同组广播收起信号；
   * 对外派发 ah-swipe-open / ah-swipe-close。
   */
  $effect(() => {
    const o = open;
    void tick().then(() => {
      if (o) setMaxOffset();
      applyTransform();
    });
    // 展开广播：同组兄弟收起（自身在广播里按 id 豁免）。
    if (o) {
      window.dispatchEvent(
        new CustomEvent(SWIPE_GROUP_CLOSE_EVENT, {
          detail: { group, id }
        })
      );
    }
    rootEl?.dispatchEvent(
      new CustomEvent(o ? 'ah-swipe-open' : 'ah-swipe-close', {
        bubbles: true,
        composed: true,
        detail: { id, group }
      })
    );
  });

  /** 量测操作区宽度（actions snippet 内容需等渲染完成后量测）。 */
  function setMaxOffset() {
    if (!bgEl) return;
    const w = bgEl.scrollWidth;
    if (w > 0) maxOffset = w;
  }

  /** 位移上限：操作区实测宽（未量测到默认 128px），与吸附/变换全链路同源。 */
  function cap(): number {
    return maxOffset > 0 ? maxOffset : 128;
  }

  function applyTransform() {
    if (!contentEl) return;
    contentEl.style.transform = open ? `translateX(-${cap()}px)` : '';
  }

  /** 命令式收起（宿主 / 组排他 / 路由切换均走这里）。 */
  export function close() {
    if (!open) return;
    open = false;
  }

  /** 触屏手势起点（单指；点在操作区上时不启动内容拖动，按钮点击不受手势干扰）。 */
  const onTouchStart = (e: TouchEvent) => {
    if (gesture || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!t) return;
    if ((e.target as HTMLElement).closest?.('.bg')) return;
    gesture = { axis: 'none', x0: t.clientX, y0: t.clientY, swiped: false };
    if (open) setMaxOffset();
  };

  const onTouchMove = (e: TouchEvent) => {
    const g = gesture;
    if (!g) return;
    const t = e.touches[0];
    if (!t) return;
    const next = detectSwipeAxis(g, t.clientX, t.clientY);
    if (next === 'h' && g.axis !== 'h') {
      // 判定为横向手势：内容跟手（dragging 类关掉过渡，避免 0.22s 滞后）。
      dragging = true;
      contentEl?.classList.add('dragging');
    }
    g.axis = next;
    if (g.axis !== 'h') return; // 纵向占优：交回原生滚动（根元素 touch-action: pan-y）
    g.swiped = g.swiped || Math.abs(t.clientX - g.x0) > 8;
    if (g.swiped) e.preventDefault(); // 抑制横向合成事件（含收尾 click），纵向仍可原生滚动
    const c = cap();
    // 左滑（dx<0）露出右侧操作区：内容跟随指尖左移（translateX 负值），
    // 从起点位移（open=-cap / closed=0）出发叠加 dx，钳制在 [-cap, 0]。
    const shift = open ? -c : 0;
    const dx = t.clientX - g.x0;
    const translate = clampSwipeOffset(shift + dx, -c, 0);
    if (contentEl) contentEl.style.transform = `translateX(${translate}px)`;
    // 暂存最后一次的「已露出量」（-translate，>=0），松手吸附用。
    lastOffset = -translate;
  };

  /** 松手：按 45% 阈值吸附展开/回弹；tap-close 时抑制合成 click。 */
  const onTouchEnd = (e: TouchEvent) => {
    const g = gesture;
    if (!g) return;
    gesture = null;
    contentEl?.classList.remove('dragging');
    dragging = false;
    const wasOpen = open;
    const snappedOpen = shouldSnapOpen(lastOffset, cap());
    // tap-close：展开态下点按（未滑动、吸附回收起）→ 本次仅关闭，
    // preventDefault 阻止合成 click，宿主的行 onclick（选中会话）不会误触发。
    if (wasOpen && !g.swiped && !snappedOpen) e.preventDefault();
    if (snappedOpen !== open) open = snappedOpen;
    else applyTransform();
  };

  /** 手势取消（系统手势接管 / 第二指落下）：按当前位移就近吸附。 */
  const onTouchCancel = () => {
    const g = gesture;
    if (!g) return;
    gesture = null;
    contentEl?.classList.remove('dragging');
    dragging = false;
    const snappedOpen = shouldSnapOpen(lastOffset, cap());
    if (snappedOpen !== open) open = snappedOpen;
    else applyTransform();
  };

  /**
   * 操作区点击兜底：宿主 actions 按钮自行处理业务（按钮 onclick 会冒泡到这里），
   * 点击后自动收起，保证「操作完立即还原行」的一致体验。
   */
  const onSlotActionClick = () => {
    if (open) open = false;
  };
</script>

<div
  class="swipe-item-root"
  data-open={open ? '' : undefined}
  bind:this={rootEl}
>
  <div class="inner">
    <div class="bg" aria-hidden="true" bind:this={bgEl} onclick={onSlotActionClick}>
      {@render actions?.()}
    </div>
    <div
      class="content"
      class:dragging
      bind:this={contentEl}
      ontouchstart={onTouchStart}
      ontouchmove={onTouchMove}
      ontouchend={onTouchEnd}
      ontouchcancel={onTouchCancel}
    >
      {@render children?.()}
    </div>
  </div>
</div>

<style>
  /* 原 :host 规则 → 根类（宿主侧全局样式 session-swipe.ts 等以 .swipe-item-root 为目标） */
  .swipe-item-root {
    display: block;
    position: relative;
    overflow: hidden;
    /* 圆角继承宿主链（行圆角由父级 .swipe 壳或本根元素承担） */
    border-radius: inherit;
    /* 允许纵向滚动穿透、拦截横向拖动给手势处理 */
    touch-action: pan-y;
    -webkit-touch-callout: none;
  }
  /* 操作区：贴右侧、整行高；内容左移后自然「露出」。
     按钮区宽由内容决定（actions snippet 两个按钮通常 56+56=112px 起）。
     动画：open 时淡入（0.2s），关闭时延迟 0.05s 再淡出——
     淡出延迟让「内容弹回盖住」先完成，视觉上是「先盖后隐」不穿帮。 */
  .bg {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 0;
    display: flex;
    align-items: stretch;
    pointer-events: none; /* 仅展开（内容让出该区域）时才可点 */
    opacity: 0;
    transition: opacity 0.2s ease 0.05s;
  }
  .swipe-item-root[data-open] .bg {
    pointer-events: auto;
    opacity: 1;
    transition-delay: 0s;
  }
  .content {
    position: relative;
    z-index: 1;
    display: block;
    /* 松手吸附的回弹曲线：略过冲（y>1）营造「弹簧感」；
       拖拽跟手期间由 .dragging 关掉过渡（见下）。 */
    transition:
      transform 0.24s cubic-bezier(0.22, 1.2, 0.36, 1),
      box-shadow 0.2s ease;
    will-change: transform;
    /* 内容自带底色盖住操作区；宿主行背景色在内容元素上声明 */
  }
  /* 展开态：内容右缘（贴按钮侧）升起一层薄投影，强化「盖住操作区」的层次。 */
  .swipe-item-root[data-open] .content {
    box-shadow: 3px 0 12px rgba(0, 0, 0, 0.28);
  }
  .content.dragging {
    transition: none;
  }
  /* 操作区按钮（.swipe-act）是宿主投影内容，组件 scoped 选择器
     打不到 —— 统一由 styles/swipe-act.ts（宿主并入自身样式）提供外观。 */
  /* hover 设备：隐藏滑动操作区（宿主自带 hover 按钮入口，见文件头） */
  @media (hover: hover) and (pointer: fine) {
    .bg {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .content {
      transition: none;
    }
    .bg {
      transition: none;
    }
  }
</style>
