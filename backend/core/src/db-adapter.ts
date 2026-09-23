/**
 * 统一数据库适配器抽象层
 *
 * 支持两个后端（通过环境变量 `DB_BACKEND` 切换）：
 *   - `sqlite`（默认/兜底）：node:sqlite（Node 22+ 内置，零 npm 依赖）
 *   - `turso`：@libsql/client/node（Turso 云端 SQLite，需配 TURSO_URL + TURSO_TOKEN）
 *
 * 设计要点：
 *   - 同步 API（与 node:sqlite 的 DatabaseSync 一致），调用方可无感知切换
 *   - 自动回退：turso 后端初始化失败时降级为本地 sqlite
 *   - 文件落点可配置：sqlite 用 DB_SQLITE_FILE，turso 用 TURSO_URL
 *
 * 使用方法：
 *   import { getDbAdapter } from '@agent-harness/core/db-adapter';
 *   const db = getDbAdapter({ file: './data/my.db' });
 *   db.exec('CREATE TABLE IF NOT EXISTS ...');
 *   const row = db.prepare('SELECT * FROM t WHERE id = ?').get(id);
 */

// ─── 类型契约 ────────────────────────────────────────────────────────────────

export type MaybePromise<T> = T | Promise<T>;

export interface DbStatement {
  run(...params: unknown[]): MaybePromise<{ changes: number; lastInsertRowid: number | bigint }>;
  get(...params: unknown[]): MaybePromise<Record<string, unknown> | undefined>;
  all(...params: unknown[]): MaybePromise<Record<string, unknown>[]>;
}

export interface DbAdapter {
  exec(sql: string): MaybePromise<void>;
  prepare(sql: string): DbStatement;
  close?(): void;
  /** 在 adapterCache 中的键（close 时用于同步删除缓存条目，实现自愈）。 */
  cacheKey?: string;
}

export type DbBackend = 'sqlite' | 'turso';

export interface DbAdapterOptions {
  /**
   * sqlite 后端的文件路径（默认 ./data/app.db）。
   * turso 后端忽略此字段（由 TURSO_URL 决定）。
   */
  file?: string;
  /**
   * 强制指定后端（覆盖环境变量 DB_BACKEND）。
   */
  backend?: DbBackend;
  /**
   * sqlite 后端的 PRAGMA 设置（仅 sqlite 生效，turso 忽略）。
   */
  pragmas?: {
    journalMode?: 'wal' | 'delete' | 'truncate' | 'persist' | 'memory' | 'off';
    busyTimeoutMs?: number;
    foreignKeys?: boolean;
  };
}

// ─── SQLite 后端（node:sqlite）───────────────────────────────────────────────

/** node:sqlite 的最小结构契约（避免直接依赖 @types/node 的具体版本）。 */
interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

class SqliteAdapter implements DbAdapter {
  private db: SqliteDb;
  private file: string;
  /** 自身在 adapterCache 中的键，close 时用于同步删除缓存条目（自愈）。 */
  cacheKey: string;

