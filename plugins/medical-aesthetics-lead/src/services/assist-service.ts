/**
 * 咨询师辅助简报（C6/C7，本地库版）。
 *
 * 数据源（真实 SQL，零编造）：
 * - ma_lead：画像 / 阶段 / 授权 / 转人工状态（system of record）
 * - ma_lead_message：归属线索的对话摘录（最近 N 条正序）
 * - ma_appointment：预约记录（按 lead_id 反查）
 * - ma_schedule_job：SOP 触达排期统计（避免咨询师与自动触达重复轰炸）
 *
 * CRM 适配缝：CRM 选型落地后实现 CrmReader（GET /v1/leads/{id}）替换/叠加数据源，
 * 简报结构与调用方不变；`source` 字段向调用方明示当前数据来源（local-db / crm+local）。
 *
 * 隐私纪律：
 * - 简报默认脱敏（phone/wechat 掩码），完整联系方式仅 reveal 接口（管理令牌）放行；
 * - 跟进建议全部为确定性规则推导（不经过 LLM），杜绝幻觉式「建议」。
 */

import { getLead, getMessages } from '../repo/lead-repo';
import type { LeadRecord } from '../repo/types';
import { getDb, dbCall, allRows } from '../infra/db';
import { getConfig } from '../config';
import { MaError } from '../infra/errors';

/** 联系方式掩码：手机号保留前 3 后 4；微信号保留前 2 位；过短一律 ****。 */
export function maskContact(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (v.length >= 8) return `${v.slice(0, 3)}****${v.slice(-4)}`;
  if (v.length >= 3) return `${v.slice(0, 2)}***`;
  return '****';
}

export interface BriefingAppointment {
  appointmentId: string;
  clinicId: string;
  date: string;
  time: string;
  status: string;
}

export interface LeadBriefing {
  leadId: string;
  source: 'local-db';
  generatedAt: number;
  profile: {
    name?: string;
    channel: string;
    project?: string;
    budget?: string;
    city?: string;
    intent?: string;
    grade?: string;
    stage: string;
    reached: string;
  };
  consent: { granted: boolean; at?: number };
  contact: { phone?: string; wechat?: string };
  handoff: { handedOff: boolean; reason?: string; consultedBy?: string };
  crmSync: { state: string; syncedAt?: number };
  recentMessages: { role: string; text: string; t: number }[];
  appointments: BriefingAppointment[];
  outreach: { byState: Record<string, number> };
  suggestions: string[];
}

/** 按 lead_id 反查预约单（简报用；独立小查询，不动 schedule-repo 公共面）。 */
async function appointmentsForLead(leadId: string): Promise<BriefingAppointment[]> {
  return await dbCall(async () => {
    const rows = await allRows(
      (await getDb()).prepare(
        `SELECT appointment_id, clinic_id, slot_date, slot_time, status
         FROM ma_appointment WHERE lead_id = ? ORDER BY created_at DESC LIMIT 5`
      ),
      leadId
    );
    return rows.map((r) => ({
      appointmentId: String(r.appointment_id),
      clinicId: String(r.clinic_id),
      date: String(r.slot_date),
      time: String(r.slot_time),
      status: String(r.status),
    }));
  }, '查询线索预约记录');
}

/** SOP 触达排期统计（按任务状态）。 */
async function outreachStatsForLead(leadId: string): Promise<Record<string, number>> {
  return await dbCall(async () => {
    const rows = await allRows(
      (await getDb()).prepare(
        `SELECT status, COUNT(*) AS c FROM ma_schedule_job WHERE tenant_id = ? AND lead_id = ? GROUP BY status`
      ),
      getConfig().tenantId,
      leadId
    );
    const byState: Record<string, number> = {};
    for (const r of rows) byState[String(r.status)] = Number(r.c);
    return byState;
  }, '查询线索触达排期统计');
}

/**
 * 规则化跟进建议（确定性推导，按紧急度排序，最多 4 条）。
 * 规则即合规与 SOP 的投影：D 级/转人工优先；预约到店确认次之；授权与首触再次；画像补全兜底。
 */
