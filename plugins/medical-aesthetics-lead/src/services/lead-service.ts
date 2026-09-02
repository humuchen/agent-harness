/**
 * 客资生命周期服务（业务编排层）。
 *
 * 职责：把工具的"意图"落地为真实数据操作——本地库 upsert + 对话归集 + CRM 异步同步入队。
 * 本地库是系统记录（始终可用）；CRM 同步是异步增强（发件箱至少一次投递）。
 *
 * fail-closed 体现：CRM 未配置时，客资照常落本地库，但同步状态标记为 `disabled` 并如实告知，
 * 绝不返回 `{ ok: true }` 假装 CRM 已同步。
 */

import {
  upsertLead,
  getLead,
  markCrmSync,
  assignConsultant,
} from '../repo/lead-repo';
import { attachRunTranscript } from '../repo/transcript-repo';
import { enqueue } from '../repo/outbox-repo';
import { getConfig } from '../config';
import { getRunKey } from '../runtime';
import { MaError } from '../infra/errors';
import { type LeadGrade, type CrmSyncState, type LeadStage, type LeadRecord, stageRank } from '../repo/types';

const GRADES: LeadGrade[] = ['A', 'B', 'C', 'D'];

function validGrade(g: unknown): LeadGrade {
  return (GRADES as string[]).includes(String(g)) ? (String(g) as LeadGrade) : 'C';
}

/** 将线索变更入队 CRM 同步；CRM 未配置返回 disabled（不假装同步成功）。 */
async function queueCrmSync(lead: LeadRecord): Promise<CrmSyncState> {
  const cfg = getConfig();
  if (!cfg.crm.enabled) return 'disabled';
  const idem = `lead:${lead.leadId}:${lead.updatedAt}`;
  void enqueue('lead.upsert', idem, {
    leadId: lead.leadId,
    tenantId: cfg.tenantId,
    channel: lead.channel,
    intent: lead.intent,
    project: lead.project,
    budget: lead.budget,
    city: lead.city,
    grade: lead.grade,
    stage: lead.stage,
    name: lead.name,
    phone: lead.phone,
    wechat: lead.wechat,
    clinicId: lead.clinicId,
    clinicName: lead.clinicName,
    bookingDate: lead.bookingDate,
    bookingTime: lead.bookingTime,
    appointmentId: lead.appointmentId,
    handedOff: lead.handedOff,
    handoffReason: lead.handoffReason,
  });
  return 'pending';
}

/** lead_qualify：结构化抽取客资要素 + A/B/C/D 分级，写回本地库并归集当次对话。 */
export async function qualifyLead(input: {
  leadId: string;
  channel: string;
  project?: string;
  budget?: string;
  city?: string;
  intent?: string;
  grade: string;
}): Promise<{ ok: true; leadId: string; grade: LeadGrade; stage: string; crmSync: CrmSyncState }> {
  const leadId = String(input.leadId ?? '').trim();
  if (!leadId) throw new MaError('INVALID_ARGUMENT', 'leadId required');
  const grade = validGrade(input.grade);
  // 阶段单调推进（不回退）：已到更靠后阶段（captured/booked/arrived/deal）的线索，
  // 再次 qualify 只更新画像字段，绝不把 stage 回退到 qualified。
  const existing = await getLead(leadId);
  const keepStage: LeadStage =
    existing && stageRank(existing.stage) >= stageRank('qualified') ? existing.stage : 'qualified';
  const lead = await upsertLead(leadId, {
    channel: String(input.channel ?? 'unknown'),
    project: input.project ? String(input.project) : undefined,
    budget: input.budget ? String(input.budget) : undefined,
    city: input.city ? String(input.city) : undefined,
    intent: input.intent ? String(input.intent) : undefined,
    grade,
    stage: keepStage,
  });
  // 仅当线索已存在才归集当次对话（绝不凭空建档）
  await attachRunTranscript(leadId, getRunKey() ?? '');
  const crmSync = await queueCrmSync(lead);
  if (crmSync === 'disabled') await markCrmSync(leadId, 'disabled');
  return { ok: true, leadId, grade, stage: lead.stage, crmSync };
}

/** lead_capture：用户授权后留资，推进到 captured（且不回退更靠后的阶段）。 */
export async function captureLead(input: {
  leadId: string;
  consent: boolean;
  wechat?: string;
  phone?: string;
  name?: string;
}): Promise<{
  ok: true;
  leadId: string;
  stage: string;
  crmSync: CrmSyncState;
  captured: { wechat: string; phone: string; name: string };
}> {
  const leadId = String(input.leadId ?? '').trim();
  if (!leadId) throw new MaError('INVALID_ARGUMENT', 'leadId required');
  if (!input.consent) throw new MaError('INVALID_ARGUMENT', '未获用户授权，不得留资');
  const wechat = input.wechat ? String(input.wechat) : undefined;
  const phone = input.phone ? String(input.phone) : undefined;
  const name = input.name ? String(input.name) : undefined;
  if (!wechat && !phone && !name) throw new MaError('INVALID_ARGUMENT', '至少提供一项联系方式');

  // 不回退：已到更靠后阶段（如 booked）则保持原阶段
  const existing = await getLead(leadId);
  const keepStage: LeadStage =
    existing && stageRank(existing.stage) >= stageRank('captured') ? existing.stage : 'captured';

  const lead = await upsertLead(leadId, {
    wechat,
    phone,
    name,
    consentAt: Date.now(),
    stage: keepStage,
  });
  const crmSync = await queueCrmSync(lead);
  if (crmSync === 'disabled') await markCrmSync(leadId, 'disabled');
  return {
    ok: true,
    leadId,
    stage: lead.stage,
    crmSync,
    captured: { wechat: wechat ?? '', phone: phone ?? '', name: name ?? '' },
  };
}

/** lead_handoff：转交真人咨询师，标记 handedOff + 推进到 arrived（不回退）。 */
export async function handoffLead(input: {
  leadId: string;
  reason?: string;
}): Promise<{ ok: true; leadId: string; handedOff: true; stage: string; crmSync: CrmSyncState }> {
  const leadId = String(input.leadId ?? '').trim();
  if (!leadId) throw new MaError('INVALID_ARGUMENT', 'leadId required');
  const existing = await getLead(leadId);
  const keepStage: LeadStage =
    existing && stageRank(existing.stage) >= stageRank('arrived') ? existing.stage : 'arrived';
  const lead = await upsertLead(leadId, {
    handedOff: true,
    handoffReason: input.reason ? String(input.reason) : undefined,
    stage: keepStage,
  });
  const crmSync = await queueCrmSync(lead);
  if (crmSync === 'disabled') await markCrmSync(leadId, 'disabled');
  return { ok: true, leadId, handedOff: true, stage: lead.stage, crmSync };
}

/** 认领（条件更新，防并发重复认领）。返回本次是否认领成功。 */
export async function claimLead(leadId: string, consultant: string): Promise<boolean> {
  return assignConsultant(leadId, consultant);
}
