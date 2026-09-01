/**
 * 服务端扩展：备忘管理路由。
 * 挂载前缀由 server 统一收敛为 /api/plugins/memo/*。
 * 路由 key 用**纯路径**（宿主精确匹配 path），HTTP 方法在 handler 内用 req.method 判断。
 */

import type { ServerExtension, PluginRouteHandler } from '@agent-harness/core';
import {
  listNotes,
  saveNote,
  deleteNote,
  pendingReminders,
  upcomingReminders,
  reminderHistory,
  markNotified,
  resolveRemindAt,
} from './store';

function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveP) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolveP(data ? JSON.parse(data) : {});
      } catch {
        resolveP({});
      }
    });
  });
}

export const memoServerExtension: ServerExtension = {
  id: 'memo',
  mountRoutes: {
    // GET（列出）/ POST（新增）/api/plugins/memo/notes
    '/notes': (async (req, res) => {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: true, message: 'text required' });
        const remindAt = resolveRemindAt(body.remindAt, body.remindAtISO);
        const note = saveNote(text, body.tag ? String(body.tag) : undefined, remindAt ?? undefined);
        return json(res, 200, { ok: true, id: note.id, remindAt: note.remindAt ?? null });
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const tag = url.searchParams.get('tag') ?? undefined;
      const limit = Number(url.searchParams.get('limit') ?? 50);
      json(res, 200, { ok: true, notes: listNotes(tag, Number.isFinite(limit) ? limit : 50) });
    }) as PluginRouteHandler,

    // DELETE /api/plugins/memo/note?id=xxx
    '/note': ((req, res) => {
      if (req.method !== 'DELETE') {
        return json(res, 405, { error: true, message: 'method not allowed' });
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: true, message: 'id required' });
      const deleted = deleteNote(id);
      json(res, deleted ? 200 : 404, { ok: deleted });
    }) as PluginRouteHandler,

    // GET /api/plugins/memo/reminders
    // -> { pending: 已到期未通知, upcoming: 将来, history: 已触发过的提醒 }
    // 供前端轮询主动弹通知；history 供「提醒历史」回查错过窗口的提醒。
    '/reminders': ((req, res) => {
      if (req.method !== 'GET') {
        return json(res, 405, { error: true, message: 'method not allowed' });
      }
      const now = Date.now();
      json(res, 200, {
        ok: true,
        pending: pendingReminders(now).map(toReminderDto),
        upcoming: upcomingReminders(50).map(toReminderDto),
        history: reminderHistory(20).map(toReminderDto),
      });
    }) as PluginRouteHandler,

    // POST /api/plugins/memo/reminders/ack?id=xxx -> 标记某提醒已通知（落盘 notified）
    '/reminders/ack': ((req, res) => {
      if (req.method !== 'POST') {
        return json(res, 405, { error: true, message: 'method not allowed' });
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: true, message: 'id required' });
      const ok = markNotified(id);
      json(res, 200, { ok, notified: ok });
    }) as PluginRouteHandler,
  },
};

/** 提醒 DTO（前端友好的精简字段）。notifiedAt 仅「提醒历史」用（pending/upcoming 为 null）。 */
function toReminderDto(n: {
  id: string;
  text: string;
  tag?: string;
  remindAt?: number;
  notifiedAt?: number;
}) {
  return {
    id: n.id,
    text: n.text,
    tag: n.tag ?? null,
    remindAt: n.remindAt ?? null,
    notifiedAt: n.notifiedAt ?? null,
  };
}
