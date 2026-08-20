/**
 * retrieve.ts — 检索编排（混合检索：稠密余弦 + 真 BM25；MMR 重排；Pre-retrieval 扩展）。
 *
 * 对应设计文档第 2/3 节「检索接口」与 P2/P3：
 * - 混合检索：稠密余弦（主）+ **真 BM25**（bm25.ts，IDF 加权），按 RAG_FUSE_DENSE / RAG_FUSE_BM25 融合。
 *   替代 P0 的弱「关键词集合交集占比」代理打分，具备词频/逆文档频率区分度。
 * - 重排：默认 MMR（Maximal Marginal Relevance）多样性重排（cross-encoder 重排的
 *   零依赖最小可用实现）；RAG_RERANK=none 可关闭。结果携带 rerank_score。
 * - 过滤：doc_ids / tags / time_range 在融合后应用（范围收敛）。
 * - Pre-retrieval：req.expand 时返回显著查询扩展词（expanded_terms），供 agent 二次检索。
 * - 所有读路径使用服务端重写的 tenant_id，严格租户内检索。
 */

import { MemoryVectorStore, RetrieveResult } from './store';
import { EmbeddingProvider, tokenize } from './embed';
import { Bm25Corpus } from './bm25';

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
  /** Pre-retrieval：返回显著查询扩展词（agent 可据此二次检索）。 */
  expand?: boolean;
}

export interface RetrieveResponse {
  results: RetrieveResult[];
  trace_id: string;
  latency_ms: number;
  /** 命中查询缓存时为 true（P3 可观测）。 */
  cache_hit?: boolean;
  expanded_terms?: string[];
}

/** 内部扩展形态：候选结果附带稠密分与 BM25 分，供融合/重排使用。 */
type Scored = RetrieveResult & { dense: number; bm25: number };

function newTraceId(): string {
  return 'rag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * MMR（最大边际相关）重排：λ*相关度 - (1-λ)*与已选结果的最大相似度。
 * 提升召回列表的多样性，避免多 chunk 内容冗余；零依赖的 cross-encoder 重排替代品。
 */
function mmrRerank(items: Scored[], vectorMap: Map<string, number[]>, lambda: number): Scored[] {
  const selected: Scored[] = [];
  const remaining = [...items];
  while (remaining.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const rel = remaining[i].score;
      let maxSim = 0;
      for (const s of selected) {
        const va = vectorMap.get(remaining[i].chunk_id);
        const vb = vectorMap.get(s.chunk_id);
        if (va && vb) {
          const sim = MemoryVectorStore.cosine(va, vb);
          if (sim > maxSim) maxSim = sim;
        }
      }
      const val = lambda * rel - (1 - lambda) * maxSim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return selected;
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
  const queryTerms = tokenize(req.query);

  // 1) 稠密余弦候选（放大候选集供融合/重排）
  const cand = store.search(req.tenant_id, queryVec, topK * 4);
  if (cand.length === 0) {
    return { results: [], trace_id: newTraceId(), latency_ms: Date.now() - t0 };
  }

  // 2) 真 BM25：从租户全量 chunk 重建语料（含 IDF），对候选打分
  const allChunks = store.getChunks(req.tenant_id);
  const corpus = Bm25Corpus.fromChunks(allChunks);
  const vectorMap = new Map<string, number[]>();
  for (const c of allChunks) vectorMap.set(c.chunk_id, c.vector);

  const scored: Scored[] = cand.map((r) => {
    const dense = Math.max(0, r.score); // 余弦 clamp 到 [0,1]
    const bm25 = corpus.scoreChunk(r.chunk_id, queryTerms);
    return { ...r, dense, bm25 };
  });
  const maxBm25 = Math.max(1e-9, ...scored.map((s) => s.bm25));
  const wDense = Number(process.env.RAG_FUSE_DENSE ?? 0.6);
  const wBm25 = Number(process.env.RAG_FUSE_BM25 ?? 0.4);
  for (const s of scored) {
    s.score = wDense * s.dense + wBm25 * (s.bm25 / maxBm25); // 融合分（0~1）
  }

  // 3) 过滤（范围收敛；租户已在 store.search 内强制）
  const f = req.filters;
  let filtered = scored;
  if (f) {
    filtered = scored.filter((r) => {
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

  // 4) 重排（P2：cross-encoder 重排的最小可用实现 = MMR；RAG_RERANK=none 关闭）
  const rerankMode = (process.env.RAG_RERANK ?? 'mmr').toLowerCase();
  let ordered = filtered;
  if (rerankMode !== 'none' && filtered.length > 1) {
    ordered = mmrRerank(filtered, vectorMap, 0.5);
  }

  // 5) 阈值 + 取 top_k
  const ranked = ordered.filter((r) => r.score >= threshold).slice(0, topK);
  if (rerankMode !== 'none') {
    for (const r of ranked) r.rerank_score = r.score;
  }

  // 6) Pre-retrieval：查询扩展词（按 IDF 取显著词项）
  const expanded_terms = req.expand ? corpus.topTerms(queryTerms, 5) : undefined;

  return {
    results: ranked,
    trace_id: newTraceId(),
    latency_ms: Date.now() - t0,
    expanded_terms,
  };
}
