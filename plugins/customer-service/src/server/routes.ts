/**
 * 服务端扩展：客服看板 / 工单 / 知识库管理路由。
 * 挂载前缀由 server 统一为 /api/plugins/customer-service/*。
 * 路由 key 用**纯路径**（宿主精确匹配 path），HTTP 方法在 handler 内用 req.method 判断。
 */
import type { ServerExtension, PluginRouteHandler } from '@agent-harness/core';
import { readJsonBody, safeEqual, jsonReply } from '@agent-harness/core';
import { listTickets, getTicket, updateTicket } from '../repo/ticket-repo';
import { listSessions } from '../repo/session-repo';
import { listSeats, upsertSeat, setSeatStatus, setSeatMaxConcurrent } from '../repo/seat-repo';
import { claim as claimHandoff } from '../services/session-service';
import { search as searchKbSvc, add as addKbSvc } from '../services/kb-service';
import { listPendingReminders, updateReminderStatus } from '../repo/reminder-repo';
import { getConfig } from '../config';

/** P1#24：JSON 响应助手委托 kit 的 jsonReply（三插件统一口径）；调用点保持 json 名不变。 */
const json = jsonReply;

/** P1#25：请求体读取委托 kit 的 readJsonBody（统一安全基线）；保留 CS_MAX_BODY_BYTES
 *  差异化配置入口（默认与 kit 一致 1MB）。 */
