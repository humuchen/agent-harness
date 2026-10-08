/**
 * advanced-retrieval.ts — 高级检索编排（P6-B 方案二二期，对齐 LangChain
 * MultiQueryRetriever / HyDE 的最小子集）。
 *
 * 设计要点：
 * - 两者都依赖 LLMProvider（generate.ts 抽象，createLLM 构造），LLM 调用失败一律
 *   **降级为原查询检索**（明确 warn，不静默失败也不中断服务）。
 * - multi-query：LLM 改写 N 个查询逐个检索 → RRF（Reciprocal Rank Fusion，k=60）融合
 *   去重；改写结果透出（rewritten）供上层观测。
 * - HyDE：LLM 生成假设答案片段 → 以假设文本为查询走正常检索（稠密 + BM25 融合
 *   天然可用 —— 假设答案是自然语言，tokenize 可分词）。
 * - 不做缓存/去重跨调用状态：每次请求独立（缓存由 server 层 QueryCache 承担）。
 */

import { retrieve, type RetrieveRequest, type RetrieveResponse } from './retrieve';
import type { RetrieveResult, VectorStore } from './store';
import type { EmbeddingProvider } from './embed';
import type { LLMProvider } from './generate';

/** multi-query 改写条数上限（1–5，缺省 3；含原查询共 n+1 路检索）。 */
const MULTI_QUERY_MAX = 5;
/** RRF 融合常数（业界惯例 60）。 */
const RRF_K = 60;

export interface MultiQueryOptions {
  /** 改写查询条数（缺省 3）。 */
  n?: number;
}

export interface MultiQueryResponse extends RetrieveResponse {
  /** 实际使用的查询列表（首项为原查询）。 */
  rewritten: string[];
  /** LLM 改写失败降级单查询时为 true（观测用）。 */
  degraded?: boolean;
}

export interface HyDEResponse extends RetrieveResponse {
  /** LLM 生成的假设答案（降级时缺省）。 */
  hypothetical?: string;
  /** LLM 失败降级原查询时为 true。 */
  degraded?: boolean;
}

/** multi-query：改写多路检索 + RRF 融合。 */
export async function multiQueryRetrieve(
  store: VectorStore,
  provider: EmbeddingProvider,
  llm: LLMProvider,
  req: RetrieveRequest,
  opts: MultiQueryOptions = {}
): Promise<MultiQueryResponse> {
  const n = Math.min(Math.max(opts.n ?? 3, 1), MULTI_QUERY_MAX);
  const t0 = Date.now();
  let rewritten: string[] = [req.query];
  let degraded = false;
  try {
    const raw = await llm.chat(
      [
        {
          role: 'system',
          content:
            '你是检索查询改写器。把用户查询改写为 3 个不同角度的检索查询' +
            '（同义改写 / 上下位概念 / 关键词化）。只输出 JSON 字符串数组，' +
            '形如 ["查询1","查询2","查询3"]，不要任何其它文字。',
        },
        { role: 'user', content: req.query },
      ],
      { temperature: 0.3 }
    );
    const match = raw.match(/\[[\s\S]*\]/);
    const parsed = match ? (JSON.parse(match[0]) as unknown) : [];
    if (Array.isArray(parsed)) {
      const qs = parsed
        .map((x) => String(x).trim())
        .filter(Boolean)
        .filter((q) => q !== req.query)
        .slice(0, n);
      if (qs.length > 0) rewritten = [req.query, ...qs];
    }
  } catch (e) {
    // LLM 失败 → 降级单查询（明确告警，不静默）。
    degraded = true;
    console.warn(
      `[rag:multi-query] 改写失败，降级原查询：${e instanceof Error ? e.message : String(e)}`
    );
  }

  // 多路检索（parent 展开禁用 —— 融合后再展开才有意义；此处保持简单：关闭）。
  const per: RetrieveResponse[] = [];
  for (const q of rewritten) {
    per.push(
      await retrieve(store, provider, {
        ...req,
        query: q,
        parent: false,
        expand: false,
        top_k: req.top_k ?? 5,
      })
    );
  }
  // RRF 融合：score = Σ 1/(k + rank)（rank 从 1 起）。
  const fused = new Map<string, { r: RetrieveResult; s: number }>();
  for (const resp of per) {
    resp.results.forEach((r, i) => {
      const inc = 1 / (RRF_K + i + 1);
      const cur = fused.get(r.chunk_id);
      if (cur) cur.s += inc;
      else fused.set(r.chunk_id, { r, s: inc });
    });
  }
  const results = [...fused.values()]
    .sort((a, b) => b.s - a.s)
    .slice(0, req.top_k ?? 5)
    .map(({ r, s }) => ({ ...r, score: s, rerank_score: s }));
  return {
    results,
    trace_id: per[0]?.trace_id ?? '',
    latency_ms: Date.now() - t0,
    rewritten,
    ...(degraded ? { degraded } : {}),
  };
}

/** HyDE：假设答案检索（LLM 生成假设片段 → 以其为查询走正常融合检索）。 */
export async function hydeRetrieve(
  store: VectorStore,
  provider: EmbeddingProvider,
  llm: LLMProvider,
  req: RetrieveRequest
): Promise<HyDEResponse> {
  let hypothetical = '';
  let degraded = false;
  try {
    hypothetical = (
      await llm.chat(
        [
          {
            role: 'system',
            content:
              '写一段 100–200 字的直接回答文本（假设文档片段风格，包含关键词与术语），' +
              '不解释、不寒暄、不使用第一人称。',
          },
          { role: 'user', content: req.query },
        ],
        { temperature: 0.4 }
      )
    ).trim();
  } catch (e) {
    degraded = true;
    console.warn(
      `[rag:hyde] 假设生成失败，降级原查询：${e instanceof Error ? e.message : String(e)}`
    );
  }
  const resp = await retrieve(store, provider, { ...req, query: hypothetical || req.query });
  return {
    ...resp,
    ...(hypothetical ? { hypothetical } : {}),
    ...(degraded ? { degraded } : {}),
  };
}
