/**
 * 定时调度器（B3 根缺口）+ SOP/回捞规划（B4/B5 v1）。
 *
 * 职责（每轮 tick 两步）：
 * 1) planSopJobs —— 规划：
 *    - welcome：近期新建（stage='new'）线索排「欢迎语」（welcomeWindowHours 内，幂等键防重）；
 *    - recall：未转化（stage ∈ new/contacted/qualified/captured）、非 D 级、未转人工、
 *      已留资授权（consent_at 非空）且有联系方式（phone/wechat）的线索，沉默达
 *      2h/24h 节点各排一次「回捞」（scheduled_key = recall:{leadId}:{node} 幂等）；
 *      线索再次活跃（updated_at 刷新）后重新计时，天然避免「聊着呢还打扰」。
 *    - birthday / repurchase：需要运营提供生日/购买数据与文案，走 /scheduler/jobs 手动排期，
 *      本服务绝不虚构数据（fail-closed，与全插件纪律一致）。
 * 2) runDueJobs —— 消费到期任务：按模板产出合规文案 → enqueue 到 ma_outbox
 *    （topic='outreach.send'）→ 交 outbox worker 真实投递（至少一次）。
 *    执行前复查线索状态：已转化 / 已转人工 / D 级 → skipped（防打扰 + 投诉风险）。
 *
 * 投递前提：MA_OUTREACH_BASE_URL 已配置；未配置时消息在发件箱 pending 积压（诚实暴露），
 * 待网关接入后自动 flush。定时器 unref，不阻塞进程退出。
 */

import { getDb, dbCall, allRows, getRow } from '../infra/db';
import { getConfig } from '../config';
import { MaError } from '../infra/errors';
import {
  enqueueJob,
  dueBatch,
  markJobFinished,
  markJobFailed,
  jobStats,
  type ScheduleJobRow,
} from '../repo/schedule-job-repo';
import { enqueue } from '../repo/outbox-repo';
import { buildWelcomeText, buildRecallText, buildPostOpText } from './outreach-templates';
import { resolveAbText, withRiskHint } from './ab-service';
import { generateDailyReport, scanAnomalies, metaGet, metaSet } from './report-service';
import { pullAdSpend } from './ad-client';
import { generateStrategySuggestions } from './strategy-service';
import { screenMedicalAdText } from '@agent-harness/medical-ad-guard';

let timer: NodeJS.Timeout | null = null;

/** 任务级最大尝试次数（消息产出失败的退避上限；投递侧重试由 outbox maxAttempts 独立控制）。 */
const MAX_JOB_ATTEMPTS = 5;

/** 未转化阶段（回捞候选；booked/arrived/deal 已转化，lost 已流失沉淀，均不回捞）。 */
const UNCONVERTED_STAGES = `'new','contacted','qualified','captured'`;

interface LeadBrief {
  lead_id: string;
  channel: string;
  project: string | null;
  name: string | null;
  phone: string | null;
  wechat: string | null;
  consent_at: number | null;
}

function toBrief(r: Record<string, unknown>): LeadBrief {
  return {
    lead_id: String(r.lead_id),
    channel: String(r.channel ?? ''),
    project: (r.project as string) ?? null,
    name: (r.name as string) ?? null,
    phone: (r.phone as string) ?? null,
    wechat: (r.wechat as string) ?? null,
    consent_at: r.consent_at == null ? null : Number(r.consent_at),
  };
}

/** 读取单条线索的调度所需最小字段。 */
async function leadBrief(leadId: string): Promise<LeadBrief | undefined> {
  return await dbCall(async () => {
    const r = (await getRow(
      (await getDb()).prepare(
        `SELECT lead_id, channel, project, name, phone, wechat, consent_at FROM ma_lead WHERE lead_id = ?`
      ),
      leadId
    )) as Record<string, unknown> | undefined;
    return r ? toBrief(r) : undefined;
  }, '读取线索概要');
}

