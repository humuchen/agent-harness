/**
 * 医美客资插件配置解析（唯一配置入口）。
 *
 * 设计原则（本次重构的核心）：
 * 1. **零内置业务数据**：插件源码不含任何项目语料 / 院区 / 号源 / 线索样本。
 *    所有业务数据都来自真实数据源（本地关系库 + 外部 CRM/HIS/KB REST 服务）。
 * 2. **fail-closed（失败关闭）**：某能力依赖的后端未配置时，对应工具/接口返回明确的
 *    `NOT_CONFIGURED` 错误，**绝不退化为假数据、也绝不假装成功**。
 * 3. 懒解析：env 可能在 import 之后才注入（server 启动顺序），因此配置在首次读取时解析并缓存，
 *    可通过 resetConfig() 失效（测试用）。
 *
 * 全部环境变量见 docs/CONFIG.md。
 */

import { join, resolve } from 'node:path';

/** 关系库配置（线索/知识库/号源/预约/发件箱的系统记录）。 */
export interface DbConfig {
  /** 驱动：sqlite（node:sqlite 内置，零依赖）。 */
  driver: 'sqlite';
  /** 数据库文件绝对路径。 */
  file: string;
  /** busy_timeout（毫秒），多副本共享卷时避免瞬时锁冲突直接报错。 */
  busyTimeoutMs: number;
}

/** 外部 REST 上游通用配置。 */
export interface UpstreamConfig {
  /** 是否已配置（baseUrl 非空）。未配置时相关能力 fail-closed。 */
  enabled: boolean;
  baseUrl: string;
  /** Bearer token（日志中一律脱敏）。 */
  token: string;
  /** 单次请求超时。 */
  timeoutMs: number;
  /** 失败重试次数（仅对可重试错误：网络异常 / 429 / 5xx）。 */
  retries: number;
}

/** 文本嵌入服务配置（语义检索用）。在通用上游基础上增加模型名。 */
export interface EmbedConfig extends UpstreamConfig {
  /** 嵌入模型名（OpenAI 兼容端点用，如 text-embedding-3-small / nomic-embed-text）。 */
  model: string;
}

export interface MaConfig {
  /** 租户标识：贯穿 DB 行、CRM 请求头与 A2A 信封。 */
  tenantId: string;
  db: DbConfig;
  /** 客户关系管理系统（线索的业务主系统）。 */
  crm: UpstreamConfig;
  /** 预约/HIS 系统（院区、号源、预约单的权威来源）。 */
  his: UpstreamConfig;
  /** 项目知识库服务。source=db 时查本地库；source=http 时查外部 KB 服务。 */
  kb: UpstreamConfig & { source: 'db' | 'http' };
  /** 外部 RAG 检索服务（services/rag）。已配则 project_kb_search 优先走 RAG，
   *  未配回退本地库（kb）。RAG 入库由 scripts/rag-ingest.cjs 完成。 */
  rag: UpstreamConfig;
  /** 文本嵌入服务（语义检索用）。未配置则 hybrid 检索退化为词面+意图，绝不伪造向量。 */
  embed: EmbedConfig;
  /** 渠道 webhook 入口：HMAC 校验密钥（未配置则拒绝所有 webhook，避免裸奔）。 */
  webhookSecret: string;
  /** 运营数据导入 / 看板写操作的管理令牌（未配置则拒绝写入）。 */
  adminToken: string;
  /** CRM 同步发件箱（至少一次投递）。 */
  outbox: { enabled: boolean; intervalMs: number; maxAttempts: number; batchSize: number };
  /** 入站消息触发 agent 的 A2A 入口（平台自身 /api/a2a/tasks）。 */
  a2a: { baseUrl: string; timeoutMs: number };
  /** 启动时自动种子演示数据：设为 '1' 且 DB 为空时写入模拟客资。仅用于开发 / 验证环境。 */
  seedOnStartup: boolean;
}

/** 解析整数 env，非法/缺省时回退。 */
function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 解析上游配置：baseUrl 为空即 enabled=false（该能力 fail-closed）。 */
function upstream(prefix: string, defaults: { timeoutMs?: number; retries?: number } = {}): UpstreamConfig {
  const baseUrl = (process.env[`${prefix}_BASE_URL`] ?? '').trim().replace(/\/+$/, '');
  return {
    enabled: baseUrl.length > 0,
    baseUrl,
    token: (process.env[`${prefix}_TOKEN`] ?? '').trim(),
    timeoutMs: int(`${prefix}_TIMEOUT_MS`, defaults.timeoutMs ?? 8000),
    retries: int(`${prefix}_RETRIES`, defaults.retries ?? 2),
  };
}

