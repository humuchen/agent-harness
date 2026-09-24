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

// ─── 运行期 failover 代理（Turso → 本地 sqlite）────────────────────────────

/** 连接类错误判定：只有这类错误才触发降级（SQL 语法/约束等语义错误 failover 救不了，原样抛）。 */
function isConnectionError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e ?? '');
  return /fetch failed|network|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|ENOTFOUND|socket.*(hang|closed)|unreachable|refused|HTTP 5\d\d|HTTP 429|timed?\s*out|aborted/i.test(
    msg
  );
}

/**
 * Turso 运行期 failover 代理（②）：远端故障时自动切本地 sqlite 兜底，探活恢复后切回。
 *
 * 状态机（自持，不依赖外部熔断器——需区分「连接错误计数」与「语义错误直抛」）：
 *   healthy → 连接类错误累计 2 次 → degraded（窗口 15s 内全部走本地）
 *           → 窗口过期后下一个操作试探远端（probe）：成功则恢复 healthy，失败则续窗。
 *
 * 数据一致性（明确取舍）：降级窗口内的写入落在本地库，**不自动回放**——回放需要
 * 幂等键与冲突消解，复杂度失控。窗口期以 structLog + 计数器明确告警「写操作需人工对账」；
 * probe 成功恢复时同样留痕。本地兜底文件独立于远端库（缓存键含 localFile，互不串库）。
 * （导出仅供测试：窗口/阈值在测试中收缩以验证状态机。）
 */
export class FailoverProxyAdapter implements DbAdapter {
  private primary: DbAdapter;
  private fallback: DbAdapter;
  private label: string;
  /** 连接类失败计数（healthy 态累计，达阈值进入 degraded）。 */
  private fails = 0;
  private degradedUntil = 0;
  private degradedLogged = false;
  /** 降级阈值 / 探活窗口（静态可变，仅供测试收缩时序）。 */
  static DEGRADE_THRESHOLD = 2;
  static PROBE_WINDOW_MS = 15_000;
  cacheKey: string;

  constructor(primary: DbAdapter, fallback: DbAdapter, opts: { cacheKey: string; label: string }) {
    this.primary = primary;
    this.fallback = fallback;
    this.cacheKey = opts.cacheKey;
    this.label = opts.label;
  }

  private degraded(): boolean {
    return Date.now() < this.degradedUntil;
  }

  private markDegraded(): void {
    this.fails += 1;
    if (this.fails >= FailoverProxyAdapter.DEGRADE_THRESHOLD) {
      this.degradedUntil = Date.now() + FailoverProxyAdapter.PROBE_WINDOW_MS;
      if (!this.degradedLogged) {
        this.degradedLogged = true;
        console.warn(
          `[db-adapter] ${this.label}: 远端连接故障，降级本地 sqlite 兜底 ` +
            `（${FailoverProxyAdapter.PROBE_WINDOW_MS / 1000}s 窗口，窗口内写操作需人工对账）；将自动探活恢复`
        );
      }
    }
  }

  private recover(): void {
    if (this.degradedLogged) {
      this.degradedLogged = false;
      console.log(`[db-adapter] ${this.label}: 远端探活恢复，切回远端库`);
    }
    this.fails = 0;
    this.degradedUntil = 0;
  }

  /**
   * 统一远端调用：healthy 直连（同步结果原样返回，Promise 挂 rejected 处理）；
   * 连接类错误计数/降级后走本地兜底；语义错误原样抛（不污染状态机）。
   */
  private viaRemote<R>(remote: () => R, local: () => R): R {
    if (this.degraded()) {
      // 探活窗口过期：本操作先试远端（probe）
      if (Date.now() >= this.degradedUntil && this.degradedUntil !== 0) {
        try {
          const r = remote();
          this.recover();
          if (r && typeof (r as unknown as Promise<unknown>).then === 'function') {
            return (r as unknown as Promise<unknown>).then(undefined, (e: unknown) =>
              this.onRemoteError(e, local)
            ) as R;
          }
          return r;
        } catch (e) {
          return this.onRemoteError(e, local);
        }
      }
      return local();
    }
    try {
      const r = remote();
      if (r && typeof (r as unknown as Promise<unknown>).then === 'function') {
        return (r as unknown as Promise<unknown>).then(undefined, (e: unknown) =>
          this.onRemoteError(e, local)
        ) as R;
      }
      this.fails = 0;
      return r;
    } catch (e) {
      return this.onRemoteError(e, local);
    }
  }

