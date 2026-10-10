"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationController = void 0;
/**
 * 本地通知插件封装（Capacitor @capacitor/local-notifications）
 *
 * 替换浏览器 Notification API：
 * - 浏览器 Notification 在 Capacitor WebView 中不可用
 * - Capacitor LocalNotifications 使用原生系统通知
 */
const local_notifications_1 = require("@capacitor/local-notifications");
const register_plugins_1 = require("../bridge/register-plugins");
exports.notificationController = {
    async requestPermission() {
        const { isNative } = (0, register_plugins_1.getPlugins)();
        if (!isNative) {
            // 浏览器环境，使用浏览器 Notification API
            if (typeof Notification === 'undefined')
                return { granted: false };
            const perm = await Notification.requestPermission();
            return { granted: perm === 'granted' };
        }
        try {
            const result = await local_notifications_1.LocalNotifications.requestPermissions();
            return { granted: result.display === 'granted' };
        }
        catch {
            return { granted: false };
        }
    },
    async display(options) {
        const { isNative } = (0, register_plugins_1.getPlugins)();
        if (!isNative) {
            // 浏览器环境
            if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
                return;
            }
            try {
                const n = new Notification(options.title, { body: options.body });
                n.onclick = () => { window.focus(); n.close(); };
            }
            catch { /* ignore */ }
            return;
        }
        // 原生环境
        try {
            await local_notifications_1.LocalNotifications.schedule({
                notifications: [{
                        title: options.title,
                        body: options.body,
                        id: Math.floor(Math.random() * 100000),
                        sound: undefined,
                        smallIcon: 'ic_stat_icon_sample',
                    }]
            });
        }
        catch { /* ignore */ }
    }
};
