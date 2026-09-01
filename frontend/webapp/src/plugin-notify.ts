/**
 * 插件主动提醒（SSE 实时推送 + 轮询降级，通用、不耦合具体插件业务词）。
 *
 * 背景：webapp 用 unsafeHTML 注入插件 HTML，<script> 不执行；项目已有 SSE 基建
 * （/api/chat/stream 按 owner 订阅 chat-bus）。提醒采用「服务端经 reminder-bus 实时推 SSE +
 * 前端订阅 /api/events」链路（与 chat-sync 同源范式），轮询仅作 SSE 断开时的降级兜底。
 *
 * 约定：插件在 fire 时经 ctx.events.emit('memo:reminder', {...})，服务端 plugin-ext 把它桥接进
 * reminder-bus；前端经 /api/events 收到即弹 ah-notification + 浏览器桌面通知，并调
 * POST /api/plugins/memo/reminders/ack?id= 落盘 ack 防重复。SSE 不可用时降级为每 20s 轮询
 * GET /api/plugins/memo/reminders 的 pending 列表。
 *
 * 去重：内存 Set（本会话不重复弹）+ 服务端 ack（跨刷新/跨端不重复）。
 *
 * 桌面通知降级（重要）：toast 默认只停 8s，且浏览器标签页在后台时用户根本看不到。
 * 一旦桌面通知不可用（未授权 / 浏览器不支持 / 非安全上下文），提醒「只弹一下就没了」，
 * 用户回来后完全无从察觉——曾据此误判为「提醒功能坏了」。因此降级时：
 *   ① toast 升级为 warning 语义并延长停留（详见 REMINDER_TOAST_MS）；
 *   ② 累加未读计数并持久化到 localStorage；
 *   ③ 派发 ah-reminder-unread 事件，由 app.ts 在备忘 Tab 上打红点。
 * 真正的兜底是服务端「提醒历史」（看板可回查），红点只是把用户引导过去。
 */

import { authedFetch } from './api';
import { notify } from './components/ah-notification';

interface ReminderDto {
  id: string;
  text: string;
  tag?: string | null;
  remindAt?: number | null;
}

const POLL_MS = 20_000;
/** 提醒 toast 的停留时长：比默认 info(3.2s) 长得多，避免一闪而过被错过。 */
const REMINDER_TOAST_MS = 12_000;
/** 桌面通知不可用时的降级停留时长：更醒目、更久，并提示权限未开。 */
const REMINDER_TOAST_MS_FALLBACK = 20_000;
/** 未读提醒计数的持久化键（跨刷新保留，进入对应 Tab 才清零）。 */
const UNREAD_KEY = 'ah:memo-reminder-unread';
/**
 * 提醒归属的插件 Tab id（对应备忘看板注册时的 tabId）。
 * 在这里集中定义、随事件 detail 抛出，而不是写进 app.ts：webapp 主壳必须零业务词，
 * 只按 detail.tabId 做红点匹配，不认识「备忘」这个概念。
 */
const REMINDER_TAB_ID = 'memo';

/** 未读提醒状态：哪个 Tab 上挂几条未读。 */
export interface ReminderUnread {
  tabId: string;
  count: number;
}

/** 本会话已弹过的 id（内存去重）。 */
const shown = new Set<string>();
/** SSE 连接句柄（非浏览器/未建立时为 null）。 */
let es: { close: () => void } | null = null;
/** 轮询定时器句柄（降级用）。 */
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** 是否正在用轮询降级（SSE 不可用/断开）。 */
let polling = false;
/** 是否已申请过桌面通知权限。 */
let permProbed = false;

function fmtTime(ts?: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 申请（必要时）桌面通知权限，返回当前是否允许。 */
function ensureDesktopPermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'denied';
  if (!permProbed) {
    permProbed = true;
    if (Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined);
    }
  }
  return Notification.permission;
}

/**
 * 弹桌面通知（权限允许时）。
 * @returns 是否真的弹出了桌面通知——false 表示「只有应用内 toast 兜底」，
 *          调用方据此升级提示强度并累加未读（后台标签页看不到 toast，容易整个错过）。
 */
