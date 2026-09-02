/**
 * 院区 / 号源 / 预约单仓储（防超卖核心）。
 *
 * 关键约束：
 * - 号源占用走**事务 + 条件更新**（booked < capacity 才 +1），天然防超卖；
 * - 预约单建单与号源占用在**同一事务**内完成，保证原子性；
 * - 唯一索引 ux_appt_slot_active 防止同一 (slot, lead) 重复建有效预约单。
 *
 * 与过去 book.ts 的差异：过去无论号源是否存在都返回 ok:true（假成功）。
 * 现在号源满/已约/不存在均抛 MaError（CONFLICT/NOT_FOUND），由工具层据实回灌模型。
 */

import { getDb, getDbAsync, dbCall, allRows, getRow, runStmt, inTransaction, type SqliteDatabase } from '../infra/db';
import { getConfig } from '../config';
import { MaError } from '../infra/errors';
import { type ClinicRecord, type SlotRecord, type AppointmentRecord } from './types';

function rowToClinic(r: Record<string, unknown>): ClinicRecord {
  return {
    clinicId: String(r.clinic_id),
    name: String(r.name),
    city: (r.city as string) ?? undefined,
    address: (r.address as string) ?? undefined,
    phone: (r.phone as string) ?? undefined,
    active: Number(r.active) === 1,
  };
}

function rowToSlot(r: Record<string, unknown>): SlotRecord {
  const capacity = Number(r.capacity);
  const booked = Number(r.booked);
  return {
    slotId: String(r.slot_id),
    clinicId: String(r.clinic_id),
    date: String(r.slot_date),
    time: String(r.slot_time),
    capacity,
    booked,
    status: Number(r.status) === 1 || r.status === 'open' ? 'open' : 'closed',
    doctor: (r.doctor as string) ?? undefined,
    remaining: Math.max(0, capacity - booked),
  };
}

function rowToAppointment(r: Record<string, unknown>): AppointmentRecord {
  return {
    appointmentId: String(r.appointment_id),
    leadId: String(r.lead_id),
    clinicId: String(r.clinic_id),
    slotId: String(r.slot_id),
    date: String(r.slot_date),
    time: String(r.slot_time),
    status: r.status as AppointmentRecord['status'],
    externalId: (r.external_id as string) ?? undefined,
    externalStatus: (r.external_status as string) ?? undefined,
    createdAt: Number(r.created_at),
  };
}

/** 查询院区（可选按城市过滤，参数化）。 */
export async function searchClinics(city?: string): Promise<ClinicRecord[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const tid = getConfig().tenantId;
    const rows = city
      ? await allRows(db.prepare('SELECT * FROM ma_clinic WHERE tenant_id = ? AND active = 1 AND city = ? ORDER BY name'), tid, city)
      : await allRows(db.prepare('SELECT * FROM ma_clinic WHERE tenant_id = ? AND active = 1 ORDER BY city, name'), tid);
    return rows.map(rowToClinic);
  }, '查询院区');
}

export async function getClinic(clinicId: string): Promise<ClinicRecord | null> {
  return await dbCall(async () => {
    const row = await getRow((await getDb()).prepare('SELECT * FROM ma_clinic WHERE tenant_id = ? AND clinic_id = ?'), getConfig().tenantId, clinicId);
    return row ? rowToClinic(row) : null;
  }, '读取院区');
}

/** 列出某院区号源（可选按日期过滤），仅返回仍开放且有余量的。 */
export async function listSlots(clinicId: string, date?: string): Promise<SlotRecord[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const tid = getConfig().tenantId;
    let rows;
    if (date) {
      rows = await allRows(db.prepare(
          `SELECT * FROM ma_slot WHERE tenant_id = ? AND clinic_id = ? AND slot_date = ? AND status = 'open' ORDER BY slot_date, slot_time`
        ), tid, clinicId, date);
    } else {
      rows = await allRows(db.prepare(
          `SELECT * FROM ma_slot WHERE tenant_id = ? AND clinic_id = ? AND status = 'open' ORDER BY slot_date, slot_time`
        ), tid, clinicId);
    }
    return rows.map(rowToSlot).filter((s) => s.remaining > 0);
  }, '查询号源');
}

