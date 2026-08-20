/**
 * retrieve.ts — 检索编排（混合检索 + 重排占位 + 过滤 + 阈值）。
 *
 * 对应设计文档第 2/3 节「检索接口」：
 * - 混合检索：稠密余弦（主） + 关键词命中（辅，token 集合交集占比），加权融合。
 *   P2 可替换为 ANN 索引 + 真 BM25 + cross-encoder 重排；此处保留可插拔接缝。
 * - 重排占位 simpleRerank：当前保持余弦序；生产在此接入 cross-encoder 重排。
 * - 过滤：doc_ids / tags / time_range 在融合后应用（权限隔离前的范围收敛）。
 * - 所有读路径使用服务端重写的 tenant_id，严格租户内检索。
 */

import { MemoryVectorStore, RetrieveResult } from './store';
import { EmbeddingProvider, tokenize } from './embed';

export interface RetrieveFilters {
  doc_ids?: string[];
  tags?: string[];
  time_range?: [number, number];
}

export interface RetrieveRequest {
  query: string;
  top_k?: number;
  score_threshold?: number;
  filters?: RetrieveFilters;
  /** 由服务端鉴权后重写注入，忽略客户端传入值（防越权）。 */
  tenant_id: string;
}

export interface RetrieveResponse {
  results: RetrieveResult[];
  trace_id: string;
  latency_ms: number;
}

function newTraceId(): string {
  return 'rag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 关键词重叠度：query token 集合与 content token 集合的交集占比（0~1）。 */
function keywordOverlap(query: string, content: string): number {
  const q = tokenize(query);
  if (!q.length) return 0;
  const cSet = new Set(tokenize(content));
  let hit = 0;
  for (const t of q) if (cSet.has(t)) hit++;
  return hit / q.length;
}

/** 重排占位：保持融合序。生产在此替换为 cross-encoder 重排。 */
function simpleRerank(results: RetrieveResult[]): RetrieveResult[] {
  return results;
}

export function retrieve(
  store: MemoryVectorStore,
  provider: EmbeddingProvider,
  req: RetrieveRequest,
): RetrieveResponse {
  const t0 = Date.now();
  const topK = Math.min(Math.max(req.top_k ?? 5, 1), 50);
  const threshold = req.score_threshold ?? 0;
  const queryVec = provider.embed(req.query);

  // 1) 稠密余弦候选（放大候选集供融合/重排）
  const cand = store.search(req.tenant_id, queryVec, topK * 4);

  // 2) 混合融合：0.75*余弦 + 0.25*关键词
  const fused = cand.map((r) => ({
    ...r,
    score: 0.75 * r.score + 0.25 * keywordOverlap(req.query, r.content),
  }));

  // 3) 过滤（范围收敛，租户已在 store.search 内强制）
  const f = req.filters;
  let filtered = fused;
  if (f) {
    filtered = fused.filter((r) => {
      if (f.doc_ids && f.doc_ids.length && !f.doc_ids.includes(r.doc_id)) return false;
      if (f.tags && f.tags.length) {
        const tags = (r.metadata?.tags as string[] | undefined) ?? [];
        if (!f.tags.some((t) => tags.includes(t))) return false;
      }
      if (f.time_range) {
        const ts = (r.metadata?.created_at as number | undefined) ?? 0;
        if (ts < f.time_range[0] || ts > f.time_range[1]) return false;
      }
      return true;
    });
  }

  // 4) 阈值 + 重排 + top_k
  const ranked = simpleRerank(filtered)
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    results: ranked,
    trace_id: newTraceId(),
    latency_ms: Date.now() - t0,
  };
}