/**
 * 数据目录优先级（与既有约定一致）：
 * MA_DATA_DIR > MEMORY_DIR/plugins/medical-aesthetics-lead > ./data/ma-lead
 */
function resolveDataDir(): string {
  if (process.env.MA_DATA_DIR) return process.env.MA_DATA_DIR;
  if (process.env.MEMORY_DIR) return join(process.env.MEMORY_DIR, 'plugins', 'medical-aesthetics-lead');
  return join(process.cwd(), 'data', 'ma-lead');
}

let cached: MaConfig | null = null;

/** 取得配置（首次调用解析 env 并缓存）。 */
export function getConfig(): MaConfig {
  if (cached) return cached;
  const dataDir = resolveDataDir();
  cached = {
    tenantId: (process.env.MA_TENANT_ID ?? 'default').trim() || 'default',
    db: {
      driver: 'sqlite',
      // MA_DB_FILE 可能传相对路径；统一在此解析为绝对路径，
      // 避免 seed / export / 运行时在不同工作目录下解析到不同文件（曾导致导出读到空库）。
      file: process.env.MA_DB_FILE ? resolve(process.cwd(), process.env.MA_DB_FILE) : join(dataDir, 'ma-lead.db'),
      busyTimeoutMs: int('MA_DB_BUSY_TIMEOUT_MS', 5000),
    },
    crm: upstream('MA_CRM'),
    his: upstream('MA_HIS'),
    kb: {
      ...upstream('MA_KB'),
      // 缺省用本地库（运营经导入接口写入 / 由外部 KB 服务同步落库）。
      source: (process.env.MA_KB_SOURCE ?? 'db').trim() === 'http' ? 'http' : 'db',
    },
    rag: upstream('MA_RAG'),
    embed: {
      ...upstream('MA_EMBED'),
      model: (process.env.MA_EMBED_MODEL ?? 'text-embedding-3-small').trim(),
    },
    webhookSecret: (process.env.MA_WEBHOOK_SECRET ?? '').trim(),
    adminToken: (process.env.MA_ADMIN_TOKEN ?? '').trim(),
    outbox: {
      enabled: process.env.MA_OUTBOX_ENABLED !== 'false',
      intervalMs: int('MA_OUTBOX_INTERVAL_MS', 15000),
      maxAttempts: int('MA_OUTBOX_MAX_ATTEMPTS', 8),
      batchSize: int('MA_OUTBOX_BATCH_SIZE', 20),
    },
    a2a: {
      baseUrl: (process.env.MA_A2A_BASE_URL ?? process.env.AGENT_A2A_BASE_URL ?? '')
        .trim()
        .replace(/\/+$/, ''),
      timeoutMs: int('MA_A2A_TIMEOUT_MS', 60000),
    },
  };
  return cached;
}

/** 失效配置缓存（测试 / 运行期重载 env 用）。 */
export function resetConfig(): void {
  cached = null;
}

/** 供 /health 与看板展示的配置摘要（**不含任何密钥**）。 */
export function configSummary(): Record<string, unknown> {
  const c = getConfig();
  return {
    tenantId: c.tenantId,
    db: { driver: c.db.driver, file: c.db.file },
    crm: { enabled: c.crm.enabled, baseUrl: c.crm.baseUrl || null, hasToken: c.crm.token.length > 0 },
    his: { enabled: c.his.enabled, baseUrl: c.his.baseUrl || null, hasToken: c.his.token.length > 0 },
    kb: { source: c.kb.source, enabled: c.kb.enabled, baseUrl: c.kb.baseUrl || null },
    rag: { enabled: c.rag.enabled, baseUrl: c.rag.baseUrl || null },
    embed: { enabled: c.embed.enabled, baseUrl: c.embed.baseUrl || null, model: c.embed.model },
    webhook: { configured: c.webhookSecret.length > 0 },
    admin: { configured: c.adminToken.length > 0 },
    outbox: c.outbox,
    a2a: { configured: c.a2a.baseUrl.length > 0, baseUrl: c.a2a.baseUrl || null },
  };
}