  constructor(file: string, pragmas?: DbAdapterOptions['pragmas']) {
    const fs = require('node:fs');
    const path = require('node:path');
    this.file = file;
    this.cacheKey = `sqlite:${file}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string) => SqliteDb };
    this.db = new sqlite.DatabaseSync(file);
    // 常用 PRAGMA（按配置，走默认值兜底）
    const journal = pragmas?.journalMode ?? 'wal';
    const busy = pragmas?.busyTimeoutMs ?? 5000;
    try { this.db.exec(`PRAGMA journal_mode = ${journal};`); } catch { /* 可能不支持 */ }
    try { this.db.exec(`PRAGMA busy_timeout = ${busy};`); } catch { /* ok */ }
    if (pragmas?.foreignKeys) {
      try { this.db.exec('PRAGMA foreign_keys = ON;'); } catch { /* ok */ }
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): DbStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const r = stmt.run(...params);
        return { changes: r.changes as number, lastInsertRowid: r.lastInsertRowid as number };
      },
      get: (...params: unknown[]) => stmt.get(...params) as Record<string, unknown> | undefined,
      all: (...params: unknown[]) => stmt.all(...params) as Record<string, unknown>[],
    };
  }

  close(): void {
    try { this.db.close(); } catch { /* ok */ }
    evictAdapterCache(this.cacheKey);
  }
}

// ─── Turso 后端（@libsql/client/node）──────────────────────────────────────

/** @libsql/client 的最小结构契约（可选依赖，未安装时不可达此路径）。 */
type LibsqlArgs = Array<string | number | bigint | Uint8Array | null>;
interface LibsqlResult {
  rowsAffected?: number;
  lastInsertRowid?: number | bigint | string;
  rows?: Array<Record<string, unknown>>;
}
interface LibsqlClient {
  execute(stmt: string | { sql: string; args: LibsqlArgs }): LibsqlResult | Promise<LibsqlResult>;
  close(): void;
}

class TursoAdapter implements DbAdapter {
  private client: LibsqlClient;
  /** 自身在 adapterCache 中的键，close 时用于同步删除缓存条目（自愈）。 */
  cacheKey: string;

  constructor(url: string, token?: string) {
    this.cacheKey = `turso:${url}`;
    try {
      // @libsql/client/node 使用 createClient 工厂函数
      const { createClient } = require('@libsql/client/node') as { createClient: (cfg: Record<string, unknown>) => LibsqlClient };
      this.client = createClient({
        url,
        authToken: token,
        // 启用 Hrana v2 协议（libsql:// / wss://），以获得 batch 多语句原子执行能力。
        // 若服务端不支持则自动降级到 HTTP。
        ...(url.startsWith('libsql://') || url.startsWith('libsql+ws://') || url.startsWith('libsql+wss://')
          ? { tls: true } : {}),
      });
    } catch (e) {
      throw new Error(
        `Turso 后端初始化失败（缺少依赖或配置错误）：${e instanceof Error ? e.message : String(e)}。请执行 pnpm add @libsql/client`
      );
    }
  }

  exec(sql: string): void | Promise<void> {
    // libsql Hrana 不允许单条 execute 中包含多条语句，需要按分号分割后逐个执行
    // 顺序执行 DDL 即可满足幂等建表需求。
    const stmts: string[] = [];
    for (const stmt of sql.split(/;\s*/)) {
      const trimmed = stmt.trim();
      if (trimmed) stmts.push(trimmed);
    }
    if (stmts.length === 0) return;
    const first = stmts[0];
    if (first === undefined) return;

    // 检查第一条返回值判断是否为 Promise（HTTP 模式）
    const firstResult = this.client.execute(first);
    if (firstResult && typeof (firstResult as Promise<LibsqlResult>).then === 'function') {
      // HTTP 模式：顺序 await 每条语句
      let chain = firstResult as Promise<LibsqlResult>;
      for (const stmt of stmts.slice(1)) {
        chain = chain.then(() => this.client.execute(stmt));
      }
      return chain.then(() => {});
    } else {
      // WebSocket 模式：同步执行
      for (const stmt of stmts.slice(1)) {
        this.client.execute(stmt);
      }
    }
  }

  /** execute 的统一 await：无论 Hrana 返回同步结果还是 Promise，都收敛为 Promise。 */
  private async awaitResult(
    sql: string,
    params: unknown[]
  ): Promise<LibsqlResult> {
    const r = this.client.execute({ sql, args: params as LibsqlArgs });
    if (r && typeof (r as Promise<LibsqlResult>).then === 'function') {
      return r as Promise<LibsqlResult>;
    }
    return r as LibsqlResult;
  }

  prepare(sql: string): DbStatement {
    return {
      run: async (...params: unknown[]) => {
        const res = await this.awaitResult(sql, params);
        return {
          changes: res.rowsAffected ?? 0,
          lastInsertRowid: res.lastInsertRowid != null ? Number(res.lastInsertRowid) : 0,
        };
      },
      get: async (...params: unknown[]) => {
        const res = await this.awaitResult(sql, params);
        return res.rows?.[0] as Record<string, unknown> | undefined;
      },
      all: async (...params: unknown[]) => {
        const res = await this.awaitResult(sql, params);
        return res.rows as Record<string, unknown>[] ?? [];
      },
    };
  }

  close(): void {
    try { this.client.close(); } catch { /* ok */ }
    evictAdapterCache(this.cacheKey);
  }
}

// ─── 单例管理 ────────────────────────────────────────────────────────────────

const adapterCache = new Map<string, DbAdapter>();

/** 关闭适配器时把对应缓存条目删除：下次 getDbAdapter 会重新建连（关闭后自愈，避免复用已关闭实例）。 */
function evictAdapterCache(cacheKey: string): void {
  adapterCache.delete(cacheKey);
}

/**
 * P1：按租户/数据分区解析 SQLite 文件路径。
 *
 * 设计：默认 `./data/app.db`；当传入 `dataZone`（如 'medical' / 'financial'）时，
 * 路径变为 `./data/<dataZone>/app.db`，实现 per-zone 物理分区（不同合规域数据落不同文件，
 * 配合 ComplianceProfile.dataResidency='domestic' 与 audit dataZone 字段满足合规审计维度）。
 * 缺省 `dataZone='general'` 时返回原始路径（向后兼容，行为不变）。
 *
 * ⚠️ 仅影响 sqlite 后端；turso 后端的分区由 TURSO_URL 指向的远端库决定，此函数不改动它。
 */
export function resolveTenantDbPath(base: string, dataZone?: string): string {
  const zone = (dataZone ?? 'general').trim().toLowerCase();
  if (!zone || zone === 'general') return base;
  // 安全：zone 仅允许 [a-z0-9_-]，杜绝路径穿越
  if (!/^[a-z0-9_-]+$/.test(zone)) return base;
  const pathMod = require('node:path') as { dirname: (s: string) => string; basename: (s: string) => string; join: (...p: string[]) => string };
  return pathMod.join(pathMod.dirname(base), zone, pathMod.basename(base));
}

/**
 * 获取（或创建）数据库适配器。
 *
 * 同一 file 配置返回同一实例（单例）；不同 file 各自独立连接。
 * 自动回退：若环境指定 turso 但初始化失败，降级为本地 sqlite。
 *
 * ⚠️ 单例是**进程级**的，插件「停用」不应关闭它：关闭会波及其它仍有效的插件，
 * 且缓存仍持有已关闭实例导致后续请求全部失败（"Client was manually closed"）。
 * 因此 close() 会同步把缓存条目删除，使下次 getDbAdapter 重新建连（自愈）。
 */
export function getDbAdapter(opts: DbAdapterOptions = {}): DbAdapter {
  const backend = (opts.backend || process.env.DB_BACKEND || 'sqlite').toLowerCase() as DbBackend;
  // Turso 后端按 TURSO_URL 区分（同一文件可被多个远端库共用），sqlite 按 file 区分。
  const file =
    backend === 'turso'
      ? process.env.TURSO_URL || opts.file || './data/app.db'
      : opts.file || process.env.DB_SQLITE_FILE || './data/app.db';
  const cacheKey = `${backend}:${file}`;

  if (adapterCache.has(cacheKey)) return adapterCache.get(cacheKey)!;

  let adapter: DbAdapter | null = null;

  if (backend === 'turso') {
    const url = process.env.TURSO_URL;
    const token = process.env.TURSO_TOKEN;
    if (url) {
      try {
        adapter = new TursoAdapter(url, token);
        // libsql://、https://、wss:// 均为远端库；仅 file: 前缀是本地文件（libsql 本地模式）。
        const isRemote = /^(libsql|https|wss):\/\//.test(url);
        console.log(`[db-adapter] 后端：Turso (${isRemote ? 'remote' : 'local-file'}) ${isRemote ? url : ''}`);
      } catch (e) {
        console.warn(`[db-adapter] Turso 初始化失败，降级为本地 sqlite：${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      console.warn('[db-adapter] DB_BACKEND=turso 但未设置 TURSO_URL，降级为本地 sqlite');
    }
  }

  // 兜底：sqlite
  if (!adapter) {
    adapter = new SqliteAdapter(file, opts.pragmas);
    console.log(`[db-adapter] 后端：SQLite（本地文件 ${file}）`);
  }

  adapterCache.set(cacheKey, adapter);
  // 兜底（Turso→sqlite 降级）也可能构造 sqlite 实例并自带正确的 cacheKey，
  // 这里再显式对齐，确保 close 时 evict 的是当前缓存键。
  adapter.cacheKey = cacheKey;
  return adapter;
}

/** 测试用：清空缓存，强制重新创建。 */
export function resetDbAdaptersForTest(): void {
  for (const adapter of adapterCache.values()) {
    try { adapter.close?.(); } catch { /* ok */ }
  }
  adapterCache.clear();
}
