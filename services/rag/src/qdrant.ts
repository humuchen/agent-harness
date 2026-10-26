/**
 * qdrant.ts — Qdrant 向量存储后端（P6-B VectorStore 契约实现）。
 *
 * 设计要点：
 * - **零 SDK**：纯 REST（fetch）+ node:crypto，与 services/rag「stdlib-only」纪律一致；
 *   对接自建 / Qdrant Cloud 均为同一 HTTP 契约。
 * - 确定性点 id：Qdrant 点 id 仅接受无符号整数或 UUID；chunk_id 经 MD5 摊平成 UUID
 *   （同 chunk_id → 同点 id → upsert 天然幂等，无需额外查询）。
 * - 租户隔离：所有读写路径强制 tenant_id 过滤（与 MemoryVectorStore 同红线）。
 * - 混合检索：getChunks 经 scroll 分页全量导出（with_vector），hybridCapable=true ——
 *   BM25 融合 / MMR / 查询扩展在 Qdrant 后端与内存后端行为一致。
 * - 集合按需自建（dim + Cosine），幂等；鉴权走 Qdrant 的 `api-key` 头。
 *
 * env：QDRANT_URL / QDRANT_API_KEY / QDRANT_COLLECTION（缺省 rag_chunks）。
 */

import { createHash } from 'node:crypto';
import { aclVisible, type Chunk, type RetrieveResult, type VectorStore } from './store';

