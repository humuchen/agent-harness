/**
 * 抽屉（Drawer）侧滑关闭手势的纯几何逻辑（无 DOM）。
 * -------------------------------------------------------------------
 * 与 utils/swipe-gesture.ts（列表行滑动露钮）同一分层约定：判定/钳制/决策全部是
 * 纯函数，组件内只负责「把 touch 事件喂进来、把结果写回 DOM」，便于单测与双端一致。
 *
 * 手势语义（按 placement）：
 * - right 抽屉（面板停靠屏幕右缘）：从面板内缘（自由缘）向右滑 → 关闭；
 * - left 抽屉：从面板右缘向左滑 → 关闭；
 * - top 抽屉：从面板下缘向上滑 → 关闭；
 * - bottom 抽屉：从面板上缘向下滑 → 关闭。
 *
 * 两个刻意的设计约束：
 * 1. **只认关闭方向**：反向（朝打开方向）位移不确认为拖拽——面板已全开，没有可
 *    跟随空间，交回页面（纵向滚动等原生行为）。
 * 2. **轴向锁定**：确认后一次手势中途不回退；未确认时纵向位移占优则整体不确认
 *    （抽屉 body 的纵向滚动不被抢）。
 */

/** 抽屉方位（与 ah-drawer.svelte 的 DrawerPlacement 结构一致）。
 *  此处独立定义而非 import 组件类型：utils 层不反向依赖 components。 */
export type DrawerSwipePlacement = 'left' | 'right' | 'top' | 'bottom';

/** 边缘命中区默认宽度（px）：与 app 壳「边缘右滑开侧栏」的 edgeZone 同量级。 */
export const DEFAULT_EDGE_ZONE = 32;

/** 轴向起判位移（px）：过滤指尖抖动，与 swipe-gesture.ts 的 slop 同值。 */
export const DEFAULT_SWIPE_SLOP = 10;

/** 主轴优势比：关闭轴位移需大于垂直轴位移的该倍数，避免与纵向滚动抢手势。 */
export const DEFAULT_SWIPE_RATIO = 1.2;

/** 橡皮筋阻抗：越过全关位后每多拖 1px，面板只跟随 0.3px（iOS 阻尼感，防「拖飞」）。 */
export const DRAG_OVERSCROLL_RESISTANCE = 0.3;

/** 松手距离阈值（占面板尺寸比例）：拖过即关。 */
export const DEFAULT_CLOSE_THRESHOLD = 0.35;

/** 甩动速度阈值（px/ms）：0.5px/ms ≈ 500px/s，原生抽屉的「快甩即关」手感。 */
export const DEFAULT_FLICK_VELOCITY = 0.5;

/** 甩动生效的最小拖动量（px）：防「指尖一抖就关」。 */
export const DEFAULT_MIN_FLICK_OFFSET = 24;

/** 面板矩形的最小几何子集（getBoundingClientRect 的结构化子集，便于测试注入）。 */
export interface SwipePanelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 是否垂直方位抽屉（top/bottom 走纵向滑动手势）。 */
export function isVerticalPlacement(placement: DrawerSwipePlacement): boolean {
  return placement === 'top' || placement === 'bottom';
}

/**
 * 位移在「关闭轴」上的投影：>0 表示正朝关闭方向移动。
 * right/bottom 为 +x/+y；left/top 为 -x/-y。
 */
export function closingDelta(
  placement: DrawerSwipePlacement,
  dx: number,
  dy: number
): number {
  switch (placement) {
    case 'right':
      return dx;
    case 'left':
      return -dx;
    case 'bottom':
      return dy;
    case 'top':
      return -dy;
  }
}

/**
 * 触摸点是否落在抽屉的「内缘带」——侧滑关闭只允许从面板自由缘（朝屏幕中心那侧）
 * 发起。刻意与系统返回手势所在的屏幕最外侧边缘带错开，降低手势争夺；
 * 全屏抽屉（移动端常见）内缘即屏幕对侧边缘，该处发起关闭也不与系统返回同带。
 */
export function inSwipeEdgeZone(
  placement: DrawerSwipePlacement,
  x: number,
  y: number,
  panel: SwipePanelRect,
  zone: number = DEFAULT_EDGE_ZONE
): boolean {
  if (zone <= 0) return false;
  switch (placement) {
    case 'right':
      return x - panel.left <= zone;
    case 'left':
      return panel.right - x <= zone;
    case 'top':
      return panel.bottom - y <= zone;
    case 'bottom':
      return y - panel.top <= zone;
  }
}