function fireDesktop(r: ReminderDto): boolean {
  if (ensureDesktopPermission() !== 'granted') return false;
  try {
    const n = new Notification('备忘提醒', {
      body: r.tag ? `[${r.tag}] ${r.text}` : r.text,
      tag: `memo-remind-${r.id}`,
      // 桌面通知常驻等待用户处理：它不占页面空间，无需像 toast 那样急着消失。
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    /* 非用户手势下构造 Notification 可能抛错，降级为仅应用内 toast */
    return false;
  }
}

/** 弹应用内通知 + 桌面通知，并 ack 服务端落盘（幂等）。 */
function surface(r: ReminderDto): void {
  if (shown.has(r.id)) return;
  shown.add(r.id);

  const when = fmtTime(r.remindAt);
  const body = r.tag ? `[${r.tag}] ${r.text}` : r.text;
  const title = when ? `备忘提醒 · ${when}` : '备忘提醒';

  // 先尝试桌面通知：它能在标签页后台时触达用户，是「不漏提醒」的主通道。
  const desktopOk = fireDesktop(r);

  if (desktopOk) {
    notify.info(body, {
      title,
      key: `memo-remind-${r.id}`,
      duration: REMINDER_TOAST_MS,
    });
  } else {
    // 降级：只有 toast 这一条通道，标签页在后台就彻底错过。
    // 因此升级为 warning（左侧黄条更醒目）+ 更长停留 + 明示权限未开，
    // 并累加未读计数，让备忘 Tab 打红点把用户引导到「提醒历史」回查。
    notify.warning(`${body}（桌面通知未开启，已记入提醒历史）`, {
      title,
      key: `memo-remind-${r.id}`,
      duration: REMINDER_TOAST_MS_FALLBACK,
    });
    bumpUnread();
  }

  void authedFetch(
    `/api/plugins/memo/reminders/ack?id=${encodeURIComponent(r.id)}`,
    { method: 'POST' }
  ).catch(() => undefined);
}

/* ------------------------------ 未读提醒计数 ------------------------------ */

/** 读取持久化的未读提醒数（localStorage 不可用时退化为 0，不阻断提醒）。 */
function readUnread(): number {
  try {
    const n = Number(localStorage.getItem(UNREAD_KEY) ?? '0');
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** 写入未读计数并广播给订阅方（app.ts 的 Tab 红点）。 */
function writeUnread(n: number): void {
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  try {
    localStorage.setItem(UNREAD_KEY, String(count));
  } catch {
    /* 隐私模式 / 配额满：内存态仍继续，不影响提醒本身 */
  }
  const detail: ReminderUnread = { tabId: REMINDER_TAB_ID, count };
  window.dispatchEvent(new CustomEvent('ah-reminder-unread', { detail }));
}

/** 未读 +1（仅桌面通知不可用时调用，桌面通知弹成功则视为已触达）。 */
function bumpUnread(): void {
  writeUnread(readUnread() + 1);
}

/** 供外部读取当前未读状态（app.ts 初始化红点用）。 */
export function getReminderUnread(): ReminderUnread {
  return { tabId: REMINDER_TAB_ID, count: readUnread() };
}

/** 供外部清零未读（进入对应 Tab 时调用，幂等）。 */
export function clearReminderUnread(): void {
  if (readUnread() !== 0) writeUnread(0);
}

/** 处理一条提醒事件（SSE 或轮询均走此入口）。 */
function handleReminder(e: unknown): void {
  const r = e as ReminderDto & { type?: string };
  if (!r || typeof r.id !== 'string') return;
  surface(r);
}

// ---------------------------------------------------------------------------
// 轮询降级
// ---------------------------------------------------------------------------

let pollInFlight = false;

/** 单次轮询：拉取待提醒并逐条弹窗（仅在 SSE 不可用时启用）。 */
async function pollOnce(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const res = await authedFetch('/api/plugins/memo/reminders', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { pending?: ReminderDto[] };
    for (const r of data.pending ?? []) handleReminder(r);
  } catch {
    /* 网络/鉴权失败静默：下次轮询继续 */
  } finally {
    pollInFlight = false;
  }
}

function startPolling(): void {
  if (polling) return;
  polling = true;
  void pollOnce();
  pollTimer = setInterval(() => void pollOnce(), POLL_MS);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  polling = false;
}

// ---------------------------------------------------------------------------
// SSE 主通道
// ---------------------------------------------------------------------------

function startSse(): void {
  if (es || typeof EventSource === 'undefined') {
    // 不支持 EventSource 直接走轮询降级
    startPolling();
    return;
  }
  try {
    const source = new EventSource('/api/events');
    es = { close: () => source.close() };
    source.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as { type?: string };
        if (data.type === 'memo:reminder') {
          handleReminder(data);
        }
      } catch {
        /* 坏消息跳过 */
      }
    };
    source.onerror = () => {
      // SSE 断开：关连接 + 降级轮询，待下次 start 重连（浏览器会在 onerror 后停发，
      // 由我们主动关闭并切轮询，避免无限重连刷日志）。
      try {
        source.close();
      } catch {
        /* 已关 */
      }
      es = null;
      startPolling();
    };
  } catch {
    // EventSource 构造失败：降级轮询
    es = null;
    startPolling();
  }
}

/** 启动提醒通道（SSE 优先，失败轮询降级）。幂等。 */
export function startPluginNotify(): void {
  startSse();
}

/** 停止全部提醒通道并清理（登出时调用）。 */
export function stopPluginNotify(): void {
  if (es) {
    try {
      es.close();
    } catch {
      /* 已关 */
    }
    es = null;
  }
  stopPolling();
  shown.clear();
  permProbed = false;
}
