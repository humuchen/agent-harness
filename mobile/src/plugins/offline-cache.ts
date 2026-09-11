/**
 * 离线缓存策略封装
 *
 * 移动端弱网场景下提供「只读」视图：
 * - 通过 @capacitor/preferences 缓存最近一次成功拉取的数据
 * - 网络不可用时回退到缓存数据
 * - 缓存带 TTL，过期后自动标记为 stale
 *
 * 注意：Service Worker 在 iOS WKWebView 中行为受限，
 * 当前以 Preferences 轻量缓存为主，后续可升级。
 */
import { getPlugins } from '../bridge/register-plugins';
import { App } from '@capacitor/app';

const CACHE_KEY_PREFIX = 'ah:cache:';
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 分钟

export interface CacheEntry<T> {
  data: T;
  cachedAt: number; // timestamp
  ttlMs: number;
}

export interface OfflineCacheController {
  /** 缓存数据 */
  set<T>(key: string, data: T, ttlMs?: number): Promise<void>;
  /** 读取缓存（过期返回 null） */
  get<T>(key: string): Promise<T | null>;
  /** 读取缓存（含 stale 标记，便于 UI 显示「数据可能不是最新」） */
  getWithMeta<T>(key: string): Promise<{ data: T; stale: boolean } | null>;
  /** 清除所有缓存 */
  clear(): Promise<void>;
  /** 检查网络状态（通过 Capacitor App 插件） */
  isOnline(): Promise<boolean>;
}

export const offlineCacheController: OfflineCacheController = {
  async set<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL_MS) {
    const { preferences } = getPlugins();
    const entry: CacheEntry<T> = {
      data,
      cachedAt: Date.now(),
      ttlMs
    };
    await preferences.set({
      key: `${CACHE_KEY_PREFIX}${key}`,
      value: JSON.stringify(entry)
    });
  },
  async get<T>(key: string): Promise<T | null> {
    const { preferences } = getPlugins();
    const result = await preferences.get({ key: `${CACHE_KEY_PREFIX}${key}` });
    if (!result.value) return null;
    try {
      const entry = JSON.parse(result.value) as CacheEntry<T>;
      const age = Date.now() - entry.cachedAt;
      if (age > entry.ttlMs) return null; // 过期
      return entry.data;
    } catch {
      return null;
    }
  },
  async getWithMeta<T>(key: string): Promise<{ data: T; stale: boolean } | null> {
    const { preferences } = getPlugins();
    const result = await preferences.get({ key: `${CACHE_KEY_PREFIX}${key}` });
    if (!result.value) return null;
    try {
      const entry = JSON.parse(result.value) as CacheEntry<T>;
      const age = Date.now() - entry.cachedAt;
      return {
        data: entry.data,
        stale: age > entry.ttlMs
      };
    } catch {
      return null;
    }
  },
  async clear() {
    const { preferences } = getPlugins();
    await preferences.clear();
  },
  async isOnline() {
    // Capacitor App 插件不直接提供网络状态，这里通过 navigator.onLine
    // 实际项目中可引入 @capacitor/network 插件增强
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return navigator.onLine;
    }
    return true; // 默认在线
  }
};
