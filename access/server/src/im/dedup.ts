/**
 * IM 消息去重（可插拔：进程内 LRU / Redis 跨实例）。
 *
 * 为什么需要：IM 平台在未及时收到 200 时会**重复推送**同一事件（at-least-once 语义），
 * 若不拦截会导致同一句话被 agent 处理多次（重复计费 + 重复回复）。
 *
 * 两档实现（与 run-queue / chat-bus 同款「接口 + 默认实现 + 组合工厂」范式）：
 * - `MemoryDedupStore`（默认）：进程内 LRU，零依赖。覆盖单实例部署的绝大多数重推。
 * - `RedisDedupStore`：`SET key 1 NX EX <ttl>` 原子占位，**跨实例**去重。多副本部署时
 *   同一消息即便被负载均衡打到不同副本，也只有第一个副本能占位成功、其余副本丢弃。
 *
 * 降级策略：Redis 不可用（未配 / 连接失败 / 命令异常）时一律**放行**（返回 true），
 * 宁可重复处理也不阻断业务——去重是优化，不是正确性前提。
 */

/** 去重存储契约（异步，兼容本地与跨实例实现）。 */
export interface DedupStore {
  readonly kind: 'memory' | 'redis';
  /** 首次见到返回 true（应处理）；重复返回 false（应丢弃）。 */
  check(key: string): Promise<boolean>;
  /** 当前记录数（可观测）；Redis 实现返回 -1（分布式计数不可知）。 */
  size(): number;
}

/** 默认容量：按「峰值 20 msg/s × 5 分钟」估算，足以覆盖任何平台的重推窗口。 */
const DEFAULT_CAPACITY = 5000;
/** 默认 Redis 去重键 TTL（秒）：覆盖平台重推窗口即可，过长会白占内存。 */
const DEFAULT_TTL_SEC = 300;
const DEFAULT_PREFIX = 'im:dedup:';

/**
 * 进程内 LRU 去重（单实例默认）。
 * 保留原有同步 `check()` 语义，供 `MessageDeduper` 直接复用。
 */
export class MessageDeduper {
  private readonly capacity: number;
  /** 用 Map 的插入序实现 LRU：命中时 delete + set 移到队尾。 */
  private readonly seen = new Map<string, number>();

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity > 0 ? capacity : DEFAULT_CAPACITY;
  }

  /**
   * 标记并检查：首次见到返回 true（应处理），重复返回 false（应丢弃）。
   * 副作用：命中或插入都会把该 key 刷新为「最近使用」。
   */
  check(key: string): boolean {
    if (!key) return true; // 无 id 的消息不去重（由 bridge 侧合成兜底 key）
    const hit = this.seen.has(key);
    if (hit) {
      // 刷新为最近使用（LRU 语义）。
      this.seen.delete(key);
      this.seen.set(key, Date.now());
      return false;
    }
    this.seen.set(key, Date.now());
    if (this.seen.size > this.capacity) {
      // 淘汰最旧一条（Map 迭代顺序即插入序）。
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  /** 当前记录条数（可观测 / 测试用）。 */
  size(): number {
    return this.seen.size;
  }
}

/** 内存去重存储（实现异步契约，内部委托 `MessageDeduper`）。 */
export class MemoryDedupStore implements DedupStore {
  readonly kind = 'memory' as const;
  private readonly inner: MessageDeduper;

  constructor(capacity?: number) {
    this.inner = new MessageDeduper(capacity);
  }

  async check(key: string): Promise<boolean> {
    return this.inner.check(key);
  }

  size(): number {
    return this.inner.size();
  }
}

/**
 * Redis 去重存储（跨实例）。
 *
 * 用 `SET <prefix><key> 1 EX <ttl> NX` 做原子占位：
 * - 返回 `OK` → 本实例首次见到该消息，应处理；
 * - 返回 `null` → 键已存在（同实例或**其它实例**已处理），应丢弃。
 *
 * 该命令在 Redis 单线程模型下天然原子，无需分布式锁。
 */
export class RedisDedupStore implements DedupStore {
  readonly kind = 'redis' as const;
  private readonly ttlSec: number;
  private readonly prefix: string;
  /** 本实例成功占位计数（仅用于观测，非全局值）。 */
  private localHits = 0;

  constructor(opts: { ttlSec?: number; prefix?: string } = {}) {
    this.ttlSec = opts.ttlSec && opts.ttlSec > 0 ? opts.ttlSec : DEFAULT_TTL_SEC;
    this.prefix = opts.prefix ?? DEFAULT_PREFIX;
  }

  async check(key: string): Promise<boolean> {
    if (!key) return true;
    // 延迟 require：避免在无 Redis 场景下也加载 ioredis（保持「一切降级可用」）。
    let client: { set(...args: unknown[]): Promise<unknown> } | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('../redis-client') as typeof import('../redis-client');
      client = mod.getRedisClient();
    } catch {
      return true; // redis-client 不可加载 → 放行
    }
    if (!client) return true; // 未配置 REDIS_URL → 放行
    try {
      const res = await client.set(this.prefix + key, '1', 'EX', this.ttlSec, 'NX');
      if (res === 'OK') {
        this.localHits++;
        return true;
      }
      return false;
    } catch {
      // 命令异常（连接抖动等）→ 放行，不阻断业务。
      return true;
    }
  }

  /** Redis 为分布式存储，全局计数不可知；返回本实例占位数供参考。 */
  size(): number {
    return this.localHits;
  }
}

/**
 * 组合工厂：按环境变量选择去重后端。
 * - `REDIS_URL` 已配置 或 `IM_DEDUP_BACKEND=redis` → RedisDedupStore（跨实例）
 * - 其余 / 未设置                                  → MemoryDedupStore（默认，零行为变更）
 */
export function createDedupStore(env: NodeJS.ProcessEnv = process.env): DedupStore {
  const explicit = (env.IM_DEDUP_BACKEND ?? '').toLowerCase();
  const useRedis = explicit === 'redis' || (explicit !== 'memory' && Boolean(env.REDIS_URL));
  if (!useRedis) return new MemoryDedupStore();
  const ttl = Number(env.IM_DEDUP_TTL_SEC);
  return new RedisDedupStore({ ttlSec: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : undefined });
}
