/**
 * 策略建议引擎（P2 自动策略闭环的「建议」侧）。
 *
 * 定位：把「数据回流」变成「可执行建议」，但**绝不自动执行**——引擎只产出建议并落库，
 * 由运营经 `reviewSuggestion` 人工确认（approved）后才允许 `markSuggestionExecuted`。
 * 人工闸门是硬约束：避免把经营动作交给无人值守的规则引擎。
 *
 * 规则（全部基于真实指标，无任何编造）：
 * 1. `improve_arrival`    到院率低于阈值 → 建议加强到店提醒与沉默回捞配置
 * 2. `improve_deal`       成交率低于阈值 → 建议补话术库/案例库覆盖并复盘咨询师简报
 * 3. `improve_repurchase` 复购率低于阈值 → 建议加强术后关怀序列与复购培育触达
 * 4. `check_lead_drop`    新增线索日环比大跌 → 建议核查投放消耗与留资渠道
 * 5. `optimize_ad_cpl`    单条留资成本偏高 → 建议优化投放渠道结构（有花费数据时）
 *
 * 幂等：suggestion_id = sug_{rule}_{YYYY-MM-DD}，同规则当天重复生成去重。
 * 数据不足（分母为 0）时该规则不产出建议——没有证据就不给意见。
 */

import { getDb, dbCall, allRows } from '../infra/db';
import { getConfig } from '../config';
import { runAnalyticsQuery } from '../analytics/analytics-service';
import { orderStats } from '../repo/order-repo';
import { adSpendStats } from '../repo/ad-spend-repo';
import { emitAlert } from './report-service';

export type SuggestionSeverity = 'info' | 'warn' | 'error';
export type SuggestionStatus = 'pending' | 'approved' | 'rejected' | 'executed';

export interface StrategySuggestion {
  suggestionId: string;
  tenantId: string;
  rule: string;
  severity: SuggestionSeverity;
  title: string;
  detail: string;
  action: string;
  evidence: Record<string, number | null>;
  status: SuggestionStatus;
  reviewReason?: string;
  reviewedBy?: string;
  reviewedAt?: number;
  executedAt?: number;
  createdAt: number;
  updatedAt: number;
}

