import type {
  AgentCard,
  AgentHealth,
  IndustryDomain,
} from './types';

/**
 * 智能体注册表持久化后端（P0.1：Agent Registry & Discovery）。
 *
 * 沿用 `MemoryStore` 的「接口 + 默认实现 + 工厂」范式，把「AgentCard 存在哪」与
 * 「注册表怎么用」解耦。内置四种实现：
 * - VolatileAgentStore：纯内存（默认，无持久化，单进程运行/测试用）
 * - FileAgentStore：每个 agentId 一个 JSON 文件（零依赖，适合单节点落地）
 * - SqliteAgentStore：node:sqlite（零 npm 依赖，Node 22+ 内置，适合多实例/生产）
 * - RedisAgentStore：单 Hash 存全部卡片（多副本共享 + 重启不丢，投产首选；client 由调用方注入）
 *
 * 所有方法均为异步；core 不 import 任何 redis 库，Redis client 经最小契约（AgentStoreRedis）注入。
 */
export interface AgentStore {
  /** 后端类型，用于探测与运维视图。 */
  readonly kind: 'volatile' | 'file' | 'sqlite' | 'redis';
  register(card: AgentCard): Promise<void>;
  /** 上报心跳（部分字段即可），刷新 lastHeartbeat 并按需覆盖 status/load。 */
  heartbeat(id: string, health: Partial<AgentHealth>): Promise<void>;
  deregister(id: string): Promise<void>;
  get(id: string): Promise<AgentCard | null>;
  list(): Promise<AgentCard[]>;
  query(filter: { domain?: IndustryDomain; capability?: string }): Promise<AgentCard[]>;
}

/**
 * Redis 客户端最小契约（仅 Hash 命令）。真实实现为 ioredis（原生支持这些方法），
 * 测试用 FakeRedis 注入，从而在不依赖真实 Redis 服务的情况下验证后端逻辑。
 *
 * 与 server 的 queue-backend RedisLike 有意保持字段子集一致（同一个 ioredis 实例可同时喂给
 * 队列后端与本 store），core 侧不 import 任何 redis 库 —— 保持「零硬运行时依赖」。
 */
export interface AgentStoreRedis {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  /** 返回该 hash 全部 field→value；空 hash 返回 {}（与 ioredis 行为一致）。 */
  hgetall(key: string): Promise<Record<string, string>>;
}

/** 把任意字符串规整为安全的存储 key，杜绝路径穿越与注入（与 sanitizeKey 同规约）。 */
export function sanitizeAgentKey(raw: string | undefined | null): string {
  if (!raw) return 'unknown';
  const cleaned = String(raw)
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 64);
  return cleaned || 'unknown';
}

/** 纯内存实现：进程内 Map，无持久化。 */
export class VolatileAgentStore implements AgentStore {
  readonly kind = 'volatile' as const;
  private map = new Map<string, AgentCard>();

  async register(card: AgentCard): Promise<void> {
    this.map.set(card.id, card);
  }
  async heartbeat(id: string, health: Partial<AgentHealth>): Promise<void> {
    const c = this.map.get(id);
    if (!c) return;
    c.health = { ...c.health, ...health, lastHeartbeat: Date.now() };
  }
  async deregister(id: string): Promise<void> {
    this.map.delete(id);
  }
  async get(id: string): Promise<AgentCard | null> {
    return this.map.get(id) ?? null;
  }
  async list(): Promise<AgentCard[]> {
    return [...this.map.values()];
  }
  async query(filter: { domain?: IndustryDomain; capability?: string }): Promise<AgentCard[]> {
    return (await this.list()).filter((c) => {
      if (filter.domain && c.domain !== filter.domain) return false;
      if (filter.capability && !c.capabilities.some((cap) => cap.id === filter.capability)) return false;
      return true;
    });
  }
}

/** 文件实现：每个 agentId 一个 JSON 文件，落盘用原子 rename 防半截写。 */
export class FileAgentStore implements AgentStore {
  readonly kind = 'file' as const;
  private dir: string;

  constructor(opts: { dir: string }) {
    this.dir = opts.dir ?? './data/agents';
  }

  private filePath(id: string): string {
    return `${this.dir}/${sanitizeAgentKey(id)}.json`;
  }