/** 回捞候选查询：未转化 + 非 D 级 + 未转人工 + 已授权 + 有联系方式 + 沉默达阈值。 */
async function recallCandidates(silenceBeforeMs: number): Promise<LeadBrief[]> {
  return await dbCall(async () => {
    const cfg = getConfig();
    const rows = await allRows(
      (await getDb()).prepare(
        `SELECT lead_id, channel, project, name, phone, wechat, consent_at FROM ma_lead
         WHERE tenant_id = ?
           AND stage IN (${UNCONVERTED_STAGES})
           AND (grade IS NULL OR grade <> 'D')
           AND handed_off = 0
           AND consent_at IS NOT NULL
           AND ((phone IS NOT NULL AND phone != '') OR (wechat IS NOT NULL AND wechat != ''))
           AND updated_at <= ?
         ORDER BY updated_at ASC
         LIMIT 500`
      ),
      cfg.tenantId,
      silenceBeforeMs
    );
    return rows.map(toBrief);
  }, '查询回捞候选');
}

/** 规划结果计数。 */
export interface PlanResult {
  welcome: number;
  recallFirst: number;
  recallSecond: number;
  /** 术后关怀序列排期数（P1-⑦）。 */
  postOp: number;
}

/**
 * 规划 SOP 任务（幂等；重复调用因 scheduled_key UNIQUE 自动去重）。
 * 回捞按「最后活跃时间 + 节点」判定：沉默达 2h 排 first、达 24h 排 second；
 * 因 key 含节点，两节点互不冲突；线索复联后 updated_at 刷新，未达节点的自然不再排。
 */
export async function planSopJobs(now = Date.now()): Promise<PlanResult> {
  const cfg = getConfig().scheduler;
  const out: PlanResult = { welcome: 0, recallFirst: 0, recallSecond: 0, postOp: 0 };

  // 1) 欢迎语：近期新建、尚未进入需求挖掘的线索。
  if (cfg.welcomeEnabled) {
    const windowStart = now - cfg.welcomeWindowHours * 3_600_000;
    const rows = await dbCall(async () => {
      return await allRows(
        (await getDb()).prepare(
          `SELECT lead_id, channel, name, project FROM ma_lead
           WHERE tenant_id = ? AND stage = 'new' AND created_at >= ?
           ORDER BY created_at DESC LIMIT 200`
        ),
        getConfig().tenantId,
        windowStart
      );
    }, '查询欢迎语候选');
    for (const r of rows) {
      const leadId = String(r.lead_id);
      const inserted = await enqueueJob({
        jobType: 'welcome',
        leadId,
        scheduledKey: `welcome:${leadId}`,
        dueAt: now,
        payload: { channel: String(r.channel ?? ''), name: (r.name as string) ?? undefined, project: (r.project as string) ?? undefined },
      });
      if (inserted) out.welcome += 1;
    }
  }

  // 2) 沉默回捞：两节点独立排期。
  if (cfg.recallEnabled) {
    const nodes: Array<{ node: 'first' | 'second'; hours: number; field: 'recallFirst' | 'recallSecond' }> = [
      { node: 'first', hours: cfg.recallFirstHours, field: 'recallFirst' },
      { node: 'second', hours: cfg.recallSecondHours, field: 'recallSecond' },
    ];
    for (const n of nodes) {
      if (n.hours <= 0) continue;
      const candidates = await recallCandidates(now - n.hours * 3_600_000);
      for (const lead of candidates) {
        const inserted = await enqueueJob({
          jobType: 'recall',
          leadId: lead.lead_id,
          scheduledKey: `recall:${lead.lead_id}:${n.node}`,
          dueAt: now,
          payload: {
            node: n.node,
            channel: lead.channel,
            name: lead.name ?? undefined,
            project: lead.project ?? undefined,
            to: { name: lead.name ?? undefined, phone: lead.phone ?? undefined, wechat: lead.wechat ?? undefined },
          },
        });
        if (inserted) out[n.field] += 1;
      }
    }
  }

  // 3) 术后关怀序列（P1-⑦）：到店/成交后自动关怀与复购培育。
  if (cfg.postOpEnabled && cfg.postOpDays.length) {
    out.postOp = await planPostOpJobs(now);
  }

  return out;
}

