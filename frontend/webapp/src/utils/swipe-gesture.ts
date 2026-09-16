/**
 * 滑动操作手势的纯几何逻辑（无 DOM）：轴向判定 / 位移钳制 / 吸附决策。
 *
 * 供 ah-swipe-item 等通用滑动组件使用；独立成纯函数便于单测，
 * 组件内只负责「把 touch 事件喂进来、把结果写回 DOM」。
 */

/** 轴向判定：`h`=已判定为水平滑动手势。 */
export type SwipeAxis = 'none' | 'h';

export interface SwipeAxisState {
  axis: SwipeAxis;
  /** 手势起始触摸点（clientX / clientY）。 */
  x0: number;
  y0: number;
}

/**
 * 判定当前触摸点是否构成「水平滑动手势」。
 * - 已判定为 h 则保持（一次手势中途不回退）；
 * - 横向位移超过 slop 且明显大于纵向（|dx| > |dy| * ratio）才判定为 h，
 *   否则视为纵向滚动，交回原生滚动。
 */
export function detectSwipeAxis(
  state: SwipeAxisState,
  x: number,
  y: number,
  slop = 10,
  ratio = 1.2
): SwipeAxis {
  if (state.axis === 'h') return 'h';
  const dx = Math.abs(x - state.x0);
  const dy = Math.abs(y - state.y0);
  if (dx > slop && dx > dy * ratio) return 'h';
  return 'none';
}

/** 把拖动位移钳制到 [min, max]（超出范围时手指仍继续移动，但内容不再跟随）。 */
export function clampSwipeOffset(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * 松手吸附决策：位移达到 max * threshold 判为「展开」，否则回弹收起。
 * 0.45 比 0.5 略宽松——操作按钮区通常不超过 160px，少拖一点即触发，跟手。
 * 用 `>=`：恰好拖到阈值包络即判展开（含边界），与测试文档化的边界语义一致。
 */
export function shouldSnapOpen(offset: number, max: number, threshold = 0.45): boolean {
  if (max <= 0) return false;
  return offset >= max * threshold;
}
