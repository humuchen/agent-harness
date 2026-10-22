/**
 * 成交 / 消费订单仓储（P1-⑧ 数据闭环底座）。
 *
 * 原架构缺口：服务履历截至到店（ma_appointment.arrived/completed），无成交后消费 / 订单表，
 * 导致复购率与真实 ROI 无数据支撑。本 repo 提供订单写入与统计，供 analytics 计算：
 * - 复购率：同一 leadId 多笔 paid 订单占比；
 * - 真实 ROI：成交金额 / 广告花费（花费由投放平台接入后补齐，见 P1-⑨）。
 *
 * 纪律同全插件：参数化 SQL、按 tenant_id 隔离、空数据返回空。绝不虚构金额。
 */

import { getDb, dbCall, allRows, getRow, runStmt } from '../infra/db';
import { getConfig } from '../config';
import { type OrderRecord } from './types';

function rowToOrder(r: Record<string, unknown>): OrderRecord {
  return {
    orderId: String(r.order_id),
    tenantId: String(r.tenant_id),
    leadId: String(r.lead_id),
    project: String(r.project),
    category: (r.category as string) ?? undefined,
    amount: Number(r.amount ?? 0),
    currency: String(r.currency ?? 'CNY'),
    status: (r.status as OrderRecord['status']) ?? 'paid',
    clinicId: (r.clinic_id as string) ?? undefined,
    clinicName: (r.clinic_name as string) ?? undefined,
    consultant: (r.consultant as string) ?? undefined,
    source: (r.source as string) ?? undefined,
    paidAt: r.paid_at != null ? Number(r.paid_at) : undefined,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** 写入 / 更新订单（幂等；HIS/CRM 同步或运营经工具写入）。 */
export async function upsertOrder(o: OrderRecord): Promise<void> {
  await dbCall(async () => {
    (await getDb())
      .prepare(
        `INSERT INTO ma_order (order_id, tenant_id, lead_id, project, category, amount, currency, status, clinic_id, clinic_name, consultant, source, paid_at, created_at, updated_at)
         VALUES (:order_id, :tenant_id, :lead_id, :project, :category, :amount, :currency, :status, :clinic_id, :clinic_name, :consultant, :source, :paid_at, :created_at, :updated_at)
         ON CONFLICT(order_id) DO UPDATE SET
           lead_id=excluded.lead_id, project=excluded.project, category=excluded.category, amount=excluded.amount,
           currency=excluded.currency, status=excluded.status, clinic_id=excluded.clinic_id, clinic_name=excluded.clinic_name,
           consultant=excluded.consultant, source=excluded.source, paid_at=excluded.paid_at, updated_at=excluded.updated_at`
      )
      .run({
        order_id: o.orderId,
        tenant_id: getConfig().tenantId,
        lead_id: o.leadId,
        project: o.project,
        category: o.category ?? null,
        amount: o.amount ?? 0,
        currency: o.currency ?? 'CNY',
        status: o.status ?? 'paid',
        clinic_id: o.clinicId ?? null,
        clinic_name: o.clinicName ?? null,
        consultant: o.consultant ?? null,
        source: o.source ?? null,
        paid_at: o.paidAt ?? null,
        created_at: o.createdAt ?? Date.now(),
        updated_at: o.updatedAt ?? Date.now(),
      });
  }, '写入订单');
}

/** 按线索列出订单（明细查看）。 */
export async function listOrdersByLead(leadId: string, limit = 50): Promise<OrderRecord[]> {
  return await dbCall(async () => {
    const rows = await allRows(
      (await getDb()).prepare(
        `SELECT * FROM ma_order WHERE tenant_id = ? AND lead_id = ? ORDER BY COALESCE(paid_at, created_at) DESC LIMIT ?`
      ),
      getConfig().tenantId,
      leadId,
      limit
    );
    return rows.map(rowToOrder);
  }, '按线索列订单');
}

/** 统计订单（复购率 / 真实 ROI 底座）。时间范围可选（按 paid_at）。 */
export interface OrderStats {
  /** 订单总数（paid 状态）。 */
  orderCount: number;
  /** 成交客户数（去重 leadId）。 */
  customerCount: number;
  /** 总成交金额（paid）。 */
  totalRevenue: number;
  /** 复购客户数（同一 leadId 多笔 paid 订单）。 */
  repurchaseCustomers: number;
  /** 复购率 = 复购客户数 / 成交客户数。 */
  repurchaseRate: number;
  /** 分项目成交金额（用于 ROI / 项目毛利交叉）。 */
  byProject: Array<{ project: string; revenue: number; orders: number }>;
}

export async function orderStats(startTime?: number, endTime?: number): Promise<OrderStats> {
  return await dbCall(async () => {
    const db = await getDb();
    const tid = getConfig().tenantId;
    const tw: string[] = [];
    const vals: unknown[] = [tid];
    if (startTime != null) {
      tw.push('paid_at >= ?');
      vals.push(Math.floor(startTime / 1000));
    }
    if (endTime != null) {
      tw.push('paid_at <= ?');
      vals.push(Math.floor(endTime / 1000));
    }
    const where = `tenant_id = ? AND status = 'paid'${tw.length ? ' AND ' + tw.join(' AND ') : ''}`;

    const orders = (await allRows(db.prepare(`SELECT lead_id, project, amount FROM ma_order WHERE ${where}`), ...vals)) as Array<{
      lead_id: string;
      project: string;
      amount: number;
    }>;

    const byLead = new Map<string, number>();
    const byProject = new Map<string, { revenue: number; orders: number }>();
    let totalRevenue = 0;
    for (const o of orders) {
      byLead.set(o.lead_id, (byLead.get(o.lead_id) ?? 0) + 1);
      totalRevenue += Number(o.amount ?? 0);
      const cur = byProject.get(o.project) ?? { revenue: 0, orders: 0 };
      cur.revenue += Number(o.amount ?? 0);
      cur.orders += 1;
      byProject.set(o.project, cur);
    }

    const customerCount = byLead.size;
    const repurchaseCustomers = [...byLead.values()].filter((n) => n > 1).length;
    return {
      orderCount: orders.length,
      customerCount,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      repurchaseCustomers,
      repurchaseRate: customerCount > 0 ? Math.round((repurchaseCustomers / customerCount) * 1000) / 10 : 0,
      byProject: [...byProject.entries()]
        .map(([project, v]) => ({ project, revenue: Math.round(v.revenue * 100) / 100, orders: v.orders }))
        .sort((a, b) => b.revenue - a.revenue),
    };
  }, '订单统计');
}

/** 读取单条订单。 */
export async function getOrder(orderId: string): Promise<OrderRecord | null> {
  return await dbCall(async () => {
    const row = await getRow((await getDb()).prepare('SELECT * FROM ma_order WHERE tenant_id = ? AND order_id = ?'), getConfig().tenantId, orderId);
    return row ? rowToOrder(row) : null;
  }, '读取订单');
}
