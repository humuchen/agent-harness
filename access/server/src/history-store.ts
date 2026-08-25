/**
 * 聊天历史镜像存储（ah_chat_history 迁移的接口层）。
 *
 * 设计：
 * - `ChatHistoryStore` 是唯一存取契约（增删改查），前端所有读写经 /api/history* 路由
 *   打到该接口，不再直接依赖 localStorage；
 * - 当前以 SQLite（Node 22+ 内置 node:sqlite，零 npm 依赖）作为临时持久化方案；
 *   后续切换正式数据库时只需新增一个实现并在 createHistoryStore 工厂中替换，
 *   接口与调用方零改动；
 * - node:sqlite 运行期不可用（老版本 Node）时自动降级为进程内存实现，
 *   保证服务可启动、功能可用（仅失去跨重启持久化）。
 *
 * 环境变量：
 * - HISTORY_BACKEND: 'sqlite'（默认）| 'memory'
 * - HISTORY_DB_FILE: SQLite 文件路径（默认 <cwd>/data/chat-history.db）
 */

export interface HistoryThreadMeta {
  sid: string;
  title: string;
  /** 会话最近更新时间（毫秒），由客户端随写入上报。 */
  updatedAt: number;
  /** 镜像落盘时间（毫秒）。 */
  savedAt: number;
}

/** 聊天历史存取契约（增删改查）。data 为调用方序列化好的信封 JSON 字符串。 */
export interface ChatHistoryStore {
  /** 写入 / 覆盖某会话的历史镜像（幂等 upsert）。 */
  upsert(meta: HistoryThreadMeta, data: string): void;
  /** 读取某会话镜像；不存在返回 null。 */
  get(sid: string): { meta: HistoryThreadMeta; data: string } | null;
  /** 删除某会话镜像；返回是否确有删除。 */
  remove(sid: string): boolean;
  /** 列出全部会话元信息（按 savedAt 倒序）。 */
  index(): HistoryThreadMeta[];
}

/* ------------------------------ 内存实现 ------------------------------ */

class MemoryHistoryStore implements ChatHistoryStore {
  private rows = new Map<string, { meta: HistoryThreadMeta; data: string }>();

  upsert(meta: HistoryThreadMeta, data: string): void {
    this.rows.set(meta.sid, { meta: { ...meta }, data });
  }
  get(sid: string) {
    const r = this.rows.get(sid);
    return r ? { meta: { ...r.meta }, data: r.data } : null;
  }
  remove(sid: string): boolean {
    return this.rows.delete(sid);
  }
  index(): HistoryThreadMeta[] {
    return [...this.rows.values()]
      .map((r) => ({ ...r.meta }))
      .sort((a, b) => b.savedAt - a.savedAt);
  }
}

/* ----------------------------- SQLite 实现 ---------------------------- */

class SqliteHistoryStore implements ChatHistoryStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(file: string) {
    // 兼容说明：部分 @types/node 版本无 node:sqlite 类型，动态加载并视为 any
    // （与 backend/core/src/memory-store.ts 同一约定）。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqlite = require('node:sqlite') as { DatabaseSync: any };
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_history (
        sid        TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        saved_at   INTEGER NOT NULL,
        data       TEXT NOT NULL
      );
    `);
  }

  upsert(meta: HistoryThreadMeta, data: string): void {
    this.db
      .prepare(
        `INSERT INTO chat_history (sid, title, updated_at, saved_at, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET
           title = excluded.title,
           updated_at = excluded.updated_at,
           saved_at = excluded.saved_at,
           data = excluded.data`
      )
      .run(meta.sid, meta.title, meta.updatedAt, meta.savedAt, data);
  }

  get(sid: string): { meta: HistoryThreadMeta; data: string } | null {
    const row = this.db
      .prepare(
        `SELECT sid, title, updated_at, saved_at, data
         FROM chat_history WHERE sid = ?`
      )
      .get(sid);
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

  remove(sid: string): boolean {
    const r = this.db.prepare(`DELETE FROM chat_history WHERE sid = ?`).run(sid);
    return Number(r?.changes ?? 0) > 0;
  }

  index(): HistoryThreadMeta[] {
    const rows = this.db
      .prepare(
        `SELECT sid, title, updated_at, saved_at FROM chat_history ORDER BY saved_at DESC`
      )
      .all();
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