export function deriveSuggestions(lead: LeadRecord, appts: BriefingAppointment[], outreach: Record<string, number>): string[] {
  const s: string[] = [];
  const booked = appts.find((a) => a.status === 'booked');

  if (lead.handedOff || lead.grade === 'D') {
    s.push(
      lead.handedOff
        ? `客资已转人工${lead.handoffReason ? `（原因：${lead.handoffReason}）` : ''}：请真人优先接手，先处理诉求与情绪，不要让自动应答继续对话。`
        : 'D 级客资（投诉/纠纷/敏感）：必须人工接手处理，禁止自动应答与营销触达。'
    );
  }
  if (booked) {
    s.push(`已预约 ${booked.date} ${booked.time}（院区 ${booked.clinicId}）：到店前一天确认，当天提醒到店；变更需走改期流程。`);
  }
  if (!lead.consentAt) {
    s.push('尚未取得留资授权：先说明信息用途并取得明确同意，再引导留联系方式（lead_capture 必须带 consent）。');
  } else if (lead.stage === 'new' || lead.stage === 'contacted' || lead.stage === 'qualified') {
    const pendingAuto = (outreach.pending ?? 0) + (outreach.done ?? 0);
    s.push(
      pendingAuto > 0
        ? '已授权且有联系方式：调度器已自动排期欢迎/回捞触达，人工跟进请错峰，避免同日重复轰炸。'
        : '已授权且有联系方式：建议 24 小时内完成首次触达（电话或微信），首触话术先科普后邀约。'
    );
  }
  if (lead.grade === 'A' && (lead.stage === 'captured' || lead.stage === 'qualified')) {
    s.push('高意向（A 级）：尽快安排面诊与专属方案；报价只用区间/起，不承诺固定价与疗效。');
  }
  if (!lead.project) {
    s.push('画像缺意向项目：优先探明项目诉求，再推送对应科普内容（先调 project_kb_search）。');
  }
  if (lead.crmSyncState === 'pending' && (lead.phone || lead.wechat)) {
    s.push('CRM 同步仍为 pending：确认 CRM 上游配置是否就绪，避免客资漏录。');
  }
  return s.slice(0, 4);
}

/** 生成咨询师简报（脱敏版；完整联系方式走 reveal 接口）。 */
export async function buildLeadBriefing(leadId: string, opts: { messageLimit?: number } = {}): Promise<LeadBriefing> {
  const lead = await getLead(leadId, false);
  if (!lead) throw new MaError('NOT_FOUND', `线索不存在：${leadId}`);
  const [messages, appts, outreach] = await Promise.all([
    getMessages(leadId, opts.messageLimit ?? 10),
    appointmentsForLead(leadId),
    outreachStatsForLead(leadId),
  ]);
  // getMessages 返回时间正序（最近 N 条，倒序取正序回放），直接使用
  return {
    leadId,
    source: 'local-db',
    generatedAt: Date.now(),
    profile: {
      name: lead.name,
      channel: lead.channel,
      project: lead.project,
      budget: lead.budget,
      city: lead.city,
      intent: lead.intent,
      grade: lead.grade,
      stage: lead.stage,
      reached: lead.reached,
    },
    consent: { granted: lead.consentAt != null, at: lead.consentAt },
    contact: { phone: maskContact(lead.phone), wechat: maskContact(lead.wechat) },
    handoff: {
      handedOff: lead.handedOff,
      reason: lead.handoffReason,
      consultedBy: lead.consultedBy,
    },
    crmSync: { state: lead.crmSyncState ?? 'pending', syncedAt: lead.crmSyncedAt },
    recentMessages: messages,
    appointments: appts,
    outreach: { byState: outreach },
    suggestions: deriveSuggestions(lead, appts, outreach),
  };
}

/** 完整联系方式放行（reveal 接口专用，须管理令牌；返回完整 phone/wechat）。 */
export async function revealContact(leadId: string): Promise<{ leadId: string; name?: string; phone?: string; wechat?: string }> {
  const lead = await getLead(leadId, false);
  if (!lead) throw new MaError('NOT_FOUND', `线索不存在：${leadId}`);
  return { leadId, name: lead.name, phone: lead.phone, wechat: lead.wechat };
}
