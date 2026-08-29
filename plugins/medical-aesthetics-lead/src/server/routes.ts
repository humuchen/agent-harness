import type { ServerExtension, PluginRouteHandler } from '@agent-harness/core';
import { computeStats, listLeads, assignConsultant } from '../repo/lead-repo';
import { saveInbound, markInboundState } from '../repo/inbound-repo';
import { outboxSnapshot } from '../services/outbox-worker';
import { importProjects, listKnowledge } from '../services/kb-service';
import { upsertClinic, upsertSlot, setAppointmentExternal, getAppointmentByExternalId, getAppointment } from '../repo/schedule-repo';
import { markCrmSync } from '../repo/lead-repo';
import { getConfig, configSummary } from '../config';
import { dbHealth } from '../infra/db';
import { verifyWebhook, verifyAdminToken } from '../infra/signature';
import { toMaError } from '../infra/errors';
import { getPluginContext } from '../runtime';
import { makeTaskId } from '@agent-harness/core';

type Req = import('node:http').IncomingMessage;
type Res = import('node:http').ServerResponse;

/** 读取请求体：同时返回原始串（供验签）与 JSON 解析结果。 */
function readRawBody(req: Req): Promise<{ raw: string; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      let json: Record<string, unknown> = {};
      if (raw) {
        const ct = String(req.headers['content-type'] ?? '').toLowerCase();
        try {
          if (ct.includes('application/x-www-form-urlencoded')) {
            const o: Record<string, unknown> = {};
            for (const [k, v] of new URLSearchParams(raw)) o[k] = v;
            json = o;
          } else {
            json = JSON.parse(raw);
          }
        } catch {
          json = {};
        }
      }
      resolve({ raw, json });
    });
    req.on('error', () => resolve({ raw: '', json: {} }));
  });
}

function send(res: Res, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// 只读统计 / 明细（真实 SQL 聚合）
// ---------------------------------------------------------------------------

/** GET /stats —— 完整客资统计（漏斗 / 渠道 / 等级 / 队列 / CRM 同步健康）。 */
const stats: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const [stats, ob] = await Promise.all([computeStats(), outboxSnapshot()]);
  send(res, 200, { ...stats, outbox: ob });
};

/** GET /leads —— 客资明细 + 统计。 */
const leads: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const [stats, all, page] = await Promise.all([computeStats(), listLeads(), listLeads(100, 0)]);
  send(res, 200, { total: all.length, stats, leads: page });
};

/** GET /handoffs —— 转人工队列（待认领）。 */
const handoffs: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const s = await Promise.resolve(computeStats());
  const q = s.handoffQueue.map((r) => ({
    leadId: r.leadId,
    grade: r.grade,
    project: r.project,
    intent: r.intent,
    city: r.city,
  }));
  send(res, 200, { queue: q, count: q.length });
};

/** GET /followups —— 待跟进队列（C 级 / 未转化）。 */
const followups: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const s = await Promise.resolve(computeStats());
  const q = s.followupQueue.map((r) => ({
    leadId: r.leadId,
    grade: r.grade,
    channel: r.channel,
    project: r.project,
    intent: r.intent,
  }));
  send(res, 200, { queue: q, count: q.length });
};

/** GET /health —— 库健康 + 配置摘要（脱敏）。 */
const health: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const [db, ob] = await Promise.all([dbHealth(), outboxSnapshot()]);
  send(res, 200, { ok: true, db, config: configSummary(), outbox: ob });
};

/** GET /config —— 配置摘要（脱敏）。 */
const configRoute: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  send(res, 200, configSummary());
};

/** GET /kb —— 知识库项目清单（真实数据）。 */
const kbList: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const items = listKnowledge(true).map((p) => ({ projectId: p.projectId, name: p.name, category: p.category }));
  send(res, 200, { total: items.length, projects: items });
};

// ---------------------------------------------------------------------------
// 写操作：认领 / 分配 / 导入 / webhook
// ---------------------------------------------------------------------------

/** POST /leads/assign —— 分配客资给咨询师。 */
const assign: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const { json } = await readRawBody(req);
  const leadId = String(json.leadId ?? '');
  const consultant = String(json.consultant ?? '');
  if (!leadId) return send(res, 400, { error: 'leadId required' });
  const ok = assignConsultant(leadId, consultant);
  send(res, ok ? 200 : 409, { ok, consultant: ok ? consultant : undefined });
};

