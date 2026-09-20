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
import { buildWelcomeText, buildRecallText } from './outreach-templates';
import { resolveAbText, withRiskHint } from './ab-service';
import { medicalAdRules } from '@agent-harness/medical-ad-guard';

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
}

/**
 * 规划 SOP 任务（幂等；重复调用因 scheduled_key UNIQUE 自动去重）。
 * 回捞按「最后活跃时间 + 节点」判定：沉默达 2h 排 first、达 24h 排 second；
 * 因 key 含节点，两节点互不冲突；线索复联后 updated_at 刷新，未达节点的自然不再排。
 */
export async function planSopJobs(now = Date.now()): Promise<PlanResult> {
  const cfg = getConfig().scheduler;
  const out: PlanResult = { welcome: 0, recallFirst: 0, recallSecond: 0 };

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

  return out;
}

/**
 * 运营手动排期任务（生日/复购提醒等）。
 * 自拟文案必须先过医疗广告合规筛查（复用 medical-ad-guard 词表），
 * 命中红线（疗效承诺/诊断式/固定价/贬低同业等）直接拒绝，绝不带病入队。
 */
export async function scheduleManualJob(input: {
  jobType: 'welcome' | 'recall' | 'birthday' | 'repurchase';
  leadId: string;
  dueAt?: number;
  text?: string;
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
    for (const rule of medicalAdRules) {
      if (rule.re.test(input.text)) {
        throw new MaError('INVALID_ARGUMENT', `文案命中医疗广告合规红线（${rule.reason}），已拒绝排期`);
      }
    }
  }
  const scheduledKey = input.key?.trim() || `${input.jobType}:${input.leadId}:${dueAt}`;
  await enqueueJob({
    jobType: input.jobType,
    leadId: input.leadId,
    scheduledKey,
    dueAt,
    payload: {
      text: input.text,
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
  if (['booked', 'arrived', 'deal'].includes(stage)) {
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

/** 单轮调度：规划 + 消费。手动触发（/scheduler/tick）与后台循环共用。 */
export async function schedulerTick(): Promise<{ plan: PlanResult; run: RunResult }> {
  const plan = await planSopJobs();
  const run = await runDueJobs();
  return { plan, run };
}

/** 启动后台调度（幂等；unref 不阻塞进程退出）。 */
export function startScheduler(): void {
  const cfg = getConfig();
  if (!cfg.scheduler.enabled || timer) return;
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
