/**
 * Capacitor 插件注册中心
 *
 * 集中注册所有原生插件，便于：
 * - 统一管理插件生命周期
 * - 测试时注入 mock
 * - 避免多处重复 import
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { Filesystem } from '@capacitor/filesystem';
import { Camera } from '@capacitor/camera';

export interface PluginRegistry {
  app: typeof App;
  preferences: typeof Preferences;
  pushNotifications: typeof PushNotifications;
  filesystem: typeof Filesystem;
  camera: typeof Camera;
  isNative: boolean;
}

let registry: PluginRegistry | null = null;

/**
 * 获取插件注册表（单例）。
 * 在 web 预览模式下 Capacitor 插件不可用，需由调用方判 isNative。
 */
export function getPlugins(): PluginRegistry {
  if (registry) return registry;
  const isNative = Capacitor.isNativePlatform();
  registry = {
    app: App,
    preferences: Preferences,
    pushNotifications: PushNotifications,
    filesystem: Filesystem,
    camera: Camera,
    isNative
  };
  return registry;
}

/**
 * 注册所有插件监听器（启动时调用一次）。
 * 包括：推送通知权限、Deep Link 拦截。
 */
export function registerPlugins(): void {
  const plugins = getPlugins();

  if (!plugins.isNative) return;

  // 推送通知注册
  void plugins.pushNotifications.requestPermissions().then((result) => {
    if (result.receive === 'granted') {
      void plugins.pushNotifications.register();
    }
  });

  // Deep Link 拦截：把 piagent://path 转成内部路由事件
  plugins.app.addListener('appUrlOpen', (data) => {
    const url = new URL(data.url);
    const path = url.pathname + url.search;
    window.dispatchEvent(
      new CustomEvent('ah:deeplink', { detail: { path, raw: data.url } })
    );
  });
}
