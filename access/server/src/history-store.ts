/**
 * 聊天历史镜像存储（ah_chat_history 迁移的接口层）。
 *
 * 设计：
 * - `ChatHistoryStore` 是唯一存取契约（增删改查），前端所有读写经 /api/history* 路由
 *   打到该接口，不再直接依赖 localStorage；
 * - 当前通过统一 db-adapter（支持 sqlite / turso 双后端）实现持久化；
 *   后续切换正式数据库时只需新增一个实现并在 getHistoryStore 工厂中替换，
 *   接口与调用方零改动；
 * - 数据库运行时不可用时自动降级为进程内存实现，
 *   保证服务可启动、功能可用（仅失去跨重启持久化）。
 *
 * 多用户隔离（P多用户）：每条历史镜像归属一个 owner（= 登录用户名 ctx.sub）。
 * upsert 由服务端以调用方的 ctx.sub 强制写入（忽略客户端上报，防伪造）；
 * get/remove/index 均按 owner 过滤，跨用户不可互见；旧数据无 owner 归 NULL，
 * 普通用户的 owner 过滤天然不命中（= 不可见，不泄露存在性）。
 *
 * 环境变量：
 * - HISTORY_BACKEND: 'sqlite'（默认）| 'memory'（未配置时按 DB_BACKEND 决定）
 * - HISTORY_DB_FILE: SQLite 文件路径（默认 <cwd>/data/chat-history.db）
 * - DB_BACKEND: sqlite | turso（顶层数据库后端切换，优先级高于 HISTORY_BACKEND）
 * - TURSO_URL / TURSO_TOKEN: Turso 连接配置
 */

import { getDbAdapter } from '@agent-harness/core';

export interface HistoryThreadMeta {
  sid: string;
  title: string;
  /** 会话最近更新时间（毫秒），由客户端随写入上报。 */
  updatedAt: number;
  /** 镜像落盘时间（毫秒）。 */
  savedAt: number;
}

/** 聊天历史存取契约（增删改查）。data 为调用方序列化好的信封 JSON 字符串。
 *  所有方法接收 owner 做归属隔离；index/get/remove 传 owner 时只作用该用户。 */
export interface ChatHistoryStore {
  /** 写入 / 覆盖某会话的历史镜像（幂等 upsert），owner 为归属用户（服务端强制）。 */
  upsert(meta: HistoryThreadMeta, data: string, owner: string): void;
  /** 读取某会话镜像；owner 不符或不存在返回 null（不泄露存在性）。 */
  get(sid: string, owner?: string): { meta: HistoryThreadMeta; data: string } | null;
  /** 删除某会话镜像；owner 不符或不存在返回 false。 */
  remove(sid: string, owner?: string): boolean;
  /** 列出会话元信息（按 savedAt 倒序）；owner 指定时只列该用户。 */
  index(owner?: string): HistoryThreadMeta[];
}

/* ------------------------------ 内存实现 ------------------------------ */

class MemoryHistoryStore implements ChatHistoryStore {
  private rows = new Map<
    string,
    { meta: HistoryThreadMeta; data: string; owner: string }
  >();

  upsert(meta: HistoryThreadMeta, data: string, owner: string): void {
    this.rows.set(meta.sid, { meta: { ...meta }, data, owner });
  }
  get(sid: string, owner?: string) {
    const r = this.rows.get(sid);
    if (!r) return null;
    if (owner && r.owner !== owner) return null;
    return { meta: { ...r.meta }, data: r.data };
  }
  remove(sid: string, owner?: string): boolean {
    const r = this.rows.get(sid);
    if (!r) return false;
    if (owner && r.owner !== owner) return false;
    return this.rows.delete(sid);
  }
  index(owner?: string): HistoryThreadMeta[] {
    const all = [...this.rows.values()];
    const filtered = owner ? all.filter((r) => r.owner === owner) : all;
    return filtered
      .map((r) => ({ ...r.meta }))
      .sort((a, b) => b.savedAt - a.savedAt);
  }
}

/* ----------------------------- SQLite 实现 ---------------------------- */

class SqliteHistoryStore implements ChatHistoryStore {
  private db: any;