function todayStr(now = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function rowToSuggestion(r: Record<string, unknown>): StrategySuggestion {
  let evidence: Record<string, number | null> = {};
  if (r.evidence_json) {
    try {
      evidence = JSON.parse(String(r.evidence_json));
    } catch {
      evidence = {};
    }
  }
  return {
    suggestionId: String(r.suggestion_id),
    tenantId: String(r.tenant_id),
    rule: String(r.rule),
    severity: String(r.severity) as SuggestionSeverity,
    title: String(r.title),
    detail: String(r.detail),
    action: String(r.action),
    evidence,
    status: String(r.status) as SuggestionStatus,
    reviewReason: (r.review_reason as string) ?? undefined,
    reviewedBy: (r.reviewed_by as string) ?? undefined,
    reviewedAt: r.reviewed_at != null ? Number(r.reviewed_at) : undefined,
    executedAt: r.executed_at != null ? Number(r.executed_at) : undefined,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export interface GeneratedSuggestion {
  rule: string;
  severity: SuggestionSeverity;
  title: string;
  detail: string;
  action: string;
  evidence: Record<string, number | null>;
}

/** 规则引擎：纯函数，输入真实指标 → 输出建议列表（无证据的规则不产出）。 */
export function evaluateStrategyRules(input: {
  arrivalRate: number;
  dealRate: number;
  repurchaseRate: number;
  newLeadsToday: number;
  newLeadsYesterday: number;
  cpl: number | null;
  totalSpend: number;
  thresholds: {
    arrivalRateMin: number;
    dealRateMin: number;
    repurchaseRateMin: number;
    newLeadDropPct: number;
    cplMax: number;
  };
}): GeneratedSuggestion[] {
  const out: GeneratedSuggestion[] = [];
  const t = input.thresholds;

  // 1) 到院率
  if (input.arrivalRate < t.arrivalRateMin * 100) {
    out.push({
      rule: 'improve_arrival',
      severity: input.arrivalRate < t.arrivalRateMin * 50 ? 'error' : 'warn',
      title: '到院率低于预期，建议强化到店提醒',
      detail: `当前到院率 ${input.arrivalRate}%，低于阈值 ${t.arrivalRateMin * 100}%。到院率低会直接压低成交基数。`,
      action: '检查沉默回捞（recall）配置与欢迎语触达是否正常；对已预约客户加开到店前提醒触达。',
      evidence: { arrivalRate: input.arrivalRate, threshold: t.arrivalRateMin * 100 },
    });
  }

  // 2) 成交率
  if (input.dealRate < t.dealRateMin * 100) {
    out.push({
      rule: 'improve_deal',
      severity: input.dealRate < t.dealRateMin * 50 ? 'error' : 'warn',
      title: '成交率偏低，建议补齐话术与案例支撑',
      detail: `当前成交率 ${input.dealRate}%（成交/到院），低于阈值 ${t.dealRateMin * 100}%。`,
      action: '经 library_search 补齐对应项目的话术库与案例库覆盖；复盘咨询师简报（lead_briefing）使用情况。',
      evidence: { dealRate: input.dealRate, threshold: t.dealRateMin * 100 },
    });
  }

  // 3) 复购率
  if (input.repurchaseRate < t.repurchaseRateMin * 100) {
    out.push({
      rule: 'improve_repurchase',
      severity: 'warn',
      title: '复购率偏低，建议加强术后关怀与复购培育',
      detail: `当前复购率 ${input.repurchaseRate}%，低于阈值 ${t.repurchaseRateMin * 100}%。`,
      action: '确认术后关怀序列（postOpDays）已启用；对已成交客户补充复购培育触达（repurchase）。',
      evidence: { repurchaseRate: input.repurchaseRate, threshold: t.repurchaseRateMin * 100 },
    });
  }

  // 4) 新增线索日环比
  if (
    input.newLeadsYesterday > 0 &&
    input.newLeadsToday < input.newLeadsYesterday * (1 - t.newLeadDropPct / 100)
  ) {
    const drop = Math.round((1 - input.newLeadsToday / input.newLeadsYesterday) * 1000) / 10;
    out.push({
      rule: 'check_lead_drop',
      severity: drop > t.newLeadDropPct * 1.5 ? 'error' : 'warn',
      title: '新增线索日环比大幅下跌，建议核查投放与留资渠道',
      detail: `新增线索由昨日 ${input.newLeadsYesterday} 降至今日 ${input.newLeadsToday}，跌幅 ${drop}%（阈值 ${t.newLeadDropPct}%）。`,
      action: '核查各投放渠道消耗是否异常（GET /ad-spend）；检查留资 webhook 是否正常入站。',
      evidence: {
        newLeadsToday: input.newLeadsToday,
        newLeadsYesterday: input.newLeadsYesterday,
        dropPct: drop,
      },
    });
  }

  // 5) 投放 CPL（仅有花费数据时）
  if (input.cpl != null && input.cpl > t.cplMax) {
    out.push({
      rule: 'optimize_ad_cpl',
      severity: 'warn',
      title: '单条留资成本偏高，建议优化投放渠道结构',
      detail: `当前单条留资成本 ¥${input.cpl}，高于阈值 ¥${t.cplMax}（总消耗 ¥${input.totalSpend}）。`,
      action: '对比分渠道消耗与转化（GET /ad-spend），缩减高成本低转化渠道预算。',
      evidence: { cpl: input.cpl, threshold: t.cplMax, totalSpend: input.totalSpend },
    });
  }

  return out;
}

/**
 * 生成本日策略建议（幂等：同规则当天去重）。
 * 返回本次实际新增的建议列表（已存在的规则不重复插入）。
 */
export async function generateStrategySuggestions(now = Date.now()): Promise<GeneratedSuggestion[]> {
  const cfg = getConfig().scheduler;
  const date = todayStr(now);

  const [full, orders, spend] = await Promise.all([
    runAnalyticsQuery({ type: 'full' }),
    orderStats(),
    adSpendStats(),
  ]);
  const data = full.data as {
    funnel: Array<{ stage: string; count: number }>;
    trend: Array<{ period: string; leadCount: number }>;
  };

  const STAGE_LABEL: Record<string, string> = {
    new: '新客',
    arrived: '到院',
    deal: '成交',
  };
  const countOf = (stage: string): number =>
    data.funnel.find((f) => f.stage === (STAGE_LABEL[stage] ?? stage))?.count ?? 0;
  const total = data.funnel.reduce((s, f) => s + f.count, 0);
  const arrived = countOf('arrived');
  const deals = countOf('deal');

  const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  const today = date;
  const yest = todayStr(now - 86_400_000);
  const tToday = data.trend.find((t) => t.period === today)?.leadCount ?? 0;
  const tYest = data.trend.find((t) => t.period === yest)?.leadCount ?? 0;
  const cpl = spend.totalSpend > 0 && spend.conversions > 0
    ? Math.round((spend.totalSpend / spend.conversions) * 100) / 100
    : null;

  const generated = evaluateStrategyRules({
    arrivalRate: pct(arrived, total),
    dealRate: pct(deals, arrived),
    repurchaseRate: orders.repurchaseRate,
    newLeadsToday: tToday,
    newLeadsYesterday: tYest,
    cpl,
    totalSpend: spend.totalSpend,
    thresholds: {
      arrivalRateMin: cfg.arrivalRateMin,
      dealRateMin: cfg.dealRateMin,
      repurchaseRateMin: cfg.repurchaseRateMin,
      newLeadDropPct: cfg.newLeadDropPct,
      cplMax: Number(process.env.MA_ALERT_CPL_MAX ?? 300) || 300,
    },
  });

  if (!generated.length) return [];

  await dbCall(async () => {
    const db = await getDb();
    const tid = getConfig().tenantId;
    for (const g of generated) {
      const suggestionId = `sug_${g.rule}_${date}`;
      await db
        .prepare(
          `INSERT INTO ma_strategy_suggestion(
             suggestion_id, tenant_id, rule, severity, title, detail, action,
             evidence_json, status, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(suggestion_id) DO NOTHING`
        )
        .run(
          suggestionId,
          tid,
          g.rule,
          g.severity,
          g.title,
          g.detail,
          g.action,
          JSON.stringify(g.evidence),
          now,
          now
        );
    }
  }, '策略建议写入');

  // 有 error 级建议时发一条告警，提醒运营去看（仍不自动执行）
  const worst = generated.find((g) => g.severity === 'error');
  if (worst) {
    emitAlert('warn', `[策略建议] ${worst.title}——${worst.detail}（待人工确认，不自动执行）`);
  }
  return generated;
}

/** 查询建议列表（默认 pending 优先）。 */
export async function listSuggestions(filter: { status?: SuggestionStatus; limit?: number } = {}): Promise<StrategySuggestion[]> {
  const limit = Math.min(Math.max(Number(filter.limit ?? 50), 1), 500);
  return await dbCall(async () => {
    const db = await getDb();
    const wh: string[] = ['tenant_id = ?'];
    const vals: unknown[] = [getConfig().tenantId];
    if (filter.status) {
      wh.push('status = ?');
      vals.push(filter.status);
    }
    const rows = await allRows(
      db.prepare(
        `SELECT * FROM ma_strategy_suggestion WHERE ${wh.join(' AND ')}
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT ?`
      ),
      ...vals,
      limit
    );
    return rows.map(rowToSuggestion);
  }, '策略建议查询');
}

/**
 * 人工确认建议：approve / reject。
 * rejected 必须给原因（reviewReason）——与内容驳回同一纪律。
 */
export async function reviewSuggestion(
  suggestionId: string,
  decision: 'approved' | 'rejected',
  operator: string,
  reason?: string
): Promise<StrategySuggestion> {
  if (decision === 'rejected' && !String(reason ?? '').trim()) {
    throw new Error('驳回策略建议必须给出原因（reviewReason）');
  }
  return await dbCall(async () => {
    const db = await getDb();
    const row = (await db
      .prepare('SELECT * FROM ma_strategy_suggestion WHERE suggestion_id = ?')
      .get(suggestionId)) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`策略建议不存在：${suggestionId}`);
    if (String(row.status) !== 'pending') {
      throw new Error(`当前状态 ${row.status} 不允许再审（仅 pending 可确认）`);
    }
    const now = Date.now();
    await db
      .prepare(
        `UPDATE ma_strategy_suggestion
         SET status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
         WHERE suggestion_id = ?`
      )
      .run(
        decision,
        decision === 'rejected' ? String(reason).slice(0, 500) : null,
        String(operator).slice(0, 100) || 'operator',
        now,
        now,
        suggestionId
      );
    const updated = (await db
      .prepare('SELECT * FROM ma_strategy_suggestion WHERE suggestion_id = ?')
      .get(suggestionId)) as Record<string, unknown>;
    return rowToSuggestion(updated);
  }, '策略建议确认');
}

/** 标记建议已执行（仅 approved 可执行——人工闸门）。 */
export async function markSuggestionExecuted(suggestionId: string): Promise<StrategySuggestion> {
  return await dbCall(async () => {
    const db = await getDb();
    const row = (await db
      .prepare('SELECT * FROM ma_strategy_suggestion WHERE suggestion_id = ?')
      .get(suggestionId)) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`策略建议不存在：${suggestionId}`);
    if (String(row.status) !== 'approved') {
      throw new Error(`当前状态 ${row.status} 不允许执行（仅 approved 可执行：先人工确认）`);
    }
    const now = Date.now();
    await db
      .prepare('UPDATE ma_strategy_suggestion SET executed_at = ?, status = ?, updated_at = ? WHERE suggestion_id = ?')
      .run(now, 'executed', now, suggestionId);
    const updated = (await db
      .prepare('SELECT * FROM ma_strategy_suggestion WHERE suggestion_id = ?')
      .get(suggestionId)) as Record<string, unknown>;
    return rowToSuggestion(updated);
  }, '策略建议执行');
}

/** 建议快照（看板 / API 用）：计数 + pending 列表。 */
export async function suggestionSnapshot(): Promise<{
  counts: Record<SuggestionStatus, number>;
  items: StrategySuggestion[];
}> {
  const items = await listSuggestions({ limit: 20 });
  const counts: Record<SuggestionStatus, number> = { pending: 0, approved: 0, rejected: 0, executed: 0 };
  for (const s of items) counts[s.status] += 1;
  return { counts, items };
}
