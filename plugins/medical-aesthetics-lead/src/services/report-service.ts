/**
 * 经营日报定时生成 + 业务异常预警（P1-⑥）。
 *
 * - 经营日报：SOP 调度 tick 每日首次触发时，汇总 funnel / channel / clinic / project /
 *   trend / retention + 成交复购，生成 Markdown 快照落库 `ma_daily_report`，并发一条
 *   info 事件（经核心 emitAlert → Webhook/日志 sink 捕获）。
 * - 异常预警：到院率 / 成交率 / 复购率 / 新增线索日环比跌超阈值时，发 warn/error 事件；
 *   同规则带冷却去重（存 `ma_meta`），避免刷屏。
 *
 * 两项均 fail-closed：无数据返回 0 / 空，绝不伪造数值；异常阈值与冷却在 config 可调。
 */

import { getDb, dbCall } from '../infra/db';
import { getConfig } from '../config';
import { runAnalyticsQuery } from '../analytics/analytics-service';
import { orderStats } from '../repo/order-repo';
import { getPluginContext } from '../runtime';
import type {
  AnalyticsFullResult,
  ChannelPerformance,
  FunnelAnalysis,
  ProjectProfitability,
  TimeTrendPoint,
} from '../analytics/types';

export interface DailyReport {
  date: string;
  markdown: string;
  generatedAt: number;
  tenantId: string;
  metrics: Record<string, number | null>;
}

export type AlertLevel = 'info' | 'warn' | 'error';

/** 经插件事件总线发告警（桥接核心 emitAlert → Webhook/日志 sink）。 */
export function emitAlert(level: AlertLevel, message: string): void {
  try {
    getPluginContext()
      ?.events.emit({ type: 'alert', level, message } as never);
  } catch {
    /* 事件总线不可用时不阻塞主流程 */
  }
}

