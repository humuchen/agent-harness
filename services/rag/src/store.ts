/**
 * store.ts — 向量存储与余弦检索（单节点最小闭环）。
 *
 * 满足设计文档 P0「可 docker run 单节点」与第 8 节「增量更新 / 权限隔离」：
 * - 内存为主索引，chunk 级 upsert（幂等），支持按 doc_id 整文档删除（增量更新）。
 * - 所有读路径强制 tenant_id 过滤（服务端重写后传入），零跨租户泄漏。
 * - 可选 JSON 持久化（RAG_DATA_FILE），进程重启后恢复；生产可换 sqlite/向量库（见 persistSqlite 占位）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Chunk {
  chunk_id: string;
  doc_id: string;
  tenant_id: string;
  index: number;
  content: string;
  title?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  vector: number[];
  created_at: number;
}

export interface RetrieveResult {
  chunk_id: string;
  doc_id: string;
  title?: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export class MemoryVectorStore {
  readonly dim: number;
  private chunks = new Map<string, Chunk>();

  constructor(dim: number) {
    this.dim = dim;
  }

  /** chunk 级幂等写入；相同 chunk_id 覆盖（增量更新语义）。 */
  upsert(c: Chunk): void {
    if (c.vector.length !== this.dim) {
      throw new Error(`向量维度不匹配：期望 ${this.dim}，实际 ${c.vector.length}`);
    }
    this.chunks.set(c.chunk_id, c);
  }

  /** 按 doc_id + tenant_id 删除整篇文档的所有 chunk（增量更新）。 */
  deleteByDoc(docId: string, tenantId: string): number {
    let n = 0;
    for (const [id, c] of this.chunks) {
      if (c.doc_id === docId && c.tenant_id === tenantId) {
        this.chunks.delete(id);
        n++;
      }
    }
    return n;
  }

  /** 仅返回该租户的 chunk（权限隔离主路径）。 */
  private byTenant(tenantId: string): Chunk[] {
    const out: Chunk[] = [];
    for (const c of this.chunks.values()) {
      if (c.tenant_id === tenantId) out.push(c);
    }
    return out;
  }

  /** 余弦相似度（输入向量已归一化时等价点积）。 */
  static cosine(a: number[], b: number[]): number {
    let s = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  }

  /** 候选检索：tenant 内余弦 top_k（未做阈值/融合，融合在 retrieve.ts）。 */
  search(
    tenantId: string,
    queryVec: number[],
    topK: number,
  ): RetrieveResult[] {
    const scored = this.byTenant(tenantId).map((c) => ({
      chunk_id: c.chunk_id,
      doc_id: c.doc_id,
      title: c.title,
      content: c.content,
      metadata: c.metadata,
      score: MemoryVectorStore.cosine(queryVec, c.vector),
    }));
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, topK);
  }

  count(tenantId?: string): number {
    if (!tenantId) return this.chunks.size;
    return this.byTenant(tenantId).length;
  }

  // ---------- 持久化（JSON，单节点） ----------
  persist(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const rows = [...this.chunks.values()];
    writeFileSync(file, JSON.stringify({ version: 1, dim: this.dim, chunks: rows }), 'utf8');
  }

  load(file: string): void {
    if (!existsSync(file)) return;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { dim: number; chunks: Chunk[] };
    if (raw.dim !== this.dim) {
      throw new Error(`持久化维度(${raw.dim})与当前(${this.dim})不一致`);
    }
    for (const c of raw.chunks) this.chunks.set(c.chunk_id, c);
  }
}
