/**
 * 预约服务（真实号源可用性 + 防超卖 + HIS 同步）。
 *
 * 取代原 book.ts 的"无论号源是否存在都返回 ok:true"。现在：
 * - 院区/号源都来自真实查询（ma_clinic / ma_slot）；
 * - 锁号 + 建单 + 推进线索阶段在**同一事务**内原子完成（防超卖、防半成功）；
 * - 号源满/不存在/已约均抛 MaError（NOT_FOUND/CONFLICT），由工具层据实回灌模型；
 * - 若 HIS 已配置，预约单经发件箱真实同步（至少一次投递），绝不假装同步成功。
 */

import { searchClinics, listSlots, bookSlotWithinTx } from '../repo/schedule-repo';
import { advanceStageTx, getLead } from '../repo/lead-repo';
import { inTransaction, type SqliteDatabase } from '../infra/db';
import { enqueue } from '../repo/outbox-repo';
import { getConfig } from '../config';
import { MaError } from '../infra/errors';
import { type LeadStage, type SlotRecord, type ClinicRecord, stageRank } from '../repo/types';

/** 在院区列表中按名称/城市模糊解析出院区（真实数据，无内置清单）。 */
function resolveClinic(clinics: ClinicRecord[], name: string): ClinicRecord | undefined {
  return (
    clinics.find((c) => c.name.includes(name) || name.includes(c.name)) ??
    clinics.find((c) => c.city === name)
  );
}

/** 按时段（容忍 "14:30" / "1430"）在号源列表中定位。 */
function findSlotByTime(slots: SlotRecord[], time: string): SlotRecord | undefined {
  const t = String(time).trim().replace(':', '');
  return slots.find((s) => s.time.replace(':', '') === t);
}

/** consultation_book：真实可用性校验 → 事务锁号建单 → HIS/CRM 同步入队。 */
export async function bookConsultation(input: {
  leadId: string;
  clinic: string;
  date: string;
  time: string;
}): Promise<{
  ok: true;
  leadId: string;
  appointmentId: string;
  clinic: string;
  clinicId: string;
  date: string;
  time: string;
  hisSync: 'queued' | 'disabled';
  crmSync: 'pending' | 'disabled';
}> {
  const leadId = String(input.leadId ?? '').trim();
  if (!leadId) throw new MaError('INVALID_ARGUMENT', 'leadId required');
  const clinicName = String(input.clinic ?? '').trim();
  const date = String(input.date ?? '').trim();
  const time = String(input.time ?? '').trim();
  if (!clinicName || !date || !time) throw new MaError('INVALID_ARGUMENT', 'clinic/date/time 必填');

  // 1) 解析院区（真实查库）
  const clinics = await searchClinics();
  const clinic = resolveClinic(clinics, clinicName);
  if (!clinic) {
    const names = clinics.map((c) => c.name).join('、') || '无（请先经管理接口导入院区）';
    throw new MaError('NOT_FOUND', `未找到院区「${clinicName}」，可用院区：${names}`);
  }

  // 2) 查询该日期号源（真实查库）
  const slots = await listSlots(clinic.clinicId, date);
  const slot = findSlotByTime(slots, time);
  if (!slot) {
    const avail = slots.map((s) => s.time).join('、') || '无';
    throw new MaError('NOT_FOUND', `${clinic.name} ${date} 无可用号源（当日余位时段：${avail}），请换时段或院区`);
  }

  // 3) 事务内锁号 + 建预约单 + 推进线索阶段到 booked（原子；不回退更靠后阶段）
  const cfg = getConfig();
  const appt = await inTransaction(async (conn: SqliteDatabase) => {
    const a = await bookSlotWithinTx(conn, { leadId, clinicId: clinic.clinicId, slotId: slot.slotId });
    const cur = await conn.prepare('SELECT stage FROM ma_lead WHERE lead_id = ?').get(leadId) as
      | Record<string, unknown>
      | undefined;
    const keepStage: LeadStage =
      cur && stageRank(cur.stage as LeadStage) >= stageRank('booked') ? (cur.stage as LeadStage) : 'booked';
    await advanceStageTx(conn, leadId, {
      stage: keepStage,
      clinicId: clinic.clinicId,
      clinicName: clinic.name,
      bookingDate: date,
      bookingTime: time,
      appointmentId: a.appointmentId,
    });
    return a;
  });

  // 4) HIS 同步（真实出网，失败进发件箱重试）
  const hisSync: 'queued' | 'disabled' = cfg.his.enabled ? 'queued' : 'disabled';
  if (cfg.his.enabled) {
    enqueue('appt.create', `appt:${appt.appointmentId}`, {
      appointmentId: appt.appointmentId,
      tenantId: cfg.tenantId,
      leadId,
      clinicId: clinic.clinicId,
      slotId: slot.slotId,
      date,
      time,
    });
  }

  // 5) CRM 同步（客资阶段推进）
  let crmSync: 'pending' | 'disabled' = 'disabled';
  if (cfg.crm.enabled) {
    enqueue('lead.upsert', `lead:${leadId}:${Date.now()}`, {
      leadId,
      tenantId: cfg.tenantId,
      stage: 'booked',
      clinicId: clinic.clinicId,
      clinicName: clinic.name,
      bookingDate: date,
      bookingTime: time,
      appointmentId: appt.appointmentId,
    });
    crmSync = 'pending';
  }

  return {
    ok: true,
    leadId,
    appointmentId: appt.appointmentId,
    clinic: clinic.name,
    clinicId: clinic.clinicId,
    date,
    time,
    hisSync,
    crmSync,
  };
}
