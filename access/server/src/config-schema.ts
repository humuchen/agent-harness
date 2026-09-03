/**
 * config-schema：启动期环境变量 schema 校验（依赖无关，零新增依赖）。
 *
 * 解决的问题：agent-harness 有 80+ 环境变量，且多数默认值相对 cwd（如 MEMORY_DIR）。
 * 历史上多次出现「配置写错但服务照常启动、静默降级/落盘分裂」的坑
 * （见 agent-harness 架构审计 S3/S4、OPEN_API_KEY 双用途等）。
 *
 * 本模块在启动早期对关键变量做类型/枚举/范围校验，并显式告警，把「静默 misconfig」
 * 变为显性失败（warn 级，不阻断启动，保证向后兼容）。
 *
 * 设计：声明式 schema + 纯函数校验；未来若引入 zod/envkit，可整体替换实现而不改调用方。
 */
import { structLog } from '@agent-harness/core';

type FieldType = 'string' | 'number' | 'boolean' | 'enum' | 'url' | 'json';

interface Field {
  key: string;
  type: FieldType;
  required?: boolean; // 缺失且 required=true → error
  critical?: boolean; // 校验失败视为 error（否则 warning）
  allowed?: string[]; // enum 白名单（小写比较）
  min?: number;
  max?: number;
  desc?: string;
}

// 关键变量 schema（覆盖服务绑定 / 鉴权 / LLM / 记忆 / MCP / 队列 / DB）。
// 仅在「写错会静默出错」的变量上做校验；其余保持原样由各处读取。
// 导出供 config-defaults 漂移守卫复用（DEFAULTS 键集合应与 SCHEMA 键集合一致）。
export const SCHEMA: Field[] = [
  // 服务绑定
  { key: 'PORT', type: 'number', min: 1, max: 65535, desc: '监听端口' },
  { key: 'UI_HOST', type: 'string', desc: '监听地址' },
  { key: 'MAX_BODY_BYTES', type: 'number', min: 1, desc: '请求体上限（字节）' },
  { key: 'RATE_LIMIT', type: 'number', min: 0, desc: '单 IP 限流阈值（0=关闭）' },
  { key: 'RATE_LIMIT_WINDOW_MS', type: 'number', min: 1, desc: '限流窗口（ms）' },
  // 鉴权
  {
    key: 'AUTH_PROVIDER',
    type: 'enum',
    allowed: ['token', 'oidc', 'proxy', 'account'],
    desc: '身份源'
  },
  { key: 'ACCOUNT_AUTH', type: 'boolean', desc: '账户密码身份源开关' },
  {
    key: 'UI_ROLE_PERMISSIONS',
    type: 'json',
    desc: 'RBAC 权限矩阵（JSON）'
  },
  // LLM
  { key: 'OPEN_BASE_URL', type: 'url', desc: 'LLM base URL' },
  { key: 'LLM_FAILOVER', type: 'enum', allowed: ['on', 'off', 'auto'], desc: '故障转移开关' },
  { key: 'LLM_REASONING', type: 'enum', allowed: ['on', 'off'], desc: '推理开关' },
  // 记忆
  {
    key: 'MEMORY_BACKEND',
    type: 'enum',
    allowed: ['volatile', 'file', 'sqlite'],
    desc: '记忆后端'
  },
  { key: 'MEMORY_DIR', type: 'string', desc: '文件记忆目录（建议绝对路径）' },
  { key: 'MEMORY_SQLITE_FILE', type: 'string', desc: 'SQLite 记忆文件（建议绝对路径）' },
  // MCP
  { key: 'MCP_SERVERS', type: 'json', desc: 'MCP 服务器清单（JSON 数组）' },
  { key: 'MCP_SERVER_URL', type: 'url', desc: 'MCP 兜底服务 URL' },
  // 运行队列
  {
    key: 'RUN_QUEUE_BACKEND',
    type: 'enum',
    allowed: ['memory', 'redis'],
    desc: '运行队列后端'
  },
  { key: 'RUN_CONCURRENCY', type: 'number', min: 1, desc: '并发运行数' },
  { key: 'JOB_TIMEOUT_MS', type: 'number', min: 1, desc: '任务超时（ms）' },
  // DB
  {
    key: 'DB_BACKEND',
    type: 'enum',
    allowed: ['sqlite', 'turso', 'libsql'],
    desc: '业务库后端'
  },
  { key: 'HISTORY_BACKEND', type: 'enum', allowed: ['sqlite', 'file'], desc: '历史记录后端' },
  // 安全加固
  { key: 'UI_CORS_ORIGIN', type: 'string', desc: 'CORS 白名单' },
  { key: 'AUDIT_LOG', type: 'string', desc: '审计日志路径' },
  // 配额硬上限（0=关闭，正数=窗口内最大成本美元）
  { key: 'MAX_COST_PER_WINDOW', type: 'number', min: 0, desc: '每窗口最大成本（美元，0=不限）' },
  // 存储路径（建议绝对路径）
  { key: 'ACCOUNT_DB_FILE', type: 'string', desc: '账户数据库文件路径' },
  { key: 'TELEMETRY_FILE', type: 'string', desc: '指标持久化文件路径（非空即启用自动落盘）' },
  // 业务 DB 路径（绝对路径，防 cwd 依赖）
  { key: 'HISTORY_DB_FILE', type: 'string', desc: '聊天记录数据库文件路径' },
  { key: 'MCP_SERVERS_DB_FILE', type: 'string', desc: 'MCP 服务器数据库文件路径' },
  { key: 'CUSTOM_MODELS_DB_FILE', type: 'string', desc: '自定义模型数据库文件路径' },
  { key: 'RAG_DATA_FILE', type: 'string', desc: 'RAG 数据文件路径' },
  // OTLP 导出（留空即不启用导出，故不设 required）
  {
    key: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    type: 'url',
    desc: 'OTLP Collector 地址（http(s)://，空=不导出）'
  },
  { key: 'OTEL_SERVICE_NAME', type: 'string', desc: 'OTel 服务名' },
  {
    key: 'OTEL_EXPORTER_OTLP_HEADERS',
    type: 'string',
    desc: 'OTLP 额外 Header（逗号分隔 key=value）'
  },
  {
    key: 'OTEL_METRICS_TEMPORALITY',
    type: 'enum',
    allowed: ['cumulative', 'delta'],
    desc: '指标时间聚合方式'
  },
  // 动态配置热更新
  {
    key: 'CONFIG_HOT_RELOAD_INTERVAL_MS',
    type: 'number',
    min: 0,
    desc: '配置热更新轮询间隔（ms）'
  },
  { key: 'CONFIG_PATHS', type: 'string', desc: '热更新配置文件路径（逗号分隔）' }
];

