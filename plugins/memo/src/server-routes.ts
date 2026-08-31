/**
 * 服务端扩展：备忘管理路由。
 * 挂载前缀由 server 统一收敛为 /api/plugins/memo/*。
 * 路由 key 用**纯路径**（宿主精确匹配 path），HTTP 方法在 handler 内用 req.method 判断。
 */

import type { ServerExtension, PluginRouteHandler } from '@agent-harness/core';
import { listNotes, saveNote, deleteNote } from './store';

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
        const note = saveNote(text, body.tag ? String(body.tag) : undefined);
        return json(res, 200, { ok: true, id: note.id });
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
  },
};
