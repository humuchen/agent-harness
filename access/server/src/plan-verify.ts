/**
 * P4.5 计划桥「默认验证门禁」的纯决策模块（可独立单测、无副作用）。
 *
 * 背景：`resolveWorkflowRunOpts` 内联了 P0-2 验证优先级链（body.verify > body.autoVerify >
 * 服务端 AGENT_AUTO_VERIFY）。P4.5 在 plan 桥路径补一层默认门禁：未显式指定 verify 时，
 * 回落「确定性结果断言」（零 LLM 成本）把跑题 / 空 / 截断产出拦在写黑板之前。
 *
 * 把这段「读 body 字段 + env 标志 → 产出 verify 选项」的纯决策抽出，使测试不必引入
 * 凭据解析链（provider-keys / custom-models 的 SQLite 副作用）；server.ts 仅做薄封装。
 */
import type { VerifyConfig, AssertSpec } from '@agent-harness/core';
import { GUARDRAIL_FALLBACK_PREFIX, PARTIAL_NOTICE } from '@agent-harness/core';

/** P4.5 确定性结果断言（零 LLM 成本）：拦「跑题 / 空 / 截断 / 护栏兜底」产出。 */
export const PLAN_DEFAULT_ASSERTIONS: AssertSpec[] = [
  { notContains: GUARDRAIL_FALLBACK_PREFIX },
  { notContains: PARTIAL_NOTICE },
  { minLength: 20 }
];

export interface PlanVerifyInput {
  /** 是否计划桥路径（POST /api/workflows 携带 body.plan）。 */
  isPlan: boolean;
  /** body.verify（原始值，类型判定在此进行）。 */
  bodyVerify: unknown;
  /** body.autoVerify（boolean 显式开关）。 */
  bodyAutoVerify: unknown;
  /** 服务端 AGENT_AUTO_VERIFY 是否开启（env，调用方预解析传入）。 */
  envAutoVerify: boolean;
  /** AGENT_PLAN_VERIFY_RETRIES 解析值（调用方经 parsePlanVerifyRetries 传入）。 */
  planVerifyRetries: number;
}

export interface PlanVerifyResult {
  /** 最终 verify 配置（可能为 undefined = 门禁关闭）。 */
  verifyConfig: VerifyConfig | undefined;
  /**
   * 验证重试预算覆盖：仅「plan 默认门禁命中」时注入（显式 body.verify / body.autoVerify
   * 保持 AGENT_VERIFY_MAX_RETRIES 存量语义，不覆盖）。
   */
  verifyMaxRetries: number | undefined;
  /** 是否启用逐 task 结果断言（taskMeta.outputChecks → per-step contains 断言）。 */
  planOutputChecks: boolean;
}

/**
 * 决策：验证优先级链 + P4.5 plan 默认门禁。
 *  - body.verify（非空对象）→ 原样采用（显式，含 autoVerify 语义由调用方保证）。
 *  - body.autoVerify（boolean）→ 显式开 / 关。
 *  - envAutoVerify → 服务端默认 auto。
 *  - isPlan 且以上皆未显式指定 → 回落确定性默认门禁（auto + PLAN_DEFAULT_ASSERTIONS，
 *    重试预算 = planVerifyRetries，并开启逐 task 结果断言）。
 *  非 plan 路径 → 行为与旧版逐字一致（零回归）。
 */
export function resolvePlanVerify(inp: PlanVerifyInput): PlanVerifyResult {
  let verifyConfig: VerifyConfig | undefined;
  let verifyExplicit = false;
  if (inp.bodyVerify && typeof inp.bodyVerify === 'object' && !Array.isArray(inp.bodyVerify)) {
    verifyConfig = inp.bodyVerify as VerifyConfig;
    verifyExplicit = true;
  } else if (typeof inp.bodyAutoVerify === 'boolean') {
    verifyConfig = inp.bodyAutoVerify ? { auto: true } : undefined;
    verifyExplicit = true;
  } else if (inp.envAutoVerify) {
    verifyConfig = { auto: true };
  }

  // P4.5：plan 桥逐 task 结果断言（taskMeta.outputChecks）——仅 plan 路径启用；
  // 即使显式传了 body.verify 也照样生效（结果断言与过程门禁正交，叠加不冲突）。
  const planOutputChecks = inp.isPlan;

  // P4.5：plan 默认门禁（仅当 plan 且未显式指定 verify 时回落）。
  let verifyMaxRetries: number | undefined;
  if (inp.isPlan && !verifyExplicit && verifyConfig === undefined) {
    verifyConfig = { auto: true, assertions: PLAN_DEFAULT_ASSERTIONS, assertionLabel: '默认门禁' };
    verifyMaxRetries = inp.planVerifyRetries;
  }

  return { verifyConfig, verifyMaxRetries, planOutputChecks };
}

/** 解析 AGENT_PLAN_VERIFY_RETRIES（缺省 1 = 未通过自检重跑 1 次；置 0 仅标记不重跑）。 */
export function parsePlanVerifyRetries(raw: string | undefined): number {
  const n = raw === undefined ? 1 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
