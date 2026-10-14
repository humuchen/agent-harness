/**
 * utils/haptics 单测：触感反馈的三级降级（原生 Haptics → Web Vibration API → no-op）
 * 与用户开关（ah:haptics:enabled，与 mobile 侧同键）。
 *
 * 覆盖：
 * - 原生壳：impact/notification/selection 映射到 window.Capacitor.Plugins.Haptics
 * - 开关关闭（原生 Preferences / 纯 Web localStorage）后全部静默 no-op
 * - 纯 Web 降级 navigator.vibrate 的 pattern；无 Vibration API 时静默不抛错
 * - 桥调用 reject 时 fail-safe（绝不向上抛）
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

/** enabledCache 是模块级状态：每个用例经 resetModules + 动态 import 取全新实例。 */
async function freshHaptics() {
  vi.resetModules();
  return import('./haptics');
}

/**
 * 触感发放入口是 fire-and-forget 的异步链（读偏好 → 桥调用 → 降级），
 * 断言前需把微任务/定时器冲刷完，否则 spy 尚未被调用。
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeHapticsSpy() {
  return {
    impact: vi.fn().mockResolvedValue(undefined),
    notification: vi.fn().mockResolvedValue(undefined),
    selectionChanged: vi.fn().mockResolvedValue(undefined),
    vibrate: vi.fn().mockResolvedValue(undefined)
  };
}

/** 注入假的 Capacitor 全局（项目约定：webapp 经 window.Capacitor.Plugins 取插件）。 */
function fakeNative(
  haptics: ReturnType<typeof makeHapticsSpy>,
  prefsStore = new Map<string, string>()
) {
  const prefs = {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: prefsStore.get(key) ?? null
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      prefsStore.set(key, value);
    })
  };
  (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: { Haptics: haptics, Preferences: prefs }
  };
  return { prefs, prefsStore };
}

/** 给 jsdom 的 navigator 装上假的 Vibration API。 */
function setWebVibrate(spy: (p: number | number[]) => boolean): void {
  Object.defineProperty(navigator, 'vibrate', {
    value: spy,
    configurable: true,
    writable: true
  });
}

afterEach(() => {
  delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor;
  try {
    localStorage.removeItem('ah:haptics:enabled');
  } catch {
    /* jsdom 不可用时忽略 */
  }
  try {
    delete (navigator as unknown as { vibrate?: unknown }).vibrate;
  } catch {
    /* 未安装时忽略 */
  }
});

