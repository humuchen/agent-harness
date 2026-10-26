import type { ServerExtension, PluginRouteHandler } from '@agent-harness/core';
import { computeStats, listLeads, assignConsultant } from '../repo/lead-repo';
import { saveInbound, markInboundState } from '../repo/inbound-repo';
import { outboxSnapshot } from '../services/outbox-worker';
import { importProjects, listKnowledge } from '../services/kb-service';
import { upsertClinic, upsertSlot, setAppointmentExternal, getAppointmentByExternalId, getAppointment, markArrived, markCompleted, listAppointmentsByDate } from '../repo/schedule-repo';
import { markCrmSync } from '../repo/lead-repo';
import { listGuardHits, guardHitStats, reviewGuardHit } from '../repo/guard-hits-repo';
import { getConfig, configSummary } from '../config';
import { dbHealth } from '../infra/db';
import { verifyWebhook, verifyAdminToken } from '../infra/signature';
import { toMaError } from '../infra/errors';
import { getPluginContext } from '../runtime';
import { makeTaskId } from '@agent-harness/core';
import { runAnalyticsQuery } from '../analytics/analytics-service';
import type { AnalyticsQuery, AnalyticsResult } from '../analytics/types';
import { schedulerSnapshot, schedulerTick, scheduleManualJob } from '../services/scheduler-service';
import { latestDailyReport } from '../services/report-service';
import { upsertAdSpend, listAdSpend, adSpendStats } from '../repo/ad-spend-repo';
import { suggestionSnapshot, reviewSuggestion, markSuggestionExecuted } from '../services/strategy-service';
import {
  contentSnapshot,
  generateTemplateContent,
  createManualDraft,
  submitContent,
  approveContent,
  rejectContent,
  publishContent,
} from '../services/content-service';
import type { ContentState, ContentPlatform } from '../repo/content-repo';
import { buildLeadBriefing, revealContact } from '../services/assist-service';
import { listExperiments, getExperiment, createExperiment, stopExperiment, assignVariant, experimentReport } from '../services/ab-service';

type Req = import('node:http').IncomingMessage;
type Res = import('node:http').ServerResponse;

/** 读取请求体：同时返回原始串（供验签）与 JSON 解析结果。
 *  P1 资源修复：加字节上限（默认 1MB，可用 MA_MAX_BODY_BYTES 调整），超限直接断开——
 *  webhook/callback 是公网可达的验签入口，旧实现无上限累积会把进程内存打满。 */
const MAX_BODY_BYTES = Number(process.env.MA_MAX_BODY_BYTES ?? 1_048_576) || 1_048_576;
function readRawBody(req: Req): Promise<{ raw: string; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      total += c.byteLength;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        chunks.length = 0;
        try { req.destroy(); } catch { /* 已断开则忽略 */ }
        resolve({ raw: '', json: {} });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
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
    req.on('error', () => { if (!aborted) resolve({ raw: '', json: {} }); });
  });
}

function send(res: Res, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// 只读统计 / 明细（真实 SQL 聚合）
// ---------------------------------------------------------------------------

/** GET /stats —— 完整客资统计（漏斗 / 渠道 / 等级 / 队列 / CRM 同步健康）。
 *  P1 鉴权修复：统计含队列规模/渠道转化等经营数据，匿名暴露可被竞品抓取，需管理令牌。 */
const stats: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const [stats, ob] = await Promise.all([computeStats(), outboxSnapshot()]);
  send(res, 200, { ...stats, outbox: ob });
};

/** GET /leads —— 客资明细 + 统计（P1 安全修复：需管理令牌——明细含手机号/微信等 PII，
 *  与 /assist/reveal 同一数据敏感级，此前与掩码版简报 /assist/briefing 的鉴权口径不一致）。 */
const leads: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const [stats, all, page] = await Promise.all([computeStats(), listLeads(), listLeads(100, 0)]);
  send(res, 200, { total: all.length, stats, leads: page });
};

/** GET /handoffs —— 转人工队列（待认领；P1 安全修复：需管理令牌，含 leadId + 项目意向画像）。 */
const handoffs: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
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

/** GET /followups —— 待跟进队列（C 级 / 未转化；P1 安全修复：需管理令牌，同 handoffs）。 */
const followups: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
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
  const items = (await listKnowledge(true)).map((p) => ({ projectId: p.projectId, name: p.name, category: p.category }));
  send(res, 200, { total: items.length, projects: items });
};