export async function getSlot(slotId: string): Promise<SlotRecord | null> {
  return await dbCall(async () => {
    const row = await getRow((await getDb()).prepare('SELECT * FROM ma_slot WHERE tenant_id = ? AND slot_id = ?'), getConfig().tenantId, slotId);
    return row ? rowToSlot(row) : null;
  }, '读取号源');
}

export async function getAppointment(appointmentId: string): Promise<AppointmentRecord | null> {
  return await dbCall(async () => {
    const row = await (await getDb()).prepare('SELECT * FROM ma_appointment WHERE appointment_id = ?').get(appointmentId);
    return row ? rowToAppointment(row) : null;
  }, '读取预约单');
}

/**
 * 事务内锁定号源并建预约单（防超卖）。不自行开事务——由调用方在 inTransaction 内调用，
 * 以便与「线索阶段推进」合并为同一原子事务。
 * 任一条件不满足（号源不存在 / 已关闭 / 已满 / 已约）抛 MaError。
 * 返回建好的预约单（含真实 appointment_id）。
 */
export async function bookSlotWithinTx(
  conn: SqliteDatabase,
  args: { leadId: string; clinicId: string; slotId: string }
): Promise<AppointmentRecord> {
  const tid = getConfig().tenantId;
  const slot = await getRow(conn.prepare('SELECT * FROM ma_slot WHERE tenant_id = ? AND slot_id = ?'), tid, args.slotId) as Record<string, unknown> | undefined;
  if (!slot) throw new MaError('NOT_FOUND', `号源不存在：${args.slotId}`);
  if (Number(slot.status) !== 1 && slot.status !== 'open') {
    throw new MaError('CONFLICT', `号源已关闭不可预约：${args.slotId}`);
  }
  if (Number(slot.booked) >= Number(slot.capacity)) {
    throw new MaError('CONFLICT', `号源已满：${args.slotId}（${slot.booked}/${slot.capacity}）`);
  }
  // 已存在有效预约单？
  const dup = await getRow(conn.prepare("SELECT 1 FROM ma_appointment WHERE slot_id = ? AND lead_id = ? AND status = 'booked'"), args.slotId, args.leadId);
  if (dup) throw new MaError('CONFLICT', `该客户已预约此号源：${args.slotId}`);
  // 条件占用 +1（并发安全；即便穿越到此处，唯一索引也会兜底）
  const upd = await runStmt(conn.prepare('UPDATE ma_slot SET booked = booked + 1, updated_at = ? WHERE slot_id = ? AND booked < capacity'), Date.now(), args.slotId);
  if (upd.changes !== 1) throw new MaError('CONFLICT', `号源已不可约：${args.slotId}`);
  const now = Date.now();
  const apptId = `appt_${now}_${Math.random().toString(36).slice(2, 8)}`;
  conn
    .prepare(
      `INSERT INTO ma_appointment (
        appointment_id, tenant_id, lead_id, clinic_id, slot_id, slot_date, slot_time, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`
    )
    .run(
      apptId,
      tid,
      args.leadId,
      args.clinicId,
      args.slotId,
      String(slot.slot_date),
      String(slot.slot_time),
      now,
      now
    );
  return rowToAppointment(await getRow(conn.prepare('SELECT * FROM ma_appointment WHERE appointment_id = ?'), apptId) as Record<string, unknown>);
}

/** 便捷封装：自带事务的号源锁定 + 建预约单。 */
export async function bookSlotTx(args: {
  leadId: string;
  clinicId: string;
  slotId: string;
  createdBy?: string;
}): Promise<AppointmentRecord> {
  return await inTransaction((conn: SqliteDatabase) => bookSlotWithinTx(conn, args));
}

