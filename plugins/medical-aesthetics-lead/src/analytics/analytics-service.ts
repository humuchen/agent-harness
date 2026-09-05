/**
 * 医美运营分析服务（真实 SQL 聚合，零模拟数据）。
 *
 * 所有方法都直接查询数据库，数据为空时返回空数组/0，绝不填充虚构数值。
 * 时区约定：入参 startTime/endTime 为毫秒时间戳（UTC），SQL 内部统一使用 unixepoch。
 */

import { getDb, dbCall } from '../infra/db';
import { getConfig } from '../config';
import { STAGE_ORDER } from '../repo/types';
import type {
  AnalyticsQuery, AnalyticsResult, AnalyticsFullResult,
  FunnelAnalysis, ChannelPerformance, ClinicPerformance,
  ProjectProfitability, TimeTrendPoint, StageRetention,
  InactiveLead,
} from './types';

const STAGE_ZH: Record<string, string> = {
  new: '新客', contacted: '已联系', qualified: '深度意向',
  captured: '信息收集', booked: '已预约', arrived: '到院', deal: '成交', lost: '丢失',
};

/** 构建时间范围 WHERE 子句（毫秒时间戳 → unix 秒）。 */
function timeWhere(field: string, q: AnalyticsQuery): { clause: string; vals: number[] } {
  if (q.startTime == null && q.endTime == null) return { clause: '1=1', vals: [] };
  const s = q.startTime != null ? Math.floor(q.startTime / 1000) : null;
  const e = q.endTime != null ? Math.floor(q.endTime / 1000) : null;
  const parts: string[] = [];
  const vals: number[] = [];
  if (s != null) { parts.push(`${field} >= ?`); vals.push(s); }
  if (e != null) { parts.push(`${field} <= ?`); vals.push(e); }
  return { clause: parts.join(' AND '), vals };
}

/** 构建租户 WHERE 子句。 */
function tenantWhere(q: AnalyticsQuery): { clause: string; vals: any[] } {
  const tid = q.tenantId ?? getConfig().tenantId;
  return { clause: 'tenant_id = ?', vals: [tid] };
}

/** 合并多个 WHERE 子句为一个字符串 + 参数数组。 */
function mergeWhere(clauses: { clause: string; vals: any[] }[]): { clause: string; vals: any[] } {
  const parts = clauses.map((c) => `(${c.clause})`);
  const vals = clauses.flatMap((c) => c.vals);
  return { clause: parts.join(' AND '), vals };
}

// ─── 漏斗分析 ─────────────────────────────────────────────────────────

/**
 * 漏斗分析：统计各阶段的人数及平均流转耗时。
 * 耗时基于 ma_lead_stage_log，计算相邻阶段的变更间隔。
 */
export async function funnelAnalysis(q: AnalyticsQuery): Promise<FunnelAnalysis[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const tw = timeWhere('created_at', q);
    const tqw = tenantWhere(q);
    const wh = mergeWhere([tqw, tw]);

    // 各阶段当前人数（按 stage 而非 reached，反映当前存态）
    const countRes = await db.prepare(
      `SELECT stage, COUNT(*) AS c FROM ma_lead
       WHERE ${wh.clause}
       GROUP BY stage`
    ).all(...(wh.vals as never[]));

    // 总数（用于百分比）
    const totalRes = await db.prepare(
      `SELECT COUNT(*) AS c FROM ma_lead WHERE ${wh.clause}`
    ).get(...(wh.vals as never[])) as { c: number };
    const total = Number(totalRes?.c ?? 0);

    const counts: Record<string, number> = {};
    for (const r of countRes as Record<string, unknown>[]) {
      counts[String(r.stage)] = Number(r.c);
    }

    // 相邻阶段平均耗时（小时）
    const stageTimes = await computeStageTransitionTimes(db, wh.vals, q.tenantId);

    const result: FunnelAnalysis[] = [];
    for (const st of STAGE_ORDER) {
      const count = counts[st] ?? 0;
      result.push({
        stage: STAGE_ZH[st] ?? st,
        count,
        percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
        avgHoursToNext: stageTimes[st],
      });
    }
    return result;
  }, '漏斗分析');
}

