/**
 * Token 缓存命中率指标统计模块。
 *
 * 背景：LLM 适配器在 `PROMPT_CACHE=true` 时会对系统提示词打 `cache_control`
 * （ephemeral），供应商侧 prompt 缓存命中后会在响应 usage 里返回
 * `prompt_tokens_details.cached_tokens`。本模块记录「每次缓存查询」与「是否命中」，
 * 计算并输出命中率（命中次数 / 总查询次数），支持实时统计与周期性聚合，
 * 并在命中率低于阈值时通过可注入的告警 sink 给出提示。
 *
 * 性能约束：
 * - `recordTokenCacheQuery` 仅做 O(1) 整数递增（无锁、无异步、不在热路径分配对象），
 *   对主流程（LLM 调用）开销可忽略。
 * - 周期性聚合运行在独立的 `setInterval` 上，且调用 `.unref()`，不阻止进程退出、
 *   不阻塞主流程；窗口日志与告警为后台旁路输出。
 *
 * 设计说明：本模块刻意不 import `telemetry`，以避免与 telemetry 形成循环依赖；
 * 日志/告警通过可注入 sink（默认写 console）上抛，由 server 在启动时把
 * `emitAlert` 注入为 alert sink，从而复用同一套 webhook/文件告警通道。
 */

export interface TokenCacheQueryInput {
  /** 本次请求是否命中缓存（cached_tokens > 0）。 */
  hit: boolean;
  /** 本次命中缓存的 token 数（用于 token 级命中率，可选）。 */
  cachedTokens?: number;
  /** 本次请求的 prompt token 数（可选）。 */
  promptTokens?: number;
  /** 模型标识（可选，用于按模型维度聚合）。 */
  model?: string;
}

export interface TokenCacheModelStat {
  queries: number;
  hits: number;
  hitRate: number;
}

export interface TokenCacheStats {
  /** 启动以来累计缓存查询次数。 */
  queries: number;
  /** 启动以来累计命中次数。 */
  hits: number;
  /** 请求级命中率 = hits / queries（queries 为 0 时返回 0）。 */
  hitRate: number;
  /** 累计缓存命中的 token 数。 */
  cachedTokens: number;
  /** 累计 prompt token 数。 */
  promptTokens: number;
  /** token 级命中率 = cachedTokens / promptTokens（无 prompt 时返回 0）。 */
  tokenHitRate: number;
  /** 统计起始时间戳（ms）。 */
  since: number;
  /** 按模型维度的命中率。 */
  byModel: Record<string, TokenCacheModelStat>;
}

export interface TokenCacheWindow {
  ts: number;
  windowMs: number;
  queries: number;
  hits: number;
  hitRate: number;
  cachedTokens: number;
  promptTokens: number;
}

type LogFn = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>
) => void;
type AlertFn = (
  level: 'warn' | 'error' | 'fatal',
  name: string,
  message: string,
  fields?: Record<string, unknown>
) => void;

// ---------------------------------------------------------------------------
// 实时累计计数器（O(1) 递增，无锁）
// ---------------------------------------------------------------------------
let queries = 0;
let hits = 0;
let cachedTokensTotal = 0;
let promptTokensTotal = 0;
const START = Date.now();
const byModel = new Map<string, { queries: number; hits: number }>();

