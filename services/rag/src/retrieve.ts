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

import { MemoryVectorStore, RetrieveResult, aclVisible, type Chunk, type VectorStore } from './store';
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
  /**
   * 长期首片：调用方 principal 列表（如 ["user:u1","group:vip"]）。
   * 带 acl 的 chunk 仅在与 principals 有交集时可见；无 acl 数据不受影响（向后兼容）。
   */
  acl_principals?: string[];
}

/**
 * 中期（BM25 语料快照缓存）：按 (tenant, store.revision) 缓存租户语料快照
 * （chunks + BM25 语料 + 向量映射）。写路径 revision 自增 → 下次检索自动失效重建；
 * 无写入期间多次检索零重建 —— 此前每次查询都执行 getChunks 全量导出 +
 * Bm25Corpus.fromChunks 全量分词重建，是规模化下的最大 CPU 热点。
 * 自定义 store 未实现 revision() 时回落逐查询重建（存量行为，零回归）。
 * 上限 RAG_SNAPSHOT_MAX_TENANTS（默认 16 租户，LRU 淘汰，防长驻进程内存无界）。
 */
interface TenantSnapshot {
  rev: number;
  chunks: Chunk[];
  corpus: Bm25Corpus;
  vectorMap: Map<string, number[]>;
}
const snapshotCache = new Map<string, TenantSnapshot>();
const SNAPSHOT_MAX = Math.max(1, Number(process.env.RAG_SNAPSHOT_MAX_TENANTS ?? 16) || 16);

async function getTenantSnapshot(
  store: VectorStore,
  tenantId: string,
): Promise<{ chunks: Chunk[]; corpus: Bm25Corpus; vectorMap: Map<string, number[]> }> {
  if (!store.hybridCapable || typeof store.revision !== 'function') {
    const chunks = await store.getChunks(tenantId);
    return {
      chunks,
      corpus: Bm25Corpus.fromChunks(chunks),
      vectorMap: new Map(chunks.map((c) => [c.chunk_id, c.vector] as const)),
    };
  }
  const hit = snapshotCache.get(tenantId);
  if (hit && hit.rev === store.revision()) {
    snapshotCache.delete(tenantId); // LRU touch
    snapshotCache.set(tenantId, hit);
    return { chunks: hit.chunks, corpus: hit.corpus, vectorMap: hit.vectorMap };
  }
  const chunks = await store.getChunks(tenantId);
  const rev = store.revision(); // 取数后再读版本：写入并发下宁可少缓存不缓存脏数据
  const snapshot: TenantSnapshot = {
    rev,
    chunks,
    corpus: Bm25Corpus.fromChunks(chunks),
    vectorMap: new Map(chunks.map((c) => [c.chunk_id, c.vector] as const)),
  };
  if (snapshotCache.has(tenantId)) snapshotCache.delete(tenantId);
  snapshotCache.set(tenantId, snapshot);
  if (snapshotCache.size > SNAPSHOT_MAX) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) snapshotCache.delete(oldest);
  }
  return { chunks: snapshot.chunks, corpus: snapshot.corpus, vectorMap: snapshot.vectorMap };
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
 * 长期首片：父块自身带 acl 时按 principals 复核（防止子块可见而父块受限被间接泄漏）。
 */
async function expandToParents(
  results: Scored[],
  chunks: Chunk[],
  principals: string[] | undefined
): Promise<Scored[]> {
  if (!results.some((r) => r.metadata?.parent_id)) return results;
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
    if (!parent || !aclVisible(parent.acl, principals)) {
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
  //    长期首片：acl_principals 透传 —— 带 acl 的 chunk 在 store 内先过滤。
  const cand0 = await store.search(req.tenant_id, queryVec, topK * 4, req.acl_principals);
  // parent 模式：候选排除父块（父块仅作返回上下文单位，不参与命中）。
  const cand = req.parent
    ? cand0.filter((r) => r.metadata?.retrieval_role !== 'parent')
    : cand0;
  if (cand.length === 0) {
    return { results: [], trace_id: traceId, latency_ms: Date.now() - t0 };
  }

  // embedding 模型版本守卫（embedding 模型管理）：候选 chunk 携带的
  // metadata.embedding_model 若存在，必须与当前 provider.model 一致。不一致说明语料由
  // 另一语义空间的模型生成，与 queryVec 不可比——混用会静默劣化检索质量。
  // 无戳（undefined）的历史/手工数据放行（向后兼容，无法判定不阻断）；
  // 默认 fail-fast 抛错；RAG_EMBED_GUARD=off 可临时关闭（迁移期旧库逐步重嵌入时用）。
  if ((process.env.RAG_EMBED_GUARD ?? 'on').trim().toLowerCase() !== 'off') {
    const mismatched = cand.filter(
      (r) => r.metadata?.embedding_model !== undefined && r.metadata?.embedding_model !== provider.model
    );
    if (mismatched.length > 0) {
      const sample = mismatched
        .slice(0, 3)
        .map((r) => `${r.chunk_id}(${String(r.metadata?.embedding_model)})`)
        .join(', ');
      throw new Error(
        `embedding 模型版本不匹配：候选 chunk 由模型 ${sample} 生成，当前 provider=${provider.model}；` +
          `请重新入库（或设 RAG_EMBED_GUARD=off 临时放行，迁移期旧库逐步重嵌入）`
      );
    }
  }

  // 2) 真 BM25：租户语料（含 IDF），对候选打分。
  //    P6-B：仅 hybridCapable 后端（Memory / Qdrant-scroll）执行；纯检索后端降级为
  //    纯稠密检索（wBm25 项归零）， BM25 / 查询扩展自动关闭。
  //    中期：语料经 getTenantSnapshot 按 (tenant, revision) 缓存，无写入期间零重建。
  const hybrid = store.hybridCapable;
  const snap = hybrid
    ? await getTenantSnapshot(store, req.tenant_id)
    : { chunks: [] as Chunk[], corpus: new Bm25Corpus(), vectorMap: new Map<string, number[]>() };
  const allChunks = snap.chunks;
  const corpus = snap.corpus;
  const vectorMap = snap.vectorMap;

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
  //（同父取最高分；结果已按分排序取首现）。父块内容取自语料快照（hybrid 后端）。
  if (req.parent && store.hybridCapable) {
    ordered = await expandToParents(ordered, allChunks, req.acl_principals);
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
