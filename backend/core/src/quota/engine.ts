/**
 * 配额 / 计费引擎（P2 生产化）。
 *
 * 提供 per-tenant 的资源配额与成本门禁，使平台「可运营」：
 *   - QPS：令牌桶限流（平滑突发，避免单租户打满全局）。
 *   - 并发：信号量（maxConcurrency），保护 worker 槽位与 LLM 连接池。
 *   - token / cost：滑动窗口累计，可配置硬上限（超出即拒绝，防止预算击穿）。
 *
 * 设计约定（与 policy/tenant 一致）：
 *   - getQuota(tenantId) 在 tenantId 为空 / 无注册时回退 default（默认「不限」，向后兼容）；
 *   - 单副本：状态均为进程内内存态；多副本：经 setRedisBackend 注入 ioredis 客户端，
 *     admit / release / 结算走单条 Lua 脚本原子完成（QPS 令牌桶 + 并发闸 + 窗口用量
 *     检查与扣减一次完成），Redis 故障时自动降级回进程内（fail-open，不阻断业务）；
 *   - admit() 是「预检 + 预留」原子操作：任一维度不通过则整体拒绝且**不消耗**任何配额，
 *     调用方需在执行结束后调用 release() 归还并发额度。
 */

/**
 * Redis 客户端最小契约（仅 eval）。真实实现为 ioredis（原生支持），
 * 与 AgentStoreRedis 同范式：core 不 import 任何 redis 库，client 由调用方注入。
 */
export interface QuotaRedisClient {
  eval(script: string, numKeys: number, ...keysAndArgs: string[]): Promise<unknown>;
}

/** 单租户配额配置（全部字段可选；缺省即「不限」）。 */
export interface TenantQuota {
  /** 每秒最大请求数（令牌桶容量 = qps， refill 速率 = qps/s）。0 / 未设 = 不限。 */
  qps?: number;
  /** 最大并发运行数。未设 = 不限。 */
  maxConcurrency?: number;
  /** 每窗口最大 token 数。未设 = 不限。 */
  maxTokensPerWindow?: number;
  /** 每窗口最大成本（与调用方约定一致的货币单位，如美元）。未设 = 不限。 */
  maxCostPerWindow?: number;
  /** 窗口长度（毫秒），用于 token / cost 统计与滚动。默认 60000。 */
  windowMs?: number;
}

/** 配额准入决策。 */
export interface QuotaDecision {
  allowed: boolean;
  /** 拒绝原因（allowed=false 时）。 */
  reason?: string;
  /** 建议客户端重试等待毫秒（限流时）。 */
  retryAfterMs?: number;
  /**
   * 本次准入的预留量（allowed=true 时）：调用方在结算实际用量时把它传回
   * recordUsage 的第三参，实现「实际替换预留」冲销 —— 否则窗口用量 =
   * 预估值 + 实际值双重累计，系统性虚高并提前触发限额（修复）。
   */
  reservation?: { tokens: number; cost: number };
}

interface Bucket {
  // QPS 令牌桶
  tokens: number;
  lastRefill: number;
  // 并发信号量
  active: number;
  // token / cost 窗口
  windowStart: number;
  tokensUsed: number;
  costUsed: number;
}

function defaultQuota(): TenantQuota {
  return { windowMs: 60000 };
}

/**
 * admit 原子脚本（多副本唯一事实源）。
 * 一次完成：QPS 令牌桶（懒补充）→ 并发闸 → 窗口用量硬上限检查 → 全部通过才扣减。
 * 先全量检查、后统一写入，任一维度拒绝则不改变任何状态（与进程内语义一致）。
 *
 * KEYS[1]=rate hash（tokens,ts）  KEYS[2]=window hash（tokens,cost，key 含窗口序号）
 * KEYS[3]=concurrency counter
 * ARGV[1]=now(ms) ARGV[2]=windowMs ARGV[3]=qps ARGV[4]=maxConcurrency
 * ARGV[5]=maxTokensPerWindow ARGV[6]=maxCostPerWindow
 * ARGV[7]=reqTokens ARGV[8]=reqCost ARGV[9]=hardLimit(0/1) ARGV[10]=windowTtlSec
 * 返回：{1}（允许）| {0, reason, retryAfterMs}（拒绝）。
 */
