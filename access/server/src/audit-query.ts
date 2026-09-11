/**
 * 合规审计查询（读侧）。
 *
 * 背景：审计**写入**侧早已就绪（core `audit()` + `AUDIT_LOG` JSONL 落盘，覆盖
 * 鉴权 / 审批 / 敏感动作 / 配额拒绝）。缺的是**读取侧**——管理员无法回答
 * 「谁在什么时间做了什么、谁审批了谁、有没有越权拦截」。
 *
 * 本模块补齐该缺口：把审计 JSONL 解析为可过滤、可分页、可聚合的查询结果，
 * 供 `GET /api/audit` 与管理界面消费。纯读取，不修改任何审计写入路径。
 *
 * 设计取舍：
 * - 审计文件为 append-only JSONL，读取采用「全量扫描 + 取尾部窗口」，配合
 *   `MAX_SCAN_LINES` 上限防止超大文件把内存打满（审计查询是运维低频操作，
 *   牺牲一点性能换零依赖与实现简洁）。
 * - 文件不存在 / 未启用落盘时返回空结果并给出 `file: null`，不报错（合规视图
 *   应能明确显示「审计未落盘」而非 500）。
 */

import type { AuditEvent, AuditOutcome } from '@agent-harness/core';

/** 单次扫描的最大行数（超出时只保留最新的一段）。 */
const MAX_SCAN_LINES = 200_000;
/** 默认返回条数。 */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

export interface AuditQueryOptions {
  limit?: number;
  offset?: number;
  /** 精确匹配 actor。 */
  actor?: string;
  /** 动作名子串匹配（如 'agent.run' 命中 'agent.run.start'）。 */
  action?: string;
  outcome?: AuditOutcome;
  /** 起始时间（epoch ms，含）。 */
  since?: number;
  /** 结束时间（epoch ms，含）。 */
  until?: number;
  /** 自由文本：在 action / actor / target / detail(JSON) 中做子串匹配。 */
  q?: string;
}

export interface AuditSummary {
  /** 各 outcome 计数。 */
  byOutcome: Record<string, number>;
  /** 动作 Top N（按次数降序）。 */
  topActions: Array<{ action: string; count: number }>;
  /** 去重后的 actor 数。 */
  actors: number;
  /** 时间窗口（本批事件的 ts 范围）。 */
  window?: { from: string; to: string };
}

export interface AuditQueryResult {
  /** 本次返回条数。 */
  count: number;
  /** 过滤后总条数（未分页前）。 */
  total: number;
  /** 事件（按时间倒序，最新在前）。 */
  events: AuditEvent[];
  /** 聚合摘要。 */
  summary: AuditSummary;
  /** 审计文件路径；null 表示未启用落盘。 */
  file: string | null;
  /** 因超过扫描上限而被忽略的更早行数（0 表示未截断）。 */
  truncatedLines: number;
}

/** 解析审计文件路径（env 优先，回退默认值）。 */
export function resolveAuditFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.AUDIT_LOG;
  return raw && raw.trim() ? raw.trim() : null;
}

/** 解析单行 JSON 为 AuditEvent；失败返回 null。 */
function parseLine(line: string): AuditEvent | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t) as AuditEvent;
    if (!o || typeof o !== 'object' || typeof o.action !== 'string') return null;
    return o;
  } catch {
    return null;
  }
}

/** 事件时间转 epoch ms（解析失败返回 NaN）。 */
function tsOf(e: AuditEvent): number {
  if (!e.ts) return NaN;
  const t = Date.parse(e.ts);
  return Number.isNaN(t) ? NaN : t;
}

/** 判断事件是否命中过滤条件。 */
function matches(e: AuditEvent, opts: AuditQueryOptions): boolean {
  if (opts.actor && e.actor !== opts.actor) return false;
  if (opts.action && !e.action.includes(opts.action)) return false;
  if (opts.outcome && e.outcome !== opts.outcome) return false;
  if (opts.since != null || opts.until != null) {
    const t = tsOf(e);
    if (Number.isNaN(t)) return false;
    if (opts.since != null && t < opts.since) return false;
    if (opts.until != null && t > opts.until) return false;
  }
  if (opts.q) {
    const needle = opts.q.toLowerCase();
    const hay = [
      e.action,
      e.actor ?? '',
      e.target ?? '',
      e.tenantId ?? '',
      e.detail ? JSON.stringify(e.detail) : ''
    ]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/** 聚合摘要。 */
export function summarize(events: AuditEvent[]): AuditSummary {
  const byOutcome: Record<string, number> = {};
  const actionCount = new Map<string, number>();
  const actors = new Set<string>();
  let from: string | undefined;
  let to: string | undefined;
  for (const e of events) {
    byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    actionCount.set(e.action, (actionCount.get(e.action) ?? 0) + 1);
    if (e.actor) actors.add(e.actor);
    if (e.ts) {
      if (!from || e.ts < from) from = e.ts;
      if (!to || e.ts > to) to = e.ts;
    }
  }
  const topActions = [...actionCount.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return {
    byOutcome,
    topActions,
    actors: actors.size,
    ...(from && to ? { window: { from, to } } : {})
  };
}

/**
 * 查询审计文件。
 * @param file 审计 JSONL 路径（null 时返回空结果）。
 * @param opts 过滤 / 分页参数。
 */
export async function queryAuditFile(
  file: string | null,
  opts: AuditQueryOptions = {}
): Promise<AuditQueryResult> {
  const limit = clamp(opts.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(0, opts.offset ?? 0);

  if (!file) {
    return {
      count: 0,
      total: 0,
      events: [],
      summary: summarize([]),
      file: null,
      truncatedLines: 0
    };
  }

  const fs = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    // 文件不存在 / 不可读 → 空结果（合规视图应显式展示「未落盘」）。
    return {
      count: 0,
      total: 0,
      events: [],
      summary: summarize([]),
      file,
      truncatedLines: 0
    };
  }

  let lines = raw.split('\n').filter((l) => l.trim());
  let truncatedLines = 0;
  if (lines.length > MAX_SCAN_LINES) {
    truncatedLines = lines.length - MAX_SCAN_LINES;
    lines = lines.slice(-MAX_SCAN_LINES); // 保留最新一段
  }

  const events: AuditEvent[] = [];
  for (const line of lines) {
    const e = parseLine(line);
    if (e && matches(e, opts)) events.push(e);
  }

  // 倒序（最新在前）：ts 缺失的排在最后。
  events.sort((a, b) => {
    const ta = tsOf(a);
    const tb = tsOf(b);
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    return vb - va;
  });

  const total = events.length;
  const page = events.slice(offset, offset + limit);
  return {
    count: page.length,
    total,
    events: page,
    summary: summarize(events),
    file,
    truncatedLines
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
