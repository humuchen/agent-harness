/**
 * tenants/registry.ts — 租户注册表（长期：多租户运营面的档案实体）。
 *
 * 背景：此前「租户」只是隐式标识（resolveTenantContext 的字符串 + 记忆复合 key），
 * 没有档案、没有状态、没有生命周期 —— 运营无法开通/停用一个租户，dataZone 仅是
 * 请求侧声明。本模块把租户提升为**可寻址的一等实体**：
 *   - 档案：tenantId / name / status(active|suspended) / plan / dataZone / residency / notes；
 *   - 准入门禁：checkAdmission() —— suspended 租户在 guard / run-routes 两个入口被拒；
 *   - dataZone 权威源：档案里的 dataZone 覆盖请求声明（server guard 接线）。
 *
 * 设计约定（与 quota/tenant-store 完全同范式）：
 *   - getDbAdapter 双后端（sqlite | turso），CREATE TABLE IF NOT EXISTS 自愈建表；
 *   - init() 失败不永久中毒（重置 ready 允许重试）；
 *   - 读路径带短 TTL 缓存（guard 在请求热路径上）；写路径即时刷缓存；
 *   - core 不感知 server 路由；配额配置仍归 TenantQuotaStore（职责分离，不重复建表）。
 */

import { getDbAdapter, type DbAdapter } from '../db-adapter';

/** 租户档案一行。 */
export interface TenantRecord {
  tenantId: string;
  name?: string;
  /** active = 正常；suspended = 已停用（准入被拒，数据保留）。 */
  status: 'active' | 'suspended';
  /** 套餐标识（自由字符串，账单/限额策略的业务维度）。 */
  plan?: string;
  /** 合规数据分区（权威源，覆盖请求声明；'general' 缺省）。 */
  dataZone?: string;
  /** 数据驻留约束（如 'cn' / 'us'），随档案记录。 */
  residency?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

/** 租户准入判定结果。 */
export type TenantAdmission = { ok: true; record: TenantRecord | null } | { ok: false; reason: string };

interface CacheEntry {
  record: TenantRecord | null;
  fetchedAt: number;
}

export class TenantRegistry {
  private file: string;
  private ttlMs: number;
  private db: DbAdapter | null = null;
  private ready: Promise<void> | null = null;
  private cache = new Map<string, CacheEntry>();

  constructor(opts: { file?: string; ttlMs?: number } = {}) {
    this.file = opts.file || process.env.TENANT_REGISTRY_DB_FILE || '/var/lib/agent-harness/tenants.db';
    this.ttlMs = opts.ttlMs ?? 15_000;
  }

