/**
 * Service Worker 注册（评审 P2-10：离线 app-shell）。
 *
 * 边界与守卫：
 * - 仅 https / localhost 注册（SW 的浏览器硬性要求；http 内网地址直接跳过）；
 * - 环境不支持（旧 WebView / jsdom 测试环境无 navigator.serviceWorker）→ 返回 null；
 * - 注册失败仅告警不抛错——SW 是纯增强能力，绝不能影响主流程（调用方
 *   fire-and-forget，见 main.ts）。
 * - SW 拦截边界（/api/* 直通等）见 public/sw.js 头注释，两处须同步理解。
 */

export const SW_PATH = '/sw.js';

/** 注册入参的最小位置形状（便于测试注入，不耦合真实 location）。 */
export interface LocationLike {
  protocol: string;
  hostname: string;
}

/**
 * 注册 /sw.js。返回注册句柄；环境不支持、被策略跳过或注册失败时返回 null。
 * @param swApi 可注入的 ServiceWorkerContainer（缺省 navigator.serviceWorker）
 * @param loc   可注入的 location 形状（缺省全局 location，仅取 protocol/hostname）
 */
export async function registerServiceWorker(
  swApi?: ServiceWorkerContainer,
  loc: LocationLike = location
): Promise<ServiceWorkerRegistration | null> {
  // jsdom / 旧 WebView：无该属性（运行时 undefined），直接放弃。
  const sw = swApi ?? (navigator as { serviceWorker?: ServiceWorkerContainer }).serviceWorker;
  if (!sw) return null;
  // SW 仅在安全上下文可用：https，或本机回环（开发/测试）。
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc.hostname);
  if (loc.protocol !== 'https:' && !isLocal) return null;
  try {
    return await sw.register(SW_PATH, { scope: '/' });
  } catch (e) {
    console.warn('[sw] 注册失败（不影响使用）：', e instanceof Error ? e.message : e);
    return null;
  }
}
