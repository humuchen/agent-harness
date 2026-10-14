/**
 * 触感反馈（haptics）：手机端交互的「实体感」——点击、发送、任务收尾的振动反馈。
 *
 * ## 环境分层
 *
 * | 环境 | 通道 | 说明 |
 * |---|---|---|
 * | 原生壳（Capacitor） | `window.Capacitor.Plugins.Haptics` | Taptic Engine（iOS）/ 振动马达（Android），效果最好 |
 * | 纯 Web（Android Chrome） | `navigator.vibrate`（Vibration API） | 浏览器降级，仅 Android 支持 |
 * | 纯 Web（iOS Safari / 桌面） | 无 | 静默 no-op，绝不抛错 |
 *
 * 取原生插件沿用 `storage-usage.ts` / `plugin-notify.ts` 的既有约定：走全局
 * `window.Capacitor.Plugins`，webapp 不依赖 `@capacitor/*`。
 *
 * ## 用户开关
 *
 * 键 `ah:haptics:enabled` 与 mobile 侧 `plugins/haptics.ts` 约定为同一键：
 * 原生壳内经 `window.Capacitor.Plugins.Preferences` 读写（与 mobile 封装同一
 * 存储，设置中心改一处两端生效）；纯 Web 回落 localStorage。默认开启，
 * 只有显式写过 'false' 才关闭。偏好读取是异步的，首次调用前 `initHaptics()`
 * 预热缓存；未预热时按默认「开」放行（触感非关键路径，fail-open）。
 */

/** 撞击强度档位。 */
export type HapticStyle = 'light' | 'medium' | 'heavy';
/** 语义化反馈类型。 */
export type HapticKind = 'success' | 'warning' | 'error';

/** 触感开关键（与 mobile/src/plugins/haptics.ts 的 HAPTICS_ENABLED_KEY 一致）。 */
const ENABLED_KEY = 'ah:haptics:enabled';

/** 纯 Web 降级的振动 pattern（毫秒）：对齐 mobile 侧 WEB_PATTERNS。 */
const WEB_PATTERNS = {
  light: 10,
  medium: 20,
  heavy: 30,
  selection: 8,
  success: 15,
  warning: [10, 40, 10],
  error: [25, 50, 25, 50, 25],
} as const;

/** 本模块用到的 Haptics 插件子集（避免引入 Capacitor 类型依赖）。 */
interface HapticsPluginLike {
  impact?(options: { style: string }): Promise<void>;
  notification?(options: { type: string }): Promise<void>;
  selectionChanged?(): Promise<void>;
  vibrate?(options: { duration: number }): Promise<void>;
}

/** 本模块用到的 Preferences 插件子集。 */
interface PreferencesPluginLike {
  get?(options: { key: string }): Promise<{ value: string | null }>;
  set?(options: { key: string; value: string }): Promise<void>;
}

interface CapacitorGlobal {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    Plugins?: Record<string, unknown>;
  };
}

/** 偏好缓存：null = 尚未加载（按默认「开」放行）。 */
let enabledCache: boolean | null = null;

/** 取出原生壳的 Haptics 插件；非原生环境（或插件未注册）返回 null。 */
function nativeHaptics(): HapticsPluginLike | null {
  const g = globalThis as unknown as CapacitorGlobal;
  if (typeof g.Capacitor?.isNativePlatform !== 'function') return null;
  if (!g.Capacitor.isNativePlatform()) return null;
  const h = g.Capacitor.Plugins?.Haptics as HapticsPluginLike | undefined;
  if (!h || typeof h.impact !== 'function') return null;
  return h;
}

/** 取出原生壳的 Preferences 插件；非原生环境返回 null（回落 localStorage）。 */
function nativePreferences(): PreferencesPluginLike | null {
  const g = globalThis as unknown as CapacitorGlobal;
  if (typeof g.Capacitor?.isNativePlatform !== 'function') return null;
  if (!g.Capacitor.isNativePlatform()) return null;
  const p = g.Capacitor.Plugins?.Preferences as PreferencesPluginLike | undefined;
  if (!p || typeof p.get !== 'function') return null;
  return p;
}

