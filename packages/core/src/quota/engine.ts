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
 *   - 所有状态均为**进程内**内存态，契合现有 RunQueue 单进程模型；多副本场景由共享后端
 *     （redis）负责配额同步（本文件只暴露纯逻辑，便于未来注入外部计数源）；
 *   - admit() 是「预检 + 预留」原子操作：任一维度不通过则整体拒绝且**不消耗**任何配额，
 *     调用方需在执行结束后调用 release() 归还并发额度。
 */

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

export class QuotaEngine {
  private defaultQuotaCfg: TenantQuota = defaultQuota();
  private quotas = new Map<string, TenantQuota>();
  private buckets = new Map<string, Bucket>();

  constructor(defaultQuotaCfg?: TenantQuota) {
    if (defaultQuotaCfg) this.defaultQuotaCfg = { ...defaultQuotaCfg };
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
    return { allowed: true };
  }

  /** 执行结束后归还并发额度（与 admit 配对）。 */
  release(tenantId: string): void {
    const id = tenantId || 'anonymous';
    const b = this.buckets.get(id);
    if (b && b.active > 0) b.active -= 1;
  }

  /** 运行期累计 token / cost（不拦截，仅统计；用于计费与窗口观测）。 */
  recordUsage(tenantId: string, usage: { tokens?: number; cost?: number }): void {
    const id = tenantId || 'anonymous';
    const q = this.getQuota(id);
    const b = this.bucket(id);
    const now = Date.now();
    this.rollWindow(b, q.windowMs && q.windowMs > 0 ? q.windowMs : 60000, now);
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
