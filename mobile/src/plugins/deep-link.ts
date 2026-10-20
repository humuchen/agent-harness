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
  /** 监听 Deep Link 跳转；返回取消函数（与 onNetworkChange 风格一致，防监听器叠加泄漏）。 */
  onDeepLink(handler: (route: DeepLinkRoute) => void): () => void;
  /** 获取启动时的 Deep Link（冷启动场景） */
  getInitialUrl(): Promise<string | null>;
}

export const deepLinkController: DeepLinkController = {
  onDeepLink(handler) {
    // P1 泄漏修复：此前不返回取消函数，重复调用会叠加 handler（同一回调触发多次）。
    const listener = ((e: CustomEvent<DeepLinkRoute>) => {
      handler(e.detail);
    }) as EventListener;
    window.addEventListener('ah:deeplink', listener);
    return () => window.removeEventListener('ah:deeplink', listener);
  },
  async getInitialUrl() {
    const { app, isNative } = getPlugins();
    if (!isNative) return null;
    const result = await (app as any).getInitialUrl?.();
    return result?.url ?? null;
  }
};
