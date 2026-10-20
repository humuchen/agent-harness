/**
 * 抽屉侧滑关闭手势纯几何逻辑验证（不启动 DOM）：
 * 边缘命中区 / 轴向确认 / 橡皮筋钳制 / 速度采样 / 松手阈值与甩动决策 / 跟手 transform。
 */
import { describe, it, expect } from 'vitest';
import {
  closingDelta,
  inSwipeEdgeZone,
  isVerticalPlacement,
  detectDrawerSwipe,
  clampDrawerOffset,
  updateDrawerSwipeVelocity,
  shouldCloseDrawer,
  drawerSwipeProgress,
  drawerDragTransform,
  DEFAULT_EDGE_ZONE
} from './drawer-gesture';

describe('isVerticalPlacement', () => {
  it('left/right 为水平方位，top/bottom 为垂直方位', () => {
    expect(isVerticalPlacement('left')).toBe(false);
    expect(isVerticalPlacement('right')).toBe(false);
    expect(isVerticalPlacement('top')).toBe(true);
    expect(isVerticalPlacement('bottom')).toBe(true);
  });
});

describe('closingDelta', () => {
  it('right/bottom 抽屉取正方向，left/top 取反方向', () => {
    expect(closingDelta('right', 30, -5)).toBe(30);
    expect(closingDelta('left', -30, 5)).toBe(30);
    expect(closingDelta('bottom', 4, 30)).toBe(30);
    expect(closingDelta('top', 4, -30)).toBe(30);
  });
});

describe('inSwipeEdgeZone', () => {
  // 右抽屉：面板 [70, 390]，内缘（自由缘）是 left=70 那侧
  const rightPanel = { left: 70, top: 0, right: 390, bottom: 844 };

  it('触摸点落在面板内缘带内 → 命中', () => {
    expect(inSwipeEdgeZone('right', 70, 400, rightPanel)).toBe(true);
    expect(inSwipeEdgeZone('right', 70 + DEFAULT_EDGE_ZONE, 400, rightPanel)).toBe(true);
  });

  it('触摸点越过内缘带 → 不命中', () => {
    expect(inSwipeEdgeZone('right', 70 + DEFAULT_EDGE_ZONE + 1, 400, rightPanel)).toBe(false);
    expect(inSwipeEdgeZone('right', 200, 400, rightPanel)).toBe(false);
  });

  it('左抽屉命中的是面板右缘带', () => {
    const leftPanel = { left: 0, top: 0, right: 320, bottom: 844 };
    expect(inSwipeEdgeZone('left', 320, 400, leftPanel)).toBe(true);
    expect(inSwipeEdgeZone('left', 320 - DEFAULT_EDGE_ZONE, 400, leftPanel)).toBe(true);
    expect(inSwipeEdgeZone('left', 320 - DEFAULT_EDGE_ZONE - 1, 400, leftPanel)).toBe(false);
  });

  it('top/bottom 抽屉按上下缘判定', () => {
    const topPanel = { left: 0, top: 0, right: 390, bottom: 320 };
    expect(inSwipeEdgeZone('top', 200, 320, topPanel)).toBe(true);
    expect(inSwipeEdgeZone('top', 200, 320 - DEFAULT_EDGE_ZONE, topPanel)).toBe(true);
    expect(inSwipeEdgeZone('top', 200, 320 - DEFAULT_EDGE_ZONE - 1, topPanel)).toBe(false);
    const bottomPanel = { left: 0, top: 524, right: 390, bottom: 844 };
    expect(inSwipeEdgeZone('bottom', 200, 524, bottomPanel)).toBe(true);
    expect(inSwipeEdgeZone('bottom', 200, 524 + DEFAULT_EDGE_ZONE, bottomPanel)).toBe(true);
    expect(inSwipeEdgeZone('bottom', 200, 524 + DEFAULT_EDGE_ZONE + 1, bottomPanel)).toBe(false);
  });

  it('zone<=0 时整体不命中（等价于关闭该手势）', () => {
    expect(inSwipeEdgeZone('right', 70, 400, rightPanel, 0)).toBe(false);
  });
});