const REDIS_ADMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local qps = tonumber(ARGV[3]) or 0
local maxConc = tonumber(ARGV[4]) or 0
local maxTokens = tonumber(ARGV[5]) or 0
local maxCost = tonumber(ARGV[6]) or 0
local reqTokens = tonumber(ARGV[7]) or 0
local reqCost = tonumber(ARGV[8]) or 0
local hard = tonumber(ARGV[9]) or 0
local winTtl = tonumber(ARGV[10]) or 120

-- 1) QPS 令牌桶（懒补充：读上次的 tokens/ts，按流逝时间补充）
local newTokens = nil
if qps > 0 then
  local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
  local tokens = tonumber(b[1])
  local ts = tonumber(b[2]) or now
  if tokens == nil then tokens = qps end
  local elapsed = math.max(0, now - ts) / 1000
  tokens = math.min(qps, tokens + elapsed * qps)
  if tokens < 1 then
    local wait = math.ceil(((1 - tokens) / qps) * 1000)
    return {0, 'qps_rate_limit', wait}
  end
  newTokens = tokens - 1
end

-- 2) 并发信号量
local active = tonumber(redis.call('GET', KEYS[3]) or '0')
if maxConc > 0 and active >= maxConc then
  return {0, 'concurrency_limit', 500}
end

-- 3) token / cost 窗口硬上限（固定窗口近似：key 含窗口序号，跨窗口自然滚动）
local usedT = tonumber(redis.call('HGET', KEYS[2], 'tokens') or '0')
local usedC = tonumber(redis.call('HGET', KEYS[2], 'cost') or '0')
if hard == 1 then
  if maxTokens > 0 and usedT + reqTokens > maxTokens then
    return {0, 'token_window_limit', 0}
  end
  if maxCost > 0 and usedC + reqCost > maxCost then
    return {0, 'cost_window_limit', 0}
  end
end

-- 全部通过 → 统一提交
if qps > 0 then
  redis.call('HSET', KEYS[1], 'tokens', newTokens, 'ts', now)
  redis.call('EXPIRE', KEYS[1], 120)
end
if maxConc > 0 then
  redis.call('INCR', KEYS[3])
  -- 泄漏自愈：即使调用方崩溃漏 release，24h 后并发槽自动过期
  redis.call('EXPIRE', KEYS[3], 86400)
end
if reqTokens ~= 0 or reqCost ~= 0 then
  redis.call('HINCRBYFLOAT', KEYS[2], 'tokens', reqTokens)
  redis.call('HINCRBYFLOAT', KEYS[2], 'cost', reqCost)
  redis.call('EXPIRE', KEYS[2], winTtl)
end
return {1}
`;

/**
 * 结算脚本：实际用量冲销预留（同窗口）或累加（跨窗口滚动后）。
 * KEYS[1]=window hash；ARGV[1]=deltaTokens ARGV[2]=deltaCost ARGV[3]=ttlSec。
 * HINCRBYFLOAT 支持负增量，天然实现「实际替换预留」。
 */
const REDIS_SETTLE_SCRIPT = `
local dT = tonumber(ARGV[1]) or 0
local dC = tonumber(ARGV[2]) or 0
if dT ~= 0 or dC ~= 0 then
  redis.call('HINCRBYFLOAT', KEYS[1], 'tokens', dT)
  redis.call('HINCRBYFLOAT', KEYS[1], 'cost', dC)
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]) or 120)
end
return 1
`;

/** release 脚本：并发槽 DECR，floor 0；归零删 key 防永久累积。 */
const REDIS_RELEASE_SCRIPT = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v > 0 then
  local nv = redis.call('DECR', KEYS[1])
  if nv <= 0 then
    redis.call('DEL', KEYS[1])
  end
end
return 1
`;