/**
 * 规划术后关怀序列（P1-⑦）：到店/成交客户在 D+{postOpDays} 的自动关怀与复购培育。
 *
 * 触发源：ma_appointment.arrived_at（已到院/已完成的预约），按 arrived_at + day 计算各节点 dueAt。
 * - 幂等：scheduled_key = `post_op:{leadId}:{day}` UNIQUE，重复 tick 自动去重；
 * - 回填护栏：仅对「dueAt 落在最近一个最长周期内（now - maxDays, now]」的节点排期，
 *   避免首次启动对全部历史到店客户批量补发；后续节点随 tick 跨过阈值自然排期；
 * - 前置条件：已授权（consent_at 非空）+ 有联系方式（phone/wechat），与 recall 同口径；
 * - 执行复查：沿用防打扰逻辑（仅对已转化客户豁免 skipped，见 executeJob）。
 */
async function planPostOpJobs(now = Date.now()): Promise<number> {
  const cfg = getConfig().scheduler;
  const rows = await dbCall(async () => {
    return (await allRows(
      (await getDb()).prepare(
        `SELECT a.lead_id AS lead_id, a.arrived_at AS arrived_at, l.channel AS channel,
                l.name AS name, l.project AS project, l.phone AS phone, l.wechat AS wechat
         FROM ma_appointment a
         JOIN ma_lead l ON l.lead_id = a.lead_id AND l.tenant_id = a.tenant_id
         WHERE a.tenant_id = ? AND a.status IN ('arrived','completed') AND a.arrived_at IS NOT NULL
           AND l.consent_at IS NOT NULL
           AND ((l.phone IS NOT NULL AND l.phone != '') OR (l.wechat IS NOT NULL AND l.wechat != ''))`
      ),
      getConfig().tenantId
    )) as Array<{
      lead_id: string;
      arrived_at: number | null;
      channel: string | null;
      name: string | null;
      project: string | null;
      phone: string | null;
      wechat: string | null;
    }>;
  }, '查询术后关怀候选');

  const maxDays = Math.max(...cfg.postOpDays);
  const backfillMs = maxDays * 86400 * 1000;
  let count = 0;
  for (const r of rows) {
    const arrivedMs = (r.arrived_at ?? 0) * 1000; // arrived_at 存 unix 秒
    if (!Number.isFinite(arrivedMs) || arrivedMs <= 0) continue;
    for (const d of cfg.postOpDays) {
      const dueAt = arrivedMs + d * 86400 * 1000;
      if (dueAt <= now && dueAt > now - backfillMs) {
        const inserted = await enqueueJob({
          jobType: 'post_op',
          leadId: String(r.lead_id),
          scheduledKey: `post_op:${String(r.lead_id)}:${d}`,
          dueAt,
          payload: {
            day: d,
            channel: r.channel ?? '',
            name: r.name ?? undefined,
            project: r.project ?? undefined,
            to: { name: r.name ?? undefined, phone: r.phone ?? undefined, wechat: r.wechat ?? undefined },
          },
        });
        if (inserted) count += 1;
      }
    }
  }
  return count;
}

/**
 * 运营手动排期任务（生日/复购提醒等）。
 * 自拟文案必须先过医疗广告合规筛查（复用 medical-ad-guard 词表），
 * 命中红线（疗效承诺/诊断式/固定价/贬低同业等）直接拒绝，绝不带病入队。
 */
