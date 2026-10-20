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
        window.addEventListener('ah:deeplink', ((e) => {
            handler(e.detail);
        }));
    },
    async getInitialUrl() {
        const { app, isNative } = (0, register_plugins_1.getPlugins)();
        if (!isNative)
            return null;
        const result = await app.getInitialUrl?.();
        return result?.url ?? null;
    }
};
