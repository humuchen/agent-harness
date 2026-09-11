/**
 * 离线缓存策略封装
 *
 * 移动端弱网场景下提供「只读」视图：
 * - 通过 @capacitor/preferences 缓存最近一次成功拉取的 server state
 * - 网络不可用时回退到缓存数据
 *
 * 注意：Service Worker 在 iOS WKWebView 中行为受限，
 * 当前以 Preferences 轻量缓存为主，后续可升级。
 */
import { getPlugins } from '../bridge/register-plugins';

const CACHE_KEY_PREFIX = 'ah:cache:';

export interface OfflineCacheController {
  /** 缓存数据 */
  set<T>(key: string, data: T): Promise<void>;
  /** 读取缓存 */
  get<T>(key: string): Promise<T | null>;
  /** 清除所有缓存 */
  clear(): Promise<void>;
}

export const offlineCacheController: OfflineCacheController = {
  async set<T>(key: string, data: T) {
    const { preferences } = getPlugins();
    await preferences.set({
      key: `${CACHE_KEY_PREFIX}${key}`,
      value: JSON.stringify(data)
    });
  },
  async get<T>(key: string): Promise<T | null> {
    const { preferences } = getPlugins();
    const result = await preferences.get({ key: `${CACHE_KEY_PREFIX}${key}` });
    if (!result.value) return null;
    try {
      return JSON.parse(result.value) as T;
    } catch {
      return null;
    }
  },
  async clear() {
    const { preferences } = getPlugins();
    await preferences.clear();
  }
};