/** 纯 Web 的 Vibration API 降级；不可用（iOS Safari / 桌面）静默跳过。 */
function webVibrate(pattern: number | readonly number[]): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern as number | number[]);
  } catch {
    /* 系统禁用振动 / 隐私模式：静默 */
  }
}

/**
 * 读取触感开关（带缓存）。默认开启；只有显式写过 'false' 才关闭。
 * 读取失败按默认「开」处理——触感是增强而非关键路径，fail-open。
 */
async function loadEnabled(): Promise<boolean> {
  if (enabledCache !== null) return enabledCache;
  const prefs = nativePreferences();
  let value: string | null;
  if (prefs?.get) {
    try {
      value = (await prefs.get({ key: ENABLED_KEY })).value;
    } catch {
      value = null;
    }
  } else {
    try {
      value = localStorage.getItem(ENABLED_KEY);
    } catch {
      value = null;
    }
  }
  enabledCache = value !== 'false';
  return enabledCache;
}

/**
 * 统一的触感发放入口：开关 → 原生 Haptics → Web Vibration API 三级降级。
 * 所有异常静默吞掉，任何环境下调用方都不需要 try/catch。
 */
async function fire(
  call: (h: HapticsPluginLike) => Promise<void>,
  webPattern: number | readonly number[]
): Promise<void> {
  if (!(await loadEnabled())) return;
  const h = nativeHaptics();
  if (h) {
    try {
      await call(h);
    } catch {
      /* 桥调用失败：静默降级到 Web（原生壳内通常同样不可用） */
    }
    return;
  }
  webVibrate(webPattern);
}

/** 通用点击反馈（按钮、发送消息等）。 */
export function hapticTap(style: HapticStyle = 'light'): void {
  void fire((h) => h.impact!({ style: style.toUpperCase() }), WEB_PATTERNS[style]);
}

/** 选择刻度感（Tab 切换、picker）。 */
export function hapticSelection(): void {
  void fire((h) => h.selectionChanged!(), WEB_PATTERNS.selection);
}

/** 成功反馈（任务完成、最终答复到达）。 */
export function hapticSuccess(): void {
  void fire((h) => h.notification!({ type: 'SUCCESS' }), WEB_PATTERNS.success);
}

/** 警告反馈（操作被拦截、需要用户注意）。 */
export function hapticWarning(): void {
  void fire((h) => h.notification!({ type: 'WARNING' }), WEB_PATTERNS.warning);
}

/** 错误反馈（运行失败、请求出错）。 */
export function hapticError(): void {
  void fire((h) => h.notification!({ type: 'ERROR' }), WEB_PATTERNS.error);
}

/** 预热偏好缓存（应用启动时调用一次，幂等）。 */
export async function initHaptics(): Promise<void> {
  await loadEnabled();
}

/** 同步读取开关状态（未预热时为默认值 true）。 */
export function isHapticsEnabled(): boolean {
  return enabledCache ?? true;
}

/**
 * 设置触感开关：先更新缓存（立即生效），再持久化。
 * 原生壳写 Preferences（与 mobile 封装同源），纯 Web 写 localStorage。
 */
export async function setHapticsEnabled(on: boolean): Promise<void> {
  enabledCache = on;
  const prefs = nativePreferences();
  if (prefs?.set) {
    try {
      await prefs.set({ key: ENABLED_KEY, value: on ? 'true' : 'false' });
    } catch {
      /* 原生写入失败：缓存已生效，下次读取回落 localStorage/默认值 */
    }
    return;
  }
  try {
    localStorage.setItem(ENABLED_KEY, on ? 'true' : 'false');
  } catch {
    /* 隐私模式 / 配额满：内存态仍继续 */
  }
}

/** 当前环境是否真的有触感通道（原生 Haptics 或 Web Vibration API）。 */
export function hapticsAvailable(): boolean {
  if (nativeHaptics()) return true;
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}
