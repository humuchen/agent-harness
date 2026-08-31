/**
 * 插件主动提醒轮询（通用、按约定端点，不耦合具体插件业务词）。
 *
 * 背景：webapp 用 unsafeHTML 注入插件 HTML，<script> 不执行；项目也无通用事件 SSE。
 * 因此「主动提醒」采用「服务端落盘待提醒 + 前端轮询端点」链路（与 chat-sync 的 SSE 互补）。
 * 约定：插件在 PluginContext.server 注册 GET /api/plugins/<pluginId>/reminders，
 * 返回 { pending: [{id,text,tag,remindAt}], upcoming: [...] }；前端轮询 pending，
 * 用 ah-notification 弹应用内通知 + 浏览器 Notification API 弹系统桌面通知，
 * 并对每条已弹过的 id 调 POST .../reminders/ack?id= 落盘，避免重复。
 *
 * 去重：内存 Set（本会话不重复弹）+ 服务端 ack（跨刷新/跨端不重复）。
 * 桌面通知权限：若用户未授权 Notification.permission，则仅应用内 toast，不阻塞；
 * 授权窗口由首次提醒时按需申请。
 */

import { authedFetch } from './api';
import { notify } from './components/ah-notification';

interface ReminderDto {
  id: string;
  text: string;
  tag?: string | null;
  remindAt?: number | null;
}

interface RemindersResp {
  ok?: boolean;
  pending?: ReminderDto[];
  upcoming?: ReminderDto[];
}

const POLL_MS = 20_000;

/** 单次轮询是否正在飞行，防重叠。 */
let inFlight = false;
/** 本会话已弹过的 id（内存去重）。 */
const shown = new Set<string>();
/** 轮询定时器句柄。 */
let timer: ReturnType<typeof setInterval> | null = null;
/** 是否已申请过桌面通知权限（避免每次提醒都弹授权框）。 */
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
    // 仅当默认态（未决定）才主动申请，避免打扰已拒绝的用户。
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
      // 点击聚焦窗口（无多窗口场景，仅 best-effort）。
      requireInteraction: false,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    // 自动关闭，避免堆积。
    setTimeout(() => n.close(), 12_000);
  } catch {
    /* 某些浏览器在非用户手势下构造 Notification 会抛错，忽略即可 */
  }
}

/** 弹应用内通知 + 桌面通知，并 ack 服务端落盘。 */
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

  // 落盘 ack（best-effort，失败不重试；下次轮询若仍 pending 会再弹，但 shown 已去重）。
  void authedFetch(
    `/api/plugins/memo/reminders/ack?id=${encodeURIComponent(r.id)}`,
    { method: 'POST' }
  ).catch(() => undefined);
}

/** 单次轮询：拉取待提醒并逐条弹窗。 */
async function poll(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await authedFetch('/api/plugins/memo/reminders', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = (await res.json()) as RemindersResp;
    const pending = data.pending ?? [];
    for (const r of pending) surface(r);
  } catch {
    /* 网络/鉴权失败静默：下次轮询继续；401 由 authedFetch 统一回收登录态。 */
  } finally {
    inFlight = false;
  }
}

/** 启动提醒轮询（幂等）。首次立即拉一次，随后每 POLL_MS 轮询。 */
export function startPluginNotify(): void {
  if (timer) return;
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
}

/** 停止轮询并清理（登出时调用）。 */
export function stopPluginNotify(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  shown.clear();
  permProbed = false;
}