/** chunk_id → 确定性 UUID（md5 摊平 8-4-4-4-12）。同 chunk_id 恒得同点 id（幂等 upsert）。 */
function chunkIdToPointId(chunkId: string): string {
  const h = createHash('md5').update(chunkId).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** 从 Chunk 剥出 payload（vector 单独走 Qdrant 的 vector 通道）。 */
function chunkPayload(c: Chunk): Record<string, unknown> {
  const { vector: _vector, ...payload } = c;
  return payload as Record<string, unknown>;
}

/** payload + vector 还原 Chunk（向后兼容缺字段：以请求侧信息兜底）。 */
function payloadToChunk(id: string, payload: Record<string, unknown>, vector: number[], tenantId: string): Chunk {
  return {
    chunk_id: String(payload.chunk_id ?? id),
    doc_id: String(payload.doc_id ?? ''),
    tenant_id: String(payload.tenant_id ?? tenantId),
    index: Number(payload.index ?? 0),
    content: String(payload.content ?? ''),
    ...(payload.title != null ? { title: String(payload.title) } : {}),
    ...(Array.isArray(payload.tags) ? { tags: payload.tags.map(String) } : {}),
    ...(Array.isArray(payload.acl) ? { acl: payload.acl.map(String) } : {}),
    ...(payload.metadata && typeof payload.metadata === 'object'
      ? { metadata: payload.metadata as Record<string, unknown> }
      : {}),
    vector,
    created_at: Number(payload.created_at ?? 0),
  };
}

export interface QdrantStoreOptions {
  dim: number;
  /** 服务地址（如 http://qdrant:6333 或 https://xxx.cloud.qdrant.io:6333）。 */
  url?: string;
  apiKey?: string;
  collection?: string;
}

export class QdrantVectorStore implements VectorStore {
  readonly dim: number;
  readonly hybridCapable = true;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly collection: string;
  /** 幂等建表（首个操作触发一次；并发调用共享同一 Promise）。 */
  private readyPromise: Promise<void> | null = null;
  /**
   * 进程内写版本号（BM25 语料快照缓存依据）。单写者进程内精确；
   * 多写者共享同一 Qdrant 集合时不感知他方写入 —— 检索侧快照可能滞后，
   * 属已知取舍（多副本写入应按租户分片路由到单写者）。
   */
  private rev = 0;

  constructor(opts: QdrantStoreOptions) {
    this.dim = opts.dim;
    const url = (opts.url ?? process.env.QDRANT_URL ?? '').replace(/\/+$/, '');
    if (!url) throw new Error('[rag-qdrant] QDRANT_URL 未配置（RAG_STORE_BACKEND=qdrant 时必填）');
    this.baseUrl = url;
    this.apiKey = opts.apiKey ?? process.env.QDRANT_API_KEY ?? '';
    this.collection = opts.collection ?? process.env.QDRANT_COLLECTION ?? 'rag_chunks';
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // P1 修复：所有请求加超时兜底（QDRANT_TIMEOUT_MS，默认 30s）——Qdrant 抖动时
    // 检索/写入此前会永久挂起。
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(Number(process.env.QDRANT_TIMEOUT_MS ?? 30_000) || 30_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`[rag-qdrant] ${method} ${path} 失败：HTTP ${resp.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    }
    return (await resp.json()) as T;
  }

  /** 集合按需自建（幂等）：已存在则跳过。 */
  private async ensureCollection(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        type ColResp = { result?: { config?: unknown } };
        let exists: boolean;
        try {
          const col = await this.request<ColResp>('GET', `/collections/${this.collection}`);
          exists = !!col.result;
        } catch {
          exists = false; // 404 / 网络首探失败均按不存在处理（create 幂等兜底）
        }
        if (!exists) {
          await this.request('PUT', `/collections/${this.collection}`, {
            vectors: { size: this.dim, distance: 'Cosine' },
          });
        }
      })();
    }
    await this.readyPromise;
  }

  async upsert(chunk: Chunk): Promise<void> {
    await this.upsertMany([chunk]);
  }

  /**
   * 批量 upsert（P1 修复）：此前 ingest 对每 chunk 单独一次 HTTP PUT（500 chunk
   * 文档 = 500 次串行往返），现按 RAG_QDRANT_BATCH_SIZE（默认 64）分批一次性提交。
   */
  async upsertMany(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    for (const c of chunks) {
      if (c.vector.length !== this.dim) {
        throw new Error(`向量维度不匹配：期望 ${this.dim}，实际 ${c.vector.length}（chunk ${c.chunk_id}）`);
      }
    }
    await this.ensureCollection();
    const batchSize = Math.max(1, Number(process.env.RAG_QDRANT_BATCH_SIZE ?? 64) || 64);
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      await this.request('PUT', `/collections/${this.collection}/points?wait=true`, {
        points: batch.map((chunk) => ({
          id: chunkIdToPointId(chunk.chunk_id),
          vector: chunk.vector,
          payload: chunkPayload(chunk),
        })),
      });
    }
    this.rev += chunks.length;
  }

  async deleteByDoc(docId: string, tenantId: string): Promise<number> {
    await this.ensureCollection();
    await this.request('POST', `/collections/${this.collection}/points/delete?wait=true`, {
      filter: {
        must: [
          { key: 'tenant_id', match: { value: tenantId } },
          { key: 'doc_id', match: { value: docId } },
        ],
      },
    });
    // Qdrant 的 delete 响应不返回精确删除数：返回 0 并在注释中标明（调用方仅作日志用途）。
    this.rev++;
    return 0;
  }

  /** 进程内写版本号（BM25 语料快照缓存失效依据；单写者精确，见类注释）。 */
  revision(): number {
    return this.rev;
  }

  async search(tenantId: string, queryVec: number[], topK: number, aclPrincipals?: string[]): Promise<RetrieveResult[]> {
    await this.ensureCollection();
    type SearchResp = {
      result?: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>;
    };
    const resp = await this.request<SearchResp>(
      'POST',
      `/collections/${this.collection}/points/search`,
      {
        vector: queryVec,
        limit: topK,
        with_payload: true,
        filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }] },
      }
    );
    return (resp.result ?? [])
      .map((p) => {
        const payload = p.payload ?? {};
        return {
          chunk_id: String(payload.chunk_id ?? String(p.id)),
          doc_id: String(payload.doc_id ?? ''),
          ...(payload.title != null ? { title: String(payload.title) } : {}),
          content: String(payload.content ?? ''),
          score: Number(p.score ?? 0),
          ...(payload.metadata && typeof payload.metadata === 'object'
            ? { metadata: payload.metadata as Record<string, unknown> }
            : {}),
          // ACL 过滤标记（临时字段，随 map 后过滤剥离）
          __acl: Array.isArray(payload.acl) ? (payload.acl as unknown[]).map(String) : undefined,
        };
      })
      .filter((r) => aclVisible(r.__acl, aclPrincipals))
      .map(({ __acl: _acl, ...rest }) => rest as RetrieveResult);
  }

  /** scroll 分页全量导出（with_vector）——混合检索语料重建。 */
  async getChunks(tenantId: string): Promise<Chunk[]> {
    await this.ensureCollection();
    type ScrollResp = {
      result?: {
        points?: Array<{ id: string | number; payload?: Record<string, unknown>; vector?: number[] }>;
        next_page_offset?: string | number | null;
      };
    };
    const out: Chunk[] = [];
    let offset: string | number | null | undefined = undefined;
    do {
      const resp: ScrollResp = await this.request<ScrollResp>('POST', `/collections/${this.collection}/points/scroll`, {
        limit: 256,
        with_payload: true,
        with_vector: true,
        filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }] },
        ...(offset != null ? { offset } : {}),
      });
      const page = resp.result ?? {};
      for (const p of page.points ?? []) {
        out.push(payloadToChunk(String(p.id), p.payload ?? {}, Array.isArray(p.vector) ? p.vector : [], tenantId));
      }
      offset = page.next_page_offset ?? null;
    } while (offset != null);
    return out;
  }

  async count(tenantId?: string): Promise<number> {
    await this.ensureCollection();
    type CountResp = { result?: { count?: number } };
    const resp = await this.request<CountResp>('POST', `/collections/${this.collection}/points/count`, {
      exact: true,
      ...(tenantId ? { filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }] } } : {}),
    });
    return Number(resp.result?.count ?? 0);
  }
}