export class QuotaEngine {
  private defaultQuotaCfg: TenantQuota = defaultQuota();
  private quotas = new Map<string, TenantQuota>();
  private buckets = new Map<string, Bucket>();
  /** DB 租户配置源（可选）：非空时 per-tenant 配额优先从它读（TTL 缓存，同步热路径）。 */
  private tenantStore: { getCached(tenantId: string): TenantQuota | null } | null = null;
  /** Redis 分布式后端（可选）：非空时 admitAsync/releaseAsync/settleUsage 走 Lua 原子脚本。 */
  private redis: QuotaRedisClient | null = null;

  constructor(defaultQuotaCfg?: TenantQuota) {
    if (defaultQuotaCfg) this.defaultQuotaCfg = { ...defaultQuotaCfg };
  }

  /**
   * 注入 DB 租户配置源（server 启动时接 TenantQuotaStore）。
   * 优先级：DB 租户行（仅覆盖显式字段）> 进程内 setQuota > default。
   */
  setTenantStore(store: { getCached(tenantId: string): TenantQuota | null } | null): void {
    this.tenantStore = store;
  }

  /** 注入 Redis 后端（多副本）；传 null 恢复纯进程内。 */
  setRedisBackend(client: QuotaRedisClient | null): void {
    this.redis = client;
  }

  /** 是否启用分布式后端（健康检查 / 运维视图）。 */
  get distributed(): boolean {
    return this.redis !== null;
  }

  /** 设置全局默认配额（未注册租户回退到此）。 */
  setDefault(q: TenantQuota): void {
    this.defaultQuotaCfg = { ...this.defaultQuotaCfg, ...q };
  }

  /** 注册 / 覆盖某租户配额。 */
  setQuota(tenantId: string, q: TenantQuota): void {
    if (!tenantId) return;
    this.quotas.set(tenantId, { ...this.defaultQuotaCfg, ...q });
  }

  /** 读取某租户配额（无注册 / 空 tenantId 回退 default）。 */
  getQuota(tenantId?: string | null): TenantQuota {
    if (!tenantId || tenantId === 'anonymous') return this.defaultQuotaCfg;
    // DB 租户行优先：仅覆盖显式配置的字段，未配置字段继承 default（继承 default 语义）。
    const fromStore = this.tenantStore?.getCached(tenantId);
    if (fromStore) {
      const merged: TenantQuota = { ...this.defaultQuotaCfg };
      if (fromStore.qps !== undefined) merged.qps = fromStore.qps;
      if (fromStore.maxConcurrency !== undefined) merged.maxConcurrency = fromStore.maxConcurrency;
      if (fromStore.maxTokensPerWindow !== undefined) merged.maxTokensPerWindow = fromStore.maxTokensPerWindow;
      if (fromStore.maxCostPerWindow !== undefined) merged.maxCostPerWindow = fromStore.maxCostPerWindow;
      if (fromStore.windowMs !== undefined) merged.windowMs = fromStore.windowMs;
      return merged;
    }
    return this.quotas.get(tenantId) ?? this.defaultQuotaCfg;
  }

  private bucket(tenantId: string): Bucket {
    let b = this.buckets.get(tenantId);
    if (!b) {
      const q = this.getQuota(tenantId);
      const cap = q.qps && q.qps > 0 ? q.qps : 0;
      b = {
        tokens: cap,
        lastRefill: Date.now(),
        active: 0,
        windowStart: Date.now(),
        tokensUsed: 0,
        costUsed: 0,
      };
      this.buckets.set(tenantId, b);
    }
    return b;
  }

  /** 滚动窗口：若距窗口起点已超过 windowMs，则清零 token/cost 累计。 */
  private rollWindow(b: Bucket, windowMs: number, now: number): void {
    if (now - b.windowStart >= windowMs) {
      b.windowStart = now;
      b.tokensUsed = 0;
      b.costUsed = 0;
    }
  }

