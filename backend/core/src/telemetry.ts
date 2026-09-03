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

// 错误明细存储（环形缓冲）：记录每条错误的具体类型 / 消息 / 时间 / 堆栈 / 上下文。
// 注意：errorlog 不反向依赖 telemetry，避免循环引用；计数仍由本模块负责。
import { captureError } from './errorlog';

let tracer: any = null;
let meter: any = null;
let initPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// 请求级上下文（traceId / 当前运行 jobId）：让所有 structLog 调用自动带上下文，
// 无需每个调用点手动传递。基于 AsyncLocalStorage，Node 22 原生支持。
// 使用 require() 兼容 CommonJS 模块系统（避免 top-level await / import.meta）。
// ---------------------------------------------------------------------------
const asyncHooks = require('node:async_hooks') as typeof import('node:async_hooks');

export interface RequestContext {
  /** 请求唯一标识（UUID），由 server 为每次 HTTP 请求生成并跨事件流透传。 */
  traceId?: string;
  /** 当前 running job id（同一任务内多条日志共享）。 */
  jobId?: string;
  /** 租户 id（若可派生）。 */
  tenantId?: string;
}

const requestStore = new asyncHooks.AsyncLocalStorage<RequestContext>();

/** 在当前 async 上下文中设置请求上下文并执行 fn，结束后还原。 */
export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestStore.run(ctx, fn);
}

/** 读取当前 async 上下文中的请求上下文；无上下文时返回空对象。 */
export function getRequestContext(): RequestContext {
  return requestStore.getStore() ?? {};
}

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

// P2：per-tenant 指标维度。与全局聚合同构，但 key 为 tenantId（global 仍走上面的 COUNTERS/TOKENS）。
// 默认 tenant 用 'anonymous' 落到同一条目，保证「未分租户」场景指标不丢失。
interface TenantMetrics {
  counters: Record<string, number>;
  hists: Record<string, Histogram>;
  tokens: { prompt: number; completion: number; total: number };
  cost: number;
  costByModel: Record<string, number>;
}
const BY_TENANT = new Map<string, TenantMetrics>();

function tenantMetrics(tenantId?: string | null): TenantMetrics {
  const id = tenantId || 'anonymous';
  let m = BY_TENANT.get(id);
  if (!m) {
    m = { counters: {}, hists: {}, tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, costByModel: {} };
    BY_TENANT.set(id, m);
  }
  return m;
}

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

/** 记录一次错误（按 name 维度计数，同时累计全局 errors）。
 *  若传入 `err`，会额外把错误类型 / 消息 / 堆栈捕获进错误明细存储（见 errorlog），
 *  从而「错误数量」与「具体错误信息」可被一并回顾。 */
export function recordError(name: string, err?: unknown): void {
  incCounter(`error.${name}`);
  incCounter('errors');
  let type: string | undefined;
  let message = name;
  let stack: string | undefined;
  if (err instanceof Error) {
    type = err.name || 'Error';
    message = err.message || name;
    stack = err.stack;
  } else if (err !== undefined) {
    message = String(err);
  }
  captureError({ name, severity: 'error', type, message, stack });
}

// ---------------------------------------------------------------------------
// P2：per-tenant 指标维度（租户级计费 / 配额 / 合规观测）
// ---------------------------------------------------------------------------

/** 累加某租户计数器。 */
export function incCounterTenant(name: string, tenantId?: string | null, n = 1): void {
  const m = tenantMetrics(tenantId);
  m.counters[name] = (m.counters[name] ?? 0) + n;
  incCounter(name, n);
}

/** 记录某租户 token 用量（同时累计全局）。 */
export function recordTokensTenant(
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  tenantId?: string | null
): void {
  if (!usage) return;
  const m = tenantMetrics(tenantId);
  const p = usage.prompt_tokens ?? 0;
  const c = usage.completion_tokens ?? 0;
  const t = usage.total_tokens ?? p + c;
  m.tokens.prompt += p;
  m.tokens.completion += c;
  m.tokens.total += t;
  recordTokens(usage);
}

