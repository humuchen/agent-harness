/**
 * 服务端扩展：客服看板 / 工单 / 知识库管理路由。
 * 挂载前缀由 server 统一为 /api/plugins/customer-service/*。
 * 路由 key 用**纯路径**（宿主精确匹配 path），HTTP 方法在 handler 内用 req.method 判断。
 */
import type { ServerExtension, PluginRouteHandler } from '@agent-harness/core';
import { listTickets, getTicket, updateTicket } from '../repo/ticket-repo';
import { listSessions } from '../repo/session-repo';
import { searchKb, insertKb } from '../repo/kb-repo';
import { listPendingReminders, updateReminderStatus } from '../repo/reminder-repo';
import { getConfig } from '../config';

/** 简单 JSON 响应助手。 */
function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** 读取请求体（JSON）。 */
function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** 校验 admin token（写操作）。 */
function authorized(req: import('node:http').IncomingMessage): boolean {
  const auth = req.headers['authorization'] ?? '';
  const token = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '';
  return token.length > 0 && token === getConfig().adminToken;
}

export const csServerExtension: ServerExtension = {
  id: 'customer-service',
  mountRoutes: {
    // GET /api/plugins/customer-service/stats —— 看板概览
    '/stats': (async (_req, res) => {
      const tickets = await Promise.resolve(listTickets(undefined, 1000));
      const sessions = await Promise.resolve(listSessions(1000));
      const open = tickets.filter((t) => t.status === 'open').length;
      const handoff = sessions.filter((s) => s.status === 'handoff').length;
      json(res, 200, {
        tickets: { total: tickets.length, open },
        sessions: { total: sessions.length, handoff },
        tenantId: getConfig().tenantId,
      });
    }) as PluginRouteHandler,

    // GET /api/plugins/customer-service/tickets?status=open
    '/tickets': (async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const status = url.searchParams.get('status') ?? undefined;
      const rows = await Promise.resolve(listTickets(status ?? undefined, 200));
      json(res, 200, rows);
    }) as PluginRouteHandler,

    // GET /api/plugins/customer-service/ticket?id=xxx
    '/ticket': ((req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: true, message: 'id required' });
      json(res, 200, getTicket(id) ?? { error: true, message: 'not found' });
    }) as PluginRouteHandler,

    // POST /api/plugins/customer-service/ticket/status —— 改状态/认领（需 admin）
    '/ticket/status': (async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: true, message: 'method not allowed' });
      if (!authorized(req)) return json(res, 401, { error: true, message: 'unauthorized' });
      const body = await readBody(req);
      const id = String(body.ticketId ?? '');
      const patch: { status?: string; assignee?: string } = {};
      if (body.status) patch.status = String(body.status);
      if (body.assignee !== undefined) patch.assignee = String(body.assignee);
      const updated = updateTicket(id, patch);
      json(res, updated ? 200 : 404, updated ?? { error: true, message: 'not found' });
    }) as PluginRouteHandler,

    // GET（检索）/ POST（写入） /api/plugins/customer-service/kb
    '/kb': (async (req, res) => {
      if (req.method === 'POST') {
        if (!authorized(req)) return json(res, 401, { error: true, message: 'unauthorized' });
        const body = await readBody(req);
        if (!body.question || !body.answer)
          return json(res, 400, { error: true, message: 'question & answer required' });
        const row = insertKb({
          question: String(body.question),
          answer: String(body.answer),
          category: body.category ? String(body.category) : undefined,
        });
        return json(res, 200, { kbId: row.kbId });
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const q = url.searchParams.get('q') ?? '';
      json(res, 200, q ? searchKb(q, 10) : []);
    }) as PluginRouteHandler,

    // GET /api/plugins/customer-service/reminders —— 查询待处理提醒
    '/reminders': (async (_req, res) => {
      const rows = await Promise.resolve(listPendingReminders(50));
      json(res, 200, rows);
    }) as PluginRouteHandler,

    // POST /api/plugins/customer-service/reminders —— 更新提醒状态
    '/reminder': (async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: true, message: 'method not allowed' });
      const body = await readBody(req);
      const id = String(body.id ?? '');
      const action = String(body.action ?? 'reminded');
      if (!id) return json(res, 400, { error: true, message: 'id required' });
      const status = action === 'ignored' ? 'ignored' : 'reminded';
      const updated = await Promise.resolve(updateReminderStatus(id, status));
      json(res, updated ? 200 : 404, updated ? { ok: true, id, status } : { error: true, message: 'not found' });
    }) as PluginRouteHandler,
  },
};