describe('detectDrawerSwipe', () => {
  it('关闭向位移超 slop 且压过纵向 → 确认', () => {
    expect(detectDrawerSwipe('right', false, 14, 4)).toBe('drag');
    expect(detectDrawerSwipe('left', false, -14, -4)).toBe('drag');
    expect(detectDrawerSwipe('bottom', false, 3, 14)).toBe('drag');
    expect(detectDrawerSwipe('top', false, 3, -14)).toBe('drag');
  });

  it('纵向位移占优 → 不确认（交回 body 原生滚动）', () => {
    expect(detectDrawerSwipe('right', false, 12, 20)).toBe('none');
    expect(detectDrawerSwipe('bottom', false, 20, 12)).toBe('none');
  });

  it('位移未达 slop → 不确认', () => {
    expect(detectDrawerSwipe('right', false, 8, 0)).toBe('none');
  });

  it('反向（朝打开方向）位移 → 不确认（面板已全开，无可跟随空间）', () => {
    expect(detectDrawerSwipe('right', false, -40, 0)).toBe('none');
    expect(detectDrawerSwipe('bottom', false, 0, -40)).toBe('none');
  });

  it('一旦确认则保持（手势中途不回退，含纵向大幅漂移）', () => {
    expect(detectDrawerSwipe('right', true, 0, 300)).toBe('drag');
    expect(detectDrawerSwipe('right', true, -100, 0)).toBe('drag');
  });

  it('自定义 slop/ratio 生效', () => {
    expect(detectDrawerSwipe('right', false, 6, 0, { slop: 5 })).toBe('drag');
    expect(detectDrawerSwipe('right', false, 11, 10, { slop: 5, ratio: 1.2 })).toBe('none');
  });
});

describe('clampDrawerOffset', () => {
  it('区间内原样返回', () => {
    expect(clampDrawerOffset(120, 320)).toBe(120);
  });

  it('反向越界收至 0', () => {
    expect(clampDrawerOffset(-80, 320)).toBe(0);
  });

  it('越过全关位按阻抗衰减跟随（0.3），不会拖飞', () => {
    // 超出 100px → 只跟随 30px
    expect(clampDrawerOffset(420, 320)).toBeCloseTo(350, 5);
  });

  it('size 非法（<=0）时归零', () => {
    expect(clampDrawerOffset(100, 0)).toBe(0);
  });
});

describe('updateDrawerSwipeVelocity', () => {
  it('相邻采样间隔内按位移/时间算速度', () => {
    const r = updateDrawerSwipeVelocity({ offset: 40, t: 1000 }, 90, 1030);
    expect(r.velocity).toBeCloseTo(50 / 30, 5);
    expect(r.sample).toEqual({ offset: 90, t: 1030 });
  });

  it('间隔超过 maxGapMs 视为停顿，速度清零', () => {
    const r = updateDrawerSwipeVelocity({ offset: 40, t: 1000 }, 200, 1200);
    expect(r.velocity).toBe(0);
  });

  it('首个采样（无 prev）速度为 0', () => {
    const r = updateDrawerSwipeVelocity(null, 10, 1000);
    expect(r.velocity).toBe(0);
    expect(r.sample).toEqual({ offset: 10, t: 1000 });
  });
});

describe('shouldCloseDrawer', () => {
  it('拖过距离阈值（0.35）判关闭', () => {
    expect(shouldCloseDrawer(120, 320, 0)).toBe(true); // 120 > 320*0.35=112
    expect(shouldCloseDrawer(112, 320, 0)).toBe(true); // 恰好等于阈值（含边界）
  });

  it('未过距离阈值且速度不足 → 回弹', () => {
    expect(shouldCloseDrawer(80, 320, 0.2)).toBe(false);
  });

  it('未过距离阈值但甩动够快且拖动量过下限 → 关闭（跟手）', () => {
    expect(shouldCloseDrawer(60, 320, 0.8)).toBe(true);
  });

  it('甩动快但拖动量过小 → 仍回弹（防指尖抖动）', () => {
    expect(shouldCloseDrawer(10, 320, 2)).toBe(false);
  });

  it('size 非法（<=0）时不关闭', () => {
    expect(shouldCloseDrawer(999, 0, 5)).toBe(false);
  });

  it('自定义阈值/甩动参数生效', () => {
    expect(shouldCloseDrawer(100, 400, 0, { threshold: 0.3 })).toBe(false); // 100 < 120
    expect(shouldCloseDrawer(120, 400, 0, { threshold: 0.3 })).toBe(true);
    expect(shouldCloseDrawer(30, 400, 0.4, { flickVelocity: 0.3, minFlickOffset: 20 })).toBe(true);
  });
});

describe('drawerSwipeProgress', () => {
  it('正常区间内等比', () => {
    expect(drawerSwipeProgress(80, 320)).toBeCloseTo(0.25, 5);
  });

  it('越过全关位截到 1（遮罩透明度不出现负值）', () => {
    expect(drawerSwipeProgress(500, 320)).toBe(1);
  });

  it('size 非法时为 0', () => {
    expect(drawerSwipeProgress(50, 0)).toBe(0);
  });
});

describe('drawerDragTransform', () => {
  it('按方位映射到对应轴的平移，符号即关闭方向', () => {
    expect(drawerDragTransform('right', 100)).toBe('translateX(100px)');
    expect(drawerDragTransform('left', 100)).toBe('translateX(-100px)');
    expect(drawerDragTransform('bottom', 100)).toBe('translateY(100px)');
    expect(drawerDragTransform('top', 100)).toBe('translateY(-100px)');
  });

  it('offset=0 返回空串（清除内联值）', () => {
    expect(drawerDragTransform('right', 0)).toBe('');
  });
});
