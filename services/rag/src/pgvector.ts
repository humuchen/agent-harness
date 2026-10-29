/**
 * pgvector.ts — PostgreSQL + pgvector 向量存储后端（P6-B VectorStore 契约实现）。
 *
 * 设计要点：
 * - **pgvector 原生 ANN**：search 走 `ORDER BY vector <=> $1::vector LIMIT topK`
 *   （余弦距离，pgvector 内核算力优化），替代内存全量扫描——生产规模（10 万+
 *   chunk）下 sqlite 后端的每查询全表扫描不可接受。
 * - **租户隔离**：所有读写路径强制 tenant_id 过滤（与 MemoryVectorStore 同红线）。
 * - **ACL 过滤在应用层**：与 sqlite/memory 后端一致（pgvector 的 ACL 数组比较
 *   语义不同，统一在应用层过滤保证各后端行为一致）。
 * - **HNSW 索引**：建表时按需创建 `vector_cosine_ops` HNSW 索引（幂等检查，
 *   PG 不支持 CREATE INDEX IF NOT EXISTS）。
 * - **维度校验**：建表时 `vector(dim)`；存量库通过 `vector::text` 采样比对维度，
 *   不一致 fail-fast（与 sqlite 后端语义一致——embedding 维度变了必须重建索引）。
 * - **pg 驱动延迟加载**：与 SqliteVectorStore 的 node:sqlite 模式一致——运行期
 *   `pg` 包缺失时给出可操作错误（不静默降级 memory：用户显式选择了 pgvector，
 *   静默降级会让「以为持久化了」的索引在重启后消失）。
 *
 * env：RAG_PG_URL（或 PGDATABASE/PGUSER/PGPASSWORD/PGHOST 由 pg 库默认读取）、
 *   RAG_PG_TABLE（默认 rag_chunks）、RAG_PG_SCHEMA（默认 public）。
 */

import { aclVisible, type Chunk, type DocSummary, type RetrieveResult, type VectorStore } from './store';

export interface PgVectorStoreOptions {
  dim: number;
  /** PostgreSQL 连接串（如 postgres://user:pass@host:5432/db）。缺省读 RAG_PG_URL。 */
  url?: string;
  /** 表名（默认 rag_chunks）。 */
  table?: string;
  /** schema（默认 public）。 */
  schema?: string;
}

