"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deepLinkController = void 0;
/**
 * Deep Link 路由插件封装
 *
 * 把 piagent://chat/:sessionId 或 piagent://plan/:planId 转成内部路由事件，
 * webapp 侧通过 window.addEventListener('ah:deeplink') 消费。
 */
const register_plugins_1 = require("../bridge/register-plugins");
exports.deepLinkController = {
    onDeepLink(handler) {
        // P1 泄漏修复：此前不返回取消函数，重复调用会叠加 handler（同一回调触发多次）。
        const listener = ((e) => {
            handler(e.detail);
        });
        window.addEventListener('ah:deeplink', listener);
        return () => window.removeEventListener('ah:deeplink', listener);
    },
    async getInitialUrl() {
        const { app, isNative } = (0, register_plugins_1.getPlugins)();
        if (!isNative)
            return null;
        const result = await app.getInitialUrl?.();
        return result?.url ?? null;
    }
};