export async function scheduleManualJob(input: {
  jobType: 'welcome' | 'recall' | 'birthday' | 'repurchase' | 'post_op';
  leadId: string;
  dueAt?: number;
  text?: string;
  /** 术后关怀节点（天），仅 jobType='post_op' 使用。 */
  day?: number;
  key?: string;
}): Promise<{ scheduledKey: string; dueAt: number }> {
  const lead = await leadBrief(input.leadId);
  if (!lead) throw new MaError('NOT_FOUND', `线索不存在：${input.leadId}`);
  const dueAt = input.dueAt && Number.isFinite(input.dueAt) && input.dueAt > 0 ? input.dueAt : Date.now();
  const needsText = input.jobType === 'birthday' || input.jobType === 'repurchase';
  if (needsText && !String(input.text ?? '').trim()) {
    throw new MaError('INVALID_ARGUMENT', `${input.jobType} 任务必须提供运营自拟文案 text`);
  }
  if (input.text) {
    // 中期：走 guard 包统一入口（硬化归一化），与运行时护栏同源、可热更新同词库。
    const hits = screenMedicalAdText(input.text);
    const first = hits[0];
    if (first) {
      throw new MaError('INVALID_ARGUMENT', `文案命中医疗广告合规红线（${first.reason}），已拒绝排期`);
    }
  }
  const scheduledKey =
    input.key?.trim() ||
    (input.jobType === 'post_op'
      ? `post_op:${input.leadId}:${input.day ?? 1}`
      : `${input.jobType}:${input.leadId}:${dueAt}`);
  await enqueueJob({
    jobType: input.jobType,
    leadId: input.leadId,
    scheduledKey,
    dueAt,
    payload: {
      text: input.text,
      day: input.jobType === 'post_op' ? input.day ?? 1 : undefined,
      channel: lead.channel,
      name: lead.name ?? undefined,
      project: lead.project ?? undefined,
      to: { name: lead.name ?? undefined, phone: lead.phone ?? undefined, wechat: lead.wechat ?? undefined },
    },
  });
  return { scheduledKey, dueAt };
}

export interface RunResult {
  processed: number;
  done: number;
  skipped: number;
  failed: number;
}

/** 消费到期任务：产出对客消息进发件箱。单条失败退避重排，绝不阻断其余任务。 */
export async function runDueJobs(now = Date.now()): Promise<RunResult> {
  const cfg = getConfig().scheduler;
  const out: RunResult = { processed: 0, done: 0, skipped: 0, failed: 0 };
  const jobs = await dueBatch(cfg.batchSize, now);
  for (const job of jobs) {
    out.processed += 1;
    try {
      await executeJob(job);
      out.done += 1;
    } catch (e) {
      await markJobFailed(job.id, (e as Error).message, MAX_JOB_ATTEMPTS, 60_000);
      out.failed += 1;
    }
  }
  return out;
}

