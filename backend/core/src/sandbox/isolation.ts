/**
 * 执行隔离级别解析（P2.d per-job 隔离执行）。
 *
 * 决策链（「演进而非重写」：全部可选，缺省退化为今天的全局 SANDBOX_BACKEND）：
 *   1) AgentCard.isolation           —— 插件 / 远端 agent 声明自身所需最低隔离；
 *   2) 租户策略 GuardrailPolicy.isolation —— 强合规租户（医疗/金融）强制不低于某级别；
 *   3) env SANDBOX_BACKEND           —— 全局默认后端；
 *   4) 跨行业不可信升级              —— 若承载租户属强合规域（医疗/金融/healthcare）而目标
 *                                      agent 来自不同行业域（跨行业不可信），把隔离级别
 *                                      至少抬到 'os'，杜绝「医疗 PII 与金融数据在弱隔离进程混流」。
 *
 * 这里是纯函数，便于单测；具体「级别 → 真实执行器」的映射仍在 createSandboxExecutor 完成
 * （'os' 在 Linux+helper 下为命名空间/seccomp 隔离，否则自动降级本地硬化进程，符合「一切降级可用」）。
 */

import type { AgentCard } from '../agents/types';
import type { GuardrailPolicy } from '../guardrails';
import { strongerIsolation, type IsolationLevel } from './types';

/** 强合规、要求「数据不出域」的租户行业域；跨行业 agent 对其执行须强制强隔离。 */
const STRICT_DOMAINS = new Set<string>(['medical-aesthetics', 'healthcare', 'finance']);

export interface ResolveIsolationInput {
  /** 目标 agent 卡片（可空，空则退化为租户/env 决策）。 */
  card?: AgentCard | null;
  /** 租户护栏策略（含可选 isolation 强制级别）。 */
  tenantPolicy?: GuardrailPolicy | null;
  /** 租户行业域（用于「跨行业不可信」升级判断）。 */
  tenantDomain?: string | null;
  /** 全局默认后端（通常来自 SANDBOX_BACKEND）。 */
  envBackend?: string | null;
}

/**
 * 解析某次 run 应采用的最终隔离后端。
 * @returns 传给 createSandboxExecutor 的 backend 字符串（'local' | 'container' | 'docker' |
 *          'podman' | 'os' | 'native' 等；此处只产出语义级别，createSandboxExecutor 再归一）。
 */
export function resolveIsolationBackend(input: ResolveIsolationInput): string {
  const envLevel = normalizeLevel(input.envBackend);
  // 1) + 2)：取 card / 租户策略中更强的级别（二者都可选）。
  const fromCard = input.card?.isolation;
  const fromTenant = input.tenantPolicy?.isolation;
  let level = envLevel;
  level = strongerIsolation(level, fromCard);
  level = strongerIsolation(level, fromTenant);

  // 4) 跨行业不可信升级：租户属强合规域，且目标 agent 来自不同行业域（或 generic 未知域）。
  const tenantDomain = input.tenantDomain;
  if (
    tenantDomain &&
    STRICT_DOMAINS.has(tenantDomain) &&
    input.card &&
    input.card.domain !== tenantDomain &&
    input.card.domain !== 'generic'
  ) {
    level = strongerIsolation(level, 'os');
  }

  return level ?? envLevel ?? 'local';
}

/** 把后端字符串归一为语义隔离级别；无法识别的（docker/podman/gvisor/kata）按 container 处理。 */
export function normalizeLevel(backend?: string | null): IsolationLevel | undefined {
  if (!backend) return undefined;
  const b = backend.toLowerCase();
  if (b === 'none') return 'none';
  if (b === 'local') return 'local';
  if (b === 'os' || b === 'native') return 'os';
  if (b === 'container' || b === 'docker' || b === 'podman' || b === 'gvisor' || b === 'kata') return 'container';
  return undefined;
}