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
 * 行业域 → 策略画像覆盖项（P2.c 强化：标注合规框架 / 数据驻留 / 审计要求 / 最低隔离级别）。
 * - medical-aesthetics / healthcare：强 PII 脱敏 + 高敏注入检测（医疗数据合规，等保 + 个保法）；
 *   数据须国内驻留、强制审计、最低以 OS 级隔离执行（PII 不出进程）。
 * - finance：默认禁止一切外部出网（denylist + `*`，等效「默认不出境」，符合金融数据出境安全评估）；
 *   数据须国内驻留、强制审计、最低以 OS 级隔离执行。
 * - education：相对放宽（长输入、低敏、关脱敏，便于自由探索），隔离沿用默认 local。
 *
 * 这些画像经 `applyIndustryProfile(tenantId, domain)` 透明叠加到某租户策略之上，使「新建金融 /
 * 医疗租户即自带合规基线」开箱即用；`registerIndustryProfiles()` 可在服务启动时统一自检注册。
 */
export const INDUSTRY_PROFILES: Record<string, Partial<GuardrailPolicy>> = {
  'medical-aesthetics': {
    enablePiiRedaction: true,
    enableInjectionScan: true,
    injectionSensitivity: 'high',
    enableSecretScan: true,
    compliance: {
      framework: '等保三级 + 个人信息保护法',
      dataResidency: 'domestic',
      auditRequired: true,
      piiRetentionDays: 30,
    },
    isolation: 'os',
  },
  healthcare: {
    enablePiiRedaction: true,
    enableInjectionScan: true,
    injectionSensitivity: 'high',
    enableSecretScan: true,
    compliance: {
      framework: '等保三级 + 个人信息保护法',
      dataResidency: 'domestic',
      auditRequired: true,
      piiRetentionDays: 30,
    },
    isolation: 'os',
  },
  finance: {
    enablePiiRedaction: true,
    enableSecretScan: true,
    network: { mode: 'denylist', deniedDomains: ['*'] },
    compliance: {
      framework: '金融行业数据安全 + 数据出境安全评估',
      dataResidency: 'domestic',
      auditRequired: true,
    },
    isolation: 'os',
  },
  education: {
    maxInputLength: 60000,
    injectionSensitivity: 'low',
    enablePiiRedaction: false,
    compliance: {
      framework: '教育行业基线（放宽）',
      dataResidency: 'any',
      auditRequired: false,
    },
    isolation: 'local',
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

  /**
   * 引导注册全部预置行业合规画像（P2.c）。幂等：以 `INDUSTRY_PROFILES` 为权威源重新同步
   * 进程内 `industryProfiles` 表，确保服务重启后画像不丢失（构造期已 seed，这里用于显式引导
   * 与自检）。返回已注册的画像域名列表。
   */
  registerIndustryProfiles(): string[] {
    for (const [domain, prof] of Object.entries(INDUSTRY_PROFILES)) {
      this.industryProfiles.set(domain, prof);
    }
    return [...this.industryProfiles.keys()];
  }

  /** 列出全部预置行业合规画像（含框架 / 数据驻留 / 审计 / 隔离级别），供治理端点展示。 */
  listIndustryProfiles(): Array<{ domain: string; profile: Partial<GuardrailPolicy> }> {
    return [...this.industryProfiles.entries()].map(([domain, profile]) => ({ domain, profile }));
  }
}

/** 进程内共享单例：服务启动时可选预注册租户策略；runner 在装配时按 tenant 取策略注入 harness。 */
export const policyEngine = new PolicyEngine();
