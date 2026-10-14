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
import { ImpactStyle, NotificationType } from '@capacitor/haptics';
import { getPlugins } from '../bridge/register-plugins';

/** 撞击强度档位。 */
export type HapticStyle = 'light' | 'medium' | 'heavy';
/** 语义化反馈类型。 */
export type HapticKind = 'success' | 'warning' | 'error';

/** 触感开关的持久化键（与 webapp 侧 utils/haptics.ts 约定同一键）。 */
export const HAPTICS_ENABLED_KEY = 'ah:haptics:enabled';

/** Web 降级振动档位（毫秒）：navigator.vibrate 的 pattern。 */
const WEB_PATTERNS = {
  light: 10,
  medium: 20,
  heavy: 30,
  selection: 8,
  success: 15,
  warning: [10, 40, 10],
  error: [25, 50, 25, 50, 25],
} as const;

export interface HapticsController {
  /** 轻/中/重撞击反馈（点击、发送等通用操作）。 */
  impact(style?: HapticStyle): Promise<void>;
  /** 成功/警告/错误语义反馈（任务完成、失败等）。 */
  notification(kind: HapticKind): Promise<void>;
  /** 选择刻度感（Tab 切换、picker 滚动）。 */
  selection(): Promise<void>;
  /** 原生振动（指定毫秒数，Android 生效；iOS 映射为短撞击）。 */
  vibrate(durationMs?: number): Promise<void>;
  /** 读取触感开关（默认开启；纯 Web 且无 Vibration API 时为 false）。 */
  isEnabled(): Promise<boolean>;
  /** 设置触感开关并持久化。 */
  setEnabled(enabled: boolean): Promise<void>;
}

/** 读用户开关：默认开启，只有显式写过 'false' 才关闭。读失败按默认开处理（触感非关键路径）。 */
async function preferenceEnabled(): Promise<boolean> {
  try {
    const { preferences } = getPlugins();
    const r = await preferences.get({ key: HAPTICS_ENABLED_KEY });
    return r.value !== 'false';
  } catch {
    return true;
  }
}

/** 纯 Web（无原生桥）的 Vibration API 降级；不可用则静默跳过。 */
function webVibrate(pattern: number | readonly number[]): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern as number | number[]);
  } catch { /* 系统禁用振动 / 隐私模式：静默 */ }
}

export const hapticsController: HapticsController = {
  async impact(style = 'medium') {
    if (!(await preferenceEnabled())) return;
    const { haptics, isNative } = getPlugins();
    if (isNative) {
      try {
        await haptics.impact({
          style: style === 'light' ? ImpactStyle.Light
            : style === 'heavy' ? ImpactStyle.Heavy
            : ImpactStyle.Medium
        });
      } catch { /* 原生触感不可用：静默降级 */ }
      return;
    }
    webVibrate(WEB_PATTERNS[style]);
  },
  async notification(kind) {
    if (!(await preferenceEnabled())) return;
    const { haptics, isNative } = getPlugins();
    if (isNative) {
      try {
        await haptics.notification({
          type: kind === 'success' ? NotificationType.Success
            : kind === 'warning' ? NotificationType.Warning
            : NotificationType.Error
        });
      } catch { /* 原生触感不可用：静默降级 */ }
      return;
    }
    webVibrate(WEB_PATTERNS[kind]);
  },
  async selection() {
    if (!(await preferenceEnabled())) return;
    const { haptics, isNative } = getPlugins();
    if (isNative) {
      try {
        await haptics.selectionChanged();
      } catch { /* 原生触感不可用：静默降级 */ }
      return;
    }
    webVibrate(WEB_PATTERNS.selection);
  },
  async vibrate(durationMs = 300) {
    if (!(await preferenceEnabled())) return;
    const { haptics, isNative } = getPlugins();
    if (isNative) {
      try {
        await haptics.vibrate({ duration: durationMs });
      } catch { /* 原生触感不可用：静默降级 */ }
      return;
    }
    webVibrate(durationMs);
  },
  async isEnabled() {
    if (!(await preferenceEnabled())) return false;
    const { isNative } = getPlugins();
    // 纯 Web 下 Vibration API 不可用（如 iOS Safari）时没有反馈可发
    if (!isNative) {
      return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
    }
    return true;
  },
  async setEnabled(value) {
    const { preferences } = getPlugins();
    await preferences.set({ key: HAPTICS_ENABLED_KEY, value: value ? 'true' : 'false' });
  }
};
