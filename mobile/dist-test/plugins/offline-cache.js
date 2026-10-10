"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.offlineCacheController = void 0;
/**
 * 离线缓存策略封装
 *
 * 移动端弱网场景下提供「只读」视图：
 * - 通过 @capacitor/preferences 缓存最近一次成功拉取的数据
 * - 网络不可用时回退到缓存数据
 * - 缓存带 TTL，过期后自动标记为 stale
 * - 通过 @capacitor/network 监听网络状态变化
 *
 * 注意：Service Worker 在 iOS WKWebView 中行为受限，
 * 当前以 Preferences 轻量缓存为主，后续可升级。
 */
const register_plugins_1 = require("../bridge/register-plugins");
const network_1 = require("@capacitor/network");
const CACHE_KEY_PREFIX = 'ah:cache:';
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 分钟
exports.offlineCacheController = {
    async set(key, data, ttlMs = DEFAULT_TTL_MS) {
        const { preferences } = (0, register_plugins_1.getPlugins)();
        const entry = {
            data,
            cachedAt: Date.now(),
            ttlMs
        };
        await preferences.set({
            key: `${CACHE_KEY_PREFIX}${key}`,
            value: JSON.stringify(entry)
        });
    },
    async get(key) {
        const { preferences } = (0, register_plugins_1.getPlugins)();
        const result = await preferences.get({ key: `${CACHE_KEY_PREFIX}${key}` });
        if (!result.value)
            return null;
        try {
            const entry = JSON.parse(result.value);
            const age = Date.now() - entry.cachedAt;
            if (age > entry.ttlMs)
                return null; // 过期
            return entry.data;
        }
        catch {
            return null;
        }
    },
    async getWithMeta(key) {
        const { preferences } = (0, register_plugins_1.getPlugins)();
        const result = await preferences.get({ key: `${CACHE_KEY_PREFIX}${key}` });
        if (!result.value)
            return null;
        try {
            const entry = JSON.parse(result.value);
            const age = Date.now() - entry.cachedAt;
            return {
                data: entry.data,
                stale: age > entry.ttlMs
            };
        }
        catch {
            return null;
        }
    },
    async clear() {
        const { preferences } = (0, register_plugins_1.getPlugins)();
        await preferences.clear();
    },
    async isOnline() {
        const status = await network_1.Network.getStatus();
        return status.connected;
    },
    async onNetworkChange(handler) {
        const handle = await network_1.Network.addListener('networkStatusChange', (status) => {
            handler(status.connected);
        });
        return () => {
            void handle.remove();
        };
    }
};
