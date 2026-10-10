"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPlugins = getPlugins;
exports.setPluginsForTest = setPluginsForTest;
exports.registerPlugins = registerPlugins;
/**
 * Capacitor 插件注册中心
 *
 * 集中注册所有原生插件，便于：
 * - 统一管理插件生命周期
 * - 测试时注入 mock
 * - 避免多处重复 import
 */
const core_1 = require("@capacitor/core");
const app_1 = require("@capacitor/app");
const preferences_1 = require("@capacitor/preferences");
const push_notifications_1 = require("@capacitor/push-notifications");
const filesystem_1 = require("@capacitor/filesystem");
const camera_1 = require("@capacitor/camera");
let registry = null;
/**
 * 获取插件注册表（单例）。
 * 在 web 预览模式下 Capacitor 插件不可用，需由调用方判 isNative。
 */
function getPlugins() {
    if (registry)
        return registry;
    const isNative = core_1.Capacitor.isNativePlatform();
    registry = {
        app: app_1.App,
        preferences: preferences_1.Preferences,
        pushNotifications: push_notifications_1.PushNotifications,
        filesystem: filesystem_1.Filesystem,
        camera: camera_1.Camera,
        isNative
    };
    return registry;
}
/**
 * 仅供测试：注入 mock 插件注册表（传 null 复位为真实单例）。
 * 落实 mobile/README 所称「Plugins follow interface + default impl pattern for
 * testability」——无此缝时 controller 内部硬取单例，mock 注入无从谈起。
 */
function setPluginsForTest(override) {
    if (override === null) {
        registry = null;
        return;
    }
    registry = { ...getPlugins(), ...override };
}
/**
 * 注册所有插件监听器（启动时调用一次）。
 * 包括：推送通知权限、Deep Link 拦截。
 */
function registerPlugins() {
    const plugins = getPlugins();
    if (!plugins.isNative)
        return;
    // 推送通知注册
    void plugins.pushNotifications.requestPermissions().then((result) => {
        if (result.receive === 'granted') {
            void plugins.pushNotifications.register();
        }
    });
    // Deep Link 拦截：把 piagent://path 转成内部路由事件
    plugins.app.addListener('appUrlOpen', (data) => {
        const url = new URL(data.url);
        const path = url.pathname + url.search;
        window.dispatchEvent(new CustomEvent('ah:deeplink', { detail: { path, raw: data.url } }));
    });
}
