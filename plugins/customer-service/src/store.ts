/**
 * 客服插件共享存储（Phase 4 · 生产加固）。
 *
 * 从 Phase 3 的「进程内 Map」升级为「文件后端」：
 * - 每条会话一个 JSON 文件，落在**共享卷**（默认 `${MEMORY_DIR}/plugins/customer-service`，
 *   即 k8s 的 RWX 卷 `/app/data/memory/plugins/customer-service`）；
 * - 写入走「临时文件 + 同 FS rename」原子替换（与 core FileMemoryStore 同款），崩溃安全；
 * - 读取路径（listRecords / satisfactionStats）直接扫描共享目录，因此**多副本下任意副本
 *   写入的会话/满意度都能被管理后台聚合看到**——满足「2 副本 ChatSession 不丢」。
 *
 * 接入点（业务无关，无新 core 改动）：
 * - 路由层（cs-routes）写入：转人工 / 满意度 / 意图；
 * - 工具层（ticket tools）写入：转人工 / 满意度；
 * - 管理后台视图（admin-panel）读取并展示统计。
 *
 * 并发说明：单会话的 read-modify-write 在极端同会话跨副本并发下可能互相覆盖（低概率，
 * 客服场景每会话通常单用户单副本处理）；如需强一致，后续可换 Redis 后端（见架构文档 Phase 4）。
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface ConversationRecord {
  sessionId: string;
  lastIntent?: string;
  handedOff: boolean;
  satisfaction?: number; // 1-5
  updatedAt: number;
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
function safeFile(sessionId: string): string {
  const cleaned = String(sessionId ?? 'anonymous').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return join(DATA_DIR, `${cleaned || 'anonymous'}.json`);
}

function readRecord(sessionId: string): ConversationRecord | null {
  try {
    const raw = readFileSync(safeFile(sessionId), 'utf-8');
    const d = JSON.parse(raw) as Partial<ConversationRecord>;
    return {
      sessionId,
      lastIntent: d.lastIntent,
      handedOff: !!d.handedOff,
      satisfaction: typeof d.satisfaction === 'number' ? d.satisfaction : undefined,
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

/** read-modify-write 单条会话文件，保证同会话多次更新合并。 */
function mutate(sessionId: string, fn: (r: ConversationRecord) => void): void {
  const r = readRecord(sessionId) ?? { sessionId, handedOff: false, updatedAt: Date.now() };
  fn(r);
  r.updatedAt = Date.now();
  writeRecord(r);
}

export function recordIntent(sessionId: string, intent: string): void {
  mutate(sessionId, (r) => { r.lastIntent = intent; });
}

export function markHandoff(sessionId: string): void {
  mutate(sessionId, (r) => { r.handedOff = true; });
}

export function recordSatisfaction(sessionId: string, score: number): void {
  mutate(sessionId, (r) => { r.satisfaction = score; });
}

/** 列出全部会话记录（扫描共享目录，跨副本聚合）。 */
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

export function satisfactionStats(): { count: number; avg: number | null } {
  const scored = listRecords().filter((r) => typeof r.satisfaction === 'number');
  if (scored.length === 0) return { count: 0, avg: null };
  const sum = scored.reduce((s, r) => s + (r.satisfaction as number), 0);
  return { count: scored.length, avg: Math.round((sum / scored.length) * 100) / 100 };
}

/** 运维/测试用：清空全部记录（仅删本地共享目录文件）。 */
export function clearRecords(): void {
  try {
    for (const f of readdirSync(DATA_DIR).filter((x) => x.endsWith('.json'))) {
      try { unlinkSync(join(DATA_DIR, f)); } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在 */ }
}
