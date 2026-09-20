/**
 * A/B 分流实验服务（E 组：只看厂商宣称数据 → 自做 A/B）。
 *
 * 设计要点：
 * - 实验绑定 SOP 触达 topic（welcome / recall_first / recall_second / birthday / repurchase），
 *   调度器执行任务时按 sticky 分流取变体文案；无活跃实验 → 回落默认模板（零回归）。
 * - sticky 分流：sha256(experimentId:leadId) 确定性哈希 → 按变体权重（缺省 50/50）落桶，
 *   并物化进 ma_ab_assignment（UNIQUE(experiment_id, lead_id)）——同一线索永远同一变体，
 *   且留有可审计的分配记录；权重后续调整不影响已分配线索。
 * - 变体文案创建时过医疗广告合规筛查（medicalAdRules），命中红线拒绝建实验；
 *   发送时统一追加风险提示（RISK_HINT），与默认模板同一纪律。
 * - 转化口径（metric）按「分配之后发生」归因，直接 join 既有真实表，不新增写路径：
 *   reply   → ma_lead_message 中该线索的 user 消息（分配时间之后）
 *   booking → ma_appointment 建单时间（分配时间之后）
 *   arrived → ma_appointment.arrived_at（分配时间之后）
 * - 报表只给真实计数与转化率 + 样本量提示（assigned < 30 明示「样本量小，差异无统计学意义」），
 *   绝不伪造「显著提升 X%」这类结论。
 */

import { createHash } from 'node:crypto';
import { getDb, dbCall, allRows, getRow, runStmt } from '../infra/db';
import { getConfig } from '../config';
import { MaError } from '../infra/errors';
import { medicalAdRules } from '@agent-harness/medical-ad-guard';
import { RISK_HINT } from './outreach-templates';

/** 实验可绑定的 SOP 触达 topic（与 scheduler executeJob 产出的 topic 精确对应）。 */
export const AB_TOPICS = ['welcome', 'recall_first', 'recall_second', 'birthday', 'repurchase'] as const;
export type AbTopic = (typeof AB_TOPICS)[number];

/** 转化口径。 */
export const AB_METRICS = ['reply', 'booking', 'arrived'] as const;
export type AbMetric = (typeof AB_METRICS)[number];

export interface AbExperimentRow {
  experimentId: string;
  name: string;
  topic: AbTopic;
  metric: AbMetric;
  status: 'running' | 'stopped';
  createdAt: number;
  stoppedAt?: number;
  variants: { key: string; text: string; weight: number }[];
}

function isAbTopic(v: string): v is AbTopic {
  return (AB_TOPICS as readonly string[]).includes(v);
}

function isAbMetric(v: string): v is AbMetric {
  return (AB_METRICS as readonly string[]).includes(v);
}

/** 确定性分桶：sha256(experimentId:leadId) 首 4 字节 → uint32 → % totalWeight。 */
function bucketOf(experimentId: string, leadId: string, totalWeight: number): number {
  const h = createHash('sha256').update(`${experimentId}:${leadId}`).digest();
  const u32 = h.readUInt32BE(0);
  return u32 % totalWeight;
}

function assertCompliantText(text: string, what: string): void {
  for (const rule of medicalAdRules) {
    if (rule.re.test(text)) {
      throw new MaError('INVALID_ARGUMENT', `${what}命中医疗广告合规红线（${rule.reason}），已拒绝创建实验`);
    }
  }
}