/** 记录某租户成本（同时累计全局）。 */
export function recordCostTenant(amount: number, model?: string, tenantId?: string | null): void {
  if (!amount) return;
  const m = tenantMetrics(tenantId);
  m.cost += amount;
  if (model) {
    const key = model || 'unknown';
    m.costByModel[key] = (m.costByModel[key] ?? 0) + amount;
  }
  recordCost(amount, model);
}

/**
 * 统一错误记录：累加错误计数器 + 输出结构化日志。
 * `err` 可传 Error（自动提取 message/stack）或任意字段对象；`fields` 用于补充上下文
 * （如 runId、sessionKey）。替代散落各处的 `recordError + 手动 structLog` 写法，
 * 让所有业务错误拥有一致的日志形态与计数维度。
 */
export function logError(name: string, err?: unknown, fields?: Record<string, unknown>): void {
  incCounter(`error.${name}`);
  incCounter('errors');
  const merged: Record<string, unknown> = { ...(fields ?? {}) };
  let type: string | undefined;
  let message = name;
  let stack: string | undefined;
  if (err instanceof Error) {
    type = err.name || 'Error';
    message = err.message;
    stack = err.stack;
    merged.message = err.message;
    merged.stack = err.stack;
  } else if (err && typeof err === 'object') {
    Object.assign(merged, err as Record<string, unknown>);
    message = (err as { message?: unknown }).message != null ? String((err as { message?: unknown }).message) : name;
  } else if (err !== undefined) {
    merged.detail = String(err);
    message = String(err);
  }
  // 同步把具体错误信息捕获进错误明细存储（type / message / stack / 上下文）。
  captureError({ name, severity: 'error', type, message, stack, fields: merged });
  structLog('error', `error: ${name}`, merged);
}

export interface MetricsSnapshot {
  since: number;
  uptimeMs: number;
  counters: Record<string, number>;
  latency: Record<string, { count: number; sumMs: number; minMs: number; maxMs: number; avgMs: number }>;
  tokens: { prompt: number; completion: number; total: number };
  cost: number;
  costByModel: Record<string, number>;
  /** P2：按租户维度聚合的指标（计费 / 配额 / 合规观测）。key 为 tenantId，'anonymous' 为未分租户。 */
  byTenant: Record<string, TenantMetricsSnapshot>;
}