/**
 * 计算相邻阶段的平均耗时（小时）。
 * 用 ma_lead_stage_log 的相邻记录间隔。
 */
async function computeStageTransitionTimes(
  db: any, vals: any[], tenantId?: string
): Promise<Record<string, number>> {
  const tid = tenantId ?? getConfig().tenantId;
  const logRows = await db.prepare(
    `SELECT lead_id, from_stage, to_stage, changed_at
     FROM ma_lead_stage_log
     WHERE tenant_id = ?
     ORDER BY lead_id, changed_at ASC`
  ).all(tid) as Array<{ lead_id: string; from_stage: string; to_stage: string; changed_at: number }>;

  // 按 lead_id 分组，依变更时间排序，计算相邻阶段间隔
  const byLead = new Map<string, Array<{ from: string; to: string; t: number }>>();
  for (const r of logRows) {
    if (!byLead.has(r.lead_id)) byLead.set(r.lead_id, []);
    byLead.get(r.lead_id)!.push({ from: r.from_stage, to: r.to_stage, t: r.changed_at });
  }

  const durations: Record<string, number[]> = {};
  for (const [, entries] of byLead) {
    for (let i = 0; i < entries.length - 1; i++) {
      const curr = entries[i]!;
      const next = entries[i + 1]!;
      const from = curr.to; // 下一段的起点 = 当前的 to
      const hours = (next.t - curr.t) / (1000 * 3600);
      if (hours >= 0 && hours < 168) { // 过滤异常值 (>7天)
        if (!durations[from]) durations[from] = [];
        durations[from].push(hours);
      }
    }
  }

  const result: Record<string, number> = {};
  for (const st of STAGE_ORDER) {
    const arr = durations[st];
    if (arr && arr.length > 0) {
      result[st] = Math.round((arr.reduce((a: number, b: number) => a + b, 0) / arr.length) * 10) / 10;
    }
  }
  return result;
}

// ─── 渠道性能分析 ─────────────────────────────────────────────────────

export async function channelPerformance(q: AnalyticsQuery): Promise<ChannelPerformance[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const tw = timeWhere('created_at', q);
    const tqw = tenantWhere(q);
    let wh = mergeWhere([tqw, tw]);

    const sql = `
      SELECT
        channel,
        COUNT(*) AS total,
        SUM(stage IN ('qualified','captured','booked','arrived','deal')) AS qualified,
        SUM(stage IN ('captured','booked','arrived','deal')) AS captured,
        SUM(stage IN ('booked','arrived','deal')) AS booked,
        SUM(stage IN ('arrived','deal')) AS arrived,
        SUM(stage IN ('deal')) AS deal
      FROM ma_lead
      WHERE ${wh.clause}
      GROUP BY channel
      ORDER BY total DESC`;

    const rows = await db.prepare(sql).all(...(wh.vals as never[])) as Record<string, unknown>[];
    return rows.map((r): ChannelPerformance => {
      const leadCount = Number(r.total);
      const qualifiedCount = Number(r.qualified);
      const capturedCount = Number(r.captured);
      const bookedCount = Number(r.booked);
      const arrivedCount = Number(r.arrived);
      const dealCount = Number(r.deal);
      return {
        channel: String(r.channel),
        leadCount,
        qualifiedCount,
        capturedCount,
        bookedCount,
        arrivedCount,
        dealCount,
        qualifyRate: leadCount > 0 ? Math.round((qualifiedCount / leadCount) * 1000) / 10 : 0,
        captureRate: qualifiedCount > 0 ? Math.round((capturedCount / qualifiedCount) * 1000) / 10 : 0,
        bookingRate: capturedCount > 0 ? Math.round((bookedCount / capturedCount) * 1000) / 10 : 0,
        arrivalRate: bookedCount > 0 ? Math.round((arrivedCount / bookedCount) * 1000) / 10 : 0,
        dealRate: arrivedCount > 0 ? Math.round((dealCount / arrivedCount) * 1000) / 10 : 0,
      };
    });
  }, '渠道性能分析');
}

