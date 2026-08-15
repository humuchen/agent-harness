// 策略引擎（P0.3 租户隔离）。
//
// 把「护栏策略」从单一全局单例提升为**按租户区分、可叠加行业画像**的分层策略源：
//   default（基础基线）
//     └─ tenant override（租户级定制）
//          └─ industry profile（行业域预置画像，如医疗强脱敏 / 金融禁出境 / 教育放宽）
//
// 设计约定（与 agents/router/tenant 一致）：
//   - getPolicy(tenantId) 在任何 tenant 为空 / 无注册时回退 default，绝不让校验裸奔；
//   - 所有合并都是**浅合并 + 显式 spread**，避免某租户策略意外继承另一租户的字段；
//   - 进程内共享单例 policyEngine，服务启动时可选预注册租户策略。

import type { GuardrailPolicy } from '../guardrails';
import type { IndustryDomain } from '../agents/types';

/** 基础默认策略（与 guardrails 的 DEFAULT_POLICY 对齐，但此处为独立快照，避免耦合其可变单例）。 */
function baseDefaultPolicy(): GuardrailPolicy {
  return {
    maxInputLength: 20000,
    enableSecretScan: true,
    enableInjectionScan: true,
    injectionSensitivity: 'medium',
    enablePiiRedaction: true,
    allowlist: [],
    // network 缺省 open（全部放行），向后兼容。
  };
}

/**
 * 行业域 → 策略画像覆盖项。
 * - medical-aesthetics / healthcare：强 PII 脱敏 + 高敏注入检测（医疗数据合规）。
 * - finance：默认禁止一切外部出网（denylist + `*`，等效「默认不出境」），租户可后续切 allowlist 放行内网/白名单。
 * - education：相对放宽（长输入、低敏、关脱敏，便于自由探索）。
 */
export const INDUSTRY_PROFILES: Record<string, Partial<GuardrailPolicy>> = {
  'medical-aesthetics': {
    enablePiiRedaction: true,
    enableInjectionScan: true,
    injectionSensitivity: 'high',
  },
  healthcare: {
    enablePiiRedaction: true,
    enableInjectionScan: true,
    injectionSensitivity: 'high',
  },
  finance: {
    enablePiiRedaction: true,
    enableSecretScan: true,
    network: { mode: 'denylist', deniedDomains: ['*'] },
  },
  education: {
    maxInputLength: 60000,
    injectionSensitivity: 'low',
    enablePiiRedaction: false,
  },
};

export class PolicyEngine {
  private defaultPolicy: GuardrailPolicy = baseDefaultPolicy();
  private tenantPolicies = new Map<string, GuardrailPolicy>();
  private industryProfiles = new Map<string, Partial<GuardrailPolicy>>(
    Object.entries(INDUSTRY_PROFILES)
  );

  /** 设置全局基线默认策略（通常由服务启动时从配置同步）。 */
  setDefault(p: GuardrailPolicy): void {
    this.defaultPolicy = { ...p };
  }

  /** 注册 / 覆盖某租户的完整策略（与 default 浅合并，调用方负责回填完整对象）。 */
  registerTenantPolicy(tenantId: string, policy: GuardrailPolicy): void {
    if (!tenantId) return;
    this.tenantPolicies.set(tenantId, { ...this.defaultPolicy, ...policy });
  }

  /**
   * 按行业域给某租户套用画像模板（与已注册策略合并：传入 extra 优先于画像，画像优先于 default）。
   * 便于「新建金融租户即自带禁出境」这类开箱即用合规。
   */
  applyIndustryProfile(
    tenantId: string,
    domain: IndustryDomain,
    extra?: Partial<GuardrailPolicy>
  ): void {
    if (!tenantId) return;
    const prof = this.industryProfiles.get(domain);
    const merged: GuardrailPolicy = {
      ...this.defaultPolicy,
      ...(prof ?? {}),
      ...(extra ?? {}),
    };
    this.tenantPolicies.set(tenantId, merged);
  }

  /** 读取某租户策略；无注册 / tenantId 为空或 anonymous 时回退 default。 */
  getPolicy(tenantId?: string | null): GuardrailPolicy {
    if (!tenantId || tenantId === 'anonymous') return this.defaultPolicy;
    return this.tenantPolicies.get(tenantId) ?? this.defaultPolicy;
  }

  /** 列出已注册租户策略 id（调试 / 健康检查）。 */
  listTenantIds(): string[] {
    return [...this.tenantPolicies.keys()];
  }
}

/** 进程内共享单例：服务启动时可选预注册租户策略；runner 在装配时按 tenant 取策略注入 harness。 */
export const policyEngine = new PolicyEngine();