  constructor(file: string) {
    // 使用统一适配器（支持 sqlite / turso 双后端）
    this.db = getDbAdapter({ file });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_history (
        sid        TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        saved_at   INTEGER NOT NULL,
        data       TEXT NOT NULL,
        owner      TEXT NOT NULL DEFAULT ''
      );
    `);
    // 旧库兼容：补 owner 列（列已存在则跳过；Turso 不支持重复 ADD COLUMN）。
    try {
      const cols = this.db.prepare('PRAGMA table_info(chat_history)').all() as Record<string, unknown>[];
      const hasOwner = cols.some((c) => String(c.name) === 'owner');
      if (!hasOwner) {
        this.db.exec(`ALTER TABLE chat_history ADD COLUMN owner TEXT NOT NULL DEFAULT ''`);
      }
    } catch {
      /* 列已存在或 Turso 不支持该 DDL，忽略 */
    }
  }

  upsert(meta: HistoryThreadMeta, data: string, owner: string): void {
    this.db
      .prepare(
        `INSERT INTO chat_history (sid, title, updated_at, saved_at, data, owner)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET
           title = excluded.title,
           updated_at = excluded.updated_at,
           saved_at = excluded.saved_at,
           data = excluded.data,
           owner = excluded.owner`
      )
      .run(meta.sid, meta.title, meta.updatedAt, meta.savedAt, data, owner);
  }

  get(sid: string, owner?: string): { meta: HistoryThreadMeta; data: string } | null {
    const sql =
      owner !== undefined
        ? `SELECT sid, title, updated_at, saved_at, data FROM chat_history WHERE sid = ? AND owner = ?`
        : `SELECT sid, title, updated_at, saved_at, data FROM chat_history WHERE sid = ?`;
    const row = owner !== undefined
      ? this.db.prepare(sql).get(sid, owner)
      : this.db.prepare(sql).get(sid);
    if (!row) return null;
    return {
      meta: {
        sid: String(row.sid),
        title: String(row.title),
        updatedAt: Number(row.updated_at),
        savedAt: Number(row.saved_at)
      },
      data: String(row.data)
    };
  }

  remove(sid: string, owner?: string): boolean {
    const r =
      owner !== undefined
        ? this.db.prepare(`DELETE FROM chat_history WHERE sid = ? AND owner = ?`).run(sid, owner)
        : this.db.prepare(`DELETE FROM chat_history WHERE sid = ?`).run(sid);
    return Number(r?.changes ?? 0) > 0;
  }

  index(owner?: string): HistoryThreadMeta[] {
    const sql =
      owner !== undefined
        ? `SELECT sid, title, updated_at, saved_at FROM chat_history WHERE owner = ? ORDER BY saved_at DESC`
        : `SELECT sid, title, updated_at, saved_at FROM chat_history ORDER BY saved_at DESC`;
    const rows = owner !== undefined ? this.db.prepare(sql).all(owner) : this.db.prepare(sql).all();
    return (rows ?? []).map((row: any) => ({
      sid: String(row.sid),
      title: String(row.title),
      updatedAt: Number(row.updated_at),
      savedAt: Number(row.saved_at)
    }));
  }
}

let singleton: ChatHistoryStore | null = null;

/** 取进程级单例存储；按 HISTORY_BACKEND 选择实现，sqlite 初始化失败自动回退内存。 */
export function getHistoryStore(): ChatHistoryStore {
  if (singleton) return singleton;
  const backend = (process.env.HISTORY_BACKEND || 'sqlite').toLowerCase();
  if (backend === 'memory') {
    singleton = new MemoryHistoryStore();
    return singleton;
  }
  try {
    const file =
      process.env.HISTORY_DB_FILE ||
      require('node:path').join(process.cwd(), 'data', 'chat-history.db');
    singleton = new SqliteHistoryStore(file);
  } catch (err) {
    // node:sqlite 不可用 / 文件无法创建：降级为内存实现，服务不因存储层不可用而拒启。
    console.warn(
      '[history-store] SQLite 不可用，降级为内存存储：',
      err instanceof Error ? err.message : err
    );
    singleton = new MemoryHistoryStore();
  }
  return singleton;
}

/** 测试用：重置单例（切换后端 / 清理临时库）。 */
export function resetHistoryStoreForTest(): void {
  singleton = null;
}