/** 执行单条任务：状态复查 → 文案产出 → 入发件箱 → 终态。 */
async function executeJob(job: ScheduleJobRow): Promise<void> {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const lead = await leadBrief(job.leadId);
  if (!lead) {
    await markJobFinished(job.id, 'skipped', 'lead 不存在（可能已清理），跳过触达');
    return;
  }
  // 复查防打扰：排期到执行之间线索可能已转化/转人工/被标 D 级。
  const state = (await getRow(
    (await getDb()).prepare('SELECT stage, handed_off, grade FROM ma_lead WHERE lead_id = ?'),
    job.leadId
  )) as Record<string, unknown> | undefined;
  const stage = String(state?.stage ?? '');
  // 术后关怀（post_op）面向已到店/成交客户，不跳过；其余 SOP（welcome/recall）对已转化客户跳过。
  if (['booked', 'arrived', 'deal'].includes(stage) && job.jobType !== 'post_op') {
    await markJobFinished(job.id, 'skipped', `线索已转化（stage=${stage}），跳过触达`);
    return;
  }
  if (Number(state?.handed_off ?? 0) === 1) {
    await markJobFinished(job.id, 'skipped', '线索已转人工，由咨询师跟进，跳过自动触达');
    return;
  }
  if (String(state?.grade ?? '') === 'D') {
    await markJobFinished(job.id, 'skipped', 'D 级（投诉/风险），禁止自动触达');
    return;
  }

  let topic: string;
  let text: string;
  let abExperimentId: string | undefined;
  let abVariant: string | undefined;
  if (job.jobType === 'welcome') {
    topic = 'welcome';
    text = buildWelcomeText(payload.name as string | undefined, payload.project as string | undefined);
  } else if (job.jobType === 'recall') {
    const node = payload.node === 'second' ? 'second' : 'first';
    topic = `recall_${node}`;
    text = buildRecallText(node, payload.name as string | undefined, payload.project as string | undefined);
  } else if (job.jobType === 'post_op') {
    // 术后关怀：优先用运营自拟文案，否则生成模板（D+1/D+7/D+30 分节点）。
    topic = 'post_op';
    const custom = String(payload.text ?? '').trim();
    text = custom || buildPostOpText(Number(payload.day ?? 1), payload.name as string | undefined, payload.project as string | undefined);
  } else {
    topic = job.jobType;
    const custom = String(payload.text ?? '').trim();
    if (!custom) {
      await markJobFinished(job.id, 'skipped', '任务缺少运营文案（payload.text 为空），跳过');
      return;
    }
    text = custom;
  }

  // A/B 分流（E 组）：该 topic 有活跃实验 → 按 sticky 分流取变体文案（创建时已过合规筛查，
  // 发送侧补风险提示）；无实验/已停止 → 保持默认模板，零回归。手动排期任务自带文案，不参与分流。
  if (job.jobType === 'welcome' || job.jobType === 'recall') {
    const ab = await resolveAbText(topic, job.leadId);
    if (ab) {
      text = withRiskHint(ab.text);
      abExperimentId = ab.experimentId;
      abVariant = ab.variantKey;
    }
  }

  // 入发件箱（幂等键 = 任务键，重跑不会重复产出）；真实投递由 outbox worker 完成。
  await enqueue('outreach.send', `outreach:${job.scheduledKey}`, {
    leadId: job.leadId,
    topic,
    channel: payload.channel ?? lead.channel,
    to: payload.to ?? { name: lead.name ?? undefined, phone: lead.phone ?? undefined, wechat: lead.wechat ?? undefined },
    text,
    jobId: job.id,
    ...(abExperimentId ? { abExperimentId, abVariant } : {}),
  });
  await markJobFinished(job.id, 'done');
}

/**
 * 单轮调度：规划 + 消费 + 日报/异常/策略建议（P1-⑥ + P2）。
 * 手动触发（/scheduler/tick）与后台循环共用。日报、异常、策略建议各自幂等/冷却去重，
 * 可安全每轮调用；异常扫描额外按 ~15min 节流，避免高频跑全量聚合。
 */
export async function schedulerTick(): Promise<{
  plan: PlanResult;
  run: RunResult;
  report: unknown;
  anomalies: unknown;
  adSpendPull: unknown;
  suggestions: unknown;
}> {
  const plan = await planSopJobs();
  const run = await runDueJobs();

  const cfg = getConfig().scheduler;
  let report: unknown = null;
  let anomalies: unknown = null;
  let adSpendPull: unknown = null;
  let suggestions: unknown = null;
  try {
    if (cfg.dailyReportEnabled) report = await generateDailyReport();
    if (cfg.anomalyEnabled) {
      const lastScan = Number((await metaGet('scheduler:last_anomaly_scan')) ?? 0);
      const scanInterval = Math.max(cfg.anomalyCooldownMs / 4, 15 * 60 * 1000);
      if (Date.now() - lastScan >= scanInterval) {
        await metaSet('scheduler:last_anomaly_scan', String(Date.now()));
        anomalies = await scanAnomalies();
      }
    }
    // 广告消耗定时拉取（P1-⑨）：每日一次，拉昨日区间；平台未配置时静默跳过。
    if (cfg.adSpendPullEnabled) {
      const lastPull = Number((await metaGet('scheduler:last_ad_spend_pull')) ?? 0);
      if (Date.now() - lastPull >= 20 * 3600 * 1000) {
        await metaSet('scheduler:last_ad_spend_pull', String(Date.now()));
        const yest = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        adSpendPull = await pullAdSpend(yest, today);
      }
    }
    // 策略建议（P2）：日报生成后基于真实指标出规则式建议（当天幂等）。
    if (cfg.suggestionEnabled) {
      suggestions = await generateStrategySuggestions();
    }
  } catch {
    /* 日报/异常/拉取/建议不应影响 SOP 主流程 */
  }
  return { plan, run, report, anomalies, adSpendPull, suggestions };
}

