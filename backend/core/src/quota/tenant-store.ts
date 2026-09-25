/**
 * 租户配额配置存储（quota 接线 · 数据库 tenant 表）。
 *
 * 职责：把 per-tenant 的配额配置（QPS / 并发 / 窗口 token / 窗口成本硬上限）
 * 持久化到 `tenant_quotas` 表，供 QuotaEngine 在 admit 时读取。
 *
 * 设计约定（与 memory-store / custom-models 一致）：
 *   - 走 getDbAdapter 双后端（DB_BACKEND=sqlite | turso），表结构用
 *     CREATE TABLE IF NOT EXISTS 自愈建表（简单幂等 schema 不走版本化迁移）；
 *   - 读路径带 TTL 缓存：admit 在热路径上，不能每次都打 DB；配置变更经
 *     upsert 写库 + 刷新缓存，外部直接改表则在 TTL（默认 30s）内最终一致；
 *   - init() 失败不永久中毒：失败时重置 ready，下次调用重试（吸取
 *     memory-store ensure() 中毒教训）；
 *   - core 不感知 server 侧路由，本 store 只管「配置存取」。
 */
import type { TenantQuota } from './engine';
import { getDbAdapter, type DbAdapter } from '../db-adapter';

/** tenant_quotas 表一行的完整形态。 */
export interface TenantQuotaRow extends TenantQuota {
  tenantId: string;
  updatedAt: number;
}

interface CacheEntry {
  row: TenantQuotaRow;
  fetchedAt: number;
}

export class TenantQuotaStore {
  private file: string;
  private ttlMs: number;
  private db: DbAdapter | null = null;
  private ready: Promise<void> | null = null;
  private cache = new Map<string, CacheEntry>();

  constructor(opts: { file?: string; ttlMs?: number } = {}) {
    this.file = opts.file || process.env.TENANT_QUOTA_DB_FILE || '/var/lib/agent-harness/tenant-quotas.db';
    this.ttlMs = opts.ttlMs ?? 30_000;
  }

  /** 显式初始化（建表 + 预热缓存）。幂等；失败可重复调用。 */
  async init(): Promise<void> {
    await this.ensure();
  }

  /** 惰性建库建表（幂等）。失败重置 ready 允许下次重试，不进程级中毒。 */
  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          this.db = getDbAdapter({ file: this.file });
          await this.db.exec(
            'CREATE TABLE IF NOT EXISTS tenant_quotas (' +
              'tenant_id TEXT PRIMARY KEY, ' +
              'qps REAL, ' +
              'max_concurrency INTEGER, ' +
              'max_tokens_per_window INTEGER, ' +
              'max_cost_per_window REAL, ' +
              'window_ms INTEGER, ' +
              'updated_at INTEGER NOT NULL)'
          );
          await this.warmCache();
        } catch (e) {
          this.ready = null; // 允许下次调用重试
          throw e;
        }
      })();
    }
    return this.ready;
  }

  /** 全量预热缓存（启动与 init 重试时）。 */
  private async warmCache(): Promise<void> {
    if (!this.db) return;
    const rows = (await this.db.prepare('SELECT * FROM tenant_quotas').all()) as Record<string, unknown>[];
    const now = Date.now();
    for (const r of rows) {
      const row = this.rowToQuota(r);
      this.cache.set(row.tenantId, { row, fetchedAt: now });
    }
  }

  private rowToQuota(r: Record<string, unknown>): TenantQuotaRow {
    const num = (v: unknown): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      tenantId: String(r.tenant_id ?? ''),
      qps: num(r.qps),
      maxConcurrency: num(r.max_concurrency),
      maxTokensPerWindow: num(r.max_tokens_per_window),
      maxCostPerWindow: num(r.max_cost_per_window),
      windowMs: num(r.window_ms),
      updatedAt: num(r.updated_at) ?? 0,
    };
  }

  /**
   * 同步读缓存（供 admit 热路径）。TTL 过期时返回旧值并触发后台刷新 ——
   * 宁可短暂旧配置也不让准入阻塞在 IO 上。
   */
  getCached(tenantId: string | null | undefined): TenantQuota | null {
    if (!tenantId || tenantId === 'anonymous') return null;
    const hit = this.cache.get(tenantId);
    if (!hit) {
      // 缓存 miss：后台拉一次（不阻塞同步调用方）
      void this.get(tenantId).catch(() => {});
      return null;
    }
    if (Date.now() - hit.fetchedAt > this.ttlMs) {
      void this.get(tenantId).catch(() => {});
    }
    return hit.row;
  }

  /** 异步读全量（缓存 miss 打 DB；DB 异常返回 null 不上抛）。 */
  async get(tenantId: string): Promise<TenantQuota | null> {
    if (!tenantId || tenantId === 'anonymous') return null;
    try {
      await this.ensure();
      if (!this.db) return null;
      const rows = (await this.db
        .prepare('SELECT * FROM tenant_quotas WHERE tenant_id = ?')
        .all(tenantId)) as Record<string, unknown>[];
      const hit = rows[0];
      if (!hit) return null;
      const row = this.rowToQuota(hit);
      this.cache.set(tenantId, { row, fetchedAt: Date.now() });
      return row;
    } catch {
      return null; // 读失败降级为「无租户配置」——引擎回退 default
    }
  }

  /** 写入 / 覆盖某租户配额（写库 + 同步刷新缓存）。 */
  async upsert(tenantId: string, q: TenantQuota): Promise<void> {
    if (!tenantId) throw new Error('tenantId is required');
    await this.ensure();
    if (!this.db) throw new Error('tenant-quotas db 未初始化');
    const now = Date.now();
    await this.db
      .prepare(
        'INSERT INTO tenant_quotas (tenant_id, qps, max_concurrency, max_tokens_per_window, max_cost_per_window, window_ms, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(tenant_id) DO UPDATE SET qps=excluded.qps, max_concurrency=excluded.max_concurrency, ' +
          'max_tokens_per_window=excluded.max_tokens_per_window, max_cost_per_window=excluded.max_cost_per_window, ' +
          'window_ms=excluded.window_ms, updated_at=excluded.updated_at'
      )
      .run(
        tenantId,
        q.qps ?? null,
        q.maxConcurrency ?? null,
        q.maxTokensPerWindow ?? null,
        q.maxCostPerWindow ?? null,
        q.windowMs ?? null,
        now
      );
    const row: TenantQuotaRow = { tenantId, ...q, updatedAt: now };
    this.cache.set(tenantId, { row, fetchedAt: now });
  }

  /** 删除某租户配额配置（回退引擎 default）。 */
  async remove(tenantId: string): Promise<void> {
    await this.ensure();
    if (!this.db) return;
    await this.db.prepare('DELETE FROM tenant_quotas WHERE tenant_id = ?').run(tenantId);
    this.cache.delete(tenantId);
  }

  /** 列出全部租户配额（运维视图）。 */
  async list(): Promise<TenantQuotaRow[]> {
    await this.ensure();
    if (!this.db) return [];
    const rows = (await this.db.prepare('SELECT * FROM tenant_quotas').all()) as Record<string, unknown>[];
    return rows.map((r) => this.rowToQuota(r));
  }
}
