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
 * 桌面通知权限：未授权则仅应用内 toast，不阻塞；首次提醒按需申请。
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

/** 弹桌面通知（权限允许时）；失败静默降级为仅应用内 toast。 */
function fireDesktop(r: ReminderDto): void {
  if (ensureDesktopPermission() !== 'granted') return;
  try {
    const n = new Notification('备忘提醒', {
      body: r.tag ? `[${r.tag}] ${r.text}` : r.text,
      tag: `memo-remind-${r.id}`,
      requireInteraction: false,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    setTimeout(() => n.close(), 12_000);
  } catch {
    /* 非用户手势下构造 Notification 可能抛错，忽略 */
  }
}

/** 弹应用内通知 + 桌面通知，并 ack 服务端落盘（幂等）。 */
function surface(r: ReminderDto): void {
  if (shown.has(r.id)) return;
  shown.add(r.id);

  const when = fmtTime(r.remindAt);
  const body = r.tag ? `[${r.tag}] ${r.text}` : r.text;
  notify.info(body, {
    title: when ? `备忘提醒 · ${when}` : '备忘提醒',
    key: `memo-remind-${r.id}`,
    duration: 8000,
  });

  fireDesktop(r);

  void authedFetch(
    `/api/plugins/memo/reminders/ack?id=${encodeURIComponent(r.id)}`,
    { method: 'POST' }
  ).catch(() => undefined);
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