/** 轴向判定结果：none=未确认（交回原生行为）；drag=已确认为侧滑关闭拖拽。 */
export type DrawerSwipePhase = 'none' | 'drag';

export interface DrawerSwipeDetectOpts {
  slop?: number;
  ratio?: number;
}

/**
 * 判定当前触摸点是否确认为「侧滑关闭拖拽」：
 * - 已确认则保持（一次手势中途不回退）；
 * - 关闭轴位移超 slop、且大于垂直轴位移 * ratio → 确认；
 * - 反向位移或纵向占优 → 不确认。
 */
export function detectDrawerSwipe(
  placement: DrawerSwipePlacement,
  confirmed: boolean,
  dx: number,
  dy: number,
  opts: DrawerSwipeDetectOpts = {}
): DrawerSwipePhase {
  if (confirmed) return 'drag';
  const { slop = DEFAULT_SWIPE_SLOP, ratio = DEFAULT_SWIPE_RATIO } = opts;
  const d = closingDelta(placement, dx, dy);
  const perp = isVerticalPlacement(placement) ? Math.abs(dx) : Math.abs(dy);
  if (d > slop && d > perp * ratio) return 'drag';
  return 'none';
}

/**
 * 把原始关闭向位移钳制为可用的拖动量：
 * - 下限 0（面板已全开，不允许反向越界）；
 * - 越过 size（全关位）后按阻抗衰减跟随，避免「拖飞」。
 */
export function clampDrawerOffset(
  raw: number,
  size: number,
  resistance: number = DRAG_OVERSCROLL_RESISTANCE
): number {
  if (size <= 0) return 0;
  if (raw <= 0) return 0;
  if (raw <= size) return raw;
  return size + (raw - size) * resistance;
}

/** 速度采样点（关闭向拖动量 + 时间戳，ms）。 */
export interface DrawerSwipeVelocitySample {
  offset: number;
  t: number;
}

/**
 * 速度采样（px/ms）。相邻两次移动间隔超过 maxGapMs 视为「中途停顿」，
 * 速度清零——松手时的甩动判定不应跨越一个停顿生效。
 */
export function updateDrawerSwipeVelocity(
  prev: DrawerSwipeVelocitySample | null,
  offset: number,
  t: number,
  maxGapMs = 100
): { velocity: number; sample: DrawerSwipeVelocitySample } {
  if (prev && t > prev.t && t - prev.t <= maxGapMs) {
    return { velocity: (offset - prev.offset) / (t - prev.t), sample: { offset, t } };
  }
  return { velocity: 0, sample: { offset, t } };
}

export interface DrawerCloseDecisionOpts {
  /** 距离阈值（占面板尺寸比例）。 */
  threshold?: number;
  /** 甩动速度阈值（px/ms）。 */
  flickVelocity?: number;
  /** 甩动生效的最小拖动量（px）。 */
  minFlickOffset?: number;
}

/**
 * 松手判定：拖过阈值关闭；未过阈值但甩动足够快（且拖动量过下限）也关闭；否则回弹。
 * 距离与速度双通道——只认距离会让「快甩小位移」失效（不跟手），
 * 只认速度会让「慢拖大位移」失效（与原生抽屉体验相悖）。
 */
export function shouldCloseDrawer(
  offset: number,
  size: number,
  velocity = 0,
  opts: DrawerCloseDecisionOpts = {}
): boolean {
  if (size <= 0) return false;
  const {
    threshold = DEFAULT_CLOSE_THRESHOLD,
    flickVelocity = DEFAULT_FLICK_VELOCITY,
    minFlickOffset = DEFAULT_MIN_FLICK_OFFSET
  } = opts;
  if (offset >= size * threshold) return true;
  return velocity >= flickVelocity && offset >= minFlickOffset;
}

/**
 * 拖动进度（0..1）：驱动遮罩透明度等比例衰减；越过全关位按 1 计。
 */
export function drawerSwipeProgress(offset: number, size: number): number {
  if (size <= 0) return 0;
  return Math.min(1, Math.max(0, offset / size));
}

/**
 * 面板跟手位移的 CSS transform：关闭向拖动量按方位映射到 translateX/Y。
 * offset=0 返回空串（清掉内联值即回到样式表的 none）。
 */
export function drawerDragTransform(
  placement: DrawerSwipePlacement,
  offset: number
): string {
  if (offset === 0) return '';
  const v = `${offset}px`;
  switch (placement) {
    case 'right':
      return `translateX(${v})`;
    case 'left':
      return `translateX(${-offset}px)`;
    case 'bottom':
      return `translateY(${v})`;
    case 'top':
      return `translateY(${-offset}px)`;
  }
}
