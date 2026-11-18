/**
 * SSE 实时通道路由（自 server.ts 外迁，P2 模块化第八批）。
 *
 * 覆盖：
 *   GET /api/chat/stream → 聊天跨设备实时同步（按 owner 订阅 chat-bus）
 *   GET /api/events      → 备忘提醒 / 客服业务提醒实时推送（按 owner 订阅 reminder-bus）
 *
 * 两者共用同一套连接治理：
 *   - 鉴权 chat:read，anon 直接 401；
 *   - sseConnectionLock 上限闸（防恶意客户端耗尽连接槽）；
 *   - startSse 建立通道 + 即时 ready 帧；
 *   - 15s ping 心跳保活（防中间代理 60s 静默掐断）；
 *   - close 时 clearInterval + unsub + release（重复 unsub 安全）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  startSse,
  writeSseFrame,
  sendJsonError
} from '../http-helpers.js';
import { sseConnectionLock } from '../run-queue.js';
import { subscribeChatEvents } from '../chat-bus.js';
import { subscribeReminders } from '../reminder-bus.js';
import type { Action, AuthContext } from '../authz.js';

export interface SseRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action
  ) => Promise<AuthContext | null>;
}

export async function handleSseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: SseRouteDeps
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const guard = deps.guard;

  // ── 聊天跨设备实时同步通道 ──
  if (path === '/api/chat/stream') {
    const ctx = await guard(req, res, 'chat:read');
    if (!ctx) return true;
    if (ctx.sub === 'anon') {
      sendJsonError(res, 401, { error: 'authentication required for chat stream' }, req);
      return true;
    }
    // P1-3: SSE 连接数上限检查（防止恶意客户端耗尽连接）
    if (!sseConnectionLock.acquire()) {
      sendJsonError(res, 503, { error: 'too many sse connections' }, req);
      return true;
    }
    const send = startSse(res, req);
    // 连接建立即时确认，便于前端判定通道已就绪。
    send({ type: 'chat:ready', owner: ctx.sub });
    // P2 修复：补 SSE 保活心跳（此前注释声称「心跳保活」但实现无 ping）——长静默
    // 连接会被中间代理（nginx 默认 60s）掐断，且占用 SSE 连接槽位。注释帧对
    // SSE 解析透明（对齐 run-routes.ts 的 pingTimer 模式）。
    const ping = setInterval(() => {
      writeSseFrame(res, ': ping\n\n', () => res.writableEnded || res.destroyed);
    }, 15_000);
    ping.unref?.();
    const unsub = subscribeChatEvents(ctx.sub, (e) => {
      try {
        send(e);
      } catch {
        /* 连接已断，unsub 在 close 时执行 */
      }
    });
    res.on('close', () => {
      clearInterval(ping);
      try {
        unsub();
      } catch {
        /* 重复 unsub 安全 */
      }
      sseConnectionLock.release();
    });
    return true;
  }

  /* ------------- 插件事件实时广播通道（SSE，提醒即时推送） ------------- */
  // 前端登录后建立一条常驻 SSE：按 owner 订阅 reminder-bus，只收本用户的备忘提醒
  //（memo:reminder 事件携带 owner，跨用户不互见）。前端据此立即弹 ah-notification +
  // 浏览器桌面通知（替代纯轮询）。心跳保活，断线前端按指数退避重连，
  // 重连期间漏掉的提醒由前端轮询 /api/plugins/memo/reminders 兜底补发。
  if (path === '/api/events') {
    const ctx = await guard(req, res, 'chat:read');
    if (!ctx) return true;
    // P1-3: SSE 连接数上限检查
    if (!sseConnectionLock.acquire()) {
      sendJsonError(res, 503, { error: 'too many sse connections' }, req);
      return true;
    }
    const send = startSse(res, req);
    // 连接建立即时确认（带 owner，便于前端核对归属）。
    send({ type: 'events:ready', owner: ctx.sub });
    // P2 修复：补 SSE 保活心跳（同 chat/stream，注释帧对解析透明）。
    const ping = setInterval(() => {
      writeSseFrame(res, ': ping\n\n', () => res.writableEnded || res.destroyed);
    }, 15_000);
    ping.unref?.();
    // 支持 role 参数：role=service 订阅客服业务提醒，默认 role=user 订阅备忘提醒
    const role = url.searchParams.get('role') === 'service' ? 'service' : 'user';
    const unsub = subscribeReminders(ctx.sub, (e) => {
      try {
        send(e);
      } catch {
        /* 连接已断，unsub 在 close 时执行 */
      }
    }, role);
    res.on('close', () => {
      clearInterval(ping);
      try {
        unsub();
      } catch {
        /* 重复 unsub 安全 */
      }
      sseConnectionLock.release();
    });
    return true;
  }

  return false;
}
