/**
 * 滑动操作手势纯几何逻辑验证（不启动 DOM）：
 * 轴向判定 / 位移钳制 / 松手吸附决策。
 */
import { describe, it, expect } from 'vitest';
import {
  detectSwipeAxis,
  clampSwipeOffset,
  shouldSnapOpen
} from './swipe-gesture';

describe('detectSwipeAxis', () => {
  it('水平位移超过 slop 且明显大于纵向时判定为 h', () => {
    const st = { axis: 'none' as const, x0: 100, y0: 200 };
    expect(detectSwipeAxis(st, 120, 203)).toBe('h');
  });

  it('纵向位移占优时保持 none（交回原生滚动）', () => {
    const st = { axis: 'none' as const, x0: 100, y0: 200 };
    expect(detectSwipeAxis(st, 104, 220)).toBe('none');
  });

  it('位移未达 slop 时不判定', () => {
    const st = { axis: 'none' as const, x0: 100, y0: 200 };
    expect(detectSwipeAxis(st, 105, 201)).toBe('none');
  });

  it('一旦判定为 h 则保持（手势中途不回退）', () => {
    const st = { axis: 'h' as const, x0: 100, y0: 200 };
    expect(detectSwipeAxis(st, 100, 300)).toBe('h');
  });

  it('左滑（反向位移）同样可判定', () => {
    const st = { axis: 'none' as const, x0: 100, y0: 200 };
    expect(detectSwipeAxis(st, 70, 198)).toBe('h');
  });
});

describe('clampSwipeOffset', () => {
  it('区间内原样返回', () => {
    expect(clampSwipeOffset(64, 0, 128)).toBe(64);
  });
  it('低于 min 收至 min', () => {
    expect(clampSwipeOffset(-20, 0, 128)).toBe(0);
  });
  it('高于 max 收至 max', () => {
    expect(clampSwipeOffset(300, 0, 128)).toBe(128);
  });
});

describe('shouldSnapOpen', () => {
  it('越过默认阈值（0.45）判展开', () => {
    expect(shouldSnapOpen(60, 128)).toBe(true); // 60 > 128*0.45=57.6
  });
  it('未过阈值判收起', () => {
    expect(shouldSnapOpen(40, 128)).toBe(false);
  });
  it('max 非法（<=0）时不展开', () => {
    expect(shouldSnapOpen(999, 0)).toBe(false);
  });
  it('自定义阈值生效', () => {
    expect(shouldSnapOpen(50, 100, 0.6)).toBe(false);
    expect(shouldSnapOpen(60, 100, 0.6)).toBe(true);
  });
});
