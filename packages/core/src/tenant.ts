// 租户上下文（P0.3 租户隔离）。
//
// 把「租户」从隐式的 env/平台身份提升为**显式、可寻址、可派生策略**的一等实体。
// 配套能力：
//   - 复合记忆 key（tenant::session）实现 per-tenant 记忆分区，互不串档；
//   - 通过 resolveTenantContext 把认证身份（SSO claim / 网关头）作为权威来源，
//     请求体声明的 tenantId 仅作本地/测试降级，杜绝客户端伪造越界。
//
// 设计约定（与 agents/router 一致）：全字段可选、向后兼容。tenantCtx 为空
// 时退化为「通用 / 全局默认策略」—— 今天的零租户行为完全不变。

import { sanitizeKey } from './memory-store';

export interface TenantContext {
  /** 归一化后的租户标识（经 sanitizeKey，杜绝路径穿越 / 注入）。 */
  id: string;
  /** 展示名（可选，来自认证身份）。 */
  name?: string;
  /** 行业域（可选，用于行业策略画像预选，见 policy/engine）。 */
  domain?: string;
}

/**
 * 解析租户上下文。
 * 优先级：认证身份（authenticatedTenantId）> 请求体声明（tenantId）；
 * 两者皆空 / 归一化为 anonymous 时返回 null（无租户 → 通用默认策略，向后兼容）。
 */
export function resolveTenantContext(raw: {
  tenantId?: string | null;
  authenticatedTenantId?: string | null;
  name?: string;
  domain?: string;
}): TenantContext | null {
  const id = raw.authenticatedTenantId || raw.tenantId;
  if (!id) return null;
  const normalized = sanitizeKey(id);
  if (normalized === 'anonymous') return null;
  return { id: normalized, name: raw.name, domain: raw.domain };
}

/**
 * 构造 per-tenant 的复合记忆 key：`<tenantId>::<sessionKey>`。
 * 同 sessionKey 在不同租户下映射到不同后端记录，实现物理隔离；
 * 未提供 tenant 时退化为原始 sessionKey（与今天一致）。
 */
export function tenantSessionKey(tenant: TenantContext | null | undefined, sessionKey: string): string {
  const sk = sanitizeKey(sessionKey);
  if (!tenant) return sk;
  return `${tenant.id}::${sk}`;
}

/**
 * 是否开启「跨行业数据隔离强制」（REQUIRE_TENANT）。
 * 接受 1/true/yes/on（大小写不敏感）为真；缺省 / 其它值为假（向后兼容默认关闭）。
 */
export function isTenantRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.REQUIRE_TENANT ?? '').toString().trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * 跨行业数据隔离强制门禁（P2 投产加固）。
 *
 * 背景：行业合规隔离（记忆分区 + 行业策略画像 + 出网管控）是 **opt-in** —— 仅当携带 tenantId
 * 派生出 tenantCtx 时才生效。若一个非通用（行业）agent 在无租户上下文下执行，医疗 PII /
 * 金融数据会走默认通用通道、无分区、无出网管控，存在合规越界风险。
 *
 * 本门禁在 REQUIRE_TENANT=true 时拦截「路由命中非 generic 行业 agent 但无 tenantCtx」的执行；
 * 通用任务（domain=generic / 无 card）不受影响，向后兼容默认关闭。run-queue / A2A / workflow
 * 三个装配入口一致调用本函数，杜绝任一路径绕过。
 *
 * @returns null 表示放行；否则返回拒绝原因（调用方据此拒绝执行 + 审计 denied）。
 */
export function enforceTenantIsolation(input: {
  /** 路由命中的 agent 领域（null / undefined / 'generic' 视为通用）。 */
  agentDomain?: string | null;
  /** 已解析的租户上下文（null 表示无租户）。 */
  tenant: TenantContext | null;
  /** 是否强制（缺省读 REQUIRE_TENANT env）。 */
  requireTenant?: boolean;
}): { denied: true; reason: string } | null {
  const required = input.requireTenant ?? isTenantRequired();
  if (!required) return null;
  const domain = input.agentDomain ?? 'generic';
  if (domain === 'generic') return null;
  if (input.tenant) return null;
  return {
    denied: true,
    reason: `industry agent (domain=${domain}) requires tenant isolation, but no tenant context was provided (set REQUIRE_TENANT=false to allow, or pass an authenticated tenantId)`,
  };
}