  /**
   * 预检 + 预留（原子）。任一维度拒绝则整体拒绝且不改变任何配额状态。
   * @param requested 本轮预计消耗的 token / cost（用于硬上限预判；不计费也可只传 0）。
   * @param hardLimit 是否对 token / cost 启用窗口硬上限（true=超出即拒绝）。
   */
  admit(
    tenantId: string,
    requested: { tokens?: number; cost?: number } = {},
    hardLimit = false
  ): QuotaDecision {
    const id = tenantId || 'anonymous';
    const q = this.getQuota(id);
    const b = this.bucket(id);
    const now = Date.now();

    // 1) QPS 令牌桶
    if (q.qps && q.qps > 0) {
      const elapsed = (now - b.lastRefill) / 1000;
      b.tokens = Math.min(q.qps, b.tokens + elapsed * q.qps);
      b.lastRefill = now;
      if (b.tokens < 1) {
        const wait = Math.ceil(((1 - b.tokens) / q.qps) * 1000);
        return { allowed: false, reason: 'qps rate limit exceeded', retryAfterMs: wait };
      }
    }

    // 2) 并发信号量
    if (q.maxConcurrency && q.maxConcurrency > 0 && b.active >= q.maxConcurrency) {
      return { allowed: false, reason: 'concurrency limit exceeded', retryAfterMs: 500 };
    }

    // 3) token / cost 窗口硬上限
    const windowMs = q.windowMs && q.windowMs > 0 ? q.windowMs : 60000;
    this.rollWindow(b, windowMs, now);
    const reqTokens = requested.tokens ?? 0;
    const reqCost = requested.cost ?? 0;
    if (hardLimit) {
      if (q.maxTokensPerWindow && b.tokensUsed + reqTokens > q.maxTokensPerWindow) {
        return { allowed: false, reason: 'token window limit exceeded' };
      }
      if (q.maxCostPerWindow && b.costUsed + reqCost > q.maxCostPerWindow) {
        return { allowed: false, reason: 'cost window limit exceeded' };
      }
    }

    // 全部通过 → 预留
    if (q.qps && q.qps > 0) b.tokens -= 1;
    b.active += 1;
    b.tokensUsed += reqTokens;
    b.costUsed += reqCost;
    return { allowed: true, reservation: { tokens: reqTokens, cost: reqCost } };
  }

  /**
   * admit/release 配对的便捷包装（防泄漏，供未来接线使用）。
   *
   * 执行 fn 前 admit；无论 fn 成功还是抛错，finally 必然 release —— 消除「调用方
   * 忘记配对 release 导致并发槽永久泄漏、并发闸永久拒绝」的风险。fn 结果经
   * `usageOf` 提取实际用量，以「实际替换预留」方式结算窗口累计（预约值被冲销，
   * 不再双重计费）。admit 拒绝时不执行 fn，直接返回 decision。
   */
  async admitAndRun<T>(
    tenantId: string,
    fn: () => Promise<T>,
    opts: {
      /** 本轮预计消耗（用于硬上限预判与预留）。 */
      requested?: { tokens?: number; cost?: number };
      /** 是否启用 token / cost 窗口硬上限。 */
      hardLimit?: boolean;
      /** 从执行结果提取实际用量；不传则不做窗口结算（仅并发/QPS 管控）。 */
      usageOf?: (result: T) => { tokens?: number; cost?: number };
    } = {}
  ): Promise<
    | { ok: true; value: T; decision: QuotaDecision }
    | { ok: false; decision: QuotaDecision; error?: unknown }
  > {
    const decision = this.admit(tenantId, opts.requested, opts.hardLimit);
    if (!decision.allowed) return { ok: false, decision };
    const reservation = decision.reservation;
    try {
      const value = await fn();
      if (opts.usageOf) {
        this.recordUsage(tenantId, opts.usageOf(value), reservation);
      }
      return { ok: true, value, decision };
    } catch (e) {
      // fn 抛错同样不向上穿透：统一以 ok:false 返回（error 字段携带原始异常），
      // finally 保证并发槽必然归还 —— 调用方无需再包 try/catch。
      return { ok: false, decision, error: e };
    } finally {
      this.release(tenantId);
    }
  }

