/**
 * 知识库仓储：参数化 SQL，真实落库（node:sqlite）。
 * 支持插入与按关键词/类别检索（词面匹配；语义检索留待 RAG 上游接入）。
 */
import { getDb } from '../infra/db';
import { getConfig } from '../config';

export interface KbRow {
  kbId: number;
  tenantId: string;
  question: string;
  answer: string;
  category?: string | null;
  updatedAt: string;
}

/** 插入知识条目（RETURNING 取自增 id）。 */
export function insertKb(input: { question: string; answer: string; category?: string }): KbRow {
  const db = getDb();
  const tenantId = getConfig().tenantId;
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `INSERT INTO cs_kb (tenant_id, question, answer, category, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING kb_id AS kbId`
    )
    .get(tenantId, input.question, input.answer, input.category ?? null, now) as { kbId: number } | undefined;
  const kbId = row?.kbId ?? 0;
  return getKb(kbId)!;
}

/** 检索：匹配 question/answer 关键词（LIKE，大小写不敏感）。 */
export function searchKb(query: string, limit = 5): KbRow[] {
  const db = getDb();
  const q = `%${query.trim().replace(/\s+/g, '%')}%`;
  return db
    .prepare(
      `SELECT kb_id AS kbId, tenant_id AS tenantId, question, answer, category, updated_at AS updatedAt
       FROM cs_kb WHERE question LIKE ? OR answer LIKE ? ORDER BY updated_at DESC LIMIT ?`
    )
    .all(q, q, limit) as KbRow[];
}

/** 按 id 取知识条目。 */
export function getKb(kbId: number): KbRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT kb_id AS kbId, tenant_id AS tenantId, question, answer, category, updated_at AS updatedAt FROM cs_kb WHERE kb_id=?`
    )
    .get(kbId) as KbRow | undefined;
  return row ?? null;
}
