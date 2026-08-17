import type { ServerExtension, PluginRouteHandler } from '@agent-harness/core';
import { fullStats, listLeads, assignLead } from '../store';

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

/** GET /api/plugins/medical-aesthetics-lead/stats —— 完整客资统计（漏斗 / 渠道 / 等级 / 队列）。 */
const stats: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  send(res, 200, fullStats());
};

/** GET /api/plugins/medical-aesthetics-lead/leads —— 客资明细 + 统计。 */
const leads: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  send(res, 200, { total: listLeads().length, stats: fullStats(), leads: listLeads().slice(0, 100) });
};

/** GET /api/plugins/medical-aesthetics-lead/handoffs —— 转人工队列（待认领）。 */
const handoffs: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const q = fullStats().handoffQueue.map((r) => ({ leadId: r.leadId, grade: r.grade, project: r.project, source: r.source }));
  send(res, 200, { queue: q, count: q.length });
};

/** GET /api/plugins/medical-aesthetics-lead/followups —— 待跟进队列（C 级 / 未转化）。 */
const followups: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const q = fullStats().followupQueue.map((r) => ({ leadId: r.leadId, grade: r.grade, channel: r.channel, project: r.project }));
  send(res, 200, { queue: q, count: q.length });
};

/** POST /api/plugins/medical-aesthetics-lead/leads/assign —— 分配客资给咨询师。 */
const assign: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const leadId = String(body.leadId ?? '');
  const consultant = String(body.consultant ?? '');
  if (!leadId) return send(res, 400, { error: 'leadId required' });
  const ok = assignLead(leadId, consultant);
  send(res, ok ? 200 : 409, { ok, consultant: ok ? consultant : undefined });
};

/** POST /api/plugins/medical-aesthetics-lead/handoffs/claim —— 坐席认领转人工客资。 */
const claim: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const leadId = String(body.leadId ?? '');
  const consultant = String(body.consultant ?? '');
  if (!leadId) return send(res, 400, { error: 'leadId required' });
  const ok = assignLead(leadId, consultant);
  send(res, ok ? 200 : 409, { ok, consultant: ok ? consultant : undefined });
};

/**
 * 客资插件服务端扩展：挂载 HTTP 路由。宿主把它们收敛到统一前缀
 * /api/plugins/medical-aesthetics-lead/*。宿主为精确路径匹配，故认领/分配用 body 传 id。
 */
export const leadServerExtension: ServerExtension = {
  id: 'medical-aesthetics-lead',
  mountRoutes: {
    '/stats': stats,
    '/leads': leads,
    '/handoffs': handoffs,
    '/followups': followups,
    '/leads/assign': assign,
    '/handoffs/claim': claim,
  },
};
