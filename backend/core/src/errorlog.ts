// 系统错误明细存储（与计数解耦）。
//
// `telemetry` 的 `recordError` / `logError` / `emitAlert` 只做「计数 + 结构化日志」，
// 日志打印即丢弃，无法在事后回顾「到底发生了哪些具体错误」。本模块在计数之外，
// 额外把**每一条错误的具体信息**留存到进程内环形缓冲：错误类别、严重级别、错误类型
// （Error 构造器名 / 'counter'）、消息内容、发生时间（epoch 毫秒 + ISO）、堆栈跟踪、
// 以及附加上下文（runId / sessionKey / tenantId 等）。
//
// 这样「错误数量」与「具体错误信息」来自同一数据源：count = getErrorSummary().total，
// 明细 = getErrorLog()，二者天然一致，可一并呈现给用户（见 server 的 /api/errors 与 /errors）。
//
// 设计约束：
// - 零运行时依赖，纯内存；不引入任何外部存储，避免与 memory-store 的持久化后端耦合。
// - 环形缓冲上限（ERROR_LOG_MAX，默认 500）防止长时间运行进程因错误堆积导致内存膨胀。
// - 本模块**不**反向依赖 telemetry（否则会产生循环引用），计数仍由 telemetry 负责。

/** 错误严重级别。目前只收录 error / fatal（系统级错误），warn 不进错误明细，避免噪声。 */
export type ErrorSeverity = 'error' | 'fatal';

/** 一条被捕获的错误明细记录。 */
export interface ErrorRecord {
  /** 全局唯一 id（time + 自增序号）。 */
  id: string;
  /** 发生时间，epoch 毫秒。 */
  time: number;
  /** 发生时间，ISO 字符串（便于人类阅读与日志对齐）。 */
  ts: string;
  /** 错误类别 / 名称，例如 'tool.shell'、'guardrail.input'、'agent.run'。 */
  name: string;
  /** 严重级别。 */
  severity: ErrorSeverity;
  /** 错误类型：Error 构造器名（如 'TypeError'）、'counter'（纯计数错误无具体异常）、或 alert 名。 */
  type?: string;
  /** 错误消息内容。 */
  message: string;
  /** 堆栈跟踪（若可用）。 */
  stack?: string;
  /** 关联租户（P0.3 隔离场景便于按租户排查）。 */
  tenantId?: string;
  /** 附加上下文字段（runId / sessionKey / 自定义 attributes 等）。 */
  fields?: Record<string, unknown>;
}

/** captureError 的输入（除自动生成的 id/time/ts 外均可选）。 */
export interface CaptureErrorInput {
  name: string;
  severity?: ErrorSeverity;
  type?: string;
  message: string;
  stack?: string;
  tenantId?: string;
  fields?: Record<string, unknown>;
  /** 允许调用方显式指定时间（重放 / 测试用）；缺省取 Date.now()。 */
  time?: number;
}

/** getErrorLog 的过滤 / 分页选项。 */
export interface GetErrorLogOptions {
  /** 最多返回多少条（取最近 N 条）。省略则全部返回。 */
  limit?: number;
  /** 仅匹配指定错误名称。 */
  name?: string;
  /** 仅匹配指定严重级别。 */
  severity?: ErrorSeverity;
  /** 仅返回 time >= since 的记录。 */
  since?: number;
  /** 仅返回 time <= until 的记录。 */
  until?: number;
}

/** 错误摘要（数量 + 按名称 / 级别分布 + 时间跨度）。 */
export interface ErrorSummary {
  /** 当前缓冲中错误总条数（= 错误数量）。 */
  total: number;
  /** 按错误名称聚合的计数。 */
  byName: Record<string, number>;
  /** 按严重级别聚合的计数。 */
  bySeverity: Record<string, number>;
  /** 最早一条错误的时间（epoch 毫秒）；无记录为 null。 */
  firstSeen: number | null;
  /** 最近一条错误的时间（epoch 毫秒）；无记录为 null。 */
  lastSeen: number | null;
}

// 环形缓冲上限：ERROR_LOG_MAX 环境变量可覆盖，缺省 500 条。
const MAX =
  (() => {
    const n = Number(process.env.ERROR_LOG_MAX);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
  })();

