import { Message } from './types';
import {
  getDbAdapter,
  DbAdapter,
} from './db-adapter';

/**
 * 持久化记忆的数据形态：对话滚动窗口 + 长期笔记。
 * 这是「存储后端」与「Memory 运行时」之间的契约，与具体后端无关。
 */
export interface PersistedMemory {
  window: Message[];
  longTerm: string[];
  // 上下文压缩产生的摘要（可选）。启用 summarizer 后，被滑动窗口淘汰的旧轮次
  // 会被压缩成一条 system 摘要固定保留，此处持久化该摘要以便跨运行恢复。
  summary?: string;
}

/**
 * 记忆存储后端抽象（P1-9：多租户 / DB 化）。
 *
 * 设计目标：把「记忆存在哪」与「记忆怎么用」彻底解耦。Memory 运行时只认
 * `key`（租户/会话标识），后端负责按 key 读写。内置三种实现：
 * - VolatileMemoryStore：纯内存（默认，无持久化，用于本地/Mock/无状态场景）
 * - FileMemoryStore：JSON 文件目录（零依赖，按 key 分桶，适合单节点落地）
 * - SqliteMemoryStore：node:sqlite（零 npm 依赖，Node 22+ 内置，适合多租户生产）
 *
 * 所有方法均为异步，新接入 Redis/Postgres 等只需实现本接口并替换 Memory 的 store。
 */
export interface MemoryStore {
  /** 后端类型，用于探测（hasPersistence）与运维视图。 */
  readonly kind: 'volatile' | 'file' | 'sqlite';
  /** 按 key 载入记忆；不存在返回 null。 */
  load(key: string): Promise<PersistedMemory | null>;
  /** 按 key 落盘记忆（幂等覆盖）。 */
  save(key: string, data: PersistedMemory): Promise<void>;
  /** 按 key 删除记忆。 */
  delete(key: string): Promise<void>;
  /** 列出所有已存在的 key（运维/多租户视图）。 */
  list(): Promise<string[]>;
}

/** 把任意字符串规整为安全的存储 key，杜绝路径穿越与注入。 */
export function sanitizeKey(raw: string | undefined | null): string {
  if (!raw) return 'anonymous';
  const cleaned = String(raw)
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 64);
  return cleaned || 'anonymous';
}

/** 纯内存实现：进程内 Map，无持久化。hasPersistence 视为 false。 */
export class VolatileMemoryStore implements MemoryStore {
  readonly kind = 'volatile' as const;
  private map = new Map<string, PersistedMemory>();

