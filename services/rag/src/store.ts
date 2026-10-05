/**
 * store.ts — 向量存储与余弦检索（单节点最小闭环）。
 *
 * 满足设计文档 P0「可 docker run 单节点」与第 8 节「增量更新 / 权限隔离」：
 * - 内存为主索引，chunk 级 upsert（幂等），支持按 doc_id 整文档删除（增量更新）。
 * - 所有读路径强制 tenant_id 过滤（服务端重写后传入），零跨租户泄漏。
 * - 可选 JSON 持久化（RAG_DATA_FILE），进程重启后恢复；生产可换 sqlite/向量库（见 persistSqlite 占位）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

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
  /** 重排后的最终序分（MMR 等重排生效时填充）。 */
  rerank_score?: number;
  metadata?: Record<string, unknown>;
}

/**
 * P6-B 向量存储统一契约（对标 LangChain VectorStore 抽象的最小可用子集）。
 *
 * 设计要点：
 * - 方法允许同步或异步返回（MaybePromise）——MemoryVectorStore 全同步零开销，
 *   外部后端（Qdrant 等）async 实现，消费方统一 `await`（await 同步值零成本）。
 * - `hybridCapable`：是否支持全量语料导出（getChunks）。BM25 混合检索 / 查询扩展 /
 *   MMR 重排依赖它；不支持的后端（如纯检索型远程库）消费方按 false 降级为纯稠密检索。
 * - persist/load 为可选能力（仅本地持久化实现提供；外部后端的持久化由其自身承担）。
 */
export type MaybePromise<T> = T | Promise<T>;

export interface VectorStore {
  readonly dim: number;
  /** 全量语料导出能力（BM25 混合 / MMR / 查询扩展的前置条件）。 */
  readonly hybridCapable: boolean;
  /** chunk 级幂等写入；相同 chunk_id 覆盖（增量更新语义）。 */
  upsert(chunk: Chunk): MaybePromise<void>;
  /** 按 doc_id + tenant_id 删除整篇文档的所有 chunk，返回删除数（后端无法计数时返回 0）。 */
  deleteByDoc(docId: string, tenantId: string): MaybePromise<number>;
  /** 候选检索：tenant 内相似度 top_k（租户过滤在实现内强制，绝不跨租户）。 */
  search(tenantId: string, queryVec: number[], topK: number): MaybePromise<RetrieveResult[]>;
  /** 租户内全量 chunk（含 vector），供 BM25 / MMR 重建语料。仅 hybridCapable=true 保证可用。 */
  getChunks(tenantId: string): MaybePromise<Chunk[]>;
  /** chunk 计数（省略 tenant = 全库）。 */
  count(tenantId?: string): MaybePromise<number>;
  /** 可选：JSON 持久化（Memory 实现；外部后端忽略）。 */
  persist?(file: string, shardByTenant?: boolean): void;
  /** 可选：从 JSON 恢复（Memory 实现）。 */
  load?(file: string, shardByTenant?: boolean): void;
  /** 可选：各租户 chunk 数（可观测 / health 用）。 */
  tenantCounts?(): Record<string, number>;
}

export class MemoryVectorStore implements VectorStore {
  readonly dim: number;
  /** P6-B：全量语料在内存 → 混合检索能力齐备。 */
  readonly hybridCapable = true;
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
    for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
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