  private onRemoteError<R>(e: unknown, local: () => R): R {
    if (!isConnectionError(e)) throw e; // 语义错误原样抛，不触发降级
    this.markDegraded();
    return local();
  }

  exec(sql: string): void | Promise<void> {
    return this.viaRemote(
      () => this.primary.exec(sql),
      () => this.fallback.exec(sql)
    );
  }

  prepare(sql: string): DbStatement {
    // 语句级代理：每个操作的远端/本地路径独立判定（prepare 本身不触发 IO）。
    const run = (...params: unknown[]) =>
      this.viaRemote(
        () => this.primary.prepare(sql).run(...params),
        () => this.fallback.prepare(sql).run(...params)
      );
    const get = (...params: unknown[]) =>
      this.viaRemote(
        () => this.primary.prepare(sql).get(...params),
        () => this.fallback.prepare(sql).get(...params)
      );
    const all = (...params: unknown[]) =>
      this.viaRemote(
        () => this.primary.prepare(sql).all(...params),
        () => this.fallback.prepare(sql).all(...params)
      );
    return { run, get, all };
  }

  close(): void {
    try { this.primary.close?.(); } catch { /* ok */ }
    try { this.fallback.close?.(); } catch { /* ok */ }
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
  // 本地 sqlite 文件路径：与 TURSO_URL 严格分离——降级时绝不把远程 URL 当本地文件名
  // 开库（此前 file 回退取 TURSO_URL，libsql 缺依赖降级后会产生名为 "libsql://xxx"
  // 的垃圾本地文件）。turso 仅 file: 前缀是本地模式，其余均为远端。
  const localFile = opts.file || process.env.DB_SQLITE_FILE || './data/app.db';
  const tursoUrl = process.env.TURSO_URL;
  const file = backend === 'turso' ? tursoUrl || localFile : localFile;
  // 缓存键必须唯一标识底层库：降级实例是「本地 localFile 的 sqlite」而非「TURSO_URL
  // 指向的远端库」，且不同调用方（不同 opts.file）必须拿到各自独立的实例——
  // 此前降级实例统一挂在 turso:<url> 键下，第二个调用方会复用第一个调用方的文件
  // 句柄，造成跨 store 数据串库。键中并入 localFile 后，同 (url, file) 组合仍单例。
  const cacheKey =
    backend === 'turso' ? `turso:${tursoUrl ?? ''}:${localFile}` : `sqlite:${localFile}`;

  if (adapterCache.has(cacheKey)) return adapterCache.get(cacheKey)!;

  let adapter: DbAdapter | null = null;

  if (backend === 'turso') {
    const token = process.env.TURSO_TOKEN;
    if (tursoUrl) {
      try {
        const tursoAdapter = new TursoAdapter(tursoUrl, token);
        // libsql://、https://、wss:// 均为远端库；仅 file: 前缀是本地文件（libsql 本地模式）。
        const isRemote = /^(libsql|https|wss):\/\//.test(tursoUrl);
        console.log(`[db-adapter] 后端：Turso (${isRemote ? 'remote' : 'local-file'}) ${isRemote ? tursoUrl : ''}`);
        // ② 运行期 failover（opt-in）：DB_FAILOVER_LOCAL=on 时远端连接故障自动切
        // 本地 sqlite 兜底（探活自动恢复；降级窗口写操作需人工对账，见类注释）。
        if (isRemote && (process.env.DB_FAILOVER_LOCAL || '').toLowerCase() === 'on') {
          const fallback = new SqliteAdapter(localFile, opts.pragmas);
          adapter = new FailoverProxyAdapter(tursoAdapter, fallback, {
            cacheKey,
            label: `Turso→sqlite(${localFile})`
          });
        } else {
          adapter = tursoAdapter;
        }
      } catch (e) {
        console.warn(`[db-adapter] Turso 初始化失败，降级为本地 sqlite：${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      console.warn('[db-adapter] DB_BACKEND=turso 但未设置 TURSO_URL，降级为本地 sqlite');
    }
  }

  // 兜底：sqlite（用 localFile——远程 URL 绝不能当本地路径）
  if (!adapter) {
    adapter = new SqliteAdapter(localFile, opts.pragmas);
    console.log(`[db-adapter] 后端：SQLite（本地文件 ${localFile}）`);
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
