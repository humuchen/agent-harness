/**
 * Deep Link 路由插件封装
 *
 * 把 piagent://chat/:sessionId 或 piagent://plan/:planId 转成内部路由事件，
 * webapp 侧通过 window.addEventListener('ah:deeplink') 消费。
 */
import { getPlugins } from '../bridge/register-plugins';

export interface DeepLinkRoute {
  path: string;
  raw: string;
}

export interface DeepLinkController {
  /** 监听 Deep Link 跳转 */
  onDeepLink(handler: (route: DeepLinkRoute) => void): void;
  /** 获取启动时的 Deep Link（冷启动场景） */
  getInitialUrl(): Promise<string | null>;
}

export const deepLinkController: DeepLinkController = {
  onDeepLink(handler) {
    window.addEventListener('ah:deeplink', ((e: CustomEvent<DeepLinkRoute>) => {
      handler(e.detail);
    }) as EventListener);
  },
  async getInitialUrl() {
    const { app, isNative } = getPlugins();
    if (!isNative) return null;
    const result = await (app as any).getInitialUrl?.();
    return result?.url ?? null;
  }
};