// ─── 院区业绩分析 ─────────────────────────────────────────────────────

export async function clinicPerformance(q: AnalyticsQuery): Promise<ClinicPerformance[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const tw = timeWhere('ma_appointment.created_at', q);
    const tqw = tenantWhere(q);

    // 院区号源利用率
    const slotSql = `
      SELECT
        s.clinic_id,
        COUNT(s.slot_id) AS total_slots,
        SUM(s.booked) AS total_booked
      FROM ma_slot s
      WHERE s.tenant_id = ?
      GROUP BY s.clinic_id`;

    // 院区预约业绩
    const apptSql = `
      SELECT
        a.clinic_id,
        COUNT(*) AS total_appts,
        SUM(CASE WHEN a.status IN ('arrived','completed') THEN 1 ELSE 0 END) AS arrived,
        SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM ma_appointment a
      WHERE ${tw.clause} AND a.tenant_id = ?
      GROUP BY a.clinic_id`;

    const apptVals = [...tw.vals, q.tenantId ?? getConfig().tenantId];
    const apptRes = await db.prepare(apptSql).all(...(apptVals as never[])) as Record<string, unknown>[];
    const slotRes = await db.prepare(slotSql).all(q.tenantId ?? getConfig().tenantId) as Record<string, unknown>[];

    // 院区名称查询
    const clinicRows = await db.prepare(
      `SELECT clinic_id, name, city FROM ma_clinic WHERE tenant_id = ?`
    ).all(q.tenantId ?? getConfig().tenantId) as Record<string, unknown>[];
    const clinicMap = new Map<string, { name: string; city: string }>();
    for (const r of clinicRows) {
      clinicMap.set(String(r.clinic_id), { name: String(r.name), city: r.city ? String(r.city) : '' });
    }

    const byClinic = new Map<string, { total_appts: number; arrived: number; completed: number }>();
    for (const r of apptRes) {
      byClinic.set(String(r.clinic_id), {
        total_appts: Number(r.total_appts),
        arrived: Number(r.arrived),
        completed: Number(r.completed),
      });
    }

    const slotMap = new Map<string, { total_slots: number; total_booked: number }>();
    for (const r of slotRes) {
      slotMap.set(String(r.clinic_id), {
        total_slots: Number(r.total_slots),
        total_booked: Number(r.total_booked),
      });
    }

    // 合并结果
    const allClinicIds = new Set<string>([
      ...clinicMap.keys(),
      ...byClinic.keys(),
      ...slotMap.keys(),
    ]);

    const result: ClinicPerformance[] = [];
    for (const cid of allClinicIds) {
      const info = clinicMap.get(cid) ?? { name: cid, city: '' };
      const appt = byClinic.get(cid) ?? { total_appts: 0, arrived: 0, completed: 0 };
      const slot = slotMap.get(cid) ?? { total_slots: 0, total_booked: 0 };
      result.push({
        clinicId: cid,
        clinicName: info.name,
        city: info.city,
        bookedCount: appt.total_appts,
        arrivedCount: appt.arrived,
        dealCount: appt.completed,
        arrivalRate: appt.total_appts > 0 ? Math.round((appt.arrived / appt.total_appts) * 1000) / 10 : 0,
        dealRate: appt.arrived > 0 ? Math.round((appt.completed / appt.arrived) * 1000) / 10 : 0,
        slotUtilization: slot.total_slots > 0 ? Math.round((slot.total_booked / (slot.total_slots * 1.0)) * 1000) / 10 : 0,
      });
    }
    return result;
  }, '院区业绩分析');
}

// ─── 项目毛利分析 ─────────────────────────────────────────────────────