// 常见拼写错误 → 提示正确变量名（减少「配了但不生效」的静默坑）。
const TYPO_HINTS: Array<{ bad: RegExp; hint: string }> = [
  { bad: /^OPENROUTER_/i, hint: 'OPEN_API_KEY（统一 LLM 密钥）' },
  { bad: /^UI_AUTH_TOKEN$/i, hint: 'UI_TOKENS（多用户静态令牌）或 ADMIN_API_KEY（admin 凭证）' }
];

export interface ConfigReport {
  errors: string[];
  warnings: string[];
}

function parseValue(field: Field, raw: string): { ok: boolean; reason?: string } {
  switch (field.type) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, reason: '不是合法数字' };
      if (field.min != null && n < field.min) return { ok: false, reason: `小于下限 ${field.min}` };
      if (field.max != null && n > field.max) return { ok: false, reason: `大于上限 ${field.max}` };
      return { ok: true };
    }
    case 'boolean': {
      const v = raw.trim().toLowerCase();
      if (!['true', 'false', '1', '0', 'on', 'off', ''].includes(v))
        return { ok: false, reason: '不是合法布尔（true/false/1/0/on/off）' };
      return { ok: true };
    }
    case 'enum': {
      const v = raw.trim().toLowerCase();
      if (!field.allowed?.includes(v)) return { ok: false, reason: `不在白名单 [${field.allowed?.join(', ')}]` };
      return { ok: true };
    }
    case 'url': {
      if (!/^https?:\/\//i.test(raw.trim()))
        return { ok: false, reason: '不是合法 http(s):// URL' };
      return { ok: true };
    }
    case 'json': {
      try {
        JSON.parse(raw);
        return { ok: true };
      } catch {
        return { ok: false, reason: '不是合法 JSON' };
      }
    }
    case 'string':
    default:
      return { ok: true };
  }
}

/** 校验 process.env 是否符合声明式 schema，返回错误/告警列表（不抛异常）。 */
export function validateConfig(): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const field of SCHEMA) {
    const raw = process.env[field.key];
    if (raw == null || raw === '') {
      if (field.required) errors.push(`缺少必需环境变量 ${field.key}（${field.desc ?? ''}）`);
      continue;
    }
    const res = parseValue(field, raw);
    if (!res.ok) {
      const msg = `${field.key}=${JSON.stringify(raw)} 校验失败：${res.reason}`;
      if (field.critical) errors.push(msg);
      else warnings.push(msg);
    }
  }

  // 拼写错误提示（独立扫描，避免静默不生效）。
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    for (const t of TYPO_HINTS) {
      if (t.bad.test(k)) warnings.push(`环境变量 ${k} 疑似拼写错误，应为 ${t.hint}`);
    }
  }

  return { errors, warnings };
}

/** 校验并结构化日志输出，把静默 misconfig 显性化。
 * AH_STARTUP_CRITICAL=1 时，critical 字段校验失败直接 throw，阻断启动（生产推荐）。
 * 默认不阻断（向后兼容），仅记录 error 级日志。 */
export function logConfigValidation(): void {
  const { errors, warnings } = validateConfig();
  if (errors.length === 0 && warnings.length === 0) {
    structLog('info', 'config', { validated: true, note: '环境变量校验通过' });
    return;
  }
  for (const e of errors) structLog('error', 'config', { issue: e });
  for (const w of warnings) structLog('warn', 'config', { issue: w });
  if (errors.length > 0) {
    const criticalErrors = SCHEMA.filter(f => f.critical).map(f => f.key);
    structLog('error', 'config', {
      summary: `${errors.length} 个必需/关键环境变量校验失败，请检查配置`,
      hint: '服务仍会尽量启动（向后兼容），但相关功能可能异常'
    });
    if (process.env.AH_STARTUP_CRITICAL === '1') {
      throw new Error(`启动阻断：${errors.length} 项配置校验失败，详见上方日志\n关键项: ${criticalErrors.join(', ')}`);
    }
  }
}
