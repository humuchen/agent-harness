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
 *
 * ## 覆盖策略：语义调用 + 全局委托
 *
 * - **语义调用**（`hapticSuccess/hapticError/hapticWarning/hapticSelection`）：
 *   放在关键交互的处理器里，表达「这件事成了/败了/被拦截」。
 * - **全局委托**（`installHaptics()`）：捕获阶段监听 document 点击，对命中
 *   `TAPPABLE_SELECTOR` 的元素补一次通用轻震——全站约 250 个按钮、语义化
 *   角色元素、外部库（Shadow DOM）按钮一次性覆盖，新增 UI 无需逐处接线。
 *   自定义可点区域（会话行、图片预览、scrim 等 div）加 `data-haptic` 属性纳入。
 * - 不产生 click 的手势（滑动露钮、长按编辑、边缘滑开抽屉）在各自手势处显式调用。
 * - 委托监听延迟一个宏任务触发，若同一点击的处理器已触发语义触感则跳过，
 *   保证「一次点击一次振动」。
 */

/** 撞击强度档位。 */
export type HapticStyle = 'light' | 'medium' | 'heavy';
/** 语义化反馈类型。 */
export type HapticKind = 'success' | 'warning' | 'error';

/** 触感开关键（与 mobile/src/plugins/haptics.ts 的 HAPTICS_ENABLED_KEY 一致）。 */
const ENABLED_KEY = 'ah:haptics:enabled';

/** 纯 Web 降级的振动 pattern（毫秒）：对齐 mobile 侧 WEB_PATTERNS。
    selection 从 8ms 提到 20ms：8ms 在多数机型上低于可感知阈值，
    纯 Web（无原生桥）环境下等于没有反馈。 */