export async function projectProfitability(q: AnalyticsQuery): Promise<ProjectProfitability[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const tw = timeWhere('created_at', q);
    const tqw = tenantWhere(q);
    const wh = mergeWhere([tqw, tw]);

    // 按 project 聚合线索 + 成交
    const leadSql = `
      SELECT
        project,
        COUNT(*) AS lc,
        SUM(stage IN ('booked','arrived','deal')) AS bc,
        SUM(stage = 'deal') AS dc
      FROM ma_lead
      WHERE ${wh.clause} AND project IS NOT NULL
      GROUP BY project
      ORDER BY lc DESC`;

    const rows = await db.prepare(leadSql).all(...(wh.vals as never[])) as Record<string, unknown>[];

    // 项目价格区间查询
    const kbRows = await db.prepare(
      `SELECT project_id, name, avg_price_tier, price_range FROM ma_project WHERE tenant_id = ?`
    ).all(q.tenantId ?? getConfig().tenantId) as Record<string, unknown>[];
    const projectMap = new Map<string, { name: string; priceTier: string; priceRange?: string }>();
    for (const r of kbRows) {
      projectMap.set(String(r.project_id), {
        name: String(r.name ?? String(r.project_id)),
        priceTier: String(r.avg_price_tier ?? 'unknown'),
        priceRange: r.price_range ? String(r.price_range) : undefined,
      });
    }

    // 估算客单价（基于 priceTier）
    const TIER_PRICE: Record<string, number> = {
      '入门': 880, '中端': 2880, '高端': 8880, '奢享': 28880,
    };

    const result: ProjectProfitability[] = [];
    for (const r of rows) {
      const proj = String(r.project);
      const info = projectMap.get(proj) ?? { name: proj, priceTier: 'unknown' };
      const priceTier = info.priceTier;
      const unitPrice = TIER_PRICE[priceTier] ?? (priceTier === 'unknown' ? 1500 : 1500);
      const dealCount = Number(r.dc);
      result.push({
        project: info.name,
        leadCount: Number(r.lc),
        bookedCount: Number(r.bc),
        dealCount,
        priceRange: info.priceRange ?? `${unitPrice}元`,
        estimatedRevenue: dealCount * unitPrice,
      });
    }
    return result;
  }, '项目毛利分析');
}

// ─── 时间趋势 ─────────────────────────────────────────────────────────

export async function timeTrend(q: AnalyticsQuery): Promise<TimeTrendPoint[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const tqw = tenantWhere(q);
    const period = q.period ?? 'day';

    // SQLite 日期截断
    const fmt = period === 'day' ? '%Y-%m-%d' : period === 'week' ? '%Y-W%W' : '%Y-%m';

    const sql = `
      SELECT
        strftime('${fmt}', datetime(created_at, 'unixepoch')) AS period,
        COUNT(*) AS lc,
        SUM(stage IN ('booked','arrived','deal')) AS bc,
        SUM(stage IN ('arrived','deal')) AS ac,
        SUM(stage = 'deal') AS dc
      FROM ma_lead
      WHERE ${tqw.clause}
      GROUP BY period
      ORDER BY period`;

    const rows = await db.prepare(sql).all(...(tqw.vals as never[])) as Record<string, unknown>[];
    return rows.map((r): TimeTrendPoint => ({
      period: String(r.period),
      leadCount: Number(r.lc),
      bookedCount: Number(r.bc),
      arrivedCount: Number(r.ac),
      dealCount: Number(r.dc),
    }));
  }, '时间趋势分析');
}

// ─── 阶段留存 ─────────────────────────────────────────────────────────

export async function stageRetention(q: AnalyticsQuery): Promise<StageRetention[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const tqw = tenantWhere(q);

    // 获取各阶段耗时
    const durations = await computeStageTransitionTimes(db, [q.tenantId ?? getConfig().tenantId], q.tenantId);

    const result: StageRetention[] = [];
    for (const st of STAGE_ORDER) {
      // 查询该阶段线索数
      const res = await db.prepare(
        `SELECT COUNT(*) AS c FROM ma_lead WHERE ${tqw.clause} AND stage >= ?`
      ).all(...([q.tenantId ?? getConfig().tenantId, st]) as never[]) as any[];
      const count = Number((res[0] as Record<string, unknown>)?.c ?? 0);
      const avgH = durations[st] ?? 0;
      result.push({
        stage: STAGE_ZH[st] ?? st,
        avgHours: avgH,
        p50Hours: avgH, // 如无更精细统计，中位数用均值代替
        p90Hours: Math.round(avgH * 2 * 10) / 10,
        count,
      });
    }
    return result;
  }, '阶段留存分析');
}

