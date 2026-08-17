import type { ServerExtension, PluginRouteHandler } from '@agent-harness/core';
import {
  markHandoff,
  recordSatisfaction,
  recordIntent,
  claimHandoff,
  fullStats,
  handoffQueue,
} from '../store';

type Req = import('node:http').IncomingMessage;
type Res = import('node:http').ServerResponse;

/** 读取请求体，兼容 JSON 与 application/x-www-form-urlencoded（原生 <form> 提交无需 JS）。 */
function readBody(req: Req): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      const ct = String(req.headers['content-type'] ?? '').toLowerCase();
      try {
        if (ct.includes('application/json')) return resolve(JSON.parse(raw));
        if (ct.includes('application/x-www-form-urlencoded')) {
          const o: Record<string, unknown> = {};
          for (const [k, v] of new URLSearchParams(raw)) o[k] = v;
          return resolve(o);
        }
        // 兜底尝试 JSON
        return resolve(JSON.parse(raw));
      } catch {
        return resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function send(res: Res, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** POST /api/plugins/customer-service/handoff —— 转人工 / 创建工单。 */
const handoff: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const sessionId = String(body.sessionId ?? 'anonymous');
  const reason = String(body.reason ?? '用户要求转人工');
  markHandoff(sessionId);
  if (body.intent) recordIntent(sessionId, String(body.intent));
  send(res, 200, { ok: true, handedOff: true, ticketId: `TK_${Date.now().toString(36)}`, reason });
};

/** POST /api/plugins/customer-service/satisfaction —— 记录满意度评分。 */
const satisfaction: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const sessionId = String(body.sessionId ?? 'anonymous');
  const score = Number(body.score ?? 0);
  recordSatisfaction(sessionId, score);
  send(res, 200, { ok: true, score });
};

/** POST /api/plugins/customer-service/intent —— 上报意图分类（供管理后台统计）。 */
const intent: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  recordIntent(String(body.sessionId ?? 'anonymous'), String(body.intent ?? '其它'));
  send(res, 200, { ok: true });
};

/** GET /api/plugins/customer-service/stats —— 完整统计视图（M7 CsStats）。 */
const stats: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  send(res, 200, fullStats());
};

/** GET /api/plugins/customer-service/handoffs —— 转人工队列（未认领）。 */
const handoffs: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const q = handoffQueue().map((r) => ({
    sessionId: r.sessionId,
    lastIntent: r.lastIntent ?? null,
    updatedAt: r.updatedAt,
  }));
  send(res, 200, { queue: q, count: q.length });
};

/** POST /api/plugins/customer-service/handoffs/claim —— 坐席认领转人工工单。 */
const claim: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const sessionId = String(body.sessionId ?? '');
  const claimedBy = String(body.claimedBy ?? '');
  if (!sessionId) return send(res, 400, { error: 'sessionId required' });
  const ok = claimHandoff(sessionId, claimedBy);
  send(res, ok ? 200 : 409, { ok, claimedBy: ok ? claimedBy : undefined });
};

/**
 * 客服插件服务端扩展：挂载 HTTP 路由。宿主（ServerPluginHost）把它们收敛到
 * 统一前缀 /api/plugins/customer-service/*，平台侧控制前缀与准入，插件只声明相对路径。
 * 注意：宿主为精确路径匹配，故认领接口用 body 传 sessionId，而非动态 :id 路径参数。
 */
export const csServerExtension: ServerExtension = {
  id: 'customer-service',
  mountRoutes: {
    '/handoff': handoff,
    '/satisfaction': satisfaction,
    '/intent': intent,
    '/stats': stats,
    '/handoffs': handoffs,
    '/handoffs/claim': claim,
  },
};
