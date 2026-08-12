/**
 * 业务层 · 数据留存与出境策略（Retention & Cross-border Export Policy）。
 *
 * 设计原则（与核心 framework 隔离，可插拔/可组合）：
 * - 留存窗口、出境脱敏都是「合规业务策略」，核心不感知。核心只负责产生审计/记忆数据，
 *   本模块决定「留多久、出境前怎么脱敏」。
 * - RetentionPolicy 为接口 + 默认实现 + 组合工厂；替换合规规则（如按数据主权区域差异化）
 *   只需改 createRetentionPolicy()，server 其余代码不动。
 */
export type RecordKind = 'audit' | 'memory' | 'recipe';

export interface RetentionPolicy {
  /** 该类记录的留存上限（毫秒）；<=0 表示永久。超期记录应在导出/聚合时被剔除。 */
  maxAgeMs(kind: RecordKind): number;
  /** 出境/导出前对记录做合规脱敏（默认剔除 PII），返回脱敏后的副本。 */
  scrubForExport<T>(kind: RecordKind, record: T): T;
  /** 当前策略快照（供运维/合规查阅，不含密钥）。 */
  describe(): { retentionDays: Record<RecordKind, number>; scrubPII: boolean };
}

function envDays(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// 轻量 PII 脱敏（业务层自有，避免与核心 guardrails 耦合）：邮箱 / 手机号 / 身份证 / 长数字串。
function scrubText(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(?<!\d)(?:\+?\d{1,3}[- ]?)?\d{6,13}(?!\d)/g, '[phone]')
    .replace(/\b\d{17}[\dXx]\b/g, '[idcard]');
}
function scrubAny(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubAny);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubAny(v);
    return out;
  }
  return value;
}

export class DefaultRetentionPolicy implements RetentionPolicy {
  private readonly days: Record<RecordKind, number>;
  constructor(opts: { auditDays?: number; memoryDays?: number; recipeDays?: number; scrubPII?: boolean } = {}) {
    this.days = {
      audit: opts.auditDays ?? envDays('RETENTION_DAYS_AUDIT', 90),
      memory: opts.memoryDays ?? envDays('RETENTION_DAYS_MEMORY', 30),
      recipe: opts.recipeDays ?? envDays('RETENTION_DAYS_RECIPE', 365),
    };
    this.scrubPII = opts.scrubPII ?? true;
  }
  private scrubPII: boolean;
  maxAgeMs(kind: RecordKind): number {
    const d = this.days[kind];
    return d <= 0 ? -1 : d * 24 * 60 * 60 * 1000;
  }
  scrubForExport<T>(_kind: RecordKind, record: T): T {
    return this.scrubPII ? (scrubAny(record) as T) : record;
  }
  describe(): { retentionDays: Record<RecordKind, number>; scrubPII: boolean } {
    return { retentionDays: this.days, scrubPII: this.scrubPII };
  }
}

/** 组合工厂：按 RETENTION_DAYS_* 环境变量装配留存策略；要按数据主权区域差异化，只改这里。 */
export function createRetentionPolicy(): RetentionPolicy {
  return new DefaultRetentionPolicy();
}
