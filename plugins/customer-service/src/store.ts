/**
 * 客服插件共享存储（Phase 4 · 生产加固 + M7 · 管理后台统计）。
 *
 * 从 Phase 3 的「进程内 Map」升级为「文件后端」：
 * - 每条会话/运行一个 JSON 文件，落在**共享卷**（默认 `${MEMORY_DIR}/plugins/customer-service`，
 *   即 k8s 的 RWX 卷 `/app/data/memory/plugins/customer-service`）；
 * - 写入走「临时文件 + 同 FS rename」原子替换（与 core FileMemoryStore 同款），崩溃安全；
 * - 读取路径（listRecords / 各类统计）直接扫描共享目录，因此**多副本下任意副本
 *   写入的会话/满意度都能被管理后台聚合看到**——满足「2 副本 ChatSession 不丢」。
 *
 * 两类 key 并存于同一目录（不同文件名）：
 * - `session:<id>`  来自工具层显式传入的 sessionId（转人工 / 满意度 / FAQ 意图）；
 * - `run:<runId>`   来自 ctx.events 订阅（run:start 用户问 + run:end 最终答），构成对话记录。
 * 管理服务按统一记录聚合统计，不区分 key 来源。
 *
 * 并发说明：单 key 的 read-modify-write 在极端同 key 跨副本并发下可能互相覆盖（低概率，
 * 客服场景每会话通常单用户单副本处理）；如需强一致，后续可换 Redis 后端（见架构文档 Phase 4）。
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type TurnRole = 'user' | 'assistant' | 'tool';

export interface Turn {
  role: TurnRole;
  text: string;
  t: number;
}

export interface ConversationRecord {
  /** key：sessionId 或 runId（前缀区分来源）。 */
  sessionId: string;
  /** 来源类型：工具层显式 session / 运行事件 run。 */
  kind?: 'session' | 'run';
  lastIntent?: string;
  handedOff: boolean;
  /** 满意度 1-5。 */
  satisfaction?: number;
  /** 转人工后由坐席认领。 */
  claimedBy?: string;
  claimedAt?: number;
  /** 对话记录（用户问 / 工具 / 最终答），最多保留最近 50 条。 */
  transcript?: Turn[];
  updatedAt: number;
}

/** M7 统计视图（对齐 customer-service-agent-modules.md 的 CsStats 契约）。 */
export interface CsStats {
  total: number;
  resolved: number;
  handedOff: number;
  handoffRate: number; // 0-100
  intentDist: Record<string, number>;
  avgSatisfaction: number | null;
  csatPct: number; // 4-5 星占比 0-100
  satisfactionDist: Record<number, number>; // 1..5
  trend: { date: string; count: number; csat: number | null }[];
}

/**
 * 共享数据目录：优先 CS_DATA_DIR（运维可显式指定），否则落在 core 的 MEMORY_DIR 下，
 * 复用同一 RWX 卷；本地无 MEMORY_DIR 时退化为 ./data/cs（单实例，仍持久化）。
 */
const DATA_DIR = process.env.CS_DATA_DIR
  ?? (process.env.MEMORY_DIR
    ? join(process.env.MEMORY_DIR, 'plugins', 'customer-service')
    : join(process.cwd(), 'data', 'cs'));

/** 规整为安全文件名，杜绝路径穿越。与 core sanitizeKey 同语义。 */
function safeFile(key: string): string {
  const cleaned = String(key ?? 'anonymous').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  return join(DATA_DIR, `${cleaned || 'anonymous'}.json`);
}