/** POST /handoffs/claim —— 坐席认领转人工客资。 */
const claim: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const { json } = await readRawBody(req);
  const leadId = String(json.leadId ?? '');
  const consultant = String(json.consultant ?? '');
  if (!leadId) return send(res, 400, { error: 'leadId required' });
  const ok = assignConsultant(leadId, consultant);
  send(res, ok ? 200 : 409, { ok, consultant: ok ? consultant : undefined });
};

/** POST /kb/import —— 导入知识库项目（需管理令牌；源码不内置，须由运营/外部服务写入）。 */
const kbImport: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  try {
    verifyAdminToken(getConfig().adminToken, req.headers as Record<string, string | string[] | undefined>);
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
  const { json } = await readRawBody(req);
  const projects = (Array.isArray(json.projects) ? json.projects : []) as Record<string, unknown>[];
  if (!projects.length) return send(res, 400, { error: 'projects[] required' });
  try {
    const n = importProjects(
      projects.map((p) => ({
        projectId: String(p.projectId ?? p.id ?? ''),
        name: String(p.name ?? ''),
        category: p.category ? String(p.category) : undefined,
        aliases: Array.isArray(p.aliases) ? (p.aliases as string[]) : [],
        summary: String(p.summary ?? ''),
        indications: p.indications ? String(p.indications) : undefined,
        contraindications: p.contraindications ? String(p.contraindications) : undefined,
        recovery: p.recovery ? String(p.recovery) : undefined,
        priceRange: p.priceRange ? String(p.priceRange) : undefined,
        faq: Array.isArray(p.faq)
          ? (p.faq as unknown[]).map((f) =>
              typeof f === 'string' ? { q: f } : { q: String((f as Record<string, unknown>).q ?? ''), a: (f as Record<string, unknown>).a ? String((f as Record<string, unknown>).a) : undefined }
            )
          : [],
        source: p.source ? String(p.source) : 'import',
        active: p.active !== false,
        updatedAt: Date.now(),
      }))
    );
    send(res, 200, { ok: true, imported: n });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /clinics/import —— 导入院区（需管理令牌）。 */
const clinicImport: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  try {
    verifyAdminToken(getConfig().adminToken, req.headers as Record<string, string | string[] | undefined>);
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
  const { json } = await readRawBody(req);
  const clinics = (Array.isArray(json.clinics) ? json.clinics : []) as Record<string, unknown>[];
  if (!clinics.length) return send(res, 400, { error: 'clinics[] required' });
  try {
    let n = 0;
    for (const c of clinics) {
      upsertClinic({
        clinicId: String(c.clinicId ?? c.id ?? ''),
        name: String(c.name ?? ''),
        city: c.city ? String(c.city) : undefined,
        address: c.address ? String(c.address) : undefined,
        phone: c.phone ? String(c.phone) : undefined,
        active: c.active !== false,
      });
      n += 1;
    }
    send(res, 200, { ok: true, imported: n });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /slots/import —— 导入号源（需管理令牌）。 */
const slotImport: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  try {
    verifyAdminToken(getConfig().adminToken, req.headers as Record<string, string | string[] | undefined>);
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
  const { json } = await readRawBody(req);
  const slots = (Array.isArray(json.slots) ? json.slots : []) as Record<string, unknown>[];
  if (!slots.length) return send(res, 400, { error: 'slots[] required' });
  try {
    let n = 0;
    for (const s of slots) {
      upsertSlot({
        slotId: String(s.slotId ?? s.id ?? ''),
        clinicId: String(s.clinicId ?? ''),
        date: String(s.date ?? ''),
        time: String(s.time ?? ''),
        capacity: typeof s.capacity === 'number' ? s.capacity : undefined,
        doctor: s.doctor ? String(s.doctor) : undefined,
        status: s.status === 'closed' ? 'closed' : 'open',
      });
      n += 1;
    }
    send(res, 200, { ok: true, imported: n });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/**
 * POST /webhook —— 渠道入站消息入口（真实链路起点）。
 * 流程：HMAC 验签 → 落库去重 → 经 A2A 触发本插件 agent 处理。
 * 验签失败 / 缺密钥一律拒绝（无鉴权裸奔入口不允许）。
 */
const webhook: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const { raw, json } = await readRawBody(req);
  // 1) 验签（密钥缺失 → NOT_CONFIGURED；签名错/超时 → UNAUTHORIZED）
  try {
    verifyWebhook(getConfig().webhookSecret, req.headers as Record<string, string | string[] | undefined>, raw);
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
  // 2) 落库（UNIQUE 去重防重放）
  const channel = String(json.channel ?? 'unknown');
  const externalId = String(json.externalId ?? '');
  if (!externalId) return send(res, 400, { ok: false, code: 'INVALID_ARGUMENT', error: 'externalId required' });
  const inbound = saveInbound({
    channel,
    externalId,
    leadKey: String(json.leadKey ?? externalId),
    text: String(json.text ?? ''),
  });
  markInboundState(inbound.id, 'dispatched');
  // 3) 经 A2A 触发 agent（异步、fire-and-forget；失败不丢消息，仍可重试）
  const ctx = getPluginContext();
  const baseUrl = getConfig().a2a.baseUrl;
  let dispatched = false;
  if (ctx?.a2a && baseUrl) {
    try {
      await ctx.a2a.send(
        {
          taskId: makeTaskId(),
          tenantId: getConfig().tenantId,
          fromAgent: 'webhook',
          toAgent: 'medical-aesthetics-lead',
          input: { channel, text: json.text, inboundId: inbound.id },
        },
        baseUrl
      );
      dispatched = true;
    } catch (e) {
      markInboundState(inbound.id, 'error', undefined, String((e as Error).message));
    }
  }
  send(res, 202, { ok: true, accepted: true, inboundId: inbound.id, dispatched });
};

/**
 * POST /callback —— 外部系统下行回写 / 状态回执入口（反向通道）。
 * 用于 HIS/CRM 在异步处理后把结果推回：如预约在 HIS 侧被确认/取消、CRM 侧线索状态变更。
 * 复用与入站 webhook 相同的 HMAC 验签（MA_WEBHOOK_SECRET），无密钥则全拒。
 */
const callback: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const { raw, json } = await readRawBody(req);
  try {
    verifyWebhook(getConfig().webhookSecret, req.headers as Record<string, string | string[] | undefined>, raw);
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
  const type = String(json.type ?? '');
  try {
    if (type === 'appt.status') {
      // 解析预约单：优先 appointmentId，其次 externalId 反查
      const apptId = String(json.appointmentId ?? '');
      const extId = String(json.externalId ?? '');
      const appt =
        (apptId && getAppointment(apptId)) ||
        (extId && getAppointmentByExternalId(extId)) ||
        null;
      if (!appt) {
        return send(res, 404, { ok: false, code: 'NOT_FOUND', error: '预约单不存在（appointmentId/externalId 均未匹配）' });
      }
      setAppointmentExternal(appt.appointmentId, extId || undefined, String(json.status ?? 'confirmed'));
      return send(res, 200, { ok: true, appointmentId: appt.appointmentId, externalStatus: json.status });
    }
    if (type === 'lead.status') {
      const leadId = String(json.leadId ?? '');
      if (!leadId) return send(res, 400, { ok: false, code: 'INVALID_ARGUMENT', error: 'leadId required' });
      const state = String(json.status ?? '') === 'failed' ? 'failed' : 'synced';
      markCrmSync(leadId, state, json.crmId ? String(json.crmId) : undefined);
      return send(res, 200, { ok: true, leadId, crmSync: state });
    }
    return send(res, 400, { ok: false, code: 'INVALID_ARGUMENT', error: `未知回调类型：${type}` });
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
};

/**
 * 客资插件服务端扩展：挂载 HTTP 路由。宿主把它们收敛到统一前缀
 * /api/plugins/medical-aesthetics-lead/*。
 */
export const leadServerExtension: ServerExtension = {
  id: 'medical-aesthetics-lead',
  mountRoutes: {
    '/stats': stats,
    '/leads': leads,
    '/handoffs': handoffs,
    '/followups': followups,
    '/health': health,
    '/config': configRoute,
    '/kb': kbList,
    '/leads/assign': assign,
    '/handoffs/claim': claim,
    '/kb/import': kbImport,
    '/clinics/import': clinicImport,
    '/slots/import': slotImport,
    '/webhook': webhook,
    '/callback': callback,
  },
};