function todayStr(now = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function metaGet(key: string): Promise<string | null> {
  return await dbCall(async () => {
    const db = await getDb();
    const row = (await db.prepare('SELECT v FROM ma_meta WHERE k = ?').get(key)) as
      | { v: string }
      | undefined;
    return row?.v ?? null;
  }, 'ma_meta.get');
}

export async function metaSet(key: string, v: string): Promise<void> {
  await dbCall(async () => {
    const db = await getDb();
    await db
      .prepare(
        `INSERT INTO ma_meta(k, v, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`
      )
      .run(key, v, Date.now());
  }, 'ma_meta.set');
}

// ─── 经营日报 ─────────────────────────────────────────────────────────

export async function hasDailyReportToday(now = Date.now()): Promise<boolean> {
  const t = todayStr(now);
  return await dbCall(async () => {
    const db = await getDb();
    const row = await db
      .prepare('SELECT 1 FROM ma_daily_report WHERE tenant_id = ? AND report_date = ?')
      .get(getConfig().tenantId, t);
    return !!row;
  }, 'daily_report.exists');
}

/** 漏斗 stage 中文名（与 analytics funnelAnalysis 的 STAGE_ZH 一致）。 */
const STAGE_LABEL: Record<string, string> = {
  new: '新客',
  contacted: '已联系',
  qualified: '深度意向',
  captured: '信息收集',
  booked: '已预约',
  arrived: '到院',
  deal: '成交',
  lost: '丢失',
};

/** 按漏斗阶段中文名取人数（funnelAnalysis 输出 stage 为 STAGE_ZH 标签）。 */
function stageCount(funnel: FunnelAnalysis[], stage: string): number {
  const label = STAGE_LABEL[stage] ?? stage;
  return funnel.find((f) => f.stage === label)?.count ?? 0;
}

function extractMetrics(full: AnalyticsFullResult, orders: { customerCount: number; repurchaseRate: number; totalRevenue: number }): Record<string, number | null> {
  const newLeads = stageCount(full.funnel, 'new');
  const arrived = stageCount(full.funnel, 'arrived');
  const deals = stageCount(full.funnel, 'deal');
  const total = full.funnel.reduce((s, f) => s + f.count, 0);
  const arrivalRate = total > 0 ? Math.round((arrived / total) * 1000) / 10 : 0;
  const dealRate = arrived > 0 ? Math.round((deals / arrived) * 1000) / 10 : 0;
  return {
    newLeads,
    arrived,
    deals,
    totalLeads: total,
    arrivalRate,
    dealRate,
    customerCount: orders.customerCount,
    repurchaseRate: orders.repurchaseRate,
    totalRevenue: orders.totalRevenue,
  };
}

function buildMarkdown(
  full: AnalyticsFullResult,
  orders: { customerCount: number; orderCount: number; totalRevenue: number; repurchaseRate: number; byProject: Array<{ project: string; revenue: number; orders: number }> },
  date: string,
  m: Record<string, number | null>
): string {
  const lines: string[] = [];
  lines.push(`# 医美运营日报（${date}）`);
  lines.push('');
  lines.push('## 核心指标');
  lines.push(`- 新增线索：${m.newLeads}`);
  lines.push(`- 到院：${m.arrived}（到院率 ${m.arrivalRate}%）`);
  lines.push(`- 成交：${m.deals}（成交率 ${m.dealRate}%）`);
  lines.push(`- 成交客户数：${m.customerCount}　复购率：${m.repurchaseRate}%`);
  lines.push(`- 累计成交金额：¥${m.totalRevenue}`);
  lines.push('');

  lines.push('## 渠道表现');
  for (const c of full.channel as ChannelPerformance[]) {
    lines.push(
      `- ${c.channel}：线索 ${c.leadCount} / 到院 ${c.arrivedCount} / 成交 ${c.dealCount}（到院率 ${c.arrivalRate}%，成交率 ${c.dealRate}%）`
    );
  }
  lines.push('');

  lines.push('## 项目成交');
  for (const p of full.project as ProjectProfitability[]) {
    lines.push(`- ${p.project}：成交 ${p.dealCount}　预估营收 ¥${p.estimatedRevenue}`);
  }
  lines.push('');

  lines.push('## 近 7 日趋势');
  const trend = (full.trend as TimeTrendPoint[]).slice(-7);
  for (const t of trend) {
    lines.push(`- ${t.period}：线索 ${t.leadCount} / 到院 ${t.arrivedCount} / 成交 ${t.dealCount}`);
  }
  lines.push('');

  lines.push('> 本报告由运营分析 Agent 自动生成，数据来自本地库真实聚合，不含模拟值。');
  return lines.join('\n');
}

/**
 * 生成今日经营日报（幂等：当天已生成则返回 null）。
 * 返回报告或 null（已生成 / 异常由调用方兜底）。
 */
export async function generateDailyReport(now = Date.now()): Promise<DailyReport | null> {
  const tenantId = getConfig().tenantId;
  const date = todayStr(now);
  if (await hasDailyReportToday(now)) return null;

  const full = (await runAnalyticsQuery({ type: 'full' })).data as AnalyticsFullResult;
  const orders = await orderStats();
  const metrics = extractMetrics(full, orders);
  const markdown = buildMarkdown(full, orders, date, metrics);

  await dbCall(async () => {
    const db = await getDb();
    await db
      .prepare(
        `INSERT INTO ma_daily_report(tenant_id, report_date, markdown, metrics_json, generated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, report_date) DO UPDATE SET
           markdown = excluded.markdown, metrics_json = excluded.metrics_json, generated_at = excluded.generated_at`
      )
      .run(tenantId, date, markdown, JSON.stringify(metrics), now);
  }, 'daily_report.insert');

  emitAlert(
    'info',
    `经营日报已生成（${date}）：新增 ${metrics.newLeads} / 到院 ${metrics.arrived} / 成交 ${metrics.deals} / 复购率 ${metrics.repurchaseRate}%`
  );

  return { date, markdown, generatedAt: now, tenantId, metrics };
}

/** 取最近一份日报（看板 / API 用）。 */
export async function latestDailyReport(): Promise<DailyReport | null> {
  return await dbCall(async () => {
    const db = await getDb();
    const row = (await db
      .prepare(
        'SELECT report_date, markdown, metrics_json, generated_at, tenant_id FROM ma_daily_report WHERE tenant_id = ? ORDER BY report_date DESC LIMIT 1'
      )
      .get(getConfig().tenantId)) as
      | { report_date: string; markdown: string; metrics_json: string | null; generated_at: number; tenant_id: string }
      | undefined;
    if (!row) return null;
    let metrics: Record<string, number | null> = {};
    if (row.metrics_json) {
      try {
        metrics = JSON.parse(row.metrics_json);
      } catch {
        metrics = {};
      }
    }
    return {
      date: row.report_date,
      markdown: row.markdown,
      generatedAt: row.generated_at,
      tenantId: row.tenant_id,
      metrics,
    };
  }, 'daily_report.latest');
}

// ─── 业务异常预警 ─────────────────────────────────────────────────────

interface AnomalyCheck {
  rule: string;
  level: AlertLevel;
  message: string;
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

/**
 * 扫描业务异常（到院率 / 成交率 / 复购率 / 新增线索日环比）。
 * 越界时发告警；同规则冷却去重（默认 6h，config 可调）。
 * 返回本次实际发出的告警列表（供测试 / 审计）。
 */
export async function scanAnomalies(now = Date.now()): Promise<AnomalyCheck[]> {
  const cfg = getConfig().scheduler;
  const full = (await runAnalyticsQuery({ type: 'full' })).data as AnalyticsFullResult;
  const orders = await orderStats();

  const newLeads = stageCount(full.funnel, 'new');
  const arrived = stageCount(full.funnel, 'arrived');
  const deals = stageCount(full.funnel, 'deal');
  const total = full.funnel.reduce((s, f) => s + f.count, 0);

  const arrivalRate = pct(arrived, total);
  const dealRate = pct(deals, arrived);

  const checks: AnomalyCheck[] = [];
  if (total > 0 && arrivalRate < cfg.arrivalRateMin * 100) {
    checks.push({
      rule: 'arrival_rate',
      level: arrivalRate < cfg.arrivalRateMin * 50 ? 'error' : 'warn',
      message: `到院率偏低：${arrivalRate}%（阈值 ${cfg.arrivalRateMin * 100}%）`,
    });
  }
  if (arrived > 0 && dealRate < cfg.dealRateMin * 100) {
    checks.push({
      rule: 'deal_rate',
      level: dealRate < cfg.dealRateMin * 50 ? 'error' : 'warn',
      message: `成交率偏低：${dealRate}%（阈值 ${cfg.dealRateMin * 100}%）`,
    });
  }
  if (orders.customerCount > 0 && orders.repurchaseRate < cfg.repurchaseRateMin * 100) {
    checks.push({
      rule: 'repurchase_rate',
      level: 'warn',
      message: `复购率偏低：${orders.repurchaseRate}%（阈值 ${cfg.repurchaseRateMin * 100}%）`,
    });
  }

  // 新增线索日环比跌幅（基于 trend 同日 vs 昨日）。
  const trend = full.trend as TimeTrendPoint[];
  const today = todayStr(now);
  const yest = todayStr(now - 86400000);
  const tToday = trend.find((t) => t.period === today)?.leadCount ?? 0;
  const tYest = trend.find((t) => t.period === yest)?.leadCount ?? 0;
  if (tYest > 0 && tToday < tYest * (1 - cfg.newLeadDropPct / 100)) {
    const drop = Math.round((1 - tToday / tYest) * 1000) / 10;
    checks.push({
      rule: 'new_lead_drop',
      level: drop > cfg.newLeadDropPct * 1.5 ? 'error' : 'warn',
      message: `新增线索日环比下跌 ${drop}%（昨日 ${tYest} → 今日 ${tToday}，阈值 ${cfg.newLeadDropPct}%）`,
    });
  }

  // 冷却去重：只对在冷却窗口外、且阈值真正越界的规则发告警。
  const fired: AnomalyCheck[] = [];
  for (const c of checks) {
    const lastKey = `alert:${c.rule}:last`;
    const last = await metaGet(lastKey);
    const lastTs = last ? Number(last) : 0;
    if (now - lastTs < cfg.anomalyCooldownMs) continue;
    await metaSet(lastKey, String(now));
    emitAlert(c.level, `[医美运营异常·${c.rule}] ${c.message}`);
    fired.push(c);
  }
  return fired;
}
