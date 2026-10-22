/**
 * 广告投放消耗仓储（P1-⑨ ROI 数据底座）。
 *
 * 数据来源两条路径：
 * 1. 投放平台 API 拉取（services/ad-client.ts → upsertAdSpend，source=平台标识）；
 * 2. 运营手动导入（POST /ad-spend/import，source=import）——无 API 资质时的诚实路径。
 *
 * 幂等：UNIQUE(tenant_id, spend_date, channel, campaign_id) + ON CONFLICT DO UPDATE，
 * 同日同计划重复导入/拉取覆盖更新，不产生重复行。
 */

import { getDb, dbCall, allRows, getRow, runStmt } from '../infra/db';
import { getConfig } from '../config';

/** 单条消耗记录（导入 / 拉取共用的输入形态）。 */
export interface AdSpendInput {
  spendDate: string;
  channel: string;
  campaignId: string;
  campaignName?: string;
  spend: number;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  source?: string;
}

export interface AdSpendRow {
  spendId: string;
  tenantId: string;
  spendDate: string;
  channel: string;
  campaignId: string;
  campaignName?: string;
  spend: number;
  currency: string;
  impressions: number;
  clicks: number;
  conversions: number;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export interface AdSpendStats {
  /** 总花费（元）。 */
  totalSpend: number;
  /** 曝光 / 点击 / 转化（留资）合计。 */
  impressions: number;
  clicks: number;
  conversions: number;
  /** 分渠道花费与转化。 */
  byChannel: Array<{ channel: string; spend: number; clicks: number; conversions: number }>;
  /** 分日花费（升序，供趋势）。 */
  byDate: Array<{ date: string; spend: number; conversions: number }>;
  /** 记录条数（0 = 无数据）。 */
  rowCount: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 归一化并校验一条输入；非法抛错（fail-fast，避免脏数据进 ROI 分母）。 */
function normalize(input: AdSpendInput, index: number): {
  spendDate: string;
  channel: string;
  campaignId: string;
  campaignName: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  source: string;
} {
  const at = `第 ${index + 1} 条`;
  const spendDate = String(input.spendDate ?? '').trim();
  if (!DATE_RE.test(spendDate)) {
    throw new Error(`${at}：spendDate 必须是 YYYY-MM-DD，收到「${spendDate}」`);
  }
  const channel = String(input.channel ?? '').trim();
  if (!channel) throw new Error(`${at}：channel 不能为空`);
  const campaignId = String(input.campaignId ?? '').trim();
  if (!campaignId) throw new Error(`${at}：campaignId 不能为空`);
  const spend = Number(input.spend);
  if (!Number.isFinite(spend) || spend < 0) {
    throw new Error(`${at}：spend 必须是非负数字，收到「${input.spend}」`);
  }
  const num = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  return {
    spendDate,
    channel,
    campaignId,
    campaignName: input.campaignName ? String(input.campaignName).trim() || null : null,
    spend,
    impressions: num(input.impressions),
    clicks: num(input.clicks),
    conversions: num(input.conversions),
    source: (input.source ?? 'import').trim() || 'import',
  };
}

/** 批量导入 / 落库消耗（幂等，返回实际写入条数）。 */
export async function upsertAdSpend(rows: AdSpendInput[]): Promise<number> {
  if (!rows.length) return 0;
  const normalized = rows.map((r, i) => normalize(r, i));
  const now = Date.now();
  return await dbCall(async () => {
    const db = await getDb();
    const tid = getConfig().tenantId;
    let written = 0;
    for (const r of normalized) {
      const spendId = `as_${r.spendDate}_${r.channel}_${r.campaignId}`.slice(0, 120);
      await runStmt(
        db.prepare(
          `INSERT INTO ma_ad_spend(
             spend_id, tenant_id, spend_date, channel, campaign_id, campaign_name,
             spend, currency, impressions, clicks, conversions, source, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, spend_date, channel, campaign_id) DO UPDATE SET
             campaign_name = excluded.campaign_name,
             spend = excluded.spend,
             impressions = excluded.impressions,
             clicks = excluded.clicks,
             conversions = excluded.conversions,
             source = excluded.source,
             updated_at = excluded.updated_at`
        ),
        spendId,
        tid,
        r.spendDate,
        r.channel,
        r.campaignId,
        r.campaignName,
        r.spend,
        r.impressions,
        r.clicks,
        r.conversions,
        r.source,
        now,
        now
      );
      written += 1;
    }
    return written;
  }, '广告消耗写入');
}

function rowToAdSpend(r: Record<string, unknown>): AdSpendRow {
  return {
    spendId: String(r.spend_id),
    tenantId: String(r.tenant_id),
    spendDate: String(r.spend_date),
    channel: String(r.channel),
    campaignId: String(r.campaign_id),
    campaignName: (r.campaign_name as string) ?? undefined,
    spend: Number(r.spend ?? 0),
    currency: String(r.currency ?? 'CNY'),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    conversions: Number(r.conversions ?? 0),
    source: String(r.source ?? 'import'),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** 查询消耗明细（按日期倒序）。 */
export async function listAdSpend(filter: { channel?: string; limit?: number } = {}): Promise<AdSpendRow[]> {
  const limit = Math.min(Math.max(Number(filter.limit ?? 200), 1), 1000);
  return await dbCall(async () => {
    const db = await getDb();
    const wh: string[] = ['tenant_id = ?'];
    const vals: unknown[] = [getConfig().tenantId];
    if (filter.channel) {
      wh.push('channel = ?');
      vals.push(filter.channel);
    }
    const rows = await allRows(
      db.prepare(
        `SELECT * FROM ma_ad_spend WHERE ${wh.join(' AND ')} ORDER BY spend_date DESC, channel ASC LIMIT ?`
      ),
      ...vals,
      limit
    );
    return rows.map(rowToAdSpend);
  }, '广告消耗查询');
}

/** 汇总统计：总花费 / 分渠道 / 分日。空数据返回全 0（fail-closed，不虚构）。 */
export async function adSpendStats(startTime?: number, endTime?: number): Promise<AdSpendStats> {
  return await dbCall(async () => {
    const db = await getDb();
    const wh: string[] = ['tenant_id = ?'];
    const vals: unknown[] = [getConfig().tenantId];
    if (startTime != null) {
      wh.push('spend_date >= ?');
      vals.push(new Date(startTime).toISOString().slice(0, 10));
    }
    if (endTime != null) {
      wh.push('spend_date <= ?');
      vals.push(new Date(endTime).toISOString().slice(0, 10));
    }
    const where = wh.join(' AND ');

    const totalRow = (await getRow(
      db.prepare(
        `SELECT COUNT(*) AS c,
                COALESCE(SUM(spend), 0) AS spend,
                COALESCE(SUM(impressions), 0) AS impressions,
                COALESCE(SUM(clicks), 0) AS clicks,
                COALESCE(SUM(conversions), 0) AS conversions
         FROM ma_ad_spend WHERE ${where}`
      ),
      ...vals
    )) as Record<string, unknown> | undefined;

    const chRows = await allRows(
      db.prepare(
        `SELECT channel,
                COALESCE(SUM(spend), 0) AS spend,
                COALESCE(SUM(clicks), 0) AS clicks,
                COALESCE(SUM(conversions), 0) AS conversions
         FROM ma_ad_spend WHERE ${where}
         GROUP BY channel ORDER BY spend DESC`
      ),
      ...vals
    );

    const dateRows = await allRows(
      db.prepare(
        `SELECT spend_date AS d,
                COALESCE(SUM(spend), 0) AS spend,
                COALESCE(SUM(conversions), 0) AS conversions
         FROM ma_ad_spend WHERE ${where}
         GROUP BY spend_date ORDER BY spend_date ASC`
      ),
      ...vals
    );

    return {
      totalSpend: Math.round(Number(totalRow?.spend ?? 0) * 100) / 100,
      impressions: Number(totalRow?.impressions ?? 0),
      clicks: Number(totalRow?.clicks ?? 0),
      conversions: Number(totalRow?.conversions ?? 0),
      byChannel: (chRows as Record<string, unknown>[]).map((r) => ({
        channel: String(r.channel),
        spend: Math.round(Number(r.spend ?? 0) * 100) / 100,
        clicks: Number(r.clicks ?? 0),
        conversions: Number(r.conversions ?? 0),
      })),
      byDate: (dateRows as Record<string, unknown>[]).map((r) => ({
        date: String(r.d),
        spend: Math.round(Number(r.spend ?? 0) * 100) / 100,
        conversions: Number(r.conversions ?? 0),
      })),
      rowCount: Number(totalRow?.c ?? 0),
    };
  }, '广告消耗统计');
}