/** pg 驱动延迟加载：缺失时给出可操作错误（不静默降级）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadPg(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('pg');
  } catch {
    throw new Error(
      `PgVectorStore 需要 pg 驱动（npm install pg）。` +
        `当前 services/rag 为 stdlib-only，pg 为可选 peer 依赖——` +
        `请安装 pg，或改用 RAG_STORE_BACKEND=memory（JSON 快照）/ sqlite / qdrant。`
    );
  }
}

/** 向量数组 → pgvector text 格式 `[1,2,3]`。 */
function vecToText(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** pgvector text 格式 → number[]。 */
function vecFromText(s: string): number[] {
  return s
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((x) => Number(x.trim()));
}

/** pg Pool 的最小类型（pg 为动态加载的可选 peer 依赖，不做完整类型声明）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgPool = any;

export class PgVectorStore implements VectorStore {
  readonly dim: number;
  readonly hybridCapable = true;
  private readonly table: string;
  private readonly schema: string;
  private pool: PgPool;
  private readonly url: string;
  /** 进程内写版本号（BM25 语料快照缓存依据）。 */
  private rev = 0;

  constructor(opts: PgVectorStoreOptions) {
    this.dim = opts.dim;
    this.url = (opts.url ?? process.env.RAG_PG_URL ?? '').trim();
    if (!this.url) {
      throw new Error('[rag-pgvector] RAG_PG_URL 未配置（RAG_STORE_BACKEND=pgvector 时必填）');
    }
    this.table = opts.table ?? process.env.RAG_PG_TABLE ?? 'rag_chunks';
    this.schema = opts.schema ?? process.env.RAG_PG_SCHEMA ?? 'public';
    // 表名/schema 仅允许标识符字符（防注入：表名会拼进 SQL）。
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.table) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.schema)) {
      throw new Error(`[rag-pgvector] 非法表名/schema：${this.schema}.${this.table}`);
    }
    const pg = loadPg();
    this.pool = pg.Pool ? new pg.Pool({ connectionString: this.url, max: 10 }) : null;
  }

  private get qualifiedTable(): string {
    return `${this.schema}.${this.table}`;
  }

  /** 建表 + HNSW 索引（幂等）。 */
  private async ensureSchema(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.qualifiedTable} (
        chunk_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        content TEXT NOT NULL,
        title TEXT,
        tags TEXT,
        metadata TEXT,
        acl TEXT,
        vector vector(${this.dim}) NOT NULL,
        created_at BIGINT NOT NULL
      )`
    );
    // 存量库平滑迁移：缺 acl 列时补齐（与 sqlite 后端同策略）。
    const cols = await this.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [this.schema, this.table]
    );
    if (!cols.rows.some((r: { column_name: string }) => r.column_name === 'acl')) {
      await this.pool.query(`ALTER TABLE ${this.qualifiedTable} ADD COLUMN acl TEXT`);
    }
    // HNSW 索引（幂等：PG 不支持 CREATE INDEX IF NOT EXISTS，先查后建）。
    const idx = await this.pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
      [this.schema, this.table, `${this.table}_vector_idx`]
    );
    if (!idx.rows.length) {
      await this.pool.query(
        `CREATE INDEX ${this.table}_vector_idx ON ${this.qualifiedTable} USING hnsw (vector vector_cosine_ops)`
      );
    }
    // 维度校验（与 sqlite 后端 fail-fast 语义一致）。
    const row = await this.pool.query(`SELECT vector::text AS v FROM ${this.qualifiedTable} LIMIT 1`);
    if (row.rows.length) {
      const v = vecFromText(row.rows[0].v);
      if (v.length !== this.dim) {
        throw new Error(`pgvector 索引维度(${v.length})与当前(${this.dim})不一致：请更换表或重新 ingest`);
      }
    }
  }

  async upsert(chunk: Chunk): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO ${this.qualifiedTable} (chunk_id, doc_id, tenant_id, idx, content, title, tags, metadata, acl, vector, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, $11)
       ON CONFLICT(chunk_id) DO UPDATE SET
         doc_id = excluded.doc_id, tenant_id = excluded.tenant_id, idx = excluded.idx,
         content = excluded.content, title = excluded.title, tags = excluded.tags,
         metadata = excluded.metadata, acl = excluded.acl, vector = excluded.vector, created_at = excluded.created_at`,
      [
        chunk.chunk_id,
        chunk.doc_id,
        chunk.tenant_id,
        chunk.index,
        chunk.content,
        chunk.title ?? null,
        chunk.tags ? JSON.stringify(chunk.tags) : null,
        chunk.metadata ? JSON.stringify(chunk.metadata) : null,
        chunk.acl?.length ? JSON.stringify(chunk.acl) : null,
        vecToText(chunk.vector),
        chunk.created_at,
      ]
    );
    this.rev++;
  }

  async deleteByDoc(docId: string, tenantId: string): Promise<number> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `DELETE FROM ${this.qualifiedTable} WHERE doc_id = $1 AND tenant_id = $2`,
      [docId, tenantId]
    );
    const n = Number(res.rowCount ?? 0);
    if (n > 0) this.rev++;
    return n;
  }

  revision(): number {
    return this.rev;
  }

  /** 候选检索：tenant 内余弦 top_k（pgvector 原生 ANN + 租户过滤在 SQL 层）。 */
  async search(tenantId: string, queryVec: number[], topK: number, aclPrincipals?: string[]): Promise<RetrieveResult[]> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `SELECT chunk_id, doc_id, title, content, tags, metadata, acl,
              1 - (vector <=> $2::vector) AS score
       FROM ${this.qualifiedTable}
       WHERE tenant_id = $1
       ORDER BY vector <=> $2::vector
       LIMIT $3`,
      [tenantId, vecToText(queryVec), topK]
    );
    const scored = res.rows.map((r: Record<string, unknown>) => ({
      chunk_id: String(r.chunk_id),
      doc_id: String(r.doc_id),
      ...(r.title != null ? { title: String(r.title) } : {}),
      content: String(r.content),
      score: Number(r.score ?? 0),
      ...(r.tags ? { tags: JSON.parse(String(r.tags)) as string[] } : {}),
      ...(r.metadata ? { metadata: JSON.parse(String(r.metadata)) as Record<string, unknown> } : {}),
      acl: r.acl ? (JSON.parse(String(r.acl)) as string[]) : undefined,
    }));
    const visible: Array<{ chunk_id: string; doc_id: string; title?: string; content: string; score: number; tags?: string[]; metadata?: Record<string, unknown>; acl?: string[] }> = scored;
    return visible.filter((s) => aclVisible(s.acl, aclPrincipals)).slice(0, topK);
    return visible.slice(0, topK);
  }

  count(tenantId?: string): Promise<number> {
    return this.ensureSchema().then(() =>
      this.pool.query(
        tenantId
          ? `SELECT COUNT(*) AS n FROM ${this.qualifiedTable} WHERE tenant_id = $1`
          : `SELECT COUNT(*) AS n FROM ${this.qualifiedTable}`,
        tenantId ? [tenantId] : []
      ).then((r: { rows: Array<{ n: string }> }) => Number(r.rows[0]?.n ?? 0))
    );
  }

  /** 租户内全量 chunk（含 vector），供 BM25 / MMR 重建语料。 */
  async getChunks(tenantId: string): Promise<Chunk[]> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `SELECT chunk_id, doc_id, tenant_id, idx, content, title, tags, metadata, acl, vector::text AS vector, created_at
       FROM ${this.qualifiedTable} WHERE tenant_id = $1 ORDER BY doc_id, idx`,
      [tenantId]
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      chunk_id: String(r.chunk_id),
      doc_id: String(r.doc_id),
      tenant_id: String(r.tenant_id),
      index: Number(r.idx),
      content: String(r.content),
      ...(r.title != null ? { title: String(r.title) } : {}),
      ...(r.tags ? { tags: JSON.parse(String(r.tags)) as string[] } : {}),
      ...(r.metadata ? { metadata: JSON.parse(String(r.metadata)) as Record<string, unknown> } : {}),
      ...(r.acl ? { acl: JSON.parse(String(r.acl)) as string[] } : {}),
      vector: vecFromText(String(r.vector)),
      created_at: Number(r.created_at),
    }));
  }

  /** 租户内文档列表（文档管理 API）。acl 为文档级统一值，取 MIN 聚合。 */
  async listDocs(tenantId: string): Promise<DocSummary[]> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `SELECT doc_id, COUNT(*) AS chunks, MIN(NULLIF(title, '')) AS title,
              MAX(created_at) AS updated_at, MIN(acl) AS acl
       FROM ${this.qualifiedTable} WHERE tenant_id = $1 GROUP BY doc_id ORDER BY updated_at DESC`,
      [tenantId]
    );
    return res.rows.map((r: Record<string, unknown>) => {
      let acl: string[] | undefined;
      if (r.acl) {
        try {
          const parsed = JSON.parse(String(r.acl));
          if (Array.isArray(parsed) && parsed.length) acl = parsed.map(String);
        } catch {
          /* 坏值按无 acl 处理 */
        }
      }
      return {
        doc_id: String(r.doc_id),
        chunks: Number(r.chunks),
        title: (r.title as string) ?? undefined,
        updated_at: Number(r.updated_at ?? 0),
        ...(acl?.length ? { acl } : {}),
      };
    });
  }

  /** no-op：写路径已落库即持久（保留以对齐 server 的「ingest 后 persist」调用）。 */
  persist(_file?: string, _shardByTenant?: boolean): void {
    void _file;
    void _shardByTenant;
  }

  /** no-op：数据在库内，无需恢复。 */
  load(_file?: string, _shardByTenant?: boolean): void {
    void _file;
    void _shardByTenant;
  }

  /** 优雅关闭（server shutdown 调用）。 */
  async close(): Promise<void> {
    const pool = this.pool as { end?: () => Promise<void> } | null;
    try {
      await pool?.end?.();
    } catch {
      /* 已关闭：忽略 */
    }
  }
}