/** 取消预约单（事务内回退号源占用，幂等）。 */
export async function cancelAppointmentTx(appointmentId: string): Promise<void> {
  await inTransaction(async (conn: SqliteDatabase) => {
    const row = await getRow(conn.prepare('SELECT * FROM ma_appointment WHERE appointment_id = ?'), appointmentId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new MaError('NOT_FOUND', `预约单不存在：${appointmentId}`);
    if (row.status !== 'booked') return; // 已取消/已到院 → 幂等
    await runStmt(conn.prepare("UPDATE ma_appointment SET status = 'cancelled', updated_at = ? WHERE appointment_id = ?"), Date.now(), appointmentId);
    conn
      .prepare('UPDATE ma_slot SET booked = MAX(0, booked - 1), updated_at = ? WHERE slot_id = ?')
      .run(Date.now(), String(row.slot_id));
  });
}

/** 把预约单同步到 HIS 后回填的外部单号 / 外部状态。两者可独立更新（按需传参）。 */
export async function setAppointmentExternal(
  appointmentId: string,
  externalId?: string,
  externalStatus?: string
): Promise<void> {
  await dbCall(async () => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (externalId !== undefined) {
      sets.push('external_id = ?');
      vals.push(externalId);
    }
    if (externalStatus !== undefined) {
      sets.push('external_status = ?');
      vals.push(externalStatus);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(Date.now());
    vals.push(appointmentId);
    (await getDb()).prepare(`UPDATE ma_appointment SET ${sets.join(', ')} WHERE appointment_id = ?`).run(...(vals as never[]));
  }, '回填预约单外部单号/状态');
}

/** 按 HIS 外部单号反查本地预约单（回调状态下发时用）。 */
export async function getAppointmentByExternalId(externalId: string): Promise<AppointmentRecord | null> {
  return await dbCall(async () => {
    const row = await (await getDb()).prepare('SELECT * FROM ma_appointment WHERE external_id = ?').get(externalId);
    return row ? rowToAppointment(row) : null;
  }, '按外部单号查预约单');
}

/** 导入/同步院区（upsert）。 */
export async function upsertClinic(c: ClinicRecord): Promise<void> {
  await dbCall(async () => {
    const db = await getDb();
    db.prepare(
      `INSERT INTO ma_clinic (clinic_id, tenant_id, name, city, address, phone, active, updated_at)
       VALUES (:clinic_id, :tenant_id, :name, :city, :address, :phone, :active, :updated_at)
       ON CONFLICT(clinic_id) DO UPDATE SET
         name=excluded.name, city=excluded.city, address=excluded.address,
         phone=excluded.phone, active=excluded.active, updated_at=excluded.updated_at`
    ).run({
      clinic_id: c.clinicId,
      tenant_id: getConfig().tenantId,
      name: c.name,
      city: c.city ?? null,
      address: c.address ?? null,
      phone: c.phone ?? null,
      active: (c.active ?? true) ? 1 : 0,
      updated_at: Date.now(),
    });
  }, '导入院区');
}

/** 导入/同步号源（upsert，按 slot_id）。 */
export async function upsertSlot(s: {
  slotId: string;
  clinicId: string;
  date: string;
  time: string;
  capacity?: number;
  doctor?: string;
  status?: 'open' | 'closed';
}): Promise<void> {
  await dbCall(async () => {
    const db = await getDb();
    db.prepare(
      `INSERT INTO ma_slot (slot_id, tenant_id, clinic_id, slot_date, slot_time, capacity, booked, status, doctor, updated_at)
       VALUES (:slot_id, :tenant_id, :clinic_id, :slot_date, :slot_time, :capacity, 0, :status, :doctor, :updated_at)
       ON CONFLICT(slot_id) DO UPDATE SET
         capacity=excluded.capacity, status=excluded.status, doctor=excluded.doctor, updated_at=excluded.updated_at`
    ).run({
      slot_id: s.slotId,
      tenant_id: getConfig().tenantId,
      clinic_id: s.clinicId,
      slot_date: s.date,
      slot_time: s.time,
      capacity: s.capacity ?? 1,
      status: s.status ?? 'open',
      doctor: s.doctor ?? null,
      updated_at: Date.now(),
    });
  }, '导入号源');
}