function readRecord(key: string): ConversationRecord | null {
  try {
    const raw = readFileSync(safeFile(key), 'utf-8');
    const d = JSON.parse(raw) as Partial<ConversationRecord>;
    return {
      sessionId: key,
      kind: d.kind,
      lastIntent: d.lastIntent,
      handedOff: !!d.handedOff,
      satisfaction: typeof d.satisfaction === 'number' ? d.satisfaction : undefined,
      claimedBy: d.claimedBy,
      claimedAt: typeof d.claimedAt === 'number' ? d.claimedAt : undefined,
      transcript: Array.isArray(d.transcript) ? (d.transcript as Turn[]) : undefined,
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/** 原子写：先写临时文件，再同 FS rename 替换目标（崩溃安全）。 */
function writeRecord(r: ConversationRecord): void {
  mkdirSync(dirname(safeFile(r.sessionId)), { recursive: true });
  const tmp = `${safeFile(r.sessionId)}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(r), 'utf-8');
  renameSync(tmp, safeFile(r.sessionId));
}

/** read-modify-write 单条记录文件，保证同 key 多次更新合并。 */
function mutate(key: string, kind: ConversationRecord['kind'], fn: (r: ConversationRecord) => void): void {
  const r = readRecord(key) ?? { sessionId: key, kind, handedOff: false, updatedAt: Date.now() };
  r.kind = r.kind ?? kind;
  fn(r);
  r.updatedAt = Date.now();
  writeRecord(r);
}

// ---------------------------------------------------------------------------
// 写入（来自工具层 / 事件层）
// ---------------------------------------------------------------------------

export function recordIntent(key: string, intent: string): void {
  if (!key) return;
  mutate(key, 'session', (r) => { r.lastIntent = intent; });
}

export function markHandoff(key: string): void {
  if (!key) return;
  mutate(key, 'session', (r) => { r.handedOff = true; });
}

export function recordSatisfaction(key: string, score: number): void {
  if (!key) return;
  mutate(key, 'session', (r) => { r.satisfaction = score; });
}

/** 追加上下文（对话记录）。每 key 最多保留最近 50 条，避免文件无限增长。 */
export function appendMessage(key: string, role: TurnRole, text: string): void {
  if (!key) return;
  mutate(key, 'run', (r) => {
    const turns = r.transcript ?? [];
    turns.push({ role, text: String(text ?? '').slice(0, 4000), t: Date.now() });
    r.transcript = turns.slice(-50);
  });
}

/** 转人工队列认领（仅当已转人工且未被认领）。 */
export function claimHandoff(key: string, by: string): boolean {
  if (!key) return false;
  let ok = false;
  mutate(key, 'session', (r) => {
    if (r.handedOff && !r.claimedBy) {
      r.claimedBy = by || 'anonymous';
      r.claimedAt = Date.now();
      ok = true;
    }
  });
  return ok;
}

// ---------------------------------------------------------------------------
// 读取 / 聚合（管理后台消费）
// ---------------------------------------------------------------------------

/** 列出全部记录（扫描共享目录，跨副本聚合），按更新时间倒序。 */
export function listRecords(): ConversationRecord[] {
  try {
    const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
    const recs = files
      .map((f) => readRecord(f.slice(0, -'.json'.length)))
      .filter((r): r is ConversationRecord => r !== null);
    return recs.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** 基础满意度统计（兼容旧调用）。 */
export function satisfactionStats(): { count: number; avg: number | null } {
  const s = fullStats();
  return { count: s.satisfactionDist[1] + s.satisfactionDist[2] + s.satisfactionDist[3] + s.satisfactionDist[4] + s.satisfactionDist[5], avg: s.avgSatisfaction };
}

/** 意图分布。 */
export function intentDistribution(): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const r of listRecords()) {
    const k = r.lastIntent ?? '未分类';
    dist[k] = (dist[k] ?? 0) + 1;
  }
  return dist;
}

/** 满意度分布（1-5 各自计数）。 */
export function satisfactionDistribution(): Record<number, number> {
  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of listRecords()) {
    if (typeof r.satisfaction === 'number') {
      const s = Math.min(5, Math.max(1, Math.round(r.satisfaction)));
      dist[s] = (dist[s] ?? 0) + 1;
    }
  }
  return dist;
}

/** 4-5 星占比（0-100）。 */
export function csatPct(): number {
  const dist = satisfactionDistribution();
  const scored = dist[1] + dist[2] + dist[3] + dist[4] + dist[5];
  if (scored === 0) return 0;
  return Math.round(((dist[4] + dist[5]) / scored) * 100);
}

/** 转人工率（0-100）。 */
export function handoffRate(): number {
  const recs = listRecords();
  if (recs.length === 0) return 0;
  const ho = recs.filter((r) => r.handedOff).length;
  return Math.round((ho / recs.length) * 100);
}

/** 按本地日期聚合趋势（近 days 天）。 */
export function dailyTrend(days = 14): CsStats['trend'] {
  const recs = listRecords();
  const map = new Map<string, { count: number; sum: number; n: number }>();
  for (const r of recs) {
    const date = new Date(r.updatedAt).toISOString().slice(0, 10);
    const cur = map.get(date) ?? { count: 0, sum: 0, n: 0 };
    cur.count += 1;
    if (typeof r.satisfaction === 'number') {
      cur.sum += r.satisfaction;
      cur.n += 1;
    }
    map.set(date, cur);
  }
  const out: CsStats['trend'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const cur = map.get(d);
    out.push({
      date: d,
      count: cur?.count ?? 0,
      csat: cur && cur.n > 0 ? Math.round((cur.sum / cur.n) * 100) / 100 : null,
    });
  }
  return out;
}

/** 转人工队列（已转人工且未认领）。 */
export function handoffQueue(): ConversationRecord[] {
  return listRecords().filter((r) => r.handedOff && !r.claimedBy);
}

/** 完整统计视图（M7 CsStats 契约）。 */
export function fullStats(): CsStats {
  const recs = listRecords();
  const dist = satisfactionDistribution();
  const scored = dist[1] + dist[2] + dist[3] + dist[4] + dist[5];
  const avg = scored === 0 ? null : Math.round(((dist[1] + dist[2] * 2 + dist[3] * 3 + dist[4] * 4 + dist[5] * 5) / scored) * 100) / 100;
  const resolved = recs.filter(
    (r) => typeof r.satisfaction === 'number' || (r.handedOff && r.claimedBy)
  ).length;
  return {
    total: recs.length,
    resolved,
    handedOff: recs.filter((r) => r.handedOff).length,
    handoffRate: handoffRate(),
    intentDist: intentDistribution(),
    avgSatisfaction: avg,
    csatPct: csatPct(),
    satisfactionDist: dist,
    trend: dailyTrend(),
  };
}

/** 运维/测试用：清空全部记录（仅删本地共享目录文件）。 */
export function clearRecords(): void {
  try {
    for (const f of readdirSync(DATA_DIR).filter((x) => x.endsWith('.json'))) {
      try { unlinkSync(join(DATA_DIR, f)); } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在 */ }
}
