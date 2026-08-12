// 轻量级链路追踪与可观测性。
//
// OpenTelemetry 是可选的。如果进程中已安装 `@opentelemetry/api` 且注册了 Tracer
// 提供商，则会发出 Span 与指标。若未安装，每个 `withSpan` 退化为普通的计时函数调用
// （无操作），因此 Harness 在运行时不存在任何强制依赖。
//
// 指标（token 用量、延迟、错误率、工具调用数、成本）同时维护一份内存聚合快照，
// 可通过 `getMetricsSnapshot()` 拉取（例如暴露给 `/api/metrics`），即使没有 OTel
// Collector 也能看到核心可观测数据。

const OTEL_API = '@opentelemetry/api';

let tracer: any = null;
let meter: any = null;
let initPromise: Promise<void> | null = null;

// 可选绑定到真实 OTel meter 的计数器，便于把指标导出到 Collector。
let otelCounters: Record<string, any> = {};
let otelHistograms: Record<string, any> = {};

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const api: any = await import(OTEL_API);
        tracer = api.trace.getTracer('agent-harness');
        try {
          meter = api.metrics.getMeter('agent-harness');
        } catch {
          meter = null;
        }
      } catch {
        tracer = null;
        meter = null;
      }
    })();
  }
  await initPromise;
}

// OpenTelemetry SpanStatusCode.ERROR 的值为 2
const SPAN_STATUS_ERROR = 2;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------
// 内存指标聚合（零依赖、进程内）
// ---------------------------------------------------------------------------

interface Histogram {
  count: number;
  sum: number;
  min: number;
  max: number;
}

const COUNTERS: Record<string, number> = {};
const HISTS: Record<string, Histogram> = {};
const TOKENS = { prompt: 0, completion: 0, total: 0 };
let COST = 0;
const COST_BY_MODEL: Record<string, number> = {};
const START = Date.now();

function ensureHist(name: string): Histogram {
  let h = HISTS[name];
  if (!h) {
    h = { count: 0, sum: 0, min: Infinity, max: -Infinity };
    HISTS[name] = h;
  }
  return h;
}

/** 累加计数器（如工具调用次数、错误数）。 */
export function incCounter(name: string, n = 1): void {
  COUNTERS[name] = (COUNTERS[name] ?? 0) + n;
  if (meter) {
    let c = otelCounters[name];
    if (!c) c = otelCounters[name] = meter.createCounter(name);
    if (c?.add) c.add(n);
  }
}

/** 记录一次耗时（毫秒），用于延迟直方图。 */
export function recordLatency(name: string, ms: number): void {
  const h = ensureHist(name);
  h.count += 1;
  h.sum += ms;
  if (ms < h.min) h.min = ms;
  if (ms > h.max) h.max = ms;
  if (meter) {
    let o = otelHistograms[name];
    if (!o) o = otelHistograms[name] = meter.createHistogram(name);
    if (o?.record) o.record(ms);
  }
}

/** 累加 token 用量（来自 LLM 响应里的 usage）。 */
export function recordTokens(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): void {
  if (!usage) return;
  const p = usage.prompt_tokens ?? 0;
  const c = usage.completion_tokens ?? 0;
  const t = usage.total_tokens ?? p + c;
  TOKENS.prompt += p;
  TOKENS.completion += c;
  TOKENS.total += t;
  incCounter('tokens.total', t);
}

/** 累加成本（由调用方按模型单价换算后传入，单位与调用方约定一致，例如美元）。
 *  传 model 时同时累加进按模型维度的成本明细，便于 `/api/metrics` 看钱花在哪。 */
export function recordCost(amount: number, model?: string): void {
  if (!amount) return;
  COST += amount;
  if (model) {
    const key = model || 'unknown';
    COST_BY_MODEL[key] = (COST_BY_MODEL[key] ?? 0) + amount;
  }
}

/** 记录一次错误（按 name 维度计数，同时累计全局 errors）。 */
export function recordError(name: string): void {
  incCounter(`error.${name}`);
  incCounter('errors');
}

export interface MetricsSnapshot {
  since: number;
  uptimeMs: number;
  counters: Record<string, number>;
  latency: Record<string, { count: number; sumMs: number; minMs: number; maxMs: number; avgMs: number }>;
  tokens: { prompt: number; completion: number; total: number };
  cost: number;
  costByModel: Record<string, number>;
}

/** 拉取当前指标快照（无 OTel Collector 时也能观测核心数据）。 */
export function getMetricsSnapshot(): MetricsSnapshot {
  const latency: MetricsSnapshot['latency'] = {};
  for (const [k, h] of Object.entries(HISTS)) {
    latency[k] = {
      count: h.count,
      sumMs: h.sum,
      minMs: h.min === Infinity ? 0 : h.min,
      maxMs: h.max === -Infinity ? 0 : h.max,
      avgMs: h.count ? h.sum / h.count : 0,
    };
  }
  return {
    since: START,
    uptimeMs: Date.now() - START,
    counters: { ...COUNTERS },
    latency,
    tokens: { ...TOKENS },
    cost: COST,
    costByModel: { ...COST_BY_MODEL },
  };
}

// ---------------------------------------------------------------------------
// 结构化日志（贯穿 runId，便于关联一次运行的全部事件）
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 输出一条结构化 JSON 日志（时间戳 + 级别 + 消息 + 任意字段）。 */
export function structLog(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, msg: message, ...(fields ?? {}) };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Span 包装（同时记录延迟与错误指标）
// ---------------------------------------------------------------------------

export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  await ensureInit();

  const run = async (): Promise<T> => {
    const start = nowMs();
    try {
      return await fn();
    } catch (err: any) {
      recordError(name);
      throw err;
    } finally {
      recordLatency(name, nowMs() - start);
    }
  };

  if (!tracer) {
    return run();
  }

  const span = tracer.startSpan(name);
  try {
    return await run();
  } catch (err: any) {
    if (span.setStatus) {
      span.setStatus({ code: SPAN_STATUS_ERROR, message: err?.message ?? String(err) });
    }
    if (span.recordException) {
      span.recordException(err);
    }
    throw err;
  } finally {
    span.end();
  }
}

/**
 * 将 OTel meter 绑定到遥测层（可选）。传入一个已初始化的 Meter，
 * 之后 `incCounter` / `recordLatency` 会同时把数据推到该 Meter，
 * 从而导出到 Collector。无 Collector 时可不调用，内存快照仍可用。
 */
export function bindOtelMeter(m: any): void {
  meter = m;
}