const MAX_BODY_BYTES = Number(process.env.CS_MAX_BODY_BYTES ?? 1_048_576) || 1_048_576;
const readBody = (req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> =>
  readJsonBody(req, { maxBytes: MAX_BODY_BYTES });

/** 校验 admin token（写操作）：P1#25 换 kit 的 safeEqual（恒定时间比较，全插件口径统一）。 */
function authorized(req: import('node:http').IncomingMessage): boolean {
  const auth = req.headers['authorization'] ?? '';
  const token = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '';
  const expected = getConfig().adminToken;
  if (!token || !expected) return false;
  return safeEqual(token, expected);
}

/** PII 掩码：姓名保留首字符，其余打码。 */
function maskName(v: string | null): string | null {
  if (!v) return v;
  return v.slice(0, 1) + '*'.repeat(Math.max(1, v.length - 1));
}

/** PII 掩码：电话保留前 3 后 4，其余打码。 */
function maskPhone(v: string | null): string | null {
  if (!v) return v;
  const digits = v.replace(/\D/g, '');
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return '*'.repeat(Math.max(digits.length, 4));
}

export const csServerExtension: ServerExtension = {
  id: 'customer-service',
  mountRoutes: {
    // 增强坐席池：GET 列表（负载升序）/ POST 注册或改名（admin）
    '/seats': (async (req, res) => {
      if (req.method === 'POST') {
        if (!authorized(req)) return json(res, 401, { error: true, message: 'unauthorized' });
        const body = await readBody(req);
        const seatId = String(body.seatId ?? '').trim();
        const name = String(body.name ?? '').trim();
        if (!seatId || !name) return json(res, 400, { error: true, message: 'seatId & name required' });
        return json(res, 200, upsertSeat({ seatId, name }));
      }
      if (req.method !== 'GET') return json(res, 405, { error: true, message: 'method not allowed' });
      json(res, 200, { seats: listSeats(100) });
    }) as PluginRouteHandler,

    // 增强坐席池：POST /seat/status {seatId, status: online|offline}（admin）
    '/seat/status': (async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: true, message: 'method not allowed' });
      if (!authorized(req)) return json(res, 401, { error: true, message: 'unauthorized' });
      const body = await readBody(req);
      const seatId = String(body.seatId ?? '').trim();
      const status = body.status === 'online' ? 'online' : body.status === 'offline' ? 'offline' : null;
      if (!seatId || !status) return json(res, 400, { error: true, message: 'seatId & status(online|offline) required' });
      const seat = setSeatStatus(seatId, status);
      return json(res, seat ? 200 : 404, seat ?? { error: true, message: 'seat not found' });
    }) as PluginRouteHandler,

    // 增强坐席池：POST /seat/max-concurrent {seatId, max}（admin）—— 并发上限调整
    '/seat/max-concurrent': (async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: true, message: 'method not allowed' });
      if (!authorized(req)) return json(res, 401, { error: true, message: 'unauthorized' });
      const body = await readBody(req);
      const seatId = String(body.seatId ?? '').trim();
      const max = Number(body.max);
      if (!seatId || !Number.isFinite(max) || max < 1) {
        return json(res, 400, { error: true, message: 'seatId & max(>=1) required' });
      }
      const seat = setSeatMaxConcurrent(seatId, max);
      return json(res, seat ? 200 : 404, seat ?? { error: true, message: 'seat not found' });
    }) as PluginRouteHandler,

    // 增强坐席池：POST /handoff/claim {seatId, sessionId?}（admin）—— 坐席认领
    // 未指派的 handoff 会话；sessionId 缺省自动取最老的等待会话。
    '/handoff/claim': (async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: true, message: 'method not allowed' });
      if (!authorized(req)) return json(res, 401, { error: true, message: 'unauthorized' });
      const body = await readBody(req);
      const seatId = String(body.seatId ?? '').trim();
      if (!seatId) return json(res, 400, { error: true, message: 'seatId required' });
      try {
        const sess = claimHandoff({
          seatId,
          sessionId: body.sessionId ? String(body.sessionId) : undefined,
        });
        return json(res, 200, { ok: true, sessionId: sess.sessionId, assignedSeat: sess.assignedSeat });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const notFound = /不存在/.test(msg);
        return json(res, notFound ? 404 : 409, { error: true, message: msg });
      }
    }) as PluginRouteHandler,

    // GET /api/plugins/customer-service/stats —— 看板概览
    '/stats': (async (_req, res) => {
      const tickets = await Promise.resolve(listTickets(undefined, 1000));
      const sessions = await Promise.resolve(listSessions(1000));
      const open = tickets.filter((t) => t.status === 'open').length;
      const handoff = sessions.filter((s) => s.status === 'handoff').length;
      // 增强（工单运营闭环）：SLA 超时未结单数 + CSAT 均分（已评工单）
      const overdue = tickets.filter((t) => t.slaBreached).length;
      const rated = tickets.filter((t) => t.rating != null);
      // 增强坐席池：在线坐席数（含 busy）
      const seats = listSeats(200);
      const seatsOnline = seats.filter((s) => s.status !== 'offline').length;
      const csatAvg = rated.length
        ? Number((rated.reduce((s, t) => s + (t.rating ?? 0), 0) / rated.length).toFixed(2))
        : null;
      json(res, 200, {
        tickets: { total: tickets.length, open, overdue },
        sessions: { total: sessions.length, handoff },
        seats: { total: seats.length, online: seatsOnline },
        csat: { ratedCount: rated.length, avg: csatAvg },
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

    // GET /api/plugins/customer-service/ticket?id=xxx（P1 鉴权修复：工单明细此前
    // 任意可读，配合旧版弱随机工单号可被枚举遍历；列表接口 /tickets 同口径已放行
    // ——明细含客户对话内容，需 admin token。）
    '/ticket': ((req, res) => {
      if (!authorized(req)) return json(res, 401, { error: true, message: 'unauthorized' });
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
    // 短期：检索走 service（RAG 语义优先 → 本地 LIKE 降级）；POST 落库后尽力镜像 RAG。
    '/kb': (async (req, res) => {
      if (req.method === 'POST') {
        if (!authorized(req)) return json(res, 401, { error: true, message: 'unauthorized' });
        const body = await readBody(req);
        if (!body.question || !body.answer)
          return json(res, 400, { error: true, message: 'question & answer required' });
        const row = await addKbSvc({
          question: String(body.question),
          answer: String(body.answer),
          category: body.category ? String(body.category) : undefined,
        });
        return json(res, 200, { kbId: row.kbId });
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const q = url.searchParams.get('q') ?? '';
      json(res, 200, q ? await searchKbSvc({ query: q, limit: 10 }) : []);
    }) as PluginRouteHandler,

    // GET /api/plugins/customer-service/reminders —— 查询待处理提醒
    // P0 安全修复：补鉴权（此前漏加，任何来源可枚举拉取含姓名/手机号的患者回访名单）
    // 并对返回的 name/phone 做掩码——看板前端走 dashboard.ts 内部调用不受影响。
    '/reminders': (async (req, res) => {
      if (!authorized(req)) return json(res, 401, { error: true, message: 'unauthorized' });
      const rows = (await Promise.resolve(listPendingReminders(50))).map((r) => ({
        ...r,
        name: maskName(r.name),
        phone: maskPhone(r.phone)
      }));
      json(res, 200, rows);
    }) as PluginRouteHandler,

    // POST /api/plugins/customer-service/reminders —— 更新提醒状态（P1 安全修复：补鉴权，
    // 与同文件 /ticket/status、/kb POST 对齐——此前漏加，任何来源可将提醒置为已处理掩盖待办）。
    '/reminder': (async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: true, message: 'method not allowed' });
      if (!authorized(req)) return json(res, 401, { error: true, message: 'unauthorized' });
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
