/**
 * rerank.ts — 检索结果重排（P2：cross-encoder 重排的完整实现）。
 *
 * 两种重排策略，由 `RAG_RERANK` 选择：
 *   - `mmr`（默认）：MMR 多样性重排，零依赖最小实现（原 retrieve.ts 内联逻辑迁入）。
 *   - `api`：真实 cross-encoder 重排——调用兼容 Jina/Cohere Rerank 格式的 HTTP API
 *     （`RAG_RERANK_API_URL` + `RAG_RERANK_API_KEY` + `RAG_RERANK_MODEL`）。
 *     未配置或调用失败时返回 null，调用方回退 MMR/融合序（与 OpenAIEmbedding 的降级策略一致）。
 *   - `none`：不重排，保持混合检索融合序。
 */

import { MemoryVectorStore, RetrieveResult } from './store';

/**
 * MMR（最大边际相关）重排：λ*相关度 - (1-λ)*与已选结果的最大相似度。
 * 提升召回列表多样性，避免多 chunk 内容冗余。
 */
export function mmrRerank<T extends { chunk_id: string; score: number }>(
  items: T[],
  vectorMap: Map<string, number[]>,
  lambda = 0.5,
): T[] {
  const selected: T[] = [];
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

export interface HttpRerankOptions {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
}

/**
 * 真实 cross-encoder 重排（HTTP API）。
 * 兼容 Jina（`POST /v1/rerank`）与 Cohere（`POST /v2/rerank`）的响应：
 * `{ results: [{ index, relevance_score }] }`。
 * 未配置 URL/KEY、请求失败或响应格式不符 → 返回 null（调用方回退）。
 * 成功时按 relevance_score 降序重排，并把相关性分写入 `rerank_score`。
 */
export async function rerankWithApi(
  query: string,
  results: RetrieveResult[],
  opts?: HttpRerankOptions,
): Promise<RetrieveResult[] | null> {
  const apiUrl = (opts?.apiUrl ?? process.env.RAG_RERANK_API_URL ?? '').trim();
  const apiKey = (opts?.apiKey ?? process.env.RAG_RERANK_API_KEY ?? '').trim();
  if (!apiUrl || !apiKey) return null;
  const model = (opts?.model ?? process.env.RAG_RERANK_MODEL ?? 'jina-reranker-v2-base-multilingual').trim();

  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        query,
        documents: results.map((r) => r.content),
        top_n: results.length,
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { results?: { index: number; relevance_score: number }[] };
    if (!Array.isArray(data.results) || data.results.length === 0) return null;

    const rel = new Map<number, number>();
    for (const r of data.results) {
      if (typeof r.index === 'number') rel.set(r.index, r.relevance_score ?? 0);
    }
    const reranked = results
      .map((r, i) => ({ r, score: rel.get(i) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .map((x) => ({ ...x.r, rerank_score: x.score }));
    return reranked;
  } catch {
    return null;
  }
}