  /** 显式初始化（建表）。幂等；失败可重复调用。 */
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
            'CREATE TABLE IF NOT EXISTS tenants (' +
              'tenant_id TEXT PRIMARY KEY, ' +
              'name TEXT, ' +
              "status TEXT NOT NULL DEFAULT 'active', " +
              'plan TEXT, ' +
              'data_zone TEXT, ' +
              'residency TEXT, ' +
              'notes TEXT, ' +
              'created_at INTEGER NOT NULL, ' +
              'updated_at INTEGER NOT NULL)'
          );
        } catch (e) {
          this.ready = null; // 允许下次调用重试
          throw e;
        }
      })();
    }
    return this.ready;
  }

  private rowToRecord(r: Record<string, unknown>): TenantRecord {
    const str = (v: unknown): string | undefined => {
      const s = v == null ? '' : String(v).trim();
      return s ? s : undefined;
    };
    const status = String(r.status ?? 'active') === 'suspended' ? 'suspended' : 'active';
    return {
      tenantId: String(r.tenant_id ?? ''),
      ...(str(r.name) ? { name: str(r.name) } : {}),
      status,
      ...(str(r.plan) ? { plan: str(r.plan) } : {}),
      ...(str(r.data_zone) ? { dataZone: str(r.data_zone) } : {}),
      ...(str(r.residency) ? { residency: str(r.residency) } : {}),
      ...(str(r.notes) ? { notes: str(r.notes) } : {}),
      createdAt: Number(r.created_at ?? 0),
      updatedAt: Number(r.updated_at ?? 0),
    };
  }

  /** 读单条（TTL 缓存；DB 异常返回 null 不上抛 —— 门禁路径宁可放行也不阻断业务）。 */
  async get(tenantId: string): Promise<TenantRecord | null> {
    if (!tenantId || tenantId === 'anonymous') return null;
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.fetchedAt <= this.ttlMs) return hit.record;
    try {
      await this.ensure();
      if (!this.db) return null;
      const rows = (await this.db
        .prepare('SELECT * FROM tenants WHERE tenant_id = ?')
        .all(tenantId)) as Record<string, unknown>[];
      const row = rows[0] ? this.rowToRecord(rows[0]) : null;
      this.cache.set(tenantId, { record: row, fetchedAt: Date.now() });
      return row;
    } catch {
      return null;
    }
  }

  /**
   * 准入门禁：租户不存在 → 放行（未建档租户按现行隐式语义处理，向后兼容）；
   * suspended → 拒绝。guard 与 run-routes（body 声明租户的降级路径）共用本判定。
   */
  async checkAdmission(tenantId: string | null | undefined): Promise<TenantAdmission> {
    if (!tenantId || tenantId === 'anonymous') return { ok: true, record: null };
    const record = await this.get(tenantId);
    if (record && record.status === 'suspended') {
      return { ok: false, reason: `tenant "${tenantId}" is suspended` };
    }
    return { ok: true, record };
  }

  /** 创建或更新档案（patch 语义：仅覆盖显式提供的字段；tenantId 必填）。 */
  async upsert(
    tenantId: string,
    patch: {
      name?: string;
      status?: 'active' | 'suspended';
      plan?: string;
      dataZone?: string;
      residency?: string;
      notes?: string;
    },
  ): Promise<TenantRecord> {
    const id = String(tenantId ?? '').trim();
    if (!id) throw new Error('tenantId is required');
    await this.ensure();
    if (!this.db) throw new Error('tenants db 未初始化');
    const existing = await this.get(id);
    const now = Date.now();
    const next: TenantRecord = {
      tenantId: id,
      name: patch.name !== undefined ? patch.name || undefined : existing?.name,
      status: patch.status ?? existing?.status ?? 'active',
      plan: patch.plan !== undefined ? patch.plan || undefined : existing?.plan,
      dataZone: patch.dataZone !== undefined ? patch.dataZone || undefined : existing?.dataZone,
      residency: patch.residency !== undefined ? patch.residency || undefined : existing?.residency,
      notes: patch.notes !== undefined ? patch.notes || undefined : existing?.notes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.db
      .prepare(
        'INSERT INTO tenants (tenant_id, name, status, plan, data_zone, residency, notes, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(tenant_id) DO UPDATE SET name=excluded.name, status=excluded.status, plan=excluded.plan, ' +
          'data_zone=excluded.data_zone, residency=excluded.residency, notes=excluded.notes, updated_at=excluded.updated_at'
      )
      .run(
        id,
        next.name ?? null,
        next.status,
        next.plan ?? null,
        next.dataZone ?? null,
        next.residency ?? null,
        next.notes ?? null,
        next.createdAt,
        next.updatedAt,
      );
    this.cache.set(id, { record: next, fetchedAt: Date.now() });
    return next;
  }

  /** 列出全部租户档案（管理视图；created_at 倒序）。 */
  async list(): Promise<TenantRecord[]> {
    await this.ensure();
    if (!this.db) return [];
    const rows = (await this.db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all()) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /** 删除档案（运营撤销；数据不清理）。 */
  async remove(tenantId: string): Promise<void> {
    await this.ensure();
    if (!this.db) return;
    await this.db.prepare('DELETE FROM tenants WHERE tenant_id = ?').run(tenantId);
    this.cache.delete(tenantId);
  }

  /** 失效某租户缓存（测试 / 外部直改库后强制回源）。 */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}

// ---------------------------------------------------------------------------
// 进程共享单例（server 启动时 configure + init；guard / run-routes / 路由组共用）。
// ---------------------------------------------------------------------------
let _registry: TenantRegistry | null = null;

/** 取得进程共享 TenantRegistry（首次调用按 env 文件路径创建）。 */
export function getTenantRegistry(): TenantRegistry {
  if (!_registry) _registry = new TenantRegistry();
  return _registry;
}

/** 配置进程共享 TenantRegistry 的存储文件（server 启动装配时调用，须在 init 前）。 */
export function configureTenantRegistry(opts: { file?: string; ttlMs?: number }): TenantRegistry {
  _registry = new TenantRegistry(opts);
  return _registry;
}
