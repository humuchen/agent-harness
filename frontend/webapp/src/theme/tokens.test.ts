/**
 * theme/tokens 单测：原生状态栏随主题同步。
 * 背景：capacitor.config.ts 的 StatusBar 只有一份启动默认值（深色主题的 LIGHT 图标），
 * 切白色主题后若不同步，状态栏就是「白字白底」——原生头部信息看不见（用户实测反馈）。
 * 同步逻辑在 setTheme（唯一直接写入点）；「跟随系统」分支绕过 setTheme，
 * 自行调用导出的 syncNativeStatusBar，本文件一并覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setTheme, syncNativeStatusBar, type Theme } from './tokens';

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
  });

  it('setTheme(dark) → 浅色图标（Style.LIGHT，配深色背景）', () => {
    const { spy, remove } = fakeNative();
    try {
      setTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(spy).toHaveBeenCalledWith({ style: 'LIGHT' });
    } finally {
      remove();
    }
  });

  it('setTheme(light) → 深色图标（Style.DARK，配浅色背景）', () => {
    const { spy, remove } = fakeNative();
    try {
      setTheme('light');
      expect(spy).toHaveBeenCalledWith({ style: 'DARK' });
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
