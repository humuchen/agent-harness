/**
 * 客服插件进程内共享存储（演示用；生产应接 ChatSession / Memory 持久后端，详见架构文档 Phase 4）。
 * - 路由层（cs-routes）写入：转人工 / 满意度 / 意图；
 * - 工具层（ticket tools）写入：转人工 / 满意度；
 * - 管理后台视图（admin-panel）读取并展示统计。
 * 三者在同一包内共享此模块，无跨层耦合。
 */

export interface ConversationRecord {
  sessionId: string;
  lastIntent?: string;
  handedOff: boolean;
  satisfaction?: number; // 1-5
  updatedAt: number;
}

const records = new Map<string, ConversationRecord>();

function touch(sessionId: string): ConversationRecord {
  let r = records.get(sessionId);
  if (!r) {
    r = { sessionId, handedOff: false, updatedAt: Date.now() };
    records.set(sessionId, r);
  }
  return r;
}

export function recordIntent(sessionId: string, intent: string): void {
  const r = touch(sessionId);
  r.lastIntent = intent;
  r.updatedAt = Date.now();
}

export function markHandoff(sessionId: string): void {
  const r = touch(sessionId);
  r.handedOff = true;
  r.updatedAt = Date.now();
}

export function recordSatisfaction(sessionId: string, score: number): void {
  const r = touch(sessionId);
  r.satisfaction = score;
  r.updatedAt = Date.now();
}

export function listRecords(): ConversationRecord[] {
  return [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function satisfactionStats(): { count: number; avg: number | null } {
  const scored = listRecords().filter((r) => typeof r.satisfaction === 'number');
  if (!scored.length) return { count: 0, avg: null };
  const sum = scored.reduce((s, r) => s + (r.satisfaction as number), 0);
  return { count: scored.length, avg: Math.round((sum / scored.length) * 100) / 100 };
}
