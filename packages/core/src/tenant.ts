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