// ---------------------------------------------------------------------------
// 可注入的日志 / 告警 sink（默认写 console，避免强依赖 telemetry 形成循环引用）
// ---------------------------------------------------------------------------
let logSink: LogFn = (level, message, fields) => {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(fields ?? {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};
let alertSink: AlertFn | null = null;

/** 覆盖默认日志 sink（测试或宿主接管时用）。 */
export function setTokenCacheLogger(fn: LogFn): void {
  logSink = fn;
}

/** 设置告警 sink；传 null 关闭告警（默认 null → 不告警，仅窗口日志）。 */
export function setTokenCacheAlertSink(fn: AlertFn | null): void {
  alertSink = fn;
}

/** 记录一次缓存查询与命中情况（热路径，O(1)）。 */
export function recordTokenCacheQuery(input: TokenCacheQueryInput): void {
  queries += 1;
  if (input.hit) hits += 1;
  const ct = Math.max(0, Math.floor(input.cachedTokens ?? 0));
  const pt = Math.max(0, Math.floor(input.promptTokens ?? 0));
  cachedTokensTotal += ct;
  promptTokensTotal += pt;
  const model = input.model || 'unknown';
  let m = byModel.get(model);
  if (!m) {
    m = { queries: 0, hits: 0 };
    byModel.set(model, m);
  }
  m.queries += 1;
  if (input.hit) m.hits += 1;
}

/** 实时统计快照（查询接口与日志共用）。 */
export function getTokenCacheStats(): TokenCacheStats {
  const byModelOut: Record<string, TokenCacheModelStat> = {};
  for (const [k, v] of byModel) {
    byModelOut[k] = {
      queries: v.queries,
      hits: v.hits,
      hitRate: v.queries ? v.hits / v.queries : 0,
    };
  }
  return {
    queries,
    hits,
    hitRate: queries ? hits / queries : 0,
    cachedTokens: cachedTokensTotal,
    promptTokens: promptTokensTotal,
    tokenHitRate: promptTokensTotal ? cachedTokensTotal / promptTokensTotal : 0,
    since: START,
    byModel: byModelOut,
  };
}

// ---------------------------------------------------------------------------
// 周期性聚合（独立定时器，后台旁路，不阻塞主流程）
// ---------------------------------------------------------------------------
const history: TokenCacheWindow[] = [];
const MAX_HISTORY = 120;
let aggTimer: ReturnType<typeof setInterval> | null = null;
let lastQueries = 0;
let lastHits = 0;
let lastCached = 0;
let lastPrompt = 0;

export interface TokenCacheAggregationOptions {
  /** 聚合窗口（ms），默认 60000。也可用 env TOKEN_CACHE_AGGREGATE_INTERVAL_MS。 */
  intervalMs?: number;
  /** 命中率阈值（0..1），窗口命中率低于该值（且样本数 >= minSamples）触发告警。默认 0.2。env TOKEN_CACHE_HITRATE_ALERT_THRESHOLD。 */
  threshold?: number;
  /** 触发告警所需的最小窗口样本数，避免早期样本太少误报。默认 10。env TOKEN_CACHE_ALERT_MIN_SAMPLES。 */
  minSamples?: number;
}

/** 启动周期性聚合（幂等：重复调用无效）。 */
export function startTokenCacheAggregation(opts?: TokenCacheAggregationOptions): void {
  if (aggTimer) return;
  const intervalMs = opts?.intervalMs ?? numEnv('TOKEN_CACHE_AGGREGATE_INTERVAL_MS', 60000);
  const threshold = opts?.threshold ?? numEnv('TOKEN_CACHE_HITRATE_ALERT_THRESHOLD', 0.2);
  const minSamples = opts?.minSamples ?? numEnv('TOKEN_CACHE_ALERT_MIN_SAMPLES', 10);
  aggTimer = setInterval(() => {
    const cur = getTokenCacheStats();
    const dq = cur.queries - lastQueries;
    const dh = cur.hits - lastHits;
    const dc = cur.cachedTokens - lastCached;
    const dp = cur.promptTokens - lastPrompt;
    const windowHitRate = dq ? dh / dq : 0;
    const win: TokenCacheWindow = {
      ts: Date.now(),
      windowMs: intervalMs,
      queries: dq,
      hits: dh,
      hitRate: windowHitRate,
      cachedTokens: dc,
      promptTokens: dp,
    };
    history.push(win);
    if (history.length > MAX_HISTORY) history.shift();

    logSink('info', 'token-cache window', {
      queries: dq,
      hits: dh,
      hitRate: +windowHitRate.toFixed(4),
      cachedTokens: dc,
      promptTokens: dp,
      cumulativeHitRate: +cur.hitRate.toFixed(4),
      cumulativeQueries: cur.queries,
    });

    if (dq >= minSamples && windowHitRate < threshold && alertSink) {
      alertSink(
        'warn',
        'token-cache-hitrate-low',
        `token cache hit rate ${(windowHitRate * 100).toFixed(1)}% < threshold ${(
          threshold * 100
        ).toFixed(1)}% (window samples=${dq})`,
        {
          hitRate: +windowHitRate.toFixed(4),
          threshold,
          samples: dq,
          cachedTokens: dc,
          promptTokens: dp,
          cumulativeHitRate: +cur.hitRate.toFixed(4),
        }
      );
    }
    lastQueries = cur.queries;
    lastHits = cur.hits;
    lastCached = cur.cachedTokens;
    lastPrompt = cur.promptTokens;
  }, intervalMs);
  // 不阻止进程退出：聚合定时器只做后台观测。
  const t = aggTimer as { unref?: () => void };
  if (typeof t.unref === 'function') t.unref();
}

/** 停止周期性聚合（测试 / 优雅关闭用）。 */
export function stopTokenCacheAggregation(): void {
  if (aggTimer) {
    clearInterval(aggTimer);
    aggTimer = null;
  }
  lastQueries = queries;
  lastHits = hits;
  lastCached = cachedTokensTotal;
  lastPrompt = promptTokensTotal;
}

/** 最近若干窗口的聚合历史（运维回溯用）。 */
export function getTokenCacheHistory(): TokenCacheWindow[] {
  return history.slice();
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
