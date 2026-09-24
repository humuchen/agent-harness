/**
 * per-tenant guardrails 引擎注册表（③ P2）。
 *
 * 职责：为每个租户提供**独立的** GuardrailsEngine 实例（策略 = 部署级默认
 * resolveDefaultPolicy() 叠加 policyEngine 租户策略/行业画像），TTL 缓存避免
 * 每 run 重建；租户间互不影响——A 租户收紧不再波及 B 租户。
 *
 * resolve 链：租户显式策略（policyEngine，含行业画像）> 部署级 env 默认 > 内置 DEFAULT。
 * 兼容说明：runner 旧的「每 run 直接 policyEngine.getPolicy(tenantId)」路径继续可用；
 * 本注册表提供引擎身份（实例）与缓存收敛，供逐步统一到单一解析点。
 */
import { GuardrailsEngine, resolveDefaultPolicy, type GuardrailPolicy } from './guardrails';
import { policyEngine } from './policy/engine';

interface RegistryEntry {
  engine: GuardrailsEngine;
  fetchedAt: number;
}

const registry = new Map<string, RegistryEntry>();
const TENANT_ENGINE_TTL_MS = 30_000;

/**
 * 取某租户的护栏引擎（TTL 缓存；无租户/anonymous 回退全局默认引擎）。
 * TTL 过期时同步返回旧实例并后台重建——热路径不阻塞，配置变更 30s 内最终一致。
 */
export function getGuardrailsForTenant(tenantId: string | null | undefined): GuardrailsEngine {
  if (!tenantId || tenantId === 'anonymous') {
    // 延迟 import 会引入循环依赖，这里直接用引擎类包一层当前默认策略。
    // 全局默认策略由 guardrails 模块自己管理（configureGuardrails 双写）。
    return defaultTenantlessEngine();
  }
  const hit = registry.get(tenantId);
  if (hit) {
    if (Date.now() - hit.fetchedAt < TENANT_ENGINE_TTL_MS) return hit.engine;
    // 过期：后台重建，本调用先用旧实例
    void buildEngine(tenantId);
    return hit.engine;
  }
  // 首次：同步构建（policyEngine.getPolicy 是同步内存读，无 IO）
  const engine = buildEngineSync(tenantId);
  registry.set(tenantId, { engine, fetchedAt: Date.now() });
  return engine;
}

/** 取某租户的护栏策略快照（供 runner 每次装配用；等价 getGuardrailsForTenant(...).policy）。 */
export function resolveTenantGuardrailPolicy(tenantId: string | null | undefined): GuardrailPolicy {
  return getGuardrailsForTenant(tenantId).policy;
}

function buildEngineSync(tenantId: string): GuardrailsEngine {
  const merged: GuardrailPolicy = {
    ...resolveDefaultPolicy(),
    ...policyEngine.getPolicy(tenantId),
  };
  return new GuardrailsEngine(merged);
}

function buildEngine(tenantId: string): void {
  registry.set(tenantId, { engine: buildEngineSync(tenantId), fetchedAt: Date.now() });
}

/** 无租户场景：用当前部署默认策略构建独立引擎（不进租户注册表）。 */
function defaultTenantlessEngine(): GuardrailsEngine {
  return new GuardrailsEngine(resolveDefaultPolicy());
}

/** 测试用：清空注册表。 */
export function resetTenantGuardrailsForTest(): void {
  registry.clear();
}
