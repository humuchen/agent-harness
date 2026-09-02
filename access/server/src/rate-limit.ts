/**
 * rate-limit：进程内固定窗口限流器。
 *
 * ── 为什么从 server.ts 抽出来 ────────────────────────────────────────────────
 * 该限流器原先内联在 server.ts，其 `rateBuckets` Map **只 set 不 delete**：
 * 每个唯一 IP（含伪造 X-Forwarded-For 头）都会永久占有一条记录，
 * 长期运行必然 OOM —— 这是确定性内存泄漏，而非理论风险。
 *
 * 抽出为独立模块的目的有二：
 *   1) 让「内存有界」这件事可被单元测试证明，而不是靠人工 review；
 *   2) 限流器不再隐式依赖 server 的模块级常量，配置来源单一。
 *
 * ── 三层内存防护 ────────────────────────────────────────────────────────────
 *   1) 惰性过期：窗口结束后的桶在下次访问时重建（原本已有）；
 *   2) 定时 sweep：周期性删除所有已过期桶；定时器 unref，不阻止进程退出；
 *   3) 容量上限：即便 sweep 未及时执行（如事件循环被长时间阻塞），
 *      也硬性淘汰最早插入的键，保证内存存在确定上界。
 *
 * 设计约束：本模块不读 process.env、不 import server 的任何东西，
 * 阈值与窗口由调用方显式传入 —— 保持纯函数语义，便于测试与复用。
 */

export interface RateLimitResult {
  /** 是否应拒绝本次请求。 */
  limited: boolean;
  /** 建议的 Retry-After（ms）；未限流时为 0。 */
  retryAfter: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * 桶数量硬上限。50k 条约合数 MB 级内存，足以覆盖正常生产流量；
 * 超出后按插入顺序淘汰最早的键，避免无界增长。
 */
export const RATE_BUCKETS_MAX = 50_000;

/** 定时清理周期（ms）：窗口默认 60s，故每分钟扫一次即可。 */
const SWEEP_INTERVAL_MS = 60_000;

const rateBuckets = new Map<string, Bucket>();

/**
 * 删除所有已过期的桶，返回删除数量。
 * 导出以便测试断言，以及运维在非侵入排查时手动触发。
 */
export function sweepRateBuckets(now: number = Date.now()): number {
  let removed = 0;
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) {
      rateBuckets.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** 当前存活的桶数量（可观测性 / 测试断言用）。 */
export function rateBucketSize(): number {
  return rateBuckets.size;
}

/** 清空所有桶。仅供测试使用，生产运行期不应调用。 */
export function resetRateBuckets(): void {
  rateBuckets.clear();
}

/**
 * 固定窗口限流：返回是否应拒绝，以及建议的 Retry-After（ms）。
 *
 * @param ip       客户端标识（通常是 IP）
 * @param limit    窗口内允许的请求数；<= 0 表示关闭限流
 * @param windowMs 窗口长度（ms）
 */
export function rateLimited(ip: string, limit: number, windowMs: number): RateLimitResult {
  if (!(limit > 0)) return { limited: false, retryAfter: 0 };

  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  const expired = bucket != null && now > bucket.resetAt;

  if (!bucket || expired) {
    // 容量兜底：先 sweep 一轮；仍超限则淘汰最早插入的键（Map 保证插入顺序）。
    if (rateBuckets.size >= RATE_BUCKETS_MAX) {
      sweepRateBuckets(now);
      let overflow = rateBuckets.size - RATE_BUCKETS_MAX + 1;
      for (const key of rateBuckets.keys()) {
        if (overflow <= 0) break;
        rateBuckets.delete(key);
        overflow -= 1;
      }
    }
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(ip, bucket);
  }

  bucket.count += 1;
  return {
    limited: bucket.count > limit,
    retryAfter: Math.max(0, bucket.resetAt - now)
  };
}

// 定期清理过期桶。unref() 确保该定时器不会阻止进程退出（优雅停机依赖此行为）。
const sweeper = setInterval(() => {
  try {
    sweepRateBuckets();
  } catch {
    /* 清理失败不应影响主流程 */
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref?.();
