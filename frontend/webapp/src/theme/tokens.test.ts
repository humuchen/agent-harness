/**
 * theme/tokens 单测：原生状态栏随主题同步。
 * 背景：capacitor.config.ts 的 StatusBar 只有一份启动默认值（深色主题的 LIGHT 图标），
 * 切白色主题后若不同步，状态栏就是「白字白底」——原生头部信息看不见（用户实测反馈）。
 * 同步逻辑在 setTheme（唯一直接写入点）；「跟随系统」分支绕过 setTheme，
 * 自行调用导出的 syncNativeStatusBar，本文件一并覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setTheme, syncNativeStatusBar, withThemeAnimation, type Theme } from './tokens';

type StyleSpy = ReturnType<typeof vi.fn>;

/** 注入假的 Capacitor 全局（项目约定：webapp 经 window.Capacitor.Plugins 取插件）。 */
function fakeNative(): { spy: StyleSpy; remove: () => void } {
  const spy = vi.fn().mockResolvedValue(undefined);
  (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: { StatusBar: { setStyle: spy } }
  };
  return { spy, remove: () => delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor };
}

describe('theme tokens：原生状态栏同步', () => {
  beforeEach(() => {
    localStorage.removeItem('ah-theme');
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor;
    document.documentElement.removeAttribute('data-theme');
    // 原生用例的幕布靠真实 340ms 定时器摘除，测试进程内可能残留 → 统一清理
    document.querySelectorAll('[data-ah-theme-veil]').forEach((el) => el.remove());
  });

  it('setTheme(dark) → 深色背景浅色图标（Style.DARK，配深色主题）', () => {
    const { spy, remove } = fakeNative();
    try {
      setTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(spy).toHaveBeenCalledWith({ style: 'DARK' });
    } finally {
      remove();
    }
  });

  it('setTheme(light) → 浅色背景深色图标（Style.LIGHT，配浅色主题）', () => {
    const { spy, remove } = fakeNative();
    try {
      setTheme('light');
      expect(spy).toHaveBeenCalledWith({ style: 'LIGHT' });
    } finally {
      remove();
    }
  });

  it('非原生环境（无 Capacitor 全局）静默降级，不抛错', () => {
    expect(() => setTheme('light')).not.toThrow();
    expect(() => syncNativeStatusBar('dark' as Theme)).not.toThrow();
  });

  it('isNativePlatform()=false（纯 Web）不调用桥', () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => false,
      Plugins: { StatusBar: { setStyle: spy } }
    };
    setTheme('dark');
    expect(spy).not.toHaveBeenCalled();
  });

  it('桥调用被 reject 时不向上抛（尽力而为语义）', () => {
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { StatusBar: { setStyle: vi.fn().mockRejectedValue(new Error('bridge')) } }
    };
    expect(() => setTheme('dark')).not.toThrow();
  });
});

/**
 * APP 主题切换闪烁修复（用户实测：仅 APP 上出现，桌面正常）。
 * APP（Capacitor WebView）不走 @property 自定义属性过渡（全文档逐帧重算重绘掉帧 → 闪烁），
 * 改走「瞬时切换 + 旧画布色幕布淡出」。本组验证该路径的行为契约。
 */
describe('theme tokens：APP 原生 WebView 幕布淡出切换', () => {
  beforeEach(() => {
    localStorage.removeItem('ah-theme');
    document.documentElement.removeAttribute('data-theme');
    // 上一组非原生用例的 .ah-theme-anim 由真实 600ms 定时器摘除，测试进程里可能残留
    document.documentElement.classList.remove('ah-theme-anim');
    vi.useFakeTimers({ toFake: ['setTimeout', 'requestAnimationFrame'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor;
    document.documentElement.removeAttribute('data-theme');
    document.querySelectorAll('[data-ah-theme-veil]').forEach((el) => el.remove());
  });

  function fakeNative(): void {
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { StatusBar: { setStyle: vi.fn().mockResolvedValue(undefined) } }
    };
  }

  it('原生环境：切换时挂幕布、不加 .ah-theme-anim 过渡类，data-theme 照常落值', () => {
    fakeNative();
    setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.classList.contains('ah-theme-anim')).toBe(false);
    expect(document.querySelectorAll('[data-ah-theme-veil]').length).toBe(1);
  });

  it('幕布在双 rAF 后开始淡出并最终摘除', () => {
    fakeNative();
    setTheme('light');
    const veil = document.querySelector('[data-ah-theme-veil]') as HTMLElement;
    // 未推进时间线：幕布仍在且不透明
    expect(veil.style.opacity).toBe('1');
    vi.advanceTimersByTime(32); // 触发双 rAF
    expect(veil.style.opacity).toBe('0'); // 开始淡出
    vi.advanceTimersByTime(400); // 淡出完成 + 移除定时器
    expect(document.querySelector('[data-ah-theme-veil]')).toBeNull();
  });

  it('data-theme 未实际变化（幂等落值）→ 幕布立即摘除，不淡出不残留', () => {
    fakeNative();
    document.documentElement.setAttribute('data-theme', 'dark');
    withThemeAnimation(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    expect(document.querySelector('[data-ah-theme-veil]')).toBeNull();
  });

  it('纯 Web 环境仍走 .ah-theme-anim 过渡类路径（桌面体验不变）', () => {
    withThemeAnimation(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });
    expect(document.documentElement.classList.contains('ah-theme-anim')).toBe(true);
    expect(document.querySelectorAll('[data-ah-theme-veil]').length).toBe(0);
    vi.advanceTimersByTime(700);
    expect(document.documentElement.classList.contains('ah-theme-anim')).toBe(false);
  });
});