// ---------------------------------------------------------------------------
// 写操作：认领 / 分配 / 导入 / webhook
// ---------------------------------------------------------------------------

/** POST /leads/assign —— 分配客资给咨询师。
 *  P1 鉴权修复：写操作（改派客资）此前无鉴权，任何可达来源均可抢占/改派，补 denyUnlessAdmin。 */
const assign: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  const leadId = String(json.leadId ?? '');
  const consultant = String(json.consultant ?? '');
  if (!leadId) return send(res, 400, { error: 'leadId required' });
  if (!consultant) return send(res, 400, { error: 'consultant required' });
  const ok = await assignConsultant(leadId, consultant);
  send(res, ok ? 200 : 409, { ok, consultant: ok ? consultant : undefined });
};

/** POST /handoffs/claim —— 坐席认领转人工客资（P1 鉴权修复：同 assign）。 */
const claim: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  const leadId = String(json.leadId ?? '');
  const consultant = String(json.consultant ?? '');
  if (!leadId) return send(res, 400, { error: 'leadId required' });
  if (!consultant) return send(res, 400, { error: 'consultant required' });
  const ok = await assignConsultant(leadId, consultant);
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
    const n = await importProjects(
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
      await upsertClinic({
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
      await upsertSlot({
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
 * POST /ad-spend/import —— 导入广告投放消耗（需管理令牌；P1-⑨ 无 API 资质时的手动路径）。
 * body: { items: [{ spendDate:'YYYY-MM-DD', channel, campaignId, campaignName?, spend,
 *                   impressions?, clicks?, conversions? }] }
 * 同日同渠道同计划重复导入幂等覆盖；spend 为负或日期格式非法 → 400（fail-fast，脏数据不进 ROI 分母）。
 */
const adSpendImport: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  try {
    verifyAdminToken(getConfig().adminToken, req.headers as Record<string, string | string[] | undefined>);
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
  const { json } = await readRawBody(req);
  const items = (Array.isArray(json.items) ? json.items : []) as Record<string, unknown>[];
  if (!items.length) return send(res, 400, { error: 'items[] required' });
  try {
    const written = await upsertAdSpend(
      items.map((s) => ({
        spendDate: String(s.spendDate ?? s.date ?? ''),
        channel: String(s.channel ?? ''),
        campaignId: String(s.campaignId ?? s.campaign_id ?? ''),
        campaignName: s.campaignName ? String(s.campaignName) : undefined,
        spend: Number(s.spend ?? 0),
        impressions: s.impressions != null ? Number(s.impressions) : undefined,
        clicks: s.clicks != null ? Number(s.clicks) : undefined,
        conversions: s.conversions != null ? Number(s.conversions) : undefined,
        source: 'import',
      }))
    );
    send(res, 200, { ok: true, imported: written });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** GET /ad-spend —— 消耗明细 + 汇总（需管理令牌；经营数据）。 */
const adSpendList: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  try {
    verifyAdminToken(getConfig().adminToken, req.headers as Record<string, string | string[] | undefined>);
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const channel = url.searchParams.get('channel') ?? undefined;
    const [items, stats] = await Promise.all([listAdSpend({ channel }), adSpendStats()]);
    send(res, 200, { items, stats });
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
  const inbound = await saveInbound({
    channel,
    externalId,
    leadKey: String(json.leadKey ?? externalId),
    text: String(json.text ?? ''),
  });
  await markInboundState(inbound.id, 'dispatched');
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
      await markInboundState(inbound.id, 'error', undefined, String((e as Error).message));
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
        (apptId ? await getAppointment(apptId) : null) ??
        (extId ? await getAppointmentByExternalId(extId) : null);
      if (!appt) {
        return send(res, 404, { ok: false, code: 'NOT_FOUND', error: '预约单不存在（appointmentId/externalId 均未匹配）' });
      }
      await setAppointmentExternal(appt.appointmentId, extId || undefined, String(json.status ?? 'confirmed'));
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

/** GET /analytics —— 运营分析查询（真实 SQL 聚合；P1 鉴权修复：经营数据需管理令牌）。 */
const analytics: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const url = new URL(String(req.url), `http://${req.headers.host ?? 'localhost'}`);
  const p = url.searchParams;
  const q: AnalyticsQuery = {
    type: (p.get('type') as AnalyticsQuery['type']) ?? 'full',
    startTime: p.get('startTime') ? Number(p.get('startTime')) : undefined,
    endTime: p.get('endTime') ? Number(p.get('endTime')) : undefined,
    channel: p.get('channel') ?? undefined,
    clinicId: p.get('clinicId') ?? undefined,
    project: p.get('project') ?? undefined,
    period: (p.get('period') as AnalyticsQuery['period']) ?? undefined,
    daysThreshold: p.get('daysThreshold') ? Number(p.get('daysThreshold')) : undefined,
  };
  try {
    const result = await runAnalyticsQuery(q);
    send(res, 200, result);
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /analytics/export —— 导出 CSV（P1 鉴权修复：匿名导出全量经营数据 + CSV 公式注入防护）。 */
const analyticsExport: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  const q = json as unknown as AnalyticsQuery;
  try {
    const result = await runAnalyticsQuery(q);
    const csv = analyticsToCsv(result);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="analytics_${Date.now()}.csv"`);
    res.end(csv);
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/**
 * P1 CSV 公式注入防护（OWASP CSV Injection）：以 `= + - @ \t \r` 开头的单元格
 * 会被 Excel/LibreOffice/WPS 当作公式执行（如 `@SUM(...)`、`=HYPERLINK(...)` DDE），
 * 运营打开导出文件即触发。前置 `'` 中和；含逗号/引号/换行的值按标准 CSV 引号包裹。
 */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 将分析结果转换为 CSV 字符串。 */
function analyticsToCsv(result: AnalyticsResult): string {
  const rows: string[] = ['section,fields,values'];
  const data = result.data as unknown;
  if (Array.isArray(data)) {
    for (const item of data as Record<string, unknown>[]) {
      const keys = Object.keys(item).map(csvCell).join('|');
      const vals = Object.values(item).map(csvCell).join('|');
      rows.push([csvCell('row'), csvCell(keys), csvCell(vals)].join(','));
    }
  } else if (data && typeof data === 'object') {
    for (const [section, arr] of Object.entries(data as Record<string, unknown[]>)) {
      for (const item of arr as Record<string, unknown>[]) {
        const keys = Object.keys(item).map(csvCell).join('|');
        const vals = Object.values(item).map(csvCell).join('|');
        rows.push([csvCell(section), csvCell(keys), csvCell(vals)].join(','));
      }
    }
  }
  return rows.join('\n');
}

/** POST /appointments/mark —— 标记预约到院/完成（表单提交）。 */
const markAppointment: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  try {
    verifyAdminToken(getConfig().adminToken, req.headers as Record<string, string | string[] | undefined>);
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
  const { json } = await readRawBody(req);
  const appointmentId = String(json.appointmentId ?? '');
  const action = String(json.action ?? '');
  if (!appointmentId || !action) return send(res, 400, { error: 'appointmentId + action required' });
  try {
    if (action === 'arrived') {
      const ok = await markArrived(appointmentId);
      send(res, 200, { ok, appointmentId, action: 'arrived' });
    } else if (action === 'completed') {
      const ok = await markCompleted(appointmentId);
      send(res, 200, { ok, appointmentId, action: 'completed' });
    } else {
      send(res, 400, { error: 'action must be "arrived" or "completed"' });
    }
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** GET /appointments —— 按日期查询当天预约单（用于到院/完成打卡）。 */
const listAppointments: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  try {
    verifyAdminToken(getConfig().adminToken, req.headers as Record<string, string | string[] | undefined>);
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
  const url = new URL(String(req.url), `http://${req.headers.host ?? 'localhost'}`);
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  try {
    const appts = await listAppointmentsByDate(date);
    send(res, 200, { date, count: appts.length, appointments: appts });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

// ---------------------------------------------------------------------------
// 定时调度器（B3）与对客触达（B4/B5）
// ---------------------------------------------------------------------------

/** GET /scheduler —— 调度器快照（配置 + 任务统计 + 触达消息统计）。 */
const schedulerRoute: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  try {
    send(res, 200, await schedulerSnapshot());
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** GET /report —— 最新经营日报（P1-⑥ 日报定时化；看板回溯入口）。 */
const reportRoute: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  try {
    const r = await latestDailyReport();
    if (!r) return send(res, 404, { error: 'no daily report yet' });
    send(res, 200, r);
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** GET /strategy —— 策略建议列表（P2 自动策略闭环；看板用）。 */
const strategyList: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const status = url.searchParams.get('status') ?? undefined;
    const snap = await suggestionSnapshot();
    const items = status ? snap.items.filter((s) => s.status === status) : snap.items;
    send(res, 200, { counts: snap.counts, items });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/**
 * POST /strategy/review —— 人工确认策略建议（需管理令牌；P2 硬闸门）。
 * body: { suggestionId, decision: 'approved'|'rejected', operator, reason? }
 * rejected 必须给原因；仅 pending 可确认。
 */
const strategyReview: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  const suggestionId = String(json.suggestionId ?? '');
  if (!suggestionId) return send(res, 400, { error: 'suggestionId required' });
  const decision = json.decision === 'approved' ? 'approved' : json.decision === 'rejected' ? 'rejected' : null;
  if (!decision) return send(res, 400, { error: "decision must be 'approved' or 'rejected'" });
  try {
    const s = await reviewSuggestion(
      suggestionId,
      decision,
      json.operator ? String(json.operator) : 'operator',
      json.reason ? String(json.reason) : undefined
    );
    send(res, 200, { ok: true, suggestion: s });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/**
 * POST /strategy/execute —— 标记建议已执行（需管理令牌）。
 * 仅 approved 可执行——人工确认是不可绕过的闸门。
 */
const strategyExecute: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  const suggestionId = String(json.suggestionId ?? '');
  if (!suggestionId) return send(res, 400, { error: 'suggestionId required' });
  try {
    const s = await markSuggestionExecuted(suggestionId);
    send(res, 200, { ok: true, suggestion: s });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /scheduler/tick —— 手动触发一轮「规划 + 消费」（需管理令牌；后台循环之外的对账入口）。 */
const schedulerTickRoute: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  try {
    verifyAdminToken(getConfig().adminToken, req.headers as Record<string, string | string[] | undefined>);
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
  try {
    send(res, 200, await schedulerTick());
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/**
 * POST /scheduler/jobs —— 运营手动排期任务（需管理令牌）。
 * body: { jobType: 'birthday'|'repurchase'|'welcome'|'recall'|'post_op', leadId, dueAt?, text?, day?, key? }
 * birthday/repurchase 必须提供运营自拟文案 text（入队前过医疗广告合规筛查）。
 */
const schedulerJobRoute: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  try {
    verifyAdminToken(getConfig().adminToken, req.headers as Record<string, string | string[] | undefined>);
  } catch (e) {
    const me = toMaError(e);
    return send(res, me.httpStatus, me.toJSON());
  }
  const { json } = await readRawBody(req);
  const jobType = String(json.jobType ?? '');
  const leadId = String(json.leadId ?? '');
  if (!leadId) return send(res, 400, { error: 'leadId required' });
  if (!['welcome', 'recall', 'birthday', 'repurchase', 'post_op'].includes(jobType)) {
    return send(res, 400, { error: 'jobType must be welcome|recall|birthday|repurchase|post_op' });
  }
  try {
    const r = await scheduleManualJob({
      jobType: jobType as 'welcome' | 'recall' | 'birthday' | 'repurchase' | 'post_op',
      leadId,
      dueAt: typeof json.dueAt === 'number' ? json.dueAt : undefined,
      text: json.text ? String(json.text) : undefined,
      day: typeof json.day === 'number' ? json.day : undefined,
      key: json.key ? String(json.key) : undefined,
    });
    send(res, 200, { ok: true, ...r });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

// ---------------------------------------------------------------------------
// 内容生产与先审后发（D8/D9）
// ---------------------------------------------------------------------------

/** 内容写操作统一的管理令牌校验。校验失败返回响应并返回 true（调用方直接 return）。 */
function denyUnlessAdmin(res: Res, req: Req): boolean {
  try {
    verifyAdminToken(getConfig().adminToken, req.headers as Record<string, string | string[] | undefined>);
    return false;
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
    return true;
  }
}

/** GET /content —— 内容流水线快照（统计 + 列表，支持 ?state=&platform=&limit=）。 */
const contentList: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const url = new URL(String(req.url), `http://${req.headers.host ?? 'localhost'}`);
  const p = url.searchParams;
  try {
    const snap = await contentSnapshot({
      state: (p.get('state') as ContentState) || undefined,
      platform: (p.get('platform') as ContentPlatform) || undefined,
      limit: p.get('limit') ? Number(p.get('limit')) : undefined,
    });
    send(res, 200, { total: snap.items.length, ...snap });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /content/generate —— 从知识库批量生成平台内容（需管理令牌；同日幂等）。 */
const contentGenerate: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  try {
    const r = await generateTemplateContent({
      platform: json.platform ? String(json.platform) : undefined,
      projectName: json.projectName ? String(json.projectName) : undefined,
    });
    send(res, 200, { ok: true, ...r });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /content/draft —— 运营手写草稿（需管理令牌；过合规筛查落库为 draft）。 */
const contentDraft: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  try {
    const r = await createManualDraft({
      platform: String(json.platform ?? ''),
      title: String(json.title ?? ''),
      body: String(json.body ?? ''),
      project: json.project ? String(json.project) : undefined,
    });
    send(res, 200, { ok: true, ...r });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /content/submit —— 送审（draft/rejected → review，需管理令牌）。 */
const contentSubmit: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  const contentId = String(json.contentId ?? '');
  if (!contentId) return send(res, 400, { error: 'contentId required' });
  try {
    const c = await submitContent(contentId, json.operator ? String(json.operator) : undefined);
    send(res, 200, { ok: true, content: c });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /content/approve —— 人工过审（review → approved，需管理令牌）。 */
const contentApprove: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  const contentId = String(json.contentId ?? '');
  if (!contentId) return send(res, 400, { error: 'contentId required' });
  try {
    const c = await approveContent(contentId, String(json.reviewer ?? ''));
    send(res, 200, { ok: true, content: c });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /content/reject —— 人工驳回（review → rejected，必须给原因，需管理令牌）。 */
const contentReject: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  const contentId = String(json.contentId ?? '');
  if (!contentId) return send(res, 400, { error: 'contentId required' });
  try {
    const c = await rejectContent(contentId, String(json.reviewer ?? ''), String(json.reason ?? ''));
    send(res, 200, { ok: true, content: c });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /content/publish —— 发布过审内容（approved → 网关 → published，需管理令牌；失败保持 approved 可重试）。 */
const contentPublish: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  const contentId = String(json.contentId ?? '');
  if (!contentId) return send(res, 400, { error: 'contentId required' });
  try {
    const c = await publishContent(contentId);
    send(res, 200, { ok: true, content: c });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** GET /assist/briefing —— 咨询师简报（脱敏版；联系方式掩码，公开读）。 */
const assistBriefing: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const url = new URL(String(req.url), `http://${req.headers.host ?? 'localhost'}`);
  const leadId = url.searchParams.get('leadId') ?? '';
  if (!leadId) return send(res, 400, { error: 'leadId required' });
  try {
    send(res, 200, { ok: true, briefing: await buildLeadBriefing(leadId) });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** GET /assist/reveal —— 完整联系方式放行（须管理令牌；简报里只有掩码）。 */
const assistReveal: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const url = new URL(String(req.url), `http://${req.headers.host ?? 'localhost'}`);
  const leadId = url.searchParams.get('leadId') ?? '';
  if (!leadId) return send(res, 400, { error: 'leadId required' });
  try {
    send(res, 200, { ok: true, ...(await revealContact(leadId)) });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

// ---------------------------------------------------------------------------
// A/B 分流实验（E 组：自做 A/B，替代「只看厂商宣称数据」）
// ---------------------------------------------------------------------------

/** GET /ab —— 实验清单（含变体与状态）。 */
const abList: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  try {
    const experiments = await listExperiments();
    send(res, 200, { total: experiments.length, experiments });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** GET /ab/report?experimentId= —— 实验报表（真实 SQL 聚合 + 样本量提示）。 */
const abReport: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const url = new URL(String(req.url), `http://${req.headers.host ?? 'localhost'}`);
  const experimentId = url.searchParams.get('experimentId') ?? '';
  if (!experimentId) return send(res, 400, { error: 'experimentId required' });
  try {
    send(res, 200, { ok: true, ...(await experimentReport(experimentId)) });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** GET /ab/assign?experimentId=&leadId= —— 预览/物化某线索的 sticky 分流结果。 */
const abAssign: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const url = new URL(String(req.url), `http://${req.headers.host ?? 'localhost'}`);
  const experimentId = url.searchParams.get('experimentId') ?? '';
  const leadId = url.searchParams.get('leadId') ?? '';
  if (!experimentId || !leadId) return send(res, 400, { error: 'experimentId + leadId required' });
  try {
    const r = await assignVariant(experimentId, leadId);
    send(res, 200, { ok: true, experimentId, leadId, ...(r ?? {}) });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /ab/experiments —— 创建实验（须管理令牌；变体文案过医疗广告合规筛查）。 */
const abCreate: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  try {
    const r = await createExperiment({
      name: String(json.name ?? ''),
      topic: String(json.topic ?? ''),
      metric: json.metric ? String(json.metric) : undefined,
      variants: (Array.isArray(json.variants) ? json.variants : []) as Record<string, unknown>[],
    });
    send(res, 200, { ok: true, ...r });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/** POST /ab/stop —— 停止实验（须管理令牌；之后该 topic 回落默认模板）。 */
const abStop: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  const experimentId = String(json.experimentId ?? '');
  if (!experimentId) return send(res, 400, { error: 'experimentId required' });
  try {
    const exp = await stopExperiment(experimentId);
    send(res, 200, { ok: true, experiment: exp });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

// ---------------------------------------------------------------------------
// 中期补全：医疗广告护栏命中审计 / 人审队列（拦截 → 复核 → 词库修正闭环）。
// ---------------------------------------------------------------------------

/** GET /guard-hits?status=pending&limit=50 —— 人审队列（须管理令牌）。 */
const guardHitsList: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const url = new URL(String(req.url), `http://${req.headers.host ?? 'localhost'}`);
  const status = url.searchParams.get('status') ?? 'pending';
  const limit = Number(url.searchParams.get('limit')) || 50;
  try {
    const [hits, stats] = await Promise.all([listGuardHits({ status, limit }), guardHitStats()]);
    send(res, 200, { ok: true, hits, stats });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/**
 * POST /guard-hits/review —— 复核处置（须管理令牌）。
 * body: { id, status: 'reviewed'|'dismissed', note? }
 * reviewed = 确认违规（保留拦截）；dismissed = 误报（反哺词库修正）。
 */
const guardHitsReview: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (denyUnlessAdmin(res, req)) return;
  const { json } = await readRawBody(req);
  const id = Number(json.id);
  const status = json.status === 'reviewed' ? 'reviewed' : json.status === 'dismissed' ? 'dismissed' : null;
  if (!Number.isFinite(id) || id <= 0 || !status) {
    return send(res, 400, { error: 'id 与 status(reviewed|dismissed) 必填' });
  }
  try {
    const hit = await reviewGuardHit(id, { status, reviewedBy: 'admin', note: json.note ? String(json.note) : undefined });
    if (!hit) return send(res, 404, { error: 'hit not found' });
    send(res, 200, { ok: true, hit });
  } catch (e) {
    const me = toMaError(e);
    send(res, me.httpStatus, me.toJSON());
  }
};

/**
 * 客资插件服务端扩展：挂载 HTTP 路由。宿主把它们收敮到统一前缀
 * /api/plugins/medical-aesthetics-lead/*.
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
    '/analytics': analytics,
    '/analytics/export': analyticsExport,
    '/appointments': listAppointments,
    '/appointments/mark': markAppointment,
    '/scheduler': schedulerRoute,
    '/scheduler/tick': schedulerTickRoute,
    '/scheduler/jobs': schedulerJobRoute,
    '/report': reportRoute,
    '/ad-spend': adSpendList,
    '/ad-spend/import': adSpendImport,
    '/strategy': strategyList,
    '/strategy/review': strategyReview,
    '/strategy/execute': strategyExecute,
    '/content': contentList,
    '/content/generate': contentGenerate,
    '/content/draft': contentDraft,
    '/content/submit': contentSubmit,
    '/content/approve': contentApprove,
    '/content/reject': contentReject,
    '/content/publish': contentPublish,
    '/assist/briefing': assistBriefing,
    '/assist/reveal': assistReveal,
    '/ab': abList,
    '/ab/report': abReport,
    '/ab/assign': abAssign,
    '/ab/experiments': abCreate,
    '/ab/stop': abStop,
    '/guard-hits': guardHitsList,
    '/guard-hits/review': guardHitsReview,
  },
};
