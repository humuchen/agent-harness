/**
 * 知识库服务：检索 / 插入。
 *
 * 短期（KB 语义检索升级）：
 * - 检索策略：CS_RAG_BASE_URL 已配置时优先调外部 RAG 服务（POST /v1/retrieve，
 *   与 services/rag 契约对齐）；RAG 未配置 / 调用失败 / 空结果时回退本地
 *   LIKE 词面匹配（存量行为零回归）。
 * - 写入联动：cs_kb_add 落本地库后，尽力（best-effort）镜像到 RAG —— RAG 侧
 *   以 `cs-kb-<kbId>` 为 doc_id 幂等 upsert，保证语义索引与本地库最终一致；
 *   镜像失败仅告警，不阻断本地写入（本地库仍是事实源）。
 */
import { searchKb, insertKb, type KbRow } from '../repo/kb-repo';
import { getConfig } from '../config';

/** 检索命中（统一 RAG / 本地两种来源的形态）。 */
export interface KbHit {
  question: string;
  answer: string;
  category?: string | null;
  /** RAG 命中时为融合分（0~1）；本地词面匹配无分。 */
  score?: number;
  /** 命中来源：rag = 语义检索；local = 本地 LIKE 词面匹配（降级/未配置）。 */
  source: 'rag' | 'local';
}

function toLocalHit(r: KbRow): KbHit {
  return { question: r.question, answer: r.answer, category: r.category ?? null, source: 'local' };
}

/** RAG 语义检索；未配置返回 null，失败重试后仍失败返回 null（调用方回退本地）。 */
async function ragSearch(query: string, limit: number): Promise<KbHit[] | null> {
  const rag = getConfig().rag;
  if (!rag.enabled) return null;
  for (let attempt = 0; attempt <= rag.retries; attempt++) {
    try {
      const resp = await fetch(`${rag.baseUrl}/v1/retrieve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(rag.token ? { authorization: `Bearer ${rag.token}` } : {}),
        },
        body: JSON.stringify({ query, top_k: limit }),
        signal: AbortSignal.timeout(rag.timeoutMs),
      });
      if (!resp.ok) throw new Error(`RAG HTTP ${resp.status}`);
      const data = (await resp.json()) as {
        results?: Array<{ doc_id: string; title?: string; content: string; score: number; metadata?: Record<string, unknown> }>;
      };
      const results = Array.isArray(data.results) ? data.results : [];
      return results.map((r) => {
        const tags = Array.isArray(r.metadata?.tags) ? (r.metadata?.tags as unknown[]).map(String) : [];
        return {
          question: r.title ?? r.doc_id,
          answer: r.content,
          category: tags.length ? tags[0]! : null,
          score: r.score,
          source: 'rag' as const,
        };
      });
    } catch (e) {
      if (attempt >= rag.retries) {
        // 回退可见性：告警而非静默 —— 排查「为什么语义检索没生效」时的第一入口。
        console.warn(`[cs-kb] RAG 检索失败，回退本地词面匹配：${e instanceof Error ? e.message : e}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  return null;
}

/**
 * 检索知识库：RAG 语义优先 → 失败/空结果回退本地 LIKE。
 */
export async function search(input: { query: string; limit?: number }): Promise<KbHit[]> {
  const limit = input.limit ?? 5;
  const q = input.query.trim();
  if (!q) return [];
  const ragHits = await ragSearch(q, limit);
  if (ragHits && ragHits.length > 0) return ragHits;
  return searchKb(q, limit).map(toLocalHit);
}

/** 把本地知识条目镜像到 RAG（doc_id=cs-kb-<kbId> 幂等）。供测试与运维复用。 */
export async function mirrorToRag(row: KbRow): Promise<boolean> {
  const rag = getConfig().rag;
  if (!rag.enabled) return false;
  try {
    const resp = await fetch(`${rag.baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(rag.token ? { authorization: `Bearer ${rag.token}` } : {}),
      },
      body: JSON.stringify({
        doc_id: `cs-kb-${row.kbId}`,
        title: row.question,
        text: `${row.question}\n${row.answer}`,
        ...(row.category ? { tags: [row.category] } : {}),
        metadata: { source: 'cs_kb', kb_id: row.kbId, updated_at: row.updatedAt },
      }),
      signal: AbortSignal.timeout(rag.timeoutMs),
    });
    if (!resp.ok && resp.status !== 202) throw new Error(`RAG ingest HTTP ${resp.status}`);
    return true;
  } catch (e) {
    console.warn(`[cs-kb] RAG 镜像失败（本地库不受影响）：${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** 插入知识条目（本地库为事实源；RAG 已配置时尽力镜像，失败不阻断）。 */
export async function add(input: { question: string; answer: string; category?: string }): Promise<KbRow> {
  const row = insertKb(input);
  // fire-and-forget：镜像失败只影响语义索引新鲜度，绝不阻断运营写入主路径。
  void mirrorToRag(row);
  return row;
}