/** 单租户指标快照形态（与全局同构，但去掉 latency 直方图以控制体积）。 */
export interface TenantMetricsSnapshot {
  counters: Record<string, number>;
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
  const byTenant: Record<string, TenantMetricsSnapshot> = {};
  for (const [id, m] of BY_TENANT.entries()) {
    byTenant[id] = {
      counters: { ...m.counters },
      tokens: { ...m.tokens },
      cost: m.cost,
      costByModel: { ...m.costByModel },
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
    byTenant,
  };
}

/** 仅拉取 per-tenant 指标（运维 / 计费对账用，避免全局大对象）。 */
export function getMetricsByTenant(): Record<string, TenantMetricsSnapshot> {
  const out: Record<string, TenantMetricsSnapshot> = {};
  for (const [id, m] of BY_TENANT.entries()) {
    out[id] = {
      counters: { ...m.counters },
      tokens: { ...m.tokens },
      cost: m.cost,
      costByModel: { ...m.costByModel },
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 结构化日志（贯穿 runId，便于关联一次运行的全部事件）
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** 输出一条结构化 JSON 日志（时间戳 + 级别 + 消息 + 任意字段）。
 * 自动注入当前请求上下文（traceId / jobId / tenantId），便于一次运行/请求的全链路关联。 */
export function structLog(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const ctx = getRequestContext();
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(fields ?? {}),
  };
  // 仅在有值时注入，避免污染无上下文的生产日志（如 daemon 进程）。
  if (ctx.traceId) entry['trace.id'] = ctx.traceId;
  if (ctx.jobId) entry['job.id'] = ctx.jobId;
  if (ctx.tenantId) entry['tenant.id'] = ctx.tenantId;
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'fatal') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// 告警下沉（可插拔：Webhook / 日志文件 / 外部 APM）
// ---------------------------------------------------------------------------

export type AlertLevel = 'warn' | 'error' | 'fatal';

/** 一条告警。severity 决定计数维度（alerts.warn/error/fatal）。 */
export interface Alert {
  level: AlertLevel;
  name: string;
  message: string;
  fields?: Record<string, unknown>;
  ts: string;
}

type AlertSink = (alert: Alert) => void | Promise<void>;
let alertSink: AlertSink | null = null;

// P1-9: 告警去重 — 相同 name 在 ALERT_DEDUP_WINDOW_MS 内只发一次 sink（日志仍全量）。
// 防止高频故障触发告警风暴。
const ALERT_DEDUP_WINDOW_MS = Number(process.env.ALERT_DEDUP_WINDOW_MS) || 10_000;
const alertLastSent: Record<string, number> = Object.create(null);

/**
 * 注册告警接收器（如 Webhook / 日志文件）。传 null 关闭（默认关闭）。
 * 接收器异常被吞掉，绝不影响主业务流程。
 */
export function setAlertSink(sink: AlertSink | null): void {
  alertSink = sink;
}

/**
 * 触发一条告警：始终留一条结构化日志（级别按 level 映射），若已注册 sink 则异步转发。
 * 即使 sink 抛错也只记一条 warn 日志，不向上传播。返回 Promise 便于调用方 `await`，
 * 但也可 fire-and-forget（内部已兜底，不会成为 unhandled rejection）。
 */
export async function emitAlert(
  level: AlertLevel,
  name: string,
  message: string,
  fields?: Record<string, unknown>
): Promise<void> {
  incCounter('alerts');
  incCounter(`alerts.${level}`);
  // 错误级 / 致命级告警也作为系统错误捕获进明细存储，保证告警与错误可一并回顾。
  if (level === 'error' || level === 'fatal') {
    captureError({
      name: `alert.${name}`,
      severity: level === 'fatal' ? 'fatal' : 'error',
      type: 'alert',
      message,
      fields,
    });
  }
  structLog(level === 'warn' ? 'warn' : 'error', `[alert] ${name}: ${message}`, fields);
  if (alertSink) {
    // P1-9: 去重 — 相同 name 在 ALERT_DEDUP_WINDOW_MS 内只发一次 sink（日志仍全量）。
    const now = Date.now();
    const lastSent = alertLastSent[name] ?? 0;
    if (now - lastSent >= ALERT_DEDUP_WINDOW_MS) {
      alertLastSent[name] = now;
      try {
        await alertSink({ level, name, message, fields, ts: new Date().toISOString() });
      } catch (e: any) {
        structLog('warn', 'alert sink failed', { error: e?.message ?? String(e), name });
      }
    } else {
      structLog('debug', `alert deduped: ${name} (within ${ALERT_DEDUP_WINDOW_MS}ms)`, fields);
    }
  }
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
      recordError(name, err);
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

// ---------------------------------------------------------------------------
// P2：指标持久化（跨重启保留累计计数 / token / 成本 / 租户维度）
// ---------------------------------------------------------------------------
// 采用零依赖 JSON 文件落盘（与 memory file 后端同源思路），默认 <APP_HOME||cwd>/data/telemetry-metrics.json。
// 进程退出（SIGTERM/SIGINT）与定时（默认 30s）自动 flush；启动时 loadMetricsSnapshot 回填内存态。
// 纯进程内单例场景下重启不丢累计指标，适配 Render 等无状态部署。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let TELEMETRY_FILE: string | null = null;
let autosaveTimer: ReturnType<typeof setInterval> | null = null;

function resolveTelemetryPath(p: string): string {
  if (path.isAbsolute(p)) return p;
  const base = process.env.APP_HOME || process.cwd();
  return path.resolve(base, p);
}

/** 设置持久化文件路径；传 null 关闭持久化（默认关闭，避免无谓 IO）。 */
export function setTelemetryFile(file: string | null): void {
  TELEMETRY_FILE = file ? resolveTelemetryPath(file) : null;
}

/**
 * 把快照写回内存态（启动时调用一次）。采用「覆盖」语义（非累计），
 * 因为落盘快照本身已是累计值，重复累加会翻倍。
 */
export function restoreMetricsSnapshot(snap: MetricsSnapshot): void {
  for (const k of Object.keys(COUNTERS)) delete COUNTERS[k];
  Object.assign(COUNTERS, snap.counters ?? {});
  for (const k of Object.keys(HISTS)) delete HISTS[k];
  for (const [k, v] of Object.entries(snap.latency ?? {})) {
    HISTS[k] = {
      count: v.count,
      sum: v.sumMs,
      min: v.minMs === 0 ? Infinity : v.minMs,
      max: v.maxMs === 0 ? -Infinity : v.maxMs,
    };
  }
  TOKENS.prompt = snap.tokens?.prompt ?? 0;
  TOKENS.completion = snap.tokens?.completion ?? 0;
  TOKENS.total = snap.tokens?.total ?? 0;
  COST = snap.cost ?? 0;
  for (const k of Object.keys(COST_BY_MODEL)) delete COST_BY_MODEL[k];
  Object.assign(COST_BY_MODEL, snap.costByModel ?? {});
  BY_TENANT.clear();
  for (const [id, m] of Object.entries(snap.byTenant ?? {})) {
    BY_TENANT.set(id, {
      counters: { ...m.counters },
      hists: {},
      tokens: { ...m.tokens },
      cost: m.cost,
      costByModel: { ...m.costByModel },
    });
  }
}

/** 启动时从文件回填（文件不存在 / 解析失败则静默跳过，不阻断启动）。 */
export function loadMetricsSnapshot(): void {
  if (!TELEMETRY_FILE) return;
  try {
    if (!existsSync(TELEMETRY_FILE)) return;
    const raw = readFileSync(TELEMETRY_FILE, 'utf8');
    const snap = JSON.parse(raw) as MetricsSnapshot;
    restoreMetricsSnapshot(snap);
    structLog('info', 'telemetry', { loaded: true, file: TELEMETRY_FILE });
  } catch (e: any) {
    structLog('warn', 'telemetry', { loaded: false, error: e?.message ?? String(e) });
  }
}

/** 把当前快照原子写盘（先写 .tmp 再 rename，避免半截文件）。失败时静默。 */
export function saveMetricsSnapshot(): void {
  if (!TELEMETRY_FILE) return;
  try {
    const dir = path.dirname(TELEMETRY_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${TELEMETRY_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(getMetricsSnapshot()), 'utf8');
    renameSync(tmp, TELEMETRY_FILE);
  } catch (e: any) {
    structLog('warn', 'telemetry', { saved: false, error: e?.message ?? String(e) });
  }
}

/**
 * 启用自动持久化：设置文件路径 + 定时 flush（unref，不阻止进程退出）+ 退出信号 flush。
 * 仅由 server 启动时调用一次；幂等（重复调用先关闭旧定时器）。
 * 注意：不注册 beforeExit，避免短命/测试子进程退出时落盘产生副作用；真实部署靠 SIGTERM/SIGINT 优雅退出 flush。
 */
export function enableTelemetryAutosave(file?: string, intervalMs = 30_000): void {
  if (file) setTelemetryFile(file);
  if (!TELEMETRY_FILE) return;
  loadMetricsSnapshot();
  if (autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => saveMetricsSnapshot(), intervalMs);
  // unref：不阻止 Node 事件循环自然退出（避免测试 / 短命进程挂起）。
  (autosaveTimer as { unref?: () => void }).unref?.();
  const flush = () => saveMetricsSnapshot();
  process.once('SIGTERM', flush);
  process.once('SIGINT', flush);
}
