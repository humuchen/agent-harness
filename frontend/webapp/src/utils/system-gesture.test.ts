/**
 * 系统手势排除桥接验证：引用计数语义 + 原生通道调用 + 纯 Web 静默降级。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  acquireDrawerGestureExclusion,
  releaseDrawerGestureExclusion,
  drawerGestureExclusionDepth
} from './system-gesture';

/** 记录原生桥调用的假桥。 */
function installFakeBridge(): { enabled: boolean[] } {
  const calls: boolean[] = [];
  (globalThis as unknown as { AhSystemGesture?: unknown }).AhSystemGesture = {
    setDrawerGestureExclusion: (enabled: boolean) => {
      calls.push(enabled);
    }
  };
  return { enabled: calls };
}

function removeFakeBridge(): void {
  delete (globalThis as unknown as { AhSystemGesture?: unknown }).AhSystemGesture;
}

describe('系统手势排除（抽屉打开期）', () => {
  beforeEach(() => {
    // 每个用例从干净计数开始（正常流程计数必然归零，此处防御用例内异常）
    while (drawerGestureExclusionDepth() > 0) releaseDrawerGestureExclusion();
  });

  afterEach(() => {
    removeFakeBridge();
    while (drawerGestureExclusionDepth() > 0) releaseDrawerGestureExclusion();
  });

  it('首个打开才下发原生 true（引用计数）', () => {
    const bridge = installFakeBridge();
    acquireDrawerGestureExclusion();
    expect(bridge.enabled).toEqual([true]);
  });

  it('多个抽屉叠开只下发一次；全部关闭才解除', () => {
    const bridge = installFakeBridge();
    acquireDrawerGestureExclusion();
    acquireDrawerGestureExclusion();
    acquireDrawerGestureExclusion();
    expect(bridge.enabled).toEqual([true]);

    releaseDrawerGestureExclusion();
    releaseDrawerGestureExclusion();
    expect(bridge.enabled).toEqual([true]); // 仍有抽屉开着，不解除

    releaseDrawerGestureExclusion();
    expect(bridge.enabled).toEqual([true, false]); // 全部关闭才解除
  });

  it('释放次数多于申请时不再重复下发（防御性 no-op）', () => {
    const bridge = installFakeBridge();
    releaseDrawerGestureExclusion();
    releaseDrawerGestureExclusion();
    expect(bridge.enabled).toEqual([]);
    expect(drawerGestureExclusionDepth()).toBe(0);
  });

  it('纯 Web（无原生桥）：全部静默，不抛错', () => {
    expect(() => {
      acquireDrawerGestureExclusion();
      acquireDrawerGestureExclusion();
      releaseDrawerGestureExclusion();
      releaseDrawerGestureExclusion();
    }).not.toThrow();
    expect(drawerGestureExclusionDepth()).toBe(0);
  });

  it('原生桥方法抛错时静默降级，不阻断抽屉交互', () => {
    (globalThis as unknown as { AhSystemGesture?: unknown }).AhSystemGesture = {
      setDrawerGestureExclusion: () => {
        throw new Error('bridge down');
      }
    };
    expect(() => {
      acquireDrawerGestureExclusion();
      releaseDrawerGestureExclusion();
    }).not.toThrow();
  });

  it('原生桥存在但缺方法（老壳）时静默跳过', () => {
    (globalThis as unknown as { AhSystemGesture?: unknown }).AhSystemGesture = {};
    expect(() => {
      acquireDrawerGestureExclusion();
      releaseDrawerGestureExclusion();
    }).not.toThrow();
  });
});
