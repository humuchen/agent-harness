/**
 * 智能客服插件配置解析（唯一配置入口）。
 *
 * 设计原则（与 ma-lead 一致）：
 * 1. 零内置业务数据：源码不含客户名单 / 订单样本 / 知识条目。
 * 2. fail-closed：外部订单上游未配置时，cs_order_query 返回明确的 NOT_CONFIGURED，绝不伪造。
 * 3. 懒解析：env 在 import 之后才注入（server 启动顺序），首次读取时解析并缓存。
 *
 * 全部环境变量见 docs/CONFIG.md。
 */

import { join, resolve } from 'node:path';

/** 外部 REST 上游通用配置。 */
export interface UpstreamConfig {
  /** 是否已配置（baseUrl 非空）。未配置时相关能力 fail-closed。 */
  enabled: boolean;
  baseUrl: string;
  token: string;
  timeoutMs: number;
  retries: number;
}

export interface CsConfig {
  /** 租户标识：贯穿 DB 行与 A2A 信封。 */
  tenantId: string;
  /** 关系库（会话/工单/知识库系统记录）。 */
  db: { driver: 'sqlite'; file: string; busyTimeoutMs: number };
  /** 订单/售后系统（外部上游，未配置则 cs_order_query fail-closed）。 */
  order: UpstreamConfig;
  /** 渠道 webhook 验签密钥（未配置则拒绝所有 webhook）。 */
  webhookSecret: string;
  /** 管理写操作令牌（未配置则拒绝写入）。 */
  adminToken: string;
  /** A2A 入口（平台自身 /api/a2a/tasks）。 */
  a2a: { baseUrl: string; timeoutMs: number };
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
 * CS_DATA_DIR > MEMORY_DIR/plugins/customer-service > ./data/cs
 */
function resolveDataDir(): string {
  if (process.env.CS_DATA_DIR) return process.env.CS_DATA_DIR;
  if (process.env.MEMORY_DIR) return join(process.env.MEMORY_DIR, 'plugins', 'customer-service');
  return join(process.cwd(), 'data', 'cs');
}

let cached: CsConfig | null = null;

/** 取得配置（首次调用解析 env 并缓存）。 */
export function getConfig(): CsConfig {
  if (cached) return cached;
  const dataDir = resolveDataDir();
  cached = {
    tenantId: (process.env.CS_TENANT_ID ?? 'default').trim() || 'default',
    db: {
      driver: 'sqlite',
      file: process.env.CS_DB_FILE ? resolve(process.cwd(), process.env.CS_DB_FILE) : join(dataDir, 'cs.db'),
      busyTimeoutMs: int('CS_DB_BUSY_TIMEOUT_MS', 5000),
    },
    order: upstream('CS_ORDER'),
    webhookSecret: (process.env.CS_WEBHOOK_SECRET ?? '').trim(),
    adminToken: (process.env.CS_ADMIN_TOKEN ?? '').trim(),
    a2a: {
      baseUrl: (process.env.CS_A2A_BASE_URL ?? process.env.AGENT_A2A_BASE_URL ?? '')
        .trim()
        .replace(/\/+$/, ''),
      timeoutMs: int('CS_A2A_TIMEOUT_MS', 60000),
    },
  };
  return cached;
}

/** 失效配置缓存（测试用）。 */
export function resetConfig(): void {
  cached = null;
}

/** 供 /health 与看板展示的配置摘要（不含任何密钥）。 */
export function configSummary(): Record<string, unknown> {
  const c = getConfig();
  return {
    tenantId: c.tenantId,
    db: { driver: c.db.driver, file: c.db.file },
    order: { enabled: c.order.enabled, baseUrl: c.order.baseUrl || null },
    webhook: { configured: c.webhookSecret.length > 0 },
    admin: { configured: c.adminToken.length > 0 },
    a2a: { configured: c.a2a.baseUrl.length > 0, baseUrl: c.a2a.baseUrl || null },
  };
}