  async load(key: string): Promise<PersistedMemory | null> {
    return this.map.get(key) ?? null;
  }
  async save(key: string, data: PersistedMemory): Promise<void> {
    this.map.set(key, data);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

/**
 * 文件实现：每个 key 一个 JSON 文件。
 * - 提供 `dir`：多租户模式，文件落在 `<dir>/<key>.json`（推荐）。
 * - 提供 `path`（旧单文件模式，向后兼容）：仅支持 key='' 的单一会话，
 *   行为与旧版 persistencePath 完全一致。
 */
export class FileMemoryStore implements MemoryStore {
  readonly kind = 'file' as const;
  private dir?: string;
  private legacyPath?: string;

  constructor(opts: { dir?: string; path?: string }) {
    if (opts.path) {
      this.legacyPath = opts.path;
    } else {
      this.dir = opts.dir ?? './data/memory';
    }
  }

  private filePath(key: string): string {
    if (this.legacyPath) return this.legacyPath;
    const safe = sanitizeKey(key);
    return `${this.dir}/${safe}.json`;
  }

  async load(key: string): Promise<PersistedMemory | null> {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(this.filePath(key), 'utf-8');
      const data = JSON.parse(raw) as Partial<PersistedMemory>;
      return {
        window: Array.isArray(data.window) ? (data.window as Message[]) : [],
        longTerm: Array.isArray(data.longTerm) ? (data.longTerm as string[]) : [],
        ...(typeof data.summary === 'string' ? { summary: data.summary } : {}),
      };
    } catch {
      return null; // 无存档，视为空
    }
  }

  async save(key: string, data: PersistedMemory): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = this.filePath(key);
    // 崩溃安全写入：先写临时文件，再在同文件系统内 rename 原子替换目标。
    // 进程在 writeFile/rename 之间崩溃时，旧文件完好、仅残留一个 .tmp，不会丢数据也不会产生半截 JSON。
    const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random()
      .toString(36)
      .slice(2)}`;
    try {
      if (!this.legacyPath) {
        const pathMod = await import('node:path');
        await fs.mkdir(pathMod.dirname(path), { recursive: true });
      }
      await fs.writeFile(tmp, JSON.stringify(data), 'utf-8');
      await fs.rename(tmp, path); // 同 FS 内 rename 不可中断，视为原子操作
    } catch (e) {
      // 清理半成品临时文件，避免残留堆积
      try {
        await fs.unlink(tmp);
      } catch {
        /* 临时文件本就不存在，忽略 */
      }
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const fs = await import('node:fs/promises');
    try {
      await fs.unlink(this.filePath(key));
    } catch {
      /* 文件不存在，忽略 */
    }
  }

  async list(): Promise<string[]> {
    if (this.legacyPath) {
      const fs = await import('node:fs/promises');
      try {
        await fs.access(this.legacyPath);
        return [''];
      } catch {
        return [];
      }
    }
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    try {
      const entries = await fs.readdir(this.dir!);
      return entries
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }
}

/**
 * SQLite 实现：基于 Node 22+ 内置的 node:sqlite（零 npm 依赖）。
 *
 * 兼容说明：@types/node 在部分版本尚无 node:sqlite 类型，因此这里用
 * `import('node:sqlite' as any)` 动态加载并把 DatabaseSync 视为 any，
 * 既能在 Node 20 工具链下编译通过，又能在 Node 22 运行期正常工作。
 * 若运行期 node 不支持 node:sqlite（如老版本），构造/初始化会抛出清晰错误，
 * 调用方应捕获并回退到 FileMemoryStore。
 */
export class SqliteMemoryStore implements MemoryStore {
  readonly kind = 'sqlite' as const;
  private file: string;
  private db: DbAdapter | null = null;
  private ready: Promise<void> | null = null;

  constructor(opts: { file: string }) {
    this.file = opts.file;
  }

  /** 惰性打开连接并建表（仅首次调用时执行）。 */
  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      // 使用统一适配器（支持 sqlite / turso 双后端）
      this.db = getDbAdapter({ file: this.file });
      await this.db.exec(
        'CREATE TABLE IF NOT EXISTS memory (' +
          'key TEXT PRIMARY KEY, ' +
          'window TEXT NOT NULL, ' +
          'long_term TEXT NOT NULL, ' +
          'summary TEXT)'
      );
      // 兼容旧库：缺列时补上（列已存在则跳过；Turso 不支持重复 ADD COLUMN）。
      try {
        const cols = (await this.db.prepare('PRAGMA table_info(memory)').all()) as Record<string, unknown>[];
        const hasSummary = cols.some((c) => String(c.name) === 'summary');
        if (!hasSummary) {
          await this.db.exec('ALTER TABLE memory ADD COLUMN summary TEXT');
        }
      } catch {
        /* 列已存在或 Turso 不支持该 DDL，忽略 */
      }
    })();
    return this.ready;
  }

  async load(key: string): Promise<PersistedMemory | null> {
    await this.ensure();
    const row = await this.db!
      .prepare('SELECT window, long_term, summary FROM memory WHERE key = ?')
      .get(key);
    if (!row) return null;
    const window = safeParseArray<Message>(row.window);
    const longTerm = safeParseArray<string>(row.long_term);
    return {
      window,
      longTerm,
      ...(typeof row.summary === 'string' ? { summary: row.summary } : {}),
    };
  }

  async save(key: string, data: PersistedMemory): Promise<void> {
    await this.ensure();
    await this.db!
      .prepare(
        'INSERT OR REPLACE INTO memory (key, window, long_term, summary) VALUES (?, ?, ?, ?)'
      )
      .run(
        key,
        JSON.stringify(data.window),
        JSON.stringify(data.longTerm),
        typeof data.summary === 'string' ? data.summary : null
      );
  }

  async delete(key: string): Promise<void> {
    await this.ensure();
    await this.db!.prepare('DELETE FROM memory WHERE key = ?').run(key);
  }

  async list(): Promise<string[]> {
    await this.ensure();
    const rows = await this.db!.prepare('SELECT key FROM memory').all() as { key: string }[];
    return rows.map((r) => r.key);
  }
}

function safeParseArray<T>(s: unknown): T[] {
  if (typeof s !== 'string') return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