/** 创建实验（变体 2~3 个；文案过合规筛查；返回 experimentId）。入参宽容解析（路由 JSON 直通）。 */
export async function createExperiment(input: {
  name: string;
  topic: string;
  metric?: string;
  variants: Record<string, unknown>[];
}): Promise<{ experimentId: string }> {
  const name = input.name.trim();
  if (!name) throw new MaError('INVALID_ARGUMENT', '实验名称 name 不能为空');
  if (!isAbTopic(input.topic)) {
    throw new MaError('INVALID_ARGUMENT', `topic 必须是 ${AB_TOPICS.join('|')}，收到：${input.topic}`);
  }
  const metric = input.metric ? input.metric : 'booking';
  if (!isAbMetric(metric)) {
    throw new MaError('INVALID_ARGUMENT', `metric 必须是 ${AB_METRICS.join('|')}，收到：${metric}`);
  }
  const raw = input.variants ?? [];
  if (raw.length < 2 || raw.length > 3) {
    throw new MaError('INVALID_ARGUMENT', 'variants 必须为 2~3 个变体（A/B 至少两组才有对照意义）');
  }
  const prepared = raw.map((v, i) => ({
    key: String(v.key ?? '').trim() || String.fromCharCode(65 + i),
    text: String(v.text ?? '').trim(),
    weight: typeof v.weight === 'number' && Number.isFinite(v.weight) && v.weight >= 0 ? Math.round(v.weight) : 50,
  }));
  const keys = prepared.map((p) => p.key);
  if (new Set(keys).size !== keys.length) {
    throw new MaError('INVALID_ARGUMENT', '变体 key 不得重复');
  }
  for (const p of prepared) {
    if (!p.text) throw new MaError('INVALID_ARGUMENT', '变体文案 text 不能为空');
    assertCompliantText(p.text, `变体「${p.key}」文案`);
  }
  const experimentId = `ab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await dbCall(async () => {
    const db = await getDb();
    await runStmt(
      db.prepare(
        `INSERT INTO ma_ab_experiment (experiment_id, tenant_id, name, topic, metric, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`
      ),
      experimentId,
      getConfig().tenantId,
      name,
      input.topic,
      metric,
      Date.now()
    );
    for (const p of prepared) {
      await runStmt(
        db.prepare(
          `INSERT INTO ma_ab_variant (experiment_id, variant_key, text, weight) VALUES (?, ?, ?, ?)`
        ),
        experimentId,
        p.key,
        p.text,
        p.weight
      );
    }
  }, '创建 A/B 实验');
  return { experimentId };
}

/** 读取实验定义（含变体）。 */
export async function getExperiment(experimentId: string): Promise<AbExperimentRow | null> {
  return await dbCall(async () => {
    const db = await getDb();
    const r = (await getRow(
      db.prepare('SELECT * FROM ma_ab_experiment WHERE experiment_id = ? AND tenant_id = ?'),
      experimentId,
      getConfig().tenantId
    )) as Record<string, unknown> | undefined;
    if (!r) return null;
    const vs = await allRows(
      db.prepare('SELECT variant_key, text, weight FROM ma_ab_variant WHERE experiment_id = ? ORDER BY variant_key'),
      experimentId
    );
    return {
      experimentId: String(r.experiment_id),
      name: String(r.name),
      topic: String(r.topic) as AbTopic,
      metric: String(r.metric) as AbMetric,
      status: String(r.status) as 'running' | 'stopped',
      createdAt: Number(r.created_at),
      stoppedAt: r.stopped_at != null ? Number(r.stopped_at) : undefined,
      variants: vs.map((v) => ({ key: String(v.variant_key), text: String(v.text), weight: Number(v.weight) })),
    };
  }, '读取实验');
}

/** 实验清单（含变体摘要）。 */
export async function listExperiments(): Promise<AbExperimentRow[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const rows = await allRows(
      db.prepare('SELECT experiment_id FROM ma_ab_experiment WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50'),
      getConfig().tenantId
    );
    return rows.map((r) => String(r.experiment_id));
  }, '实验清单').then(async (ids) => {
    const out: AbExperimentRow[] = [];
    for (const id of ids) {
      const e = await getExperiment(id);
      if (e) out.push(e);
    }
    return out;
  });
}

/**
 * sticky 分流：物化分配（UNIQUE 幂等）后返回权威变体。
 * 分桶只看当前权重；但一旦物化，后续读取一律以落库分配为准（权重变化不重洗）。
 */
export async function assignVariant(experimentId: string, leadId: string): Promise<{ variantKey: string; text: string } | null> {
  const exp = await getExperiment(experimentId);
  if (!exp) throw new MaError('NOT_FOUND', `实验不存在：${experimentId}`);
  if (!exp.variants.length) throw new MaError('INVALID_ARGUMENT', '实验无变体，无法分流');
  return await dbCall(async () => {
    const db = await getDb();
    // 已有分配 → 直接返回（sticky）
    const existing = (await getRow(
      db.prepare('SELECT variant_key FROM ma_ab_assignment WHERE experiment_id = ? AND lead_id = ?'),
      experimentId,
      leadId
    )) as Record<string, unknown> | undefined;
    if (existing) {
      const v = exp.variants.find((x) => x.key === String(existing.variant_key));
      return v ? { variantKey: v.key, text: v.text } : null;
    }
    // 按当前权重分桶 → 物化
    const total = exp.variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
    const first = exp.variants[0];
    if (!first) throw new MaError('INVALID_ARGUMENT', '实验无变体，无法分流');
    let chosen = first;
    if (total > 0) {
      const b = bucketOf(experimentId, leadId, total);
      let acc = 0;
      for (const v of exp.variants) {
        acc += Math.max(0, v.weight);
        if (b < acc) {
          chosen = v;
          break;
        }
      }
    }
    await runStmt(
      db.prepare(
        `INSERT INTO ma_ab_assignment (tenant_id, experiment_id, lead_id, variant_key, assigned_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(experiment_id, lead_id) DO NOTHING`
      ),
      getConfig().tenantId,
      experimentId,
      leadId,
      chosen.key,
      Date.now()
    );
    return { variantKey: chosen.key, text: chosen.text };
  }, 'A/B 分流');
}

/** 调度器接入点：按 topic 取活跃实验并分流；无实验/实验已停 → null（回落默认模板）。 */
export async function resolveAbText(topic: string, leadId: string): Promise<{ experimentId: string; variantKey: string; text: string } | null> {
  const row = (await getRow(
    (await getDb()).prepare(
      `SELECT experiment_id FROM ma_ab_experiment WHERE tenant_id = ? AND topic = ? AND status = 'running'
       ORDER BY created_at DESC LIMIT 1`
    ),
    getConfig().tenantId,
    topic
  )) as Record<string, unknown> | undefined;
  if (!row) return null;
  const experimentId = String(row.experiment_id);
  const asg = await assignVariant(experimentId, leadId);
  if (!asg) return null;
  return { experimentId, variantKey: asg.variantKey, text: asg.text };
}

/** 停止实验（running → stopped；之后该 topic 回落默认模板，分配记录保留可复盘）。 */
export async function stopExperiment(experimentId: string): Promise<AbExperimentRow> {
  const exp = await getExperiment(experimentId);
  if (!exp) throw new MaError('NOT_FOUND', `实验不存在：${experimentId}`);
  if (exp.status === 'running') {
    await dbCall(async () => {
      await runStmt(
        (await getDb()).prepare(
          `UPDATE ma_ab_experiment SET status = 'stopped', stopped_at = ? WHERE experiment_id = ? AND tenant_id = ?`
        ),
        Date.now(),
        experimentId,
        getConfig().tenantId
      );
    }, '停止实验');
  }
  return (await getExperiment(experimentId)) as AbExperimentRow;
}

export interface AbReport {
  experiment: AbExperimentRow;
  variants: { key: string; assigned: number; conversions: number; conversionRate: number | null }[];
  note: string;
}

/** 转化归因 SQL（按 metric 选择 EXISTS 子查询；分配时间之后发生才计转化）。 */
function conversionExistsSql(metric: AbMetric): string {
  if (metric === 'reply') {
    return `EXISTS (SELECT 1 FROM ma_lead_message m WHERE m.lead_id = a.lead_id AND m.role = 'user' AND m.created_at >= a.assigned_at)`;
  }
  if (metric === 'booking') {
    return `EXISTS (SELECT 1 FROM ma_appointment p WHERE p.lead_id = a.lead_id AND p.created_at >= a.assigned_at)`;
  }
  return `EXISTS (SELECT 1 FROM ma_appointment p WHERE p.lead_id = a.lead_id AND p.arrived_at IS NOT NULL AND p.arrived_at >= a.assigned_at)`;
}

/** 实验报表：真实 SQL 聚合（分配数 / 转化数 / 转化率），附样本量诚实提示。 */
export async function experimentReport(experimentId: string): Promise<AbReport> {
  const exp = await getExperiment(experimentId);
  if (!exp) throw new MaError('NOT_FOUND', `实验不存在：${experimentId}`);
  const rows = await dbCall(async () => {
    return await allRows(
      (await getDb()).prepare(
        `SELECT a.variant_key AS vk, COUNT(*) AS assigned,
                SUM(CASE WHEN ${conversionExistsSql(exp.metric)} THEN 1 ELSE 0 END) AS conversions
         FROM ma_ab_assignment a
         WHERE a.tenant_id = ? AND a.experiment_id = ?
         GROUP BY a.variant_key`
      ),
      getConfig().tenantId,
      experimentId
    );
  }, '实验报表聚合');
  const byKey = new Map(rows.map((r) => [String(r.vk), { assigned: Number(r.assigned), conversions: Number(r.conversions) }]));
  const variants = exp.variants.map((v) => {
    const s = byKey.get(v.key) ?? { assigned: 0, conversions: 0 };
    return {
      key: v.key,
      assigned: s.assigned,
      conversions: s.conversions,
      conversionRate: s.assigned > 0 ? Number((s.conversions / s.assigned).toFixed(4)) : null,
    };
  });
  const minAssigned = Math.min(...variants.map((v) => v.assigned));
  const note =
    variants.every((v) => v.assigned === 0)
      ? '暂无分配样本：实验尚未产生触达（检查调度器是否在跑、线索是否满足触达资格）。'
      : minAssigned < 30
        ? '样本量小（任一变体分配数 < 30），转化率差异不具统计学意义，请继续积累数据再做结论；只看厂商宣称数据不如跑完这组实验。'
        : `转化口径：${exp.metric}（分配之后发生才归因）。差异解读建议结合绝对量与业务语境，避免过早上线单一变体。`;
  return { experiment: exp, variants, note };
}

/** 发送侧文案组装：变体文案缺风险提示时补齐（与默认模板同一纪律）。 */
export function withRiskHint(text: string): string {
  return text.includes('医疗美容有风险') ? text : `${text}\n${RISK_HINT}`;
}