/**
 * 启动后台调度（幂等）。
 * 中期：传入 register（ctx.cron.register）时挂到框架级 cron —— 单飞 + 可选 leader 收敛
 * （多副本部署仅 leader 副本做规划/触达，防重复发送）+ 插件生命周期自动停。
 * 不传 register 时保持原 setInterval 行为（嵌入/测试场景零回归）。
 */
export function startScheduler(
  register?: (opts: {
    name: string;
    everyMs: number;
    run: () => Promise<void> | void;
    leaderOnly?: boolean;
  }) => () => void,
): void {
  const cfg = getConfig();
  if (!cfg.scheduler.enabled || timer) return;
  if (register) {
    register({
      name: 'scheduler-tick',
      everyMs: Math.max(250, cfg.scheduler.intervalMs),
      leaderOnly: true,
      run: async () => {
        await schedulerTick();
      },
    });
    return;
  }
  timer = setInterval(() => {
    void schedulerTick().catch(() => {
      /* 单轮异常不阻断下一轮 */
    });
  }, cfg.scheduler.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

/** 停止后台调度。 */
export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** /scheduler 快照：任务统计 + 触达消息统计。 */
export async function schedulerSnapshot(): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  return {
    enabled: cfg.scheduler.enabled,
    intervalMs: cfg.scheduler.intervalMs,
    recall: { enabled: cfg.scheduler.recallEnabled, firstHours: cfg.scheduler.recallFirstHours, secondHours: cfg.scheduler.recallSecondHours },
    welcome: { enabled: cfg.scheduler.welcomeEnabled, windowHours: cfg.scheduler.welcomeWindowHours },
    postOp: { enabled: cfg.scheduler.postOpEnabled, days: cfg.scheduler.postOpDays },
    jobs: await jobStats(),
    outreach: await outreachStats(),
  };
}

/** 触达消息统计（ma_outbox 中 topic=outreach.send 的子集）。 */
export async function outreachStats(): Promise<{
  byState: Record<string, number>;
  recent: Array<{ id: number; leadId: string; topic: string; state: string; attempts: number; lastError?: string; text: string; createdAt: number }>;
}> {
  return await dbCall(async () => {
    const db = await getDb();
    const tid = getConfig().tenantId;
    const byState: Record<string, number> = {};
    for (const r of await allRows(
      db.prepare(`SELECT state, COUNT(*) AS c FROM ma_outbox WHERE tenant_id = ? AND topic = 'outreach.send' GROUP BY state`),
      tid
    )) {
      byState[String(r.state)] = Number(r.c);
    }
    const rows = await allRows(
      db.prepare(
        `SELECT id, payload, state, attempts, last_error, created_at FROM ma_outbox
         WHERE tenant_id = ? AND topic = 'outreach.send' ORDER BY id DESC LIMIT 20`
      ),
      tid
    );
    const recent = rows.map((r) => {
      let p: Record<string, unknown> = {};
      try {
        p = r.payload ? JSON.parse(String(r.payload)) : {};
      } catch {
        /* payload 解析失败仅影响展示 */
      }
      return {
        id: Number(r.id),
        leadId: String(p.leadId ?? ''),
        topic: String(p.topic ?? ''),
        state: String(r.state),
        attempts: Number(r.attempts),
        lastError: (r.last_error as string) ?? undefined,
        text: String(p.text ?? ''),
        createdAt: Number(r.created_at),
      };
    });
    return { byState, recent };
  }, '触达消息统计');
}
