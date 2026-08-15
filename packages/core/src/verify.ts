import type { ToolCall } from './types';

/**
 * 运行期自动验证门禁（P0-2）。
 *
 * 把「一次运行是否通过验证」抽象为可插拔的 `Verifier`：
 *   - RuleBasedVerifier：复用 server 端评估器的「过程质量」逻辑（护栏未拦截 / 预算未超限 /
 *     有最终回答 / 调用了工具 / 有步骤），作为默认过程门禁。
 *   - assertionsVerifier / specsVerifier：基于断言校验「结果正确性」（如最终回答需包含某串、
 *     匹配某正则、长度区间）——这是原评估体系缺失的「结果级」校验。
 *   - composeVerifiers：多验证器 AND 组合。
 *   - createVerifier：从可序列化配置装配（供 server 经 run job 透传）。
 *
 * 该契约与具体 LLM/业务无关，可由 harness 在产出最终答案后自动调用；未通过时 harness
 * 可据此重试（self-correction）或标记返回，使「自验证」从运维手动触发变为运行期自动门禁。
 */

/** 验证上下文：harness 在收尾时把本轮关键信号喂给验证器。 */
export interface VerifyContext {
  /** 用户原始输入。 */
  input: string;
  /** 模型最终回答（已脱敏）。 */
  final: string;
  /** 实际执行的步数。 */
  steps: number;
  /** 本轮所有工具调用。 */
  toolCalls: ToolCall[];
  /** 被护栏拦截的次数。 */
  guardrailsBlocked: number;
  /** 是否触发预算熔断。 */
  budgetExceeded: boolean;
}

export interface VerifyOutcome {
  /** 是否通过。 */
  passed: boolean;
  /** 0..1 评分。 */
  score: number;
  /** 可解释的原因列表。 */
  reasons: string[];
}

/** 验证器契约：输入上下文，输出通过与否与原因。可同步或异步。 */
export type Verifier = (ctx: VerifyContext) => VerifyOutcome | Promise<VerifyOutcome>;

/** 过程质量门禁：校验运行「健康度」（非结果正确性）。默认门禁实现。 */
export const RuleBasedVerifier: Verifier = (ctx) => {
  const reasons: string[] = [];
  let score = 1;
  let hardFail = false;

  if (ctx.guardrailsBlocked > 0) {
    hardFail = true;
    score = 0;
    reasons.push(`护栏拦截 ${ctx.guardrailsBlocked} 次（硬性不通过）`);
  }
  if (ctx.budgetExceeded) {
    hardFail = true;
    score = 0;
    reasons.push('预算超限（硬性不通过）');
  }
  if (!ctx.final || !ctx.final.trim()) {
    hardFail = true;
    score = 0;
    reasons.push('无最终回答（硬性不通过）');
  } else {
    reasons.push('产出非空最终回答');
  }
  if (ctx.toolCalls.length === 0) {
    score -= 0.3;
    reasons.push('本轮未调用任何工具（可能是纯对话）');
  } else {
    reasons.push(`调用工具 ${ctx.toolCalls.length} 个`);
  }
  if (ctx.steps <= 0) {
    score -= 0.1;
    reasons.push('无明确步骤');
  } else {
    reasons.push(`执行 ${ctx.steps} 步`);
  }
  score = Math.max(0, Math.min(1, score));
  return { score: Number(score.toFixed(3)), passed: !hardFail && score >= 0.5, reasons };
};

/** 断言函数：基于上下文返回是否通过。 */
export type Assertion = (ctx: VerifyContext) => boolean | Promise<boolean>;

/** 基于断言列表的验证器（结果正确性校验）。全部断言通过才算通过。 */
export function assertionsVerifier(assertions: Assertion[]): Verifier {
  return async (ctx) => {
    const reasons: string[] = [];
    let passed = true;
    let n = 0;
    for (const a of assertions) {
      n += 1;
      let ok = false;
      try {
        ok = await a(ctx);
      } catch {
        ok = false;
      }
      if (!ok) {
        passed = false;
        reasons.push(`断言 #${n} 未通过`);
      }
    }
    if (assertions.length === 0) reasons.push('无断言（跳过结果校验）');
    else if (passed) reasons.push(`全部 ${assertions.length} 项断言通过`);
    return {
      passed,
      score: assertions.length === 0 ? 1 : passed ? 1 : 0,
      reasons,
    };
  };
}

/** 可序列化断言规格（适合经 run job / 网络透传）。 */
export interface AssertSpec {
  /** 最终回答须包含此子串。 */
  contains?: string;
  /** 最终回答不得包含此子串。 */
  notContains?: string;
  /** 最终回答须匹配此正则（source 串）。 */
  matches?: string;
  /** 最小长度。 */
  minLength?: number;
  /** 最大长度。 */
  maxLength?: number;
}

function specToPredicate(spec: AssertSpec): Assertion {
  return (ctx) => {
    const t = ctx.final;
    if (spec.contains != null && !t.includes(spec.contains)) return false;
    if (spec.notContains != null && t.includes(spec.notContains)) return false;
    if (spec.matches != null) {
      try {
        if (!new RegExp(spec.matches).test(t)) return false;
      } catch {
        return false;
      }
    }
    if (spec.minLength != null && t.length < spec.minLength) return false;
    if (spec.maxLength != null && t.length > spec.maxLength) return false;
    return true;
  };
}

/** 由可序列化规格列表构建验证器。 */
export function specsVerifier(specs: AssertSpec[]): Verifier {
  return assertionsVerifier(specs.map(specToPredicate));
}

/** 组合多个验证器：全部通过才通过，分数取最低。 */
export function composeVerifiers(...verifiers: Verifier[]): Verifier {
  return async (ctx) => {
    const reasons: string[] = [];
    let passed = true;
    let score = 1;
    for (const v of verifiers) {
      const r = await v(ctx);
      passed = passed && r.passed;
      score = Math.min(score, r.score);
      reasons.push(...r.reasons);
    }
    return { passed, score, reasons };
  };
}

/** 可序列化的验证配置（server 经 run job 透传）。 */
export interface VerifyConfig {
  /** 启用规则过程门禁（等同于 ruleBased）。 */
  auto?: boolean;
  /** 显式别名：启用规则过程门禁。 */
  ruleBased?: boolean;
  /** 结果断言规格（校验「结果正确性」）。 */
  assertions?: AssertSpec[];
}

/** 从配置装配验证器；无任何启用项时返回 undefined（harness 据此关闭门禁）。 */
export function createVerifier(cfg: VerifyConfig | undefined): Verifier | undefined {
  if (!cfg) return undefined;
  const parts: Verifier[] = [];
  if (cfg.auto || cfg.ruleBased) parts.push(RuleBasedVerifier);
  if (cfg.assertions && cfg.assertions.length) parts.push(specsVerifier(cfg.assertions));
  if (parts.length === 0) return undefined;
  return composeVerifiers(...parts);
}
