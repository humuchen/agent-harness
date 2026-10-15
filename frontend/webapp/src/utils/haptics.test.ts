/**
 * utils/haptics 单测：触感反馈的三级降级（原生 Haptics → Web Vibration API → no-op）、
 * 用户开关（ah:haptics:enabled，与 mobile 侧同键）、以及全局委托监听
 * （全站按钮类点击统一补轻震；语义调用优先不重复；节流防抖）。
 *
 * 覆盖：
 * - 原生壳：impact/notification/selection 映射到 window.Capacitor.Plugins.Haptics
 * - 开关关闭（原生 Preferences / 纯 Web localStorage）后全部静默
 * - 纯 Web 降级 navigator.vibrate 的 pattern；无 Vibration API 时静默不抛错
 * - 桥调用 reject 时 fail-safe（绝不向上抛）
 * - 全局委托：button/语义角色/data-haptic/Shadow DOM 按钮命中；文本输入与
 *   普通 div 不命中；语义触感已触发时跳过；stopPropagation 不漏（捕获阶段）；
 *   40ms 节流；install/uninstall 幂等
 */
import { describe, it, expect, afterEach, onTestFinished, vi } from 'vitest';

/** enabledCache / lastHapticAt 是模块级状态：每个用例经 resetModules + 动态 import 取全新实例。 */
async function freshHaptics() {
  vi.resetModules();
  return import('./haptics');
}

/**
 * 触感发放入口是 fire-and-forget 的异步链（读偏好 → 桥调用 → 降级），
 * 且全局委托监听内部用 setTimeout(0) 延迟触发；等待 50ms 同时跨过
 * 40ms 节流窗口，保证断言前所有链路已冲刷完。
 */
function flush(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** 在 body 下创建一个元素并派发冒泡 click（默认 composed，模拟真实点击路径）。 */
function click(el: Element): void {
  el.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
  );
}

/**
 * 安装委托监听并保证用例结束（含断言失败）时一定卸载——
 * 否则泄漏的监听会带着旧模块实例的状态污染后续用例。
 */
function withDelegated(h: Awaited<ReturnType<typeof freshHaptics>>): void {
  h.installHaptics();
  onTestFinished(() => h.uninstallHaptics());
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
  document.body.innerHTML = '';
});

describe('utils/haptics：原生壳（Capacitor Haptics）', () => {
  it('hapticTap 默认轻震，映射 impact(LIGHT)；可指定档位', async () => {
    const spy = makeHapticsSpy();
    fakeNative(spy);
    const { hapticTap } = await freshHaptics();
    hapticTap();
    await flush();
    expect(spy.impact).toHaveBeenCalledWith({ style: 'LIGHT' });
    hapticTap('heavy');
    await flush();
    expect(spy.impact).toHaveBeenLastCalledWith({ style: 'HEAVY' });
    hapticTap('medium');
    await flush();
    expect(spy.impact).toHaveBeenLastCalledWith({ style: 'MEDIUM' });
    expect(spy.impact).toHaveBeenCalledTimes(3);
  });

  it('hapticSuccess/Warning/Error 映射 notification 三档', async () => {
    const spy = makeHapticsSpy();
    fakeNative(spy);
    const { hapticSuccess, hapticWarning, hapticError } = await freshHaptics();
    hapticSuccess();
    await flush();
    expect(spy.notification).toHaveBeenCalledWith({ type: 'SUCCESS' });
    hapticWarning();
    await flush();
    expect(spy.notification).toHaveBeenLastCalledWith({ type: 'WARNING' });
    hapticError();
    await flush();
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
    await flush();
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
    await flush();
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
    await flush();
  });
});

describe('utils/haptics：纯 Web 降级（navigator.vibrate）', () => {
  it('无 Capacitor 全局时走 Vibration API，pattern 与档位对齐', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    const h = await freshHaptics();
    // 逐调用 flush(50)：跨过 40ms 节流窗口，验证每个档位的 pattern 映射
    h.hapticTap('light');
    await flush();
    expect(vibrate).toHaveBeenLastCalledWith(10);
    h.hapticTap('medium');
    await flush();
    expect(vibrate).toHaveBeenLastCalledWith(20);
    h.hapticSuccess();
    await flush();
    expect(vibrate).toHaveBeenLastCalledWith(15);
    h.hapticWarning();
    await flush();
    expect(vibrate).toHaveBeenLastCalledWith([10, 40, 10]);
    h.hapticError();
    await flush();
    expect(vibrate).toHaveBeenLastCalledWith([25, 50, 25, 50, 25]);
    h.hapticSelection();
    await flush();
    expect(vibrate).toHaveBeenLastCalledWith(8);
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
    await flush();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('setHapticsEnabled(true) 恢复（localStorage 通道）', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    const h = await freshHaptics();
    await h.setHapticsEnabled(false);
    h.hapticTap();
    await flush();
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
    await flush();
  });
});