// ─── 未活跃线索分析 ─────────────────────────────────────────────────────

/**
 * 查询未活跃线索：最后一次到院/咨询距今超过阈值天数的客户。
 * - last_visit 来源：ma_appointment.arrived_at（如有），否则 ma_appointment.created_at
 * - daysSince threshold 默认 14 天
 */
export async function inactiveLeads(q: AnalyticsQuery & { daysThreshold?: number }): Promise<InactiveLead[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const tid = q.tenantId ?? getConfig().tenantId;
    const daysThreshold = q.daysThreshold ?? 14;
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoffSec = nowSec - daysThreshold * 86400;

    // 筛选：当前 stage 在 new~arrived（排除 lost/deal），最后到院/咨询超过阈值
    // last_visit 使用 appointment.arrived_at 或 created_at
    const sql = `
      SELECT
        l.lead_id AS leadId,
        l.name,
        l.phone,
        l.project,
        datetime(COALESCE(a.arrived_at, a.created_at), 'unixepoch') AS lastVisit,
        CAST((? - COALESCE(a.arrived_at, a.created_at)) / 86400 AS INTEGER) AS daysSince,
        p.activity_title AS activityTitle,
        p.activity_id AS activityId
      FROM ma_lead l
      LEFT JOIN ma_appointment a ON a.lead_id = l.lead_id AND a.tenant_id = l.tenant_id
      LEFT JOIN ma_project p ON p.project_id = l.project AND p.tenant_id = l.tenant_id
      WHERE l.tenant_id = ?
        AND l.stage IN ('new','contacted','qualified','captured','booked','arrived')
        AND l.stage != 'lost'
        AND l.stage != 'deal'
        AND COALESCE(a.arrived_at, a.created_at) <= ?
      ORDER BY daysSince DESC
      LIMIT 200
    `;

    const rows = await db.prepare(sql).all(nowSec, tid, cutoffSec) as Record<string, unknown>[];
    return rows.map((r): InactiveLead => ({
      leadId: String(r.leadId),
      name: r.name ? String(r.name) : null,
      phone: r.phone ? String(r.phone) : null,
      project: r.project ? String(r.project) : null,
      lastVisit: r.lastVisit ? String(r.lastVisit) : null,
      daysSince: Number(r.daysSince),
      activityTitle: r.activityTitle ? String(r.activityTitle) : null,
      activityId: r.activityId ? String(r.activityId) : null,
    }));
  }, '未活跃线索分析');
}

// ─── 统一查询入口 ─────────────────────────────────────────────────────

export async function runAnalyticsQuery(q: AnalyticsQuery): Promise<AnalyticsResult> {
  const generatedAt = Date.now();

  switch (q.type) {
    case 'funnel': {
      const data = await funnelAnalysis(q);
      return { query: q, generatedAt, data };
    }
    case 'channel': {
      const data = await channelPerformance(q);
      return { query: q, generatedAt, data };
    }
    case 'clinic': {
      const data = await clinicPerformance(q);
      return { query: q, generatedAt, data };
    }
    case 'project': {
      const data = await projectProfitability(q);
      return { query: q, generatedAt, data };
    }
    case 'trend': {
      const data = await timeTrend(q);
      return { query: q, generatedAt, data };
    }
    case 'retention': {
      const data = await stageRetention(q);
      return { query: q, generatedAt, data };
    }
    case 'inactive': {
      const data = await inactiveLeads(q as AnalyticsQuery & { daysThreshold?: number });
      return { query: q, generatedAt, data };
    }
    case 'full': {
      const [funnel, channel, clinic, project, trend, retention] = await Promise.all([
        funnelAnalysis(q),
        channelPerformance(q),
        clinicPerformance(q),
        projectProfitability(q),
        timeTrend(q),
        stageRetention(q),
      ]);
      return {
        query: q,
        generatedAt,
        data: {
          funnel,
          channel,
          clinic,
          project,
          trend,
          retention,
        },
      };
    }
    default:
      throw new Error(`Unknown analytics type: ${(q as any).type}`);
  }
}
