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

export interface DbStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface DbAdapter {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close?(): void;
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

class SqliteAdapter implements DbAdapter {
  private db: any;
  private file: string;

  constructor(file: string, pragmas?: DbAdapterOptions['pragmas']) {
    const fs = require('node:fs');
    const path = require('node:path');
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sqlite = require('node:sqlite') as { DatabaseSync: any };
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
  }
}

// ─── Turso 后端（@libsql/client/node）──────────────────────────────────────

class TursoAdapter implements DbAdapter {
  private client: any;

  constructor(url: string, token?: string) {
    try {
      // @libsql/client/node 提供同步 API，接口风格与 node:sqlite 类似
      const { Client } = require('@libsql/client/node') as { Client: any };
      this.client = new Client({ url, authToken: token });
    } catch (e: any) {
      throw new Error(
        `Turso 后端初始化失败（缺少依赖或配置错误）：${e.message}。请执行 pnpm add @libsql/client`
      );
    }
  }

  exec(sql: string): void {
    // libsql client 支持 execute（单条）和 batch
    this.client.execute(sql);
  }

  prepare(sql: string): DbStatement {
    return {
      run: (...params: unknown[]) => {
        const r = this.client.execute({ sql, args: params as any });
        return {
          changes: r.rowsAffected ?? 0,
          lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : 0,
        };
      },
      get: (...params: unknown[]) => {
        const r = this.client.execute({ sql, args: params as any });
        return r.rows?.[0] as Record<string, unknown> | undefined;
      },
      all: (...params: unknown[]) => {
        const r = this.client.execute({ sql, args: params as any });
        return r.rows as Record<string, unknown>[] ?? [];
      },
    };
  }

  close(): void {
    try { this.client.close(); } catch { /* ok */ }
  }
}

// ─── 单例管理 ────────────────────────────────────────────────────────────────

const adapterCache = new Map<string, DbAdapter>();

/**
 * 获取（或创建）数据库适配器。
 *
 * 同一 file 配置返回同一实例（单例）；不同 file 各自独立连接。
 * 自动回退：若环境指定 turso 但初始化失败，降级为本地 sqlite。
 */
export function getDbAdapter(opts: DbAdapterOptions = {}): DbAdapter {
  const backend = (opts.backend || process.env.DB_BACKEND || 'sqlite').toLowerCase() as DbBackend;
  const file = opts.file || process.env.DB_SQLITE_FILE || './data/app.db';
  const cacheKey = `${backend}:${file}`;

  if (adapterCache.has(cacheKey)) return adapterCache.get(cacheKey)!;

  let adapter: DbAdapter | null = null;

  if (backend === 'turso') {
    const url = process.env.TURSO_URL;
    const token = process.env.TURSO_TOKEN;
    if (url) {
      try {
        adapter = new TursoAdapter(url, token);
        console.log(`[db-adapter] 后端：Turso (${url.startsWith('libsql:') ? 'local' : 'remote'})`);
      } catch (e: any) {
        console.warn(`[db-adapter] Turso 初始化失败，降级为本地 sqlite：${e.message}`);
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
  return adapter;
}

/** 测试用：清空缓存，强制重新创建。 */
export function resetDbAdaptersForTest(): void {
  for (const adapter of adapterCache.values()) {
    try { adapter.close?.(); } catch { /* ok */ }
  }
  adapterCache.clear();
}
