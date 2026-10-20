/**
 * 系统手势冲突协调：抽屉侧滑关闭 vs 系统返回手势（Android 10+ 边缘侧滑返回）。
 * -------------------------------------------------------------------
 * 背景：移动端抽屉常为全屏（size 500px 在 390px 屏上即 100vw），其「内缘」恰是
 * 屏幕对侧边缘——用户在该处向右滑关闭抽屉，与 Android 系统返回手势（屏幕左右
 * 边缘内滑）完全同带。web 层的 touch-action: pan-y + 非 passive preventDefault
 * 只能阻止浏览器自身的横向滚动/回退，拦不住系统级返回手势。
 *
 * 官方解法：Android `View.setSystemGestureExclusionRects()`（API 29+）——
 * 抽屉打开期间把 WebView 区域登记为「系统手势排除区」，系统返回手势在该区域
 * 不再触发，触摸全部交给应用。由 MainActivity 注入的
 * `window.AhSystemGesture` JS 接口承接（Capacitor 无此插件，走轻量
 * addJavascriptInterface，与 haptics 走 window.Capacitor.Plugins 的既有约定并存）。
 *
 * iOS 为何无需对称处理：本壳 rootViewController 是裸 CAPBridgeViewController
 * （无 UINavigationController），交互式返回识别器（interactivePopGestureRecognizer）
 * 不存在；WKWebView 的 allowsBackForwardNavigationGestures 默认关闭。即 iOS 上
 * 「边缘侧滑返回」这一系统手势在壳内不存在，抽屉侧滑关闭不存在系统级冲突，
 * web 层消费手势即可——双端用户感知一致。
 *
 * 纯 Web（桌面浏览器 / 无原生桥）：没有任何系统边缘手势需要排除，静默 no-op。
 * Chrome 的 Overscroll Navigation 由抽屉面板的 touch-action: pan-y 阻止。
 *
 * 引用计数：多个抽屉可能叠开（如设置抽屉压在对话抽屉上），只有首个打开时
 * 下发原生调用、全部关闭后才解除，避免后关闭的抽屉把先关闭的排除区一起解除。
 */

/** Android MainActivity 注入的 JS 接口子集（addJavascriptInterface 契约）。 */
interface AhSystemGestureBridge {
  /** enabled=true 登记系统手势排除区；false 解除。 */
  setDrawerGestureExclusion?(enabled: boolean): void;
}

/** 当前打开中的、申请了系统手势排除的抽屉数量。 */
let exclusionDepth = 0;

/** 取出原生桥；非原生壳 / 老壳未注入时返回 null。 */
function nativeBridge(): AhSystemGestureBridge | null {
  const g = globalThis as unknown as { AhSystemGesture?: AhSystemGestureBridge };
  return g.AhSystemGesture ?? null;
}

/** 实际下发原生调用（失败静默：排除区是增强而非关键路径，绝不阻断抽屉交互）。 */
function applyExclusion(enabled: boolean): void {
  const bridge = nativeBridge();
  if (!bridge || typeof bridge.setDrawerGestureExclusion !== 'function') return;
  try {
    bridge.setDrawerGestureExclusion(enabled);
  } catch {
    /* 桥调用失败（壳版本不匹配等）：静默降级为不排除 */
  }
}

/**
 * 申请「抽屉打开期间排除系统返回手势」。引用计数，须与 releaseDrawerGestureExclusion
 * 严格配对（推荐放在 $effect 的 cleanup 里，见 ah-drawer.svelte）。
 */
export function acquireDrawerGestureExclusion(): void {
  exclusionDepth++;
  if (exclusionDepth === 1) applyExclusion(true);
}

/** 释放排除申请；计数归零时才真正解除原生排除区。 */
export function releaseDrawerGestureExclusion(): void {
  if (exclusionDepth <= 0) return;
  exclusionDepth--;
  if (exclusionDepth === 0) applyExclusion(false);
}

/** 当前是否持有排除申请（测试/调试用）。 */
export function drawerGestureExclusionDepth(): number {
  return exclusionDepth;
}