describe('utils/haptics：全局委托监听（全站按钮类点击）', () => {
  it('button / 按钮内 span / role=switch / data-haptic 命中，普通 div 与文本输入不命中', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    const h = await freshHaptics();
    withDelegated(h);

    const btn = document.createElement('button');
    const span = document.createElement('span');
    btn.appendChild(span);
    const sw = document.createElement('div');
    sw.setAttribute('role', 'switch');
    const marked = document.createElement('div');
    marked.setAttribute('data-haptic', '');
    const plain = document.createElement('div');
    const ta = document.createElement('textarea');
    const input = document.createElement('input');
    input.type = 'text';
    document.body.append(btn, sw, marked, plain, ta, input);

    click(span); // 点在按钮内的 span 上 → 命中按钮
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenLastCalledWith(10); // 通用轻震

    click(sw);
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(2);

    click(marked);
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(3);

    click(plain); // 普通 div：不命中
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(3);

    click(ta); // 文本输入：点击聚焦不振动
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(3);

    click(input);
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(3);
  });

  it('Shadow DOM 内的按钮（外部库 mac-confirm 等）也能命中（composedPath）', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    const h = await freshHaptics();
    withDelegated(h);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const innerBtn = document.createElement('button');
    shadow.appendChild(innerBtn);

    click(innerBtn);
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('处理器已触发语义触感时，同一点击不再补通用轻震（一次点击一次振动）', async () => {
    const spy = makeHapticsSpy();
    fakeNative(spy);
    const h = await freshHaptics();
    withDelegated(h);

    // 模拟 setTab：按钮自己的处理器先跑（冒泡阶段早于 document 捕获监听之后
    // 的延迟判定），同步打戳；委托监听的 setTimeout(0) 随后看到新鲜时间戳 → 跳过。
    const btn = document.createElement('button');
    btn.addEventListener('click', () => h.hapticSelection());
    document.body.appendChild(btn);

    click(btn);
    await flush();
    expect(spy.selectionChanged).toHaveBeenCalledTimes(1);
    expect(spy.impact).not.toHaveBeenCalled();
  });

  it('处理器 stopPropagation 不漏振（捕获阶段监听先于一切处理器）', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    const h = await freshHaptics();
    withDelegated(h);

    const btn = document.createElement('button');
    btn.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(btn);

    click(btn);
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('连续快速点击按 40ms 节流，不会叠振', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    const h = await freshHaptics();
    withDelegated(h);

    const btn = document.createElement('button');
    document.body.appendChild(btn);
    click(btn);
    click(btn);
    click(btn);
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('间隔充足的连续点击各自触发（节流只压 40ms 内的）', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    const h = await freshHaptics();
    withDelegated(h);

    const btn = document.createElement('button');
    document.body.appendChild(btn);
    click(btn);
    await flush();
    click(btn);
    await flush();
    click(btn);
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(3);
  });

  it('开关关闭时委托监听同样静默；开启后恢复', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    const h = await freshHaptics();
    withDelegated(h);
    await h.setHapticsEnabled(false);

    const btn = document.createElement('button');
    document.body.appendChild(btn);
    click(btn);
    await flush();
    expect(vibrate).not.toHaveBeenCalled();

    await h.setHapticsEnabled(true);
    click(btn);
    await flush();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('install/uninstall 幂等：卸载后不再触发', async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setWebVibrate(vibrate);
    const h = await freshHaptics();
    h.installHaptics();
    h.installHaptics(); // 幂等
    onTestFinished(() => h.uninstallHaptics());

    const btn = document.createElement('button');
    document.body.appendChild(btn);
    h.uninstallHaptics();
    click(btn);
    await flush();
    expect(vibrate).not.toHaveBeenCalled();
  });
});