  /** 执行结束后归还并发额度（与 admit 配对）。 */
  release(tenantId: string): void {
    const id = tenantId || 'anonymous';
    const b = this.buckets.get(id);
    if (b && b.active > 0) b.active -= 1;
  }

  // ---------------------------------------------------------------------------
  // 分布式路径（多副本）：Redis Lua 原子脚本为唯一事实源；Redis 故障降级进程内。
  // ---------------------------------------------------------------------------

  /** 组 Redis key（固定前缀，tenantId 已由调用方规整）。 */
  private redisKeys(id: string, windowMs: number, now: number): { rateKey: string; winKey: string; concKey: string; ttlSec: number } {
    const winIdx = Math.floor(now / windowMs);
    return {
      rateKey: `ah:quota:r:${id}`,
      winKey: `ah:quota:w:${id}:${winIdx}`,
      concKey: `ah:quota:c:${id}`,
      ttlSec: Math.max(2, Math.ceil((windowMs * 2) / 1000)),
    };
  }

  /** Redis admit：返回 undefined 表示脚本层拒绝之外的情况由调用方兜底。 */
  private async admitViaRedis(
    id: string,
    requested: { tokens?: number; cost?: number },
    hardLimit: boolean
  ): Promise<QuotaDecision> {
    const q = this.getQuota(id);
    const now = Date.now();
    const windowMs = q.windowMs && q.windowMs > 0 ? q.windowMs : 60000;
    const { rateKey, winKey, concKey, ttlSec } = this.redisKeys(id, windowMs, now);
    const reqTokens = requested.tokens ?? 0;
    const reqCost = requested.cost ?? 0;
    const raw = await this.redis!.eval(
      REDIS_ADMIT_SCRIPT,
      3,
      rateKey,
      winKey,
      concKey,
      String(now),
      String(windowMs),
      String(q.qps ?? 0),
      String(q.maxConcurrency ?? 0),
      String(q.maxTokensPerWindow ?? 0),
      String(q.maxCostPerWindow ?? 0),
      String(reqTokens),
      String(reqCost),
      hardLimit ? '1' : '0',
      String(ttlSec)
    );
    // Lua 返回形如 [1]（允许）或 [0, '<reason>'（字符串）, <retryAfterMs>]
    const res = Array.isArray(raw) ? raw : [raw];
    if (Number(res[0]) === 1) {
      return { allowed: true, reservation: { tokens: reqTokens, cost: reqCost } };
    }
    const retry = Number(res[2]);
    return {
      allowed: false,
      reason: String(res[1] ?? 'quota denied'),
      retryAfterMs: Number.isFinite(retry) ? retry : undefined,
    };
  }

  /**
   * 异步准入（run-queue 热路径）。配置了 Redis 后端时走 Lua 原子脚本（多副本精确）；
   * Redis 故障 fail-open 降级进程内（单副本精确，多副本短暂退化为每副本近似——
   * 配额是保护性限流而非账务，可用性优先）。
   */
  async admitAsync(
    tenantId: string,
    requested: { tokens?: number; cost?: number } = {},
    hardLimit = false
  ): Promise<QuotaDecision> {
    const id = tenantId || 'anonymous';
    if (this.redis) {
      try {
        return await this.admitViaRedis(id, requested, hardLimit);
      } catch (e) {
        console.warn('[quota] redis admit failed, fallback to in-process:', e instanceof Error ? e.message : e);
      }
    }
    return this.admit(id, requested, hardLimit);
  }

