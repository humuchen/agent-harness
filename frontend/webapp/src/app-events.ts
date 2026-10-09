/**
 * 窗口级应用事件总线 —— 单一命名源（P1-12 收敛）。
 *
 * 背景：窗口级 CustomEvent 的名字此前以裸字符串散布在 10+ 文件（app/chat/api/main/
 * 各组件），无编译期检查 —— 拼写漂移或漏改任何一侧都会静默失联（曾出过丢内容事故）。
 * 本文件把事件名收敛为 `as const` 清单：派发/监听两侧全部引用常量，改名/删除会在
 * 编译期直接暴露全部引用点；新增事件必须先在此登记， 杜绝「随手发明第六种命名风格」。
 *
 * 范畴约定：仅收**窗口总线**事件（window 级 或 经 bubbles+composed 冒泡穿透
 * shadow DOM 到 window/宿主的跨组件事件）。组件内部契约事件（ah-confirm / mac-confirm-*
 * / agent-change / ah-open 等元素自有事件）不属于总线，不在此登记。
 *
 * 用法：
 * - 派发：window 级 `emitAppEvent(APP_EVENTS.closeOverlays)`；元素级冒泡
 *   `el.dispatchEvent(new CustomEvent(APP_EVENTS.goto, { detail, bubbles: true, composed: true }))`。
 * - 监听：`window.addEventListener(APP_EVENTS.closeOverlays, fn)`（与既有
 *   removeEventListener 配对逻辑保持原样，最小 diff）。
 */

/** 窗口级应用事件名单一命名源。 */
export const APP_EVENTS = {
  /** 登录态过期（api.ts 401 拦截 → main.ts 切回登录页）。 */
  sessionExpired: 'ah-session-expired',
  /** 用户主动退出（settings-center → main.ts 切回登录页）。 */
  sessionCleared: 'ah-session-cleared',
  /** 面板/设置/Key 变更（panels、settings-center、provider-key-settings，元素级 bubbles+composed 冒泡）→ app 刷新全局偏好。 */
  refresh: 'ah-refresh',
  /** Tab 切换意图（dashboard / chat，元素级 bubbles+composed）→ app.setTab 唯一写入点。 */
  goto: 'ah-goto',
  /** 全局运行指示条开始/结束（app ↔ chat）。 */
  barStart: 'ah:bar:start',
  barStop: 'ah:bar:stop',
  /** 指示条手动步进（预留：当前仅 top-progress-bar 监听端，无派发端，自动步进走内部 timer）。 */
  barTick: 'ah:bar:tick',
  /** app 完成对话 Tab 渲染后指定当前会话（app → chat，元素级 bubbles+composed）。 */
  selectSession: 'ah-select-session',
  /** 路由切换统一关闭覆盖层（app → chat / agent-picker / ah-drawer / ah-modal，window 级）。 */
  closeOverlays: 'ah:close-overlays',
  /** 跨端会话同步（chat-sync SSE → chat，window 级，detail: ChatSyncEvent）。 */
  chatSync: 'ah-chat-sync',
  /** agent 运行开始/结束（chat → app 指示条，window 级）。 */
  runStart: 'ah:run:start',
  runStop: 'ah:run:stop',
  /** 移动端滑动关闭会话列表（chat → ah-swipe-item，window 级）。 */
  swipeClose: 'ah:swipe-close',
  /** 登录成功（login，元素级 bubbles+composed 冒泡到 window）→ main.ts 挂载 app。 */
  loginSuccess: 'ah-login-success',
  /** 主题切换（settings-center / mac-ui-adapter → app / ah-modal / mac 组件，window 级）。 */
  themeChanged: 'ah:theme-changed',
  /** 移动端原生壳深链（Capacitor 壳 → app，window 级）。 */
  deeplink: 'ah:deeplink'
} as const;

/** 已登记的窗口事件名（编译期约束派发/监听两侧只使用清单内的名字）。 */
export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];

export interface EmitAppEventOptions {
  /** 派发目标（缺省 window）。元素级冒泡场景传入宿主元素并自行用 CustomEvent 构造。 */
  on?: EventTarget;
  /** 事件负载（CustomEvent.detail）。 */
  detail?: unknown;
}

/**
 * 派发窗口级应用事件。统一走 CustomEvent（覆盖既有 `new Event(name)` 的全部用法，
 * detail 为 undefined 时与 Event 行为一致）。
 */
export function emitAppEvent(name: AppEventName, opts: EmitAppEventOptions = {}): void {
  (opts.on ?? window).dispatchEvent(new CustomEvent(name, { detail: opts.detail }));
}
