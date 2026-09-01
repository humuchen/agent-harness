/**
 * 服务端扩展：备忘管理路由。
 * 挂载前缀由 server 统一收敛为 /api/plugins/memo/*。
 * 路由 key 用**纯路径**（宿主精确匹配 path），HTTP 方法在 handler 内用 req.method 判断。
 *
 * 用户绑定：宿主（server）鉴权后把当前登录用户作为第三参传入；所有读写均以
 * user.sub 为 owner 收口，跨用户不可互见。宿主未传（极老版本/内网直连）时兜底
 * 'anon' 桶——数据仍落库，但仅开放模式可见，不影响登录用户数据。
 */

import type { ServerExtension, PluginRouteHandler, PluginRouteUser } from '@agent-harness/core';
import {
  listNotes,
  saveNote,
  deleteNote,
  pendingReminders,
  upcomingReminders,
  reminderHistory,
  markNotified,
  resolveRemindAt,
  searchNotes,
  noteStats,
  deleteNotes,
  deleteAllOwnerNotes,
} from './store';
import { boardBodyHtml, BOARD_PAGE } from './web-view';

/** 从宿主注入的用户解析数据归属 owner。 */
function ownerOf(user?: PluginRouteUser): string {
  return user?.sub ? String(user.sub) : 'anon';
}

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
    // GET（列出/检索，仅当前用户）/ POST（新增，归属当前用户）/api/plugins/memo/notes
    //   GET 参数：tag（标签过滤）、q（关键词模糊）、limit、offset（分页）；返回 {notes, total}
    //   （listNotes 与 searchNotes 同源：均按 owner 收口，只是 GET 支持关键词+分页检索）
    '/notes': (async (req, res, user) => {
      const owner = ownerOf(user);
      if (req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: true, message: 'text required' });
        const remindAt = resolveRemindAt(body.remindAt, body.remindAtISO);
        const note = await saveNote(owner, text, body.tag ? String(body.tag) : undefined, remindAt ?? undefined);
        return json(res, 200, { ok: true, id: note.id, remindAt: note.remindAt ?? null });
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const tag = url.searchParams.get('tag') ?? undefined;
      const q = url.searchParams.get('q') ?? undefined;
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const sortRaw = url.searchParams.get('sort');
      const sort = sortRaw === 'oldest' || sortRaw === 'remind' ? sortRaw : 'newest';
      const { items, total } = await searchNotes(owner, {
        tag,
        q,
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
        sort,
      });
      json(res, 200, { ok: true, owner, notes: items, total });
    }) as PluginRouteHandler,

    // GET /api/plugins/memo/board -> 数据管理表体片段（表格 + 分页器），供看板异步检索/翻页替换 #memo-mgmt-body。
    //   参数：q（关键词）、tag、sort、offset、limit（默认 BOARD_PAGE=20）。仅返回当前 owner 数据。
    //   返回 JSON { ok, owner, html, total, offset, limit, count }，html 为可直接注入的整块表体。
    '/board': (async (req, res, user) => {
      if (req.method !== 'GET') {
        return json(res, 405, { error: true, message: 'method not allowed' });
      }
      const owner = ownerOf(user);
      const url = new URL(req.url ?? '', 'http://localhost');
      const q = url.searchParams.get('q') ?? undefined;
      const tag = url.searchParams.get('tag') ?? undefined;
      const sortRaw = url.searchParams.get('sort');
      const sort = sortRaw === 'oldest' || sortRaw === 'remind' ? sortRaw : 'newest';
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? BOARD_PAGE) || BOARD_PAGE));
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
      const { items, total } = await searchNotes(owner, { tag, q, sort, limit, offset });
      const html = boardBodyHtml({ items, total, offset, limit });
      json(res, 200, { ok: true, owner, html, total, offset, limit, count: items.length });
    }) as PluginRouteHandler,

    // GET /api/plugins/memo/stats -> 当前用户备忘统计 {total, tagged, withReminder, history}
    '/stats': (async (req, res, user) => {
      if (req.method !== 'GET') {
        return json(res, 405, { error: true, message: 'method not allowed' });
      }
      const owner = ownerOf(user);
      const stats = await noteStats(owner);
      json(res, 200, { ok: true, owner, stats });
    }) as PluginRouteHandler,

    // DELETE /api/plugins/memo/notes/batch  body:{ids:[...]} -> 批量删除（按 owner+id 收口，越权忽略）
    '/notes/batch': (async (req, res, user) => {
      if (req.method !== 'DELETE') {
        return json(res, 405, { error: true, message: 'method not allowed' });
      }
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String) : [];
      const removed = await deleteNotes(ownerOf(user), ids);
      json(res, 200, { ok: true, removed });
    }) as PluginRouteHandler,

    // DELETE /api/plugins/memo/notes/all  body:{confirm:true} -> 清空当前用户全部备忘（需二次确认）
    '/notes/all': (async (req, res, user) => {
      if (req.method !== 'DELETE') {
        return json(res, 405, { error: true, message: 'method not allowed' });
      }
      const body = await readBody(req);
      if (body.confirm !== true) {
        return json(res, 400, { error: true, message: 'requires {confirm:true}' });
      }
      const removed = await deleteAllOwnerNotes(ownerOf(user));
      json(res, 200, { ok: true, removed });
    }) as PluginRouteHandler,

    // DELETE /api/plugins/memo/note?id=xxx（仅当前用户自己的备忘可删）
    '/note': (async (req, res, user) => {
      if (req.method !== 'DELETE') {
        return json(res, 405, { error: true, message: 'method not allowed' });
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: true, message: 'id required' });
      const deleted = await deleteNote(ownerOf(user), id);
      json(res, deleted ? 200 : 404, { ok: deleted });
    }) as PluginRouteHandler,

    // GET /api/plugins/memo/reminders（仅当前用户）
    // -> { pending: 已到期未通知, upcoming: 将来, history: 已触发过的提醒 }
    // 供前端轮询主动弹通知；history 供「提醒历史」回查错过窗口的提醒。
    '/reminders': (async (req, res, user) => {
      if (req.method !== 'GET') {
        return json(res, 405, { error: true, message: 'method not allowed' });
      }
      const owner = ownerOf(user);
      const now = Date.now();
      const [pending, upcoming, history] = await Promise.all([
        pendingReminders(now),
        upcomingReminders(owner, 50),
        reminderHistory(owner, 20),
      ]);
      json(res, 200, {
        ok: true,
        owner,
        pending: pending.filter((n) => n.owner === owner).map(toReminderDto),
        upcoming: upcoming.map(toReminderDto),
        history: history.map(toReminderDto),
      });
    }) as PluginRouteHandler,

    // POST /api/plugins/memo/reminders/ack?id=xxx -> 标记某提醒已通知（落库 notified）
    '/reminders/ack': (async (req, res, user) => {
      if (req.method !== 'POST') {
        return json(res, 405, { error: true, message: 'method not allowed' });
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: true, message: 'id required' });
      const ok = await markNotified(ownerOf(user), id);
      json(res, 200, { ok, notified: ok });
    }) as PluginRouteHandler,
  },
};

/** 提醒 DTO（前端友好的精简字段）。notifiedAt 仅「提醒历史」用（pending/upcoming 为 null）。 */
function toReminderDto(n: {
  id: string;
  owner: string;
  text: string;
  tag?: string;
  remindAt?: number;
  notifiedAt?: number;
}) {
  return {
    id: n.id,
    owner: n.owner,
    text: n.text,
    tag: n.tag ?? null,
    remindAt: n.remindAt ?? null,
    notifiedAt: n.notifiedAt ?? null,
  };
}
