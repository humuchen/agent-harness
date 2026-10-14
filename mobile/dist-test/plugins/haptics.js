"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hapticsController = exports.HAPTICS_ENABLED_KEY = void 0;
/**
 * 触感反馈插件封装（接口 + 默认实现）
 *
 * 对接 Capacitor @capacitor/haptics：
 * - impact：轻/中/重撞击反馈（点击、发送消息等通用操作）
 * - notification：成功/警告/错误语义反馈（任务完成、失败收尾）
 * - selection：选择刻度感（Tab 切换、picker）
 * - vibrate：原生振动（Android 指定时长）
 *
 * 设计要点：
 * - 用户开关（默认开）持久化在 Preferences（iOS Keychain /
 *   Android EncryptedSharedPreferences），webapp 侧同一键读写，
 *   保证「设置中心关掉触感」在原生壳与纯 Web 下语义一致。
 * - 纯 Web 降级走 Vibration API（navigator.vibrate，仅 Android Chrome 支持；
 *   iOS Safari 不支持，静默 no-op）。
 * - 所有原生调用 fail-safe：插件缺失/被拒绝时静默吞掉，绝不阻断业务。
 */
const haptics_1 = require("@capacitor/haptics");
const register_plugins_1 = require("../bridge/register-plugins");
/** 触感开关的持久化键（与 webapp 侧 utils/haptics.ts 约定同一键）。 */
exports.HAPTICS_ENABLED_KEY = 'ah:haptics:enabled';
/** Web 降级振动档位（毫秒）：navigator.vibrate 的 pattern。 */
const WEB_PATTERNS = {
    light: 10,
    medium: 20,
    heavy: 30,
    selection: 8,
    success: 15,
    warning: [10, 40, 10],
    error: [25, 50, 25, 50, 25],
};
/** 读用户开关：默认开启，只有显式写过 'false' 才关闭。读失败按默认开处理（触感非关键路径）。 */
async function preferenceEnabled() {
    try {
        const { preferences } = (0, register_plugins_1.getPlugins)();
        const r = await preferences.get({ key: exports.HAPTICS_ENABLED_KEY });
        return r.value !== 'false';
    }
    catch {
        return true;
    }
}
/** 纯 Web（无原生桥）的 Vibration API 降级；不可用则静默跳过。 */
function webVibrate(pattern) {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function')
        return;
    try {
        navigator.vibrate(pattern);
    }
    catch { /* 系统禁用振动 / 隐私模式：静默 */ }
}
exports.hapticsController = {
    async impact(style = 'medium') {
        if (!(await preferenceEnabled()))
            return;
        const { haptics, isNative } = (0, register_plugins_1.getPlugins)();
        if (isNative) {
            try {
                await haptics.impact({
                    style: style === 'light' ? haptics_1.ImpactStyle.Light
                        : style === 'heavy' ? haptics_1.ImpactStyle.Heavy
                            : haptics_1.ImpactStyle.Medium
                });
            }
            catch { /* 原生触感不可用：静默降级 */ }
            return;
        }
        webVibrate(WEB_PATTERNS[style]);
    },
    async notification(kind) {
        if (!(await preferenceEnabled()))
            return;
        const { haptics, isNative } = (0, register_plugins_1.getPlugins)();
        if (isNative) {
            try {
                await haptics.notification({
                    type: kind === 'success' ? haptics_1.NotificationType.Success
                        : kind === 'warning' ? haptics_1.NotificationType.Warning
                            : haptics_1.NotificationType.Error
                });
            }
            catch { /* 原生触感不可用：静默降级 */ }
            return;
        }
        webVibrate(WEB_PATTERNS[kind]);
    },
    async selection() {
        if (!(await preferenceEnabled()))
            return;
        const { haptics, isNative } = (0, register_plugins_1.getPlugins)();
        if (isNative) {
            try {
                await haptics.selectionChanged();
            }
            catch { /* 原生触感不可用：静默降级 */ }
            return;
        }
        webVibrate(WEB_PATTERNS.selection);
    },
    async vibrate(durationMs = 300) {
        if (!(await preferenceEnabled()))
            return;
        const { haptics, isNative } = (0, register_plugins_1.getPlugins)();
        if (isNative) {
            try {
                await haptics.vibrate({ duration: durationMs });
            }
            catch { /* 原生触感不可用：静默降级 */ }
            return;
        }
        webVibrate(durationMs);
    },
    async isEnabled() {
        if (!(await preferenceEnabled()))
            return false;
        const { isNative } = (0, register_plugins_1.getPlugins)();
        // 纯 Web 下 Vibration API 不可用（如 iOS Safari）时没有反馈可发
        if (!isNative) {
            return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
        }
        return true;
    },
    async setEnabled(value) {
        const { preferences } = (0, register_plugins_1.getPlugins)();
        await preferences.set({ key: exports.HAPTICS_ENABLED_KEY, value: value ? 'true' : 'false' });
    }
};