describe('utils/haptics：原生壳（Capacitor Haptics）', () => {
  it('hapticTap 默认轻震，映射 impact(LIGHT)；可指定档位', async () => {
    const spy = makeHapticsSpy();
    fakeNative(spy);
    const { hapticTap } = await freshHaptics();
    hapticTap();
    hapticTap('heavy');
    hapticTap('medium');
    await flush();
    expect(spy.impact).toHaveBeenCalledWith({ style: 'LIGHT' });
    expect(spy.impact).toHaveBeenLastCalledWith({ style: 'MEDIUM' });
    expect(spy.impact).toHaveBeenCalledTimes(3);
  });

  it('hapticSuccess/Warning/Error 映射 notification 三档', async () => {
    const spy = makeHapticsSpy();
    fakeNative(spy);
    const { hapticSuccess, hapticWarning, hapticError } = await freshHaptics();
    hapticSuccess();
    hapticWarning();
    hapticError();
    await flush();
    expect(spy.notification).toHaveBeenCalledWith({ type: 'SUCCESS' });
    expect(spy.notification).toHaveBeenLastCalledWith({ type: 'ERROR' });
    expect(spy.notification).toHaveBeenCalledTimes(3);
  });

  it('hapticSelection 映射 selectionChanged', async () => {
    const spy = makeHapticsSpy();
    fakeNative(spy);
    const { hapticSelection } = await freshHaptics();
    hapticSelection();
    await flush();
    expect(spy.selectionChanged).toHaveBeenCalledTimes(1);
  });

  it('开关关闭（Preferences ah:haptics:enabled=false）后全部静默', async () => {
    const spy = makeHapticsSpy();
    const store = new Map([['ah:haptics:enabled', 'false']]);
    fakeNative(spy, store);
    const h = await freshHaptics();
    await h.initHaptics();
    expect(h.isHapticsEnabled()).toBe(false);
    h.hapticTap();
    h.hapticSuccess();
    h.hapticError();
    h.hapticSelection();
    expect(spy.impact).not.toHaveBeenCalled();
    expect(spy.notification).not.toHaveBeenCalled();
    expect(spy.selectionChanged).not.toHaveBeenCalled();
  });

  it('setHapticsEnabled 持久化并即时生效（关→静默，开→恢复）', async () => {
    const spy = makeHapticsSpy();
    const { prefs, prefsStore } = fakeNative(spy);
    const h = await freshHaptics();
    await h.setHapticsEnabled(false);
    expect(prefsStore.get('ah:haptics:enabled')).toBe('false');
    expect(h.isHapticsEnabled()).toBe(false);
    h.hapticTap();
    expect(spy.impact).not.toHaveBeenCalled();
    await h.setHapticsEnabled(true);
    h.hapticTap();
    await flush();
    expect(spy.impact).toHaveBeenCalledWith({ style: 'LIGHT' });
    // 写入口走原生 Preferences 桥（与 mobile 封装同源）
    expect(prefs.set).toHaveBeenCalledWith({ key: 'ah:haptics:enabled', value: 'true' });
  });

  it('默认开启：未写过偏好时 isHapticsEnabled 为 true', async () => {
    fakeNative(makeHapticsSpy());
    const h = await freshHaptics();
    await h.initHaptics();
    expect(h.isHapticsEnabled()).toBe(true);
  });

  it('桥调用 reject 时 fail-safe，不向上抛', async () => {
    const broken = {
      impact: vi.fn().mockRejectedValue(new Error('bridge down')),
      notification: vi.fn().mockRejectedValue(new Error('bridge down')),
      selectionChanged: vi.fn().mockRejectedValue(new Error('bridge down')),
      vibrate: vi.fn().mockRejectedValue(new Error('bridge down'))
    };
    fakeNative(broken);
    const h = await freshHaptics();
    expect(() => h.hapticTap()).not.toThrow();
    expect(() => h.hapticSuccess()).not.toThrow();
    expect(() => h.hapticSelection()).not.toThrow();
  });
});

describe('utils/haptics：纯 Web 降级（navigator.vibrate）', () => {
  it('无 Capacitor 全局时走 Vibration API，pattern 与档位对齐', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    const h = await freshHaptics();
    h.hapticTap('light');
    h.hapticTap('medium');
    h.hapticSuccess();
    h.hapticWarning();
    h.hapticError();
    h.hapticSelection();
    await flush();
    expect(vibrate).toHaveBeenNthCalledWith(1, 10);
    expect(vibrate).toHaveBeenNthCalledWith(2, 20);
    expect(vibrate).toHaveBeenNthCalledWith(3, 15);
    expect(vibrate).toHaveBeenNthCalledWith(4, [10, 40, 10]);
    expect(vibrate).toHaveBeenNthCalledWith(5, [25, 50, 25, 50, 25]);
    expect(vibrate).toHaveBeenNthCalledWith(6, 8);
    expect(vibrate).toHaveBeenCalledTimes(6);
  });

  it('localStorage 关闭后 Web 降级同样静默', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    localStorage.setItem('ah:haptics:enabled', 'false');
    const h = await freshHaptics();
    await h.initHaptics();
    expect(h.isHapticsEnabled()).toBe(false);
    h.hapticTap();
    h.hapticError();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('setHapticsEnabled(true) 移除关闭值后恢复（localStorage 通道）', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    const h = await freshHaptics();
    await h.setHapticsEnabled(false);
    h.hapticTap();
    expect(vibrate).not.toHaveBeenCalled();
    await h.setHapticsEnabled(true);
    expect(localStorage.getItem('ah:haptics:enabled')).toBe('true');
    h.hapticTap();
    await flush();
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it('无 Vibration API（iOS Safari / 桌面）静默 no-op，且判定为不可用', async () => {
    const h = await freshHaptics();
    expect(h.hapticsAvailable()).toBe(false);
    expect(() => h.hapticTap()).not.toThrow();
    expect(() => h.hapticError()).not.toThrow();
  });
});