  async register(card: AgentCard): Promise<void> {
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    await fs.mkdir(pathMod.dirname(this.filePath(card.id)), { recursive: true });
    const tmp = `${this.filePath(card.id)}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random()
      .toString(36)
      .slice(2)}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(card), 'utf-8');
      await fs.rename(tmp, this.filePath(card.id));
    } catch (e) {
      try {
        await fs.unlink(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
  async heartbeat(id: string, health: Partial<AgentHealth>): Promise<void> {
    const c = await this.get(id);
    if (!c) return;
    c.health = { ...c.health, ...health, lastHeartbeat: Date.now() };
    await this.register(c);
  }
  async deregister(id: string): Promise<void> {
    const fs = await import('node:fs/promises');
    try {
      await fs.unlink(this.filePath(id));
    } catch {
      /* 不存在即视为已删除 */
    }
  }
  async get(id: string): Promise<AgentCard | null> {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(this.filePath(id), 'utf-8');
      return JSON.parse(raw) as AgentCard;
    } catch {
      return null;
    }
  }
  async list(): Promise<AgentCard[]> {
    const fs = await import('node:fs/promises');
    try {
      const entries = await fs.readdir(this.dir);
      const out: AgentCard[] = [];
      for (const f of entries) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(`${this.dir}/${f}`, 'utf-8');
          out.push(JSON.parse(raw) as AgentCard);
        } catch {
          /* 坏文件跳过 */
        }
      }
      return out;
    } catch {
      return [];
    }
  }
  async query(filter: { domain?: IndustryDomain; capability?: string }): Promise<AgentCard[]> {
    return (await this.list()).filter((c) => {
      if (filter.domain && c.domain !== filter.domain) return false;
      if (filter.capability && !c.capabilities.some((cap) => cap.id === filter.capability)) return false;
      return true;
    });
  }
}

/**
 * SQLite 实现：基于 Node 22+ 内置的 node:sqlite（零 npm 依赖）。
 * 与 SqliteMemoryStore 同理，用动态 import + any 规避老工具链无 node:sqlite 类型的问题，
 * 运行期若不可用则由调用方捕获回退到 FileAgentStore。
 */
export class SqliteAgentStore implements AgentStore {
  readonly kind = 'sqlite' as const;
  private file: string;
  private db: any = null;
  private ready: Promise<void> | null = null;

  constructor(opts: { file: string }) {
    this.file = opts.file;
  }

  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const fs = await import('node:fs/promises');
      const pathMod = await import('node:path');
      await fs.mkdir(pathMod.dirname(this.file), { recursive: true });
      const sqlite = (await import('node:sqlite' as any)) as { DatabaseSync: any };
      this.db = new sqlite.DatabaseSync(this.file);
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS agents (' +
          'id TEXT PRIMARY KEY, ' +
          'domain TEXT NOT NULL, ' +
          'capabilities TEXT NOT NULL, ' +
          'card TEXT NOT NULL, ' +
          'updated_at INTEGER NOT NULL)'
      );
    })();
    return this.ready;
  }

  async register(card: AgentCard): Promise<void> {
    await this.ensure();
    const caps = JSON.stringify(card.capabilities.map((c) => c.id));
    this.db
      .prepare(
        'INSERT OR REPLACE INTO agents (id, domain, capabilities, card, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        card.id,
        String(card.domain),
        caps,
        JSON.stringify(card),
        Date.now()
      );
  }
  async heartbeat(id: string, health: Partial<AgentHealth>): Promise<void> {
    const c = await this.get(id);
    if (!c) return;
    c.health = { ...c.health, ...health, lastHeartbeat: Date.now() };
    await this.register(c);
  }
  async deregister(id: string): Promise<void> {
    await this.ensure();
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }
  async get(id: string): Promise<AgentCard | null> {
    await this.ensure();
    const row = this.db.prepare('SELECT card FROM agents WHERE id = ?').get(id);
    if (!row) return null;
    try {
      return JSON.parse(row.card) as AgentCard;
    } catch {
      return null;
    }
  }
  async list(): Promise<AgentCard[]> {
    await this.ensure();
    const rows = this.db.prepare('SELECT card FROM agents').all() as { card: string }[];
    return rows
      .map((r) => {
        try {
          return JSON.parse(r.card) as AgentCard;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as AgentCard[];
  }
  async query(filter: { domain?: IndustryDomain; capability?: string }): Promise<AgentCard[]> {
    const all = await this.list();
    return all.filter((c) => {
      if (filter.domain && c.domain !== filter.domain) return false;
      if (filter.capability && !c.capabilities.some((cap) => cap.id === filter.capability)) return false;
      return true;
    });
  }
}

/**
 * Redis 实现（P2 投产：多副本共享 + 重启不丢）。
 *
 * 存储模型：单个 Hash key（默认 `agent-harness:agents`）映射 agentId → AgentCard(JSON)。
 * - register/heartbeat = HSET（写穿）；get = HGET；deregister = HDEL；list = HGETALL 全解析。
 * - 与 RedisQueueBackend 共用同一个 ioredis 连接即可（命令互不冲突），也可独立连接。
 * - 所有卡片皆 JSON 可序列化（心跳字段随卡片一同持久化），多实例通过共享 Redis 天然一致。
 *
 * 注意：list/query 走 HGETALL 全量拉取后在内存过滤——注册表规模通常为「数十~数百个 agent」，
 * 全量拉取代价可忽略；若未来 agent 数量爆炸，可加 domain→id 的二级 Set 索引（本骨架未做）。
 */
export class RedisAgentStore implements AgentStore {
  readonly kind = 'redis' as const;
  private client: AgentStoreRedis;
  private hashKey: string;

  constructor(opts: { client: AgentStoreRedis; keyPrefix?: string }) {
    this.client = opts.client;
    this.hashKey = `${opts.keyPrefix ?? 'agent-harness'}:agents`;
  }

  async register(card: AgentCard): Promise<void> {
    await this.client.hset(this.hashKey, card.id, JSON.stringify(card));
  }
  async heartbeat(id: string, health: Partial<AgentHealth>): Promise<void> {
    const c = await this.get(id);
    if (!c) return;
    c.health = { ...c.health, ...health, lastHeartbeat: Date.now() };
    await this.register(c);
  }
  async deregister(id: string): Promise<void> {
    await this.client.hdel(this.hashKey, id);
  }
  async get(id: string): Promise<AgentCard | null> {
    const raw = await this.client.hget(this.hashKey, id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AgentCard;
    } catch {
      return null;
    }
  }
  async list(): Promise<AgentCard[]> {
    const all = await this.client.hgetall(this.hashKey);
    const out: AgentCard[] = [];
    for (const raw of Object.values(all ?? {})) {
      try {
        out.push(JSON.parse(raw) as AgentCard);
      } catch {
        /* 坏记录跳过 */
      }
    }
    return out;
  }
  async query(filter: { domain?: IndustryDomain; capability?: string }): Promise<AgentCard[]> {
    return (await this.list()).filter((c) => {
      if (filter.domain && c.domain !== filter.domain) return false;
      if (filter.capability && !c.capabilities.some((cap) => cap.id === filter.capability)) return false;
      return true;
    });
  }
}

/**
 * 按环境变量选择 AgentStore 后端（与 memory-store 的 MEMORY_BACKEND 同范式）。
 *
 * - `AGENT_STORE=sqlite`（或设了 `AGENT_STORE_SQLITE_FILE`）→ SqliteAgentStore（单机持久化，零 npm 依赖）。
 * - `AGENT_STORE=file`（或设了 `AGENT_STORE_DIR`）→ FileAgentStore（单机持久化，每 agent 一个 JSON）。
 * - `AGENT_STORE=redis` → 需调用方经 `redis` 注入 client（core 不 import ioredis）；未注入则回退 volatile。
 * - 缺省 / 无法识别 → VolatileAgentStore（内存态，重启即丢，仅单进程/测试）。
 *
 * redis 分支由 server 侧负责构造 ioredis 并传入（见 access/server/src/server.ts 启动引导）。
 */
export function createAgentStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  redis?: AgentStoreRedis | null
): AgentStore {
  const kind = (env.AGENT_STORE || '').toLowerCase();
  if (kind === 'redis' || (kind !== 'file' && kind !== 'sqlite' && kind !== 'volatile' && redis)) {
    if (redis) return new RedisAgentStore({ client: redis, keyPrefix: env.AGENT_STORE_REDIS_PREFIX });
    // 声明了 redis 却没注入 client：降级 volatile 并由调用方打印告警（保持「一切降级可用」）。
    return new VolatileAgentStore();
  }
  if (kind === 'sqlite' || env.AGENT_STORE_SQLITE_FILE) {
    return new SqliteAgentStore({ file: env.AGENT_STORE_SQLITE_FILE || './data/agents/agents.sqlite' });
  }
  if (kind === 'file' || env.AGENT_STORE_DIR) {
    return new FileAgentStore({ dir: env.AGENT_STORE_DIR || './data/agents' });
  }
  return new VolatileAgentStore();
}