  /** 异步归还并发槽（与 admitAsync 配对；无 Redis 时等价 release）。 */
  async releaseAsync(tenantId: string): Promise<void> {
    const id = tenantId || 'anonymous';
    if (this.redis) {
      try {
        const q = this.getQuota(id);
        const windowMs = q.windowMs && q.windowMs > 0 ? q.windowMs : 60000;
        const { concKey } = this.redisKeys(id, windowMs, Date.now());
        await this.redis.eval(REDIS_RELEASE_SCRIPT, 1, concKey);
        return;
      } catch (e) {
        console.warn('[quota] redis release failed, fallback to in-process:', e instanceof Error ? e.message : e);
      }
    }
    this.release(id);
  }

  /**
   * 结算实际用量：窗口累计 +=（实际 - 预留），「实际替换预留」消除双重计费。
   * 跨窗口滚动（run 跑过窗口边界）时预留随旧窗口 key 自然过期，实际用量记入新窗口。
   * 无 Redis 时等价 recordUsage。
   */
  async settleUsage(
    tenantId: string,
    usage: { tokens?: number; cost?: number },
    reservation?: { tokens?: number; cost?: number }
  ): Promise<void> {
    const id = tenantId || 'anonymous';
    if (this.redis) {
      try {
        const q = this.getQuota(id);
        const windowMs = q.windowMs && q.windowMs > 0 ? q.windowMs : 60000;
        const { winKey, ttlSec } = this.redisKeys(id, windowMs, Date.now());
        const dT = (usage.tokens ?? 0) - (reservation?.tokens ?? 0);
        const dC = (usage.cost ?? 0) - (reservation?.cost ?? 0);
        await this.redis.eval(REDIS_SETTLE_SCRIPT, 1, winKey, String(dT), String(dC), String(ttlSec));
        return;
      } catch (e) {
        console.warn('[quota] redis settle failed, fallback to in-process:', e instanceof Error ? e.message : e);
      }
    }
    this.recordUsage(id, usage, reservation);
  }

  /**
   * 运行期累计 token / cost（不拦截，仅统计；用于计费与窗口观测）。
   * @param reservation admit 成功时返回的预留量：传入后先冲销预估值再记实际值
   *   （「实际替换预留」），消除 admit + recordUsage 双重累计导致的窗口用量虚高；
   *   不传则保持旧的纯累加语义（向后兼容）。
   */
  recordUsage(
    tenantId: string,
    usage: { tokens?: number; cost?: number },
    reservation?: { tokens?: number; cost?: number }
  ): void {
    const id = tenantId || 'anonymous';
    const q = this.getQuota(id);
    const b = this.bucket(id);
    const now = Date.now();
    this.rollWindow(b, q.windowMs && q.windowMs > 0 ? q.windowMs : 60000, now);
    if (reservation) {
      // 冲销预留（floor 0：窗口可能已滚动，预留已随 rollWindow 清零）
      b.tokensUsed = Math.max(0, b.tokensUsed - (reservation.tokens ?? 0));
      b.costUsed = Math.max(0, b.costUsed - (reservation.cost ?? 0));
    }
    b.tokensUsed += usage.tokens ?? 0;
    b.costUsed += usage.cost ?? 0;
  }

  /** 当前用量快照（供 /api/metrics 与运维观测）。 */
  getUsage(tenantId: string): {
    concurrency: number;
    tokensUsed: number;
    costUsed: number;
    windowStart: number;
  } {
    const id = tenantId || 'anonymous';
    const b = this.buckets.get(id);
    if (!b) return { concurrency: 0, tokensUsed: 0, costUsed: 0, windowStart: 0 };
    return {
      concurrency: b.active,
      tokensUsed: b.tokensUsed,
      costUsed: b.costUsed,
      windowStart: b.windowStart,
    };
  }

  /** 列出已注册配额维度的租户 id（调试 / 健康检查）。 */
  listTenantIds(): string[] {
    return [...this.quotas.keys()];
  }
}

/** 进程内共享单例：服务启动时按配置预注册租户配额。 */
export const quotaEngine = new QuotaEngine();
