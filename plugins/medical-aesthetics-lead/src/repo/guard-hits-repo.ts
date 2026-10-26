/**
 * guard-hits-repo.ts — 医疗广告护栏命中审计仓储（中期补全：人审闭环）。
 *
 * 数据来源：
 * - core 护栏命中 sink（setMedicalAdAuditSink）—— 运行时输入/输出拦截（harness 路径）；
 * - 插件内自检（screenMedicalAdText）—— 内容先审后发 / A-B 创建 / 手动排期路径。
 *
 * 闭环语义：命中落表（status=pending）→ 运营复核（reviewed=确认违规 / dismissed=误报）
 * → dismissed 的误报模式反哺词库修正（外部词库加白/调词，经 reloadMedicalAdLexicon 热更）。
 */

import { getDb, allRows, getRow, runStmt } from '../infra/db';

/** ma_guard_hits 一行。 */
export interface GuardHitRow {
  id: number;
  hitAt: number;
  side: string;
  ruleId?: string | null;
  matched: string;
  reason: string;
  scope?: string | null;
  status: 'pending' | 'reviewed' | 'dismissed';
  reviewedBy?: string | null;
  reviewedAt?: number | null;
  note?: string | null;
}

const HIT_SELECT = `
  SELECT id, hit_at AS hitAt, side, rule_id AS ruleId, matched, reason, scope,
         status, reviewed_by AS reviewedBy, reviewed_at AS reviewedAt, note
  FROM ma_guard_hits`;

function toHit(r: Record<string, unknown>): GuardHitRow {
  const status = String(r.status ?? 'pending');
  return {
    id: Number(r.id),
    hitAt: Number(r.hitAt ?? 0),
    side: String(r.side ?? ''),
    ruleId: (r.ruleId as string) ?? null,
    matched: String(r.matched ?? ''),
    reason: String(r.reason ?? ''),
    scope: (r.scope as string) ?? null,
    status: status === 'reviewed' ? 'reviewed' : status === 'dismissed' ? 'dismissed' : 'pending',
    reviewedBy: (r.reviewedBy as string) ?? null,
    reviewedAt: r.reviewedAt != null ? Number(r.reviewedAt) : null,
    note: (r.note as string) ?? null,
  };
}

/** 记录一次命中（fire-and-forget 路径；调用方吞错并告警）。 */
export async function insertGuardHit(input: {
  hitAt: number;
  side: string;
  ruleId?: string | null;
  matched: string;
  reason: string;
  scope?: string | null;
}): Promise<number> {
  const db = await getDb();
  const r = await runStmt(
    db.prepare(
      `INSERT INTO ma_guard_hits (hit_at, side, rule_id, matched, reason, scope)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    input.hitAt,
    input.side,
    input.ruleId ?? null,
    input.matched,
    input.reason,
    input.scope ?? null,
  );
  return Number(r.lastInsertRowid ?? 0);
}

/** 人审队列：按状态过滤（缺省 pending；'all' 不过滤），hit_at 倒序。 */
export async function listGuardHits(opts: { status?: string; limit?: number } = {}): Promise<GuardHitRow[]> {
  const db = await getDb();
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (opts.status && opts.status !== 'all') {
    clauses.push('status = ?');
    args.push(opts.status);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = await allRows(db.prepare(`${HIT_SELECT}${where} ORDER BY hit_at DESC LIMIT ?`), ...args, limit);
  return rows.map(toHit);
}

/** 命中统计（看板/运营视图）。 */
export async function guardHitStats(): Promise<{
  pending: number;
  reviewed: number;
  dismissed: number;
  total: number;
}> {
  const db = await getDb();
  const rows = await allRows(db.prepare('SELECT status, COUNT(*) AS n FROM ma_guard_hits GROUP BY status'));
  const by = new Map(rows.map((r) => [String(r.status), Number(r.n)]));
  const pending = by.get('pending') ?? 0;
  const reviewed = by.get('reviewed') ?? 0;
  const dismissed = by.get('dismissed') ?? 0;
  return { pending, reviewed, dismissed, total: pending + reviewed + dismissed };
}

/** 复核处置：reviewed（确认违规）/ dismissed（误报）；返回更新后的行。 */
export async function reviewGuardHit(
  id: number,
  input: { status: 'reviewed' | 'dismissed'; reviewedBy: string; note?: string },
): Promise<GuardHitRow | null> {
  const db = await getDb();
  await runStmt(
    db.prepare(
      `UPDATE ma_guard_hits SET status = ?, reviewed_by = ?, reviewed_at = ?, note = ? WHERE id = ?`,
    ),
    input.status,
    input.reviewedBy,
    Date.now(),
    input.note ?? null,
    id,
  );
  const row = await getRow(db.prepare(`${HIT_SELECT} WHERE id = ?`), id);
  return row ? toHit(row) : null;
}
