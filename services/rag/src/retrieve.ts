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

import { MemoryVectorStore, RetrieveResult, type VectorStore } from './store';
import { EmbeddingProvider, tokenize } from './embed';
import { Bm25Corpus } from './bm25';
import { mmrRerank } from './rerank';

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
  /**
   * 外部传入的 trace_id（P2 全链路追踪）。
   * 若提供，则复用该 id 而非生成新的；便于与 harness 侧的 run:meta traceId 关联。
   */
  trace_id?: string;
  /**
   * P6-B 方案二二期：ParentDocument 模式 —— 入库为父子两级（retrieval_mode='parent-child'）
   * 时开启：候选排除父块（父块仅作返回上下文单位），命中子块按 parent_id 聚合返回
   * 父块内容（小块精度 + 大块上下文）。缺省 false（存量行为）。
   */
  parent?: boolean;
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
 * P6-B 方案二二期：父块展开（ParentDocument 后处理）。
 * 命中子块（metadata.parent_id）按父聚合：content 替换为父块全文、chunk_id 换为父 id、
 * metadata.expanded_from 记来源子块；同父多子命中取最高分（results 已按分排序取首现）。
 * 非父子语料（无 parent_id 标记）原样返回（零回归）。
 */
async function expandToParents(
  results: Scored[],
  store: VectorStore,
  tenantId: string
): Promise<Scored[]> {
  if (!results.some((r) => r.metadata?.parent_id)) return results;
  const chunks = await store.getChunks(tenantId);
  const byId = new Map(chunks.map((c) => [c.chunk_id, c] as const));
  const out = new Map<string, Scored>();
  for (const r of results) {
    const parentId = r.metadata?.parent_id as string | undefined;
    if (!parentId) {
      if (!out.has(r.chunk_id)) out.set(r.chunk_id, r);
      continue;
    }
    const key = `parent:${parentId}`;
    if (out.has(key)) continue; // 同父取最高分（首现）
    const parent = byId.get(parentId);
    if (!parent) {
      if (!out.has(r.chunk_id)) out.set(r.chunk_id, r);
      continue;
    }
    out.set(key, {
      ...r,
      chunk_id: parentId,
      content: parent.content,
      metadata: { ...(r.metadata ?? {}), expanded_from: r.chunk_id },
    });
  }
  return [...out.values()];
}

export async function retrieve(
  store: VectorStore,
  provider: EmbeddingProvider,
  req: RetrieveRequest,
): Promise<RetrieveResponse> {
  const t0 = Date.now();
  const topK = Math.min(Math.max(req.top_k ?? 5, 1), 50);
  const threshold = req.score_threshold ?? 0;
  // 远程 embedding（RemoteEmbedding/OpenAIEmbedding）仅支持异步；HashEmbedding 同步。
  const queryVec = provider.embedAsync ? await provider.embedAsync(req.query) : provider.embed(req.query);
  const queryTerms = tokenize(req.query);
  // 复用外部 trace_id 或生成新的
  const traceId = req.trace_id ?? newTraceId();

  // 1) 稠密余弦候选（放大候选集供融合/重排）。P6-B：后端可为异步（Qdrant）。
  const cand0 = await store.search(req.tenant_id, queryVec, topK * 4);
  // parent 模式：候选排除父块（父块仅作返回上下文单位，不参与命中）。
  const cand = req.parent
    ? cand0.filter((r) => r.metadata?.retrieval_role !== 'parent')
    : cand0;
  if (cand.length === 0) {
    return { results: [], trace_id: traceId, latency_ms: Date.now() - t0 };
  }

  // 2) 真 BM25：从租户全量 chunk 重建语料（含 IDF），对候选打分。
  //    P6-B：仅 hybridCapable 后端（Memory / Qdrant-scroll）执行；纯检索后端降级为
  //    纯稠密检索（wBm25 项归零）， BM25 / 查询扩展自动关闭。
  const hybrid = store.hybridCapable;
  const allChunks = hybrid ? await store.getChunks(req.tenant_id) : [];
  const corpus = Bm25Corpus.fromChunks(allChunks);
  const vectorMap = new Map<string, number[]>();
  for (const c of allChunks) vectorMap.set(c.chunk_id, c.vector);

  const scored: Scored[] = cand.map((r) => {
    const dense = Math.max(0, r.score); // 余弦 clamp 到 [0,1]
    const bm25 = hybrid ? corpus.scoreChunk(r.chunk_id, queryTerms) : 0;
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

  // 4) 重排：RAG_RERANK=mmr 时做 MMR（默认，零依赖）；none 关闭；
  //    api 模式由调用方（server/mcp）在检索后执行真实 cross-encoder（rerank.ts）
  const rerankMode = (process.env.RAG_RERANK ?? 'mmr').toLowerCase();
  let ordered = filtered;
  if (rerankMode === 'mmr' && filtered.length > 1) {
    ordered = mmrRerank(filtered, vectorMap, 0.5);
  }

  // 4.5) P6-B 方案二二期：父块展开 —— 命中子块按 parent_id 聚合为父块
  //（同父取最高分；结果已按分排序取首现）。父块内容从全量语料取（hybrid 后端）。
  if (req.parent && store.hybridCapable) {
    ordered = await expandToParents(ordered, store, req.tenant_id);
  }

  // 5) 阈值 + 取 top_k
  const ranked = ordered.filter((r) => r.score >= threshold).slice(0, topK);
  if (rerankMode === 'mmr') {
    for (const r of ranked) r.rerank_score = r.score;
  }

  // 6) Pre-retrieval：查询扩展词（按 IDF 取显著词项；仅混合后端可用）
  const expanded_terms = req.expand && hybrid ? corpus.topTerms(queryTerms, 5) : undefined;

  return {
    results: ranked,
    trace_id: traceId,
    latency_ms: Date.now() - t0,
    expanded_terms,
  };
}
