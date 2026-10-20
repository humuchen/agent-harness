"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushNotificationController = void 0;
/**
 * 推送通知插件封装（接口 + 默认实现）
 *
 * 对接 server 端 P1-2 审计事件 / IM 回调（P0-2），
 * 移动端仅做 FCM/APNs 投递层，事件源在 server 侧。
 */
const register_plugins_1 = require("../bridge/register-plugins");
/**
 * 默认实现：通过 Capacitor PushNotifications 插件注册设备。
 * 测试时可注入 mock。
 */
exports.pushNotificationController = {
    async register() {
        const { pushNotifications, isNative } = (0, register_plugins_1.getPlugins)();
        if (!isNative)
            return;
        const perm = await pushNotifications.requestPermissions();
        if (perm.receive === 'granted') {
            await pushNotifications.register();
        }
    },
    onNotification(handler) {
        const { pushNotifications, isNative } = (0, register_plugins_1.getPlugins)();
        if (!isNative)
            return;
        pushNotifications.addListener('pushNotificationReceived', handler);
    }
};