const ERRORS: ErrorRecord[] = [];
let seq = 0;

/**
 * 捕获一条错误明细并存入环形缓冲。
 * 返回规范化后的记录（含自动生成的 id/time/ts），便于调用方继续加工。
 */
export function captureError(input: CaptureErrorInput): ErrorRecord {
  const time = input.time ?? Date.now();
  const rec: ErrorRecord = {
    id: `err_${time.toString(36)}_${(seq++).toString(36)}`,
    time,
    ts: new Date(time).toISOString(),
    name: input.name,
    severity: input.severity ?? 'error',
    type: input.type,
    message: input.message,
    stack: input.stack,
    tenantId: input.tenantId,
    fields: input.fields,
  };
  ERRORS.push(rec);
  // 超出上限时从头部丢弃最旧记录（环形缓冲语义）。
  if (ERRORS.length > MAX) ERRORS.splice(0, ERRORS.length - MAX);
  return rec;
}

/** 取回错误明细列表（可按名称 / 级别 / 时间过滤，按最近 N 条截断）。 */
export function getErrorLog(opts: GetErrorLogOptions = {}): ErrorRecord[] {
  let out = ERRORS;
  if (opts.name) out = out.filter((e) => e.name === opts.name);
  if (opts.severity) out = out.filter((e) => e.severity === opts.severity);
  if (opts.since != null) out = out.filter((e) => e.time >= opts.since!);
  if (opts.until != null) out = out.filter((e) => e.time <= opts.until!);
  if (opts.limit != null && opts.limit > 0) out = out.slice(-opts.limit);
  return out;
}

/** 基于（已过滤的）明细计算摘要：总数、按名称 / 级别分布、时间跨度。 */
export function getErrorSummary(opts: GetErrorLogOptions = {}): ErrorSummary {
  const list = getErrorLog(opts);
  const byName: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let first: number | null = null;
  let last: number | null = null;
  for (const e of list) {
    byName[e.name] = (byName[e.name] ?? 0) + 1;
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    if (first == null || e.time < first) first = e.time;
    if (last == null || e.time > last) last = e.time;
  }
  return { total: list.length, byName, bySeverity, firstSeen: first, lastSeen: last };
}

/** 清空错误明细缓冲（运维 / 测试用）。 */
export function clearErrorLog(): void {
  ERRORS.length = 0;
}

/**
 * 生成人类可读的文本错误报告：数量横幅 + 按名称分布 + 逐条明细（类型 / 消息 / 堆栈）。
 * 既可用于「输出」场景（CLI / 日志 / 报表），也可被前端「复制为文本」复用。
 */
export function formatErrorReport(opts: GetErrorLogOptions = {}): string {
  const list = getErrorLog(opts);
  const summary = getErrorSummary(opts);
  const lines: string[] = [];
  lines.push('系统错误报告');
  lines.push('='.repeat(48));
  lines.push(`错误总数: ${summary.total}`);
  if (summary.firstSeen != null && summary.lastSeen != null) {
    lines.push(`时间跨度: ${new Date(summary.firstSeen).toISOString()} ~ ${new Date(summary.lastSeen).toISOString()}`);
  }
  const names = Object.entries(summary.byName).sort((a, b) => b[1] - a[1]);
  if (names.length) {
    lines.push('按名称分布:');
    for (const [k, v] of names) lines.push(`  - ${k}: ${v}`);
  }
  if (list.length === 0) {
    lines.push('（暂无错误记录）');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('逐条明细:');
  list.forEach((e, i) => {
    lines.push(`[${i + 1}] ${e.ts}  ${e.severity.toUpperCase()}  ${e.name}`);
    if (e.type) lines.push(`    类型: ${e.type}`);
    lines.push(`    消息: ${e.message}`);
    if (e.tenantId) lines.push(`    租户: ${e.tenantId}`);
    if (e.stack) {
      lines.push('    堆栈:');
      for (const sl of e.stack.split('\n')) lines.push(`      ${sl}`);
    }
    if (e.fields && Object.keys(e.fields).length) {
      try {
        lines.push(`    上下文: ${JSON.stringify(e.fields)}`);
      } catch {
        lines.push('    上下文: <不可序列化>');
      }
    }
  });
  return lines.join('\n');
}
