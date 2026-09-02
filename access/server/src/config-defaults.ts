/**
 * config-defaults：服务器所有可配置项的「唯一默认值来源」。
 *
 * 解决配置漂移：历史上默认值散落在 server.ts / runner.ts 的行内字面量，
 * 与 config-schema.ts 的校验清单互不同源——改了一处忘了另一处就会静默分叉
 * （见架构审计 S3/S4）。本模块把每个配置键的默认值集中定义一次，
 * server.ts / runner.ts 的运行时读取一律引用 DEFAULTS，config-schema 的
 * 校验也引用同一份（见 config-defaults.test 的漂移守卫）。
 *
 * 约定：DEFAULTS 的键必须与 config-schema 的 SCHEMA 键保持一致；
 * 新增配置项时，默认值在此定义，校验规则在 config-schema 定义。
 */

/** 所有配置键的集中默认值（单一事实来源）。 */
export const DEFAULTS: Record<string, string | number | boolean> = {
  // 服务绑定
  PORT: 4173,
  UI_HOST: '0.0.0.0',
  MAX_BODY_BYTES: 1_048_576,
  RATE_LIMIT: 120,
  RATE_LIMIT_WINDOW_MS: 60_000,
  // 鉴权
  AUTH_PROVIDER: 'token',
  ACCOUNT_AUTH: 'on',
  UI_ROLE_PERMISSIONS: '',
  // LLM
  OPEN_BASE_URL: '',
  LLM_FAILOVER: 'on',
  LLM_REASONING: 'on',
  // 记忆
  MEMORY_BACKEND: '',
  MEMORY_DIR: './data/memory',
  MEMORY_SQLITE_FILE: './data/memory.db',
  // MCP
  MCP_SERVER_URL: '',
  // MCP 服务器清单（JSON 数组字符串）；留空则由 core 的解析入口回退到内置默认清单。
  MCP_SERVERS: '',
  // 运行队列
  RUN_QUEUE_BACKEND: 'memory',
  RUN_CONCURRENCY: 4,
  JOB_TIMEOUT_MS: 0,
  // DB
  DB_BACKEND: 'sqlite',
  HISTORY_BACKEND: 'sqlite',
  // 安全
  UI_CORS_ORIGIN: '',
  AUDIT_LOG: '/app/data/audit/audit.jsonl',
  // 配额
  MAX_COST_PER_WINDOW: 0, // 0=不限（硬上限关闭），正数=窗口内最大成本（美元）
  // 存储路径（生产建议绝对路径；相对路径依赖 cwd 巧合命中卷）
  ACCOUNT_DB_FILE: './data/accounts.db',
  // 可观测性
  TELEMETRY_FILE: '',
  // OTLP 导出
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  OTEL_SERVICE_NAME: 'agent-harness',
  OTEL_EXPORTER_OTLP_HEADERS: '',
  OTEL_METRICS_TEMPORALITY: 'cumulative',
  // 动态配置
  CONFIG_HOT_RELOAD_INTERVAL_MS: 60_000,
  CONFIG_PATHS: '',
};

/** 读取字符串配置：env 优先，缺失回退 DEFAULTS（再回退传入 fallback）。 */
export function cfgStr(key: string, fallback = ''): string {
  const v = process.env[key];
  if (v != null && v !== '') return v;
  const d = DEFAULTS[key];
  return d == null ? fallback : String(d);
}

/** 读取数值配置：env 优先（须为有限数），缺失/非法回退 DEFAULTS。 */
export function cfgNum(key: string, fallback = 0): number {
  const v = process.env[key];
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  const d = DEFAULTS[key];
  return typeof d === 'number' ? d : fallback;
}

/** 读取布尔配置：env 优先（true/1/on 视为真），缺失回退 DEFAULTS（支持布尔或字符串 'on'/'off'）。 */
export function cfgBool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v != null && v !== '') return ['true', '1', 'on'].includes(v.trim().toLowerCase());
  const d = DEFAULTS[key];
  if (typeof d === 'boolean') return d;
  if (typeof d === 'string') return ['true', '1', 'on'].includes(d.trim().toLowerCase());
  return fallback;
}

/** 漂移守卫用：返回 DEFAULTS 的键集合。 */
export function defaultKeys(): string[] {
  return Object.keys(DEFAULTS);
}