const WEB_PATTERNS = {
  light: 10,
  medium: 20,
  heavy: 30,
  selection: 20,
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

/**
 * 可点击元素选择器：全局委托监听只对命中该选择器的点击补通用轻震。
 * 覆盖 button / 链接 / 语义化角色（switch/tab/menuitem/option/radio/checkbox/link）/
 * 表单开关（checkbox/radio/submit/button）/ 显式 `data-haptic` 标记的自定义可点区域。
 * 文本输入（input/textarea/select）天然不在列——点击聚焦不应振动。
 */
const TAPPABLE_SELECTOR = [
  'button',
  'a[href]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="button"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="link"]',
  '[data-haptic]'
].join(',');

/** 最近一次触感触发的时间戳（任意来源，40ms 节流防叠振）。 */
let lastHapticAt = 0;
/**
 * 最近一次「显式/语义调用」的时间戳（处理器里的 hapticTap/Selection/Success 等）。
 * 全局委托的通用轻震据此去重：同一点击的处理器已给过反馈就不再补振。
 * 与 lastHapticAt 分开——委托自己的连续轻震只受 40ms 节流约束，
 * 不应被 150ms 的语义去重窗口误杀。
 */
let lastExplicitAt = 0;
/** 同一点击内语义触感的去重窗口（ms）。 */
const SEMANTIC_DEDUP_MS = 150;
/** 连续快速点击的最小间隔（ms）：避免振动「堵车」叠成一段长振。 */
const MIN_INTERVAL_MS = 40;

/** 节流打戳：返回 false 表示距上次触感太近，本次跳过。explicit = 处理器显式调用。 */
function stampFire(explicit: boolean): boolean {
  const now = Date.now();
  if (now - lastHapticAt < MIN_INTERVAL_MS) return false;
  lastHapticAt = now;
  if (explicit) lastExplicitAt = now;
  return true;
}

/** 内部：通用轻震（不标记显式来源，仅供全局委托监听使用）。 */
function tapGenericLight(): void {
  if (!stampFire(false)) return;
  void fire('impact', (h) => h.impact!({ style: 'LIGHT' }), WEB_PATTERNS.light);
}

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
 *
 * method 显式传入而非只用 impact 探针：原生插件缺该方法（老壳未实现）时
 * 直接走 Web 降级；桥调用 reject 时同样降级——此前 catch 后直接 return，
 * 注释里承诺的「降级到 Web」并未发生，原生一失败振动就整体丢失。
 */
async function fire(
  method: 'impact' | 'notification' | 'selectionChanged' | 'vibrate',
  call: (h: HapticsPluginLike) => Promise<void>,
  webPattern: number | readonly number[]
): Promise<void> {
  if (!(await loadEnabled())) return;
  const h = nativeHaptics();
  if (h && typeof h[method] === 'function') {
    try {
      await call(h);
    } catch {
      /* 桥调用失败：按上述承诺降级到 Web Vibration API */
      webVibrate(webPattern);
    }
    return;
  }
  webVibrate(webPattern);
}

/** 通用点击反馈（按钮、发送消息等）。 */
export function hapticTap(style: HapticStyle = 'light'): void {
  if (!stampFire(true)) return;
  void fire('impact', (h) => h.impact!({ style: style.toUpperCase() }), WEB_PATTERNS[style]);
}

/**
 * 选择刻度感（Tab 切换、picker、滑动露出操作区）。
 *
 * 原生侧选 impact(LIGHT) 而非 selectionChanged()：Android 的
 * @capacitor/haptics 把 selectionChanged() 门禁在 selectionStart() 之后
 * （Haptics.java 里 selectionStarted=false 时直接 no-op，不抛错、不 reject），
 * 单独调用会被静默丢弃——这正是「切换底部 Tab 没有触感、而重复点当前 Tab
 * （走全局委托的 impact）却有」的成因。iOS 上二者等价，统一用 impact
 * 保证双端行为一致。
 */
export function hapticSelection(): void {
  if (!stampFire(true)) return;
  void fire('impact', (h) => h.impact!({ style: 'LIGHT' }), WEB_PATTERNS.selection);
}

/** 成功反馈（任务完成、最终答复到达）。 */
export function hapticSuccess(): void {
  if (!stampFire(true)) return;
  void fire('notification', (h) => h.notification!({ type: 'SUCCESS' }), WEB_PATTERNS.success);
}

/** 警告反馈（操作被拦截、需要用户注意）。 */
export function hapticWarning(): void {
  if (!stampFire(true)) return;
  void fire('notification', (h) => h.notification!({ type: 'WARNING' }), WEB_PATTERNS.warning);
}

/** 错误反馈（运行失败、请求出错）。 */
export function hapticError(): void {
  if (!stampFire(true)) return;
  void fire('notification', (h) => h.notification!({ type: 'ERROR' }), WEB_PATTERNS.error);
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
  // 重置节流时钟：开关切换本身不该被「刚才那次（可能是关闭态下的）点击」的
  // 节流窗口影响——开启后的第一次点击应立即有反馈。
  lastHapticAt = 0;
  lastExplicitAt = 0;
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

/* ------------------------------------------------------------------ *
 * 全局委托触感监听：一次性覆盖全站按钮类点击
 * ------------------------------------------------------------------ */

let delegatedInstalled = false;

/**
 * 捕获阶段的点击判定（同步）：是否点在「可点击元素」上。
 * 用 composedPath 而非 e.target——外部库（@humuchen/mac-ui 的 mac-confirm 等）
 * 在 Shadow DOM 里渲染按钮，e.target 已被重定向到宿主元素，只有 composedPath
 * 能拿到影子节点。同时天然覆盖「按钮内 span 被点」与「data-haptic 自定义区域」。
 */
function isTappableClick(e: MouseEvent): boolean {
  const path =
    typeof e.composedPath === 'function' ? e.composedPath() : [];
  const nodes: Array<EventTarget | null> =
    path.length > 0 ? path : [e.target];
  for (const n of nodes) {
    if (
      n instanceof Element &&
      typeof n.matches === 'function' &&
      n.matches(TAPPABLE_SELECTOR)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 捕获阶段监听（先于一切处理器，不受 stopPropagation 影响）：
 * 命中可点击元素后**延迟一个宏任务**再补通用轻震——等本点击的所有同步处理器
 * 跑完。若处理器已触发语义触感（Tab 切换的刻度感、发送轻震、告警/错误等，
 * 均同步打戳），则跳过，避免一次点击双重振动。
 */
function onDelegatedClickCapture(e: MouseEvent): void {
  if (!isTappableClick(e)) return;
  setTimeout(() => {
    // 处理器已触发显式/语义触感（同一点击）→ 跳过，保证一次点击一次振动
    if (Date.now() - lastExplicitAt < SEMANTIC_DEDUP_MS) return;
    tapGenericLight();
  }, 0);
}

/** 安装全局委托触感（幂等；main.ts 启动时调用一次）。 */
export function installHaptics(): void {
  if (delegatedInstalled || typeof window === 'undefined') return;
  delegatedInstalled = true;
  window.addEventListener('click', onDelegatedClickCapture, true);
}

/** 卸载全局委托触感（测试/热替换用）。 */
export function uninstallHaptics(): void {
  if (!delegatedInstalled || typeof window === 'undefined') return;
  delegatedInstalled = false;
  window.removeEventListener('click', onDelegatedClickCapture, true);
}