  /** 各租户 chunk 数（可观测 / health 用）。 */
  tenantCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.chunks.values()) out[c.tenant_id] = (out[c.tenant_id] || 0) + 1;
    return out;
  }

  /** 返回租户内全部 chunk（含 vector），供 BM25 / 重排按需重建语料（P2/P3）。 */
  getChunks(tenantId: string): Chunk[] {
    const out: Chunk[] = [];
    for (const c of this.chunks.values()) {
      if (c.tenant_id === tenantId) out.push(c);
    }
    return out;
  }

  // ---------- 持久化（JSON，单节点） ----------
  /**
   * 持久化到 JSON。
   * @param shardByTenant 为 true 时按租户分片：每个租户写 `<base>.<tenant>.json`
   *   （满足设计文档 P3「向量库按租户分片」——可映射到独立卷/分片存储）。
   */
  persist(file: string, shardByTenant = false): void {
    if (!shardByTenant) {
      mkdirSync(dirname(file), { recursive: true });
      const rows = [...this.chunks.values()];
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify({ version: 1, dim: this.dim, chunks: rows }), 'utf8');
      renameSync(tmp, file);
      return;
    }
    const dir = dirname(file);
    const base = basename(file);
    const byTenant = new Map<string, Chunk[]>();
    for (const c of this.chunks.values()) {
      const arr = byTenant.get(c.tenant_id) ?? [];
      arr.push(c);
      byTenant.set(c.tenant_id, arr);
    }
    mkdirSync(dir, { recursive: true });
    for (const [tenant, rows] of byTenant) {
      const target = join(dir, `${base}.${tenant}.json`);
      const tmp = target + '.tmp';
      writeFileSync(tmp, JSON.stringify({ version: 1, dim: this.dim, tenant, chunks: rows }), 'utf8');
      renameSync(tmp, target);
    }
  }

  /**
   * 从 JSON 恢复。
   * @param shardByTenant 为 true 时加载所有 `<base>.<tenant>.json` 分片；
   *   若分片均不存在但单文件存在，则回退加载单文件（兼容旧数据）。
   */
  load(file: string, shardByTenant = false): void {
    if (!shardByTenant) {
      if (!existsSync(file)) return;
      // P2 统一损坏策略（rag 为 stdlib-only，不引 core，内联等价实现）：
      // 解析失败 → console.error 告警 + 隔离改名（保留现场）+ 以空索引继续。
      // 此前 JSON.parse 失败直接抛出 → createRagServer 启动即崩、进入崩溃循环。
      let raw: { dim: number; chunks: Chunk[] };
      try {
        raw = JSON.parse(readFileSync(file, 'utf8')) as { dim: number; chunks: Chunk[] };
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        const quarantined = `${file}.corrupt-${Date.now()}`;
        try {
          renameSync(file, quarantined);
        } catch {
          /* 隔离失败保留原位，下次启动会再次进入本路径告警 */
        }
        console.error(
          `[rag-store] 索引文件损坏（${detail}），已隔离为 ${quarantined}，按空索引继续。` +
            `如需恢复请基于 .corrupt-* 文件人工修复后重新 ingest。`
        );
        return;
      }
      if (raw.dim !== this.dim) {
        throw new Error(`持久化维度(${raw.dim})与当前(${this.dim})不一致`);
      }
      for (const c of raw.chunks) this.chunks.set(c.chunk_id, c);
      return;
    }
    const dir = dirname(file);
    const base = basename(file);
    let loaded = 0;
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(base + '.') || !name.endsWith('.json')) continue;
        const shardPath = join(dir, name);
        // 分片损坏：告警 + 隔离改名 + 跳过该分片继续（此前静默跳过，数据静默丢失不可见）。
        let raw: { dim: number; chunks: Chunk[] };
        try {
          raw = JSON.parse(readFileSync(shardPath, 'utf8')) as { dim: number; chunks: Chunk[] };
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          const quarantined = `${shardPath}.corrupt-${Date.now()}`;
          try {
            renameSync(shardPath, quarantined);
          } catch {
            /* 隔离失败保留原位 */
          }
          console.error(
            `[rag-store] 索引分片损坏（${detail}），已隔离为 ${quarantined}，跳过该分片继续。`
          );
          continue;
        }
        if (raw.dim !== this.dim) continue;
        for (const c of raw.chunks) this.chunks.set(c.chunk_id, c);
        loaded++;
      }
    }
    if (loaded === 0 && existsSync(file)) this.load(file, false);
  }
}

/**
 * P6-B 存储工厂：按 `RAG_STORE_BACKEND` 构建向量存储后端。
 * - 缺省 / `memory` → MemoryVectorStore（单节点 JSON 持久化，零依赖，存量行为）；
 * - `qdrant` → QdrantVectorStore（REST 零 SDK；QDRANT_URL / QDRANT_API_KEY /
 *   QDRANT_COLLECTION 配置，维度取参数 dim）。
 */
export function createVectorStore(dim: number): VectorStore {
  const backend = (process.env.RAG_STORE_BACKEND ?? '').trim().toLowerCase();
  if (backend === 'qdrant') {
    // 延迟 require：仅 qdrant 后端加载该模块（保持 memory 路径零额外开销）。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { QdrantVectorStore } = require('./qdrant') as { QdrantVectorStore: new (o: { dim: number; url?: string; apiKey?: string; collection?: string }) => VectorStore };
    return new QdrantVectorStore({
      dim,
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
      collection: process.env.QDRANT_COLLECTION,
    });
  }
  return new MemoryVectorStore(dim);
}
