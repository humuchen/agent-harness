// 自定义规则注册表（输入/输出/上下文感知输出/注入打分器）与 scope 收窄判定。
// P1#21 拆分自 guardrails.ts。模块级注册表是设计约定（插件全局注册 + scope 收窄，
// 非租户私有状态）——拆文件后必须保持同一实例：本模块是唯一真相源，checks.ts 引用。
import { jevScoreInjection } from '../builtins/typesafe-jev';
import type {
  ContextualOutputRule,
  GuardrailOutputContext,
  GuardrailPolicy,
  InjectionScorer,
} from './types';

// ---------------------------------------------------------------------------
// 自定义输入规则（向后兼容）
// ---------------------------------------------------------------------------

export const customInputRules: { re: RegExp; reason: string; scope?: string; normalize?: boolean }[] = [];

/**
 * 注册一条自定义输入校验规则（命中即拦截）。
 * @param scope 可选作用域标签（如 'medical-ad'）。传入后该规则仅当运行策略的
 *   `scopes` 包含此标签时才生效；不传则始终生效（全局安全底线）。
 * @param opts.normalize 为 true 时对 hardenText(text)（全半角折叠/去零宽/去符号与
 *   空白，仅保留字母数字与 `%`）做匹配而非原文 —— 对抗「保~证不留疤」式分隔符
 *   混淆。规则 pattern 应按硬化后文本编写（连续、无空白分隔）。
 * @returns 反注册函数（调用后规则立即失效；领域词库热更新用）。
 */
export function registerInputRule(
  re: RegExp,
  reason: string,
  scope?: string,
  opts?: { normalize?: boolean }
): () => void {
  const entry = { re, reason, scope, normalize: opts?.normalize };
  customInputRules.push(entry);
  return () => {
    const i = customInputRules.indexOf(entry);
    if (i >= 0) customInputRules.splice(i, 1);
  };
}

// ---------------------------------------------------------------------------
// 自定义输出规则（与输入规则对称；供业务插件注册领域合规过滤，如医疗广告法）
// ---------------------------------------------------------------------------

export const customOutputRules: { re: RegExp; reason: string; scope?: string; normalize?: boolean }[] = [];

/**
 * 注册一条自定义输出校验规则（命中即拦截模型最终输出）。
 * @param scope 可选作用域标签（如 'medical-ad'）。传入后该规则仅当运行策略的
 *   `scopes` 包含此标签时才生效；不传则始终生效（全局安全底线）。
 * @param opts.normalize 语义同 registerInputRule。
 * @returns 反注册函数（调用后规则立即失效；领域词库热更新用）。
 */
export function registerOutputRule(
  re: RegExp,
  reason: string,
  scope?: string,
  opts?: { normalize?: boolean }
): () => void {
  const entry = { re, reason, scope, normalize: opts?.normalize };
  customOutputRules.push(entry);
  return () => {
    const i = customOutputRules.indexOf(entry);
    if (i >= 0) customOutputRules.splice(i, 1);
  };
}

// ---------------------------------------------------------------------------
// 上下文感知输出规则（P0.x）：可据「最近一次工具调用」等业务上下文做精准拦截，
// 突破纯文本正则无法感知会话状态的局限。例如：知识库查空后禁止模型自行推荐项目。
// core 只透传通用上下文（recentTool），具体业务判定由领域插件（如 medical-ad-guard）注册。
// ---------------------------------------------------------------------------

export const customContextualOutputRules: { fn: ContextualOutputRule; scope?: string }[] = [];

/**
 * 注册一条上下文感知的输出校验规则（命中即拦截模型最终输出）。
 * 与 registerOutputRule（纯文本正则）互补：可据 recentTool 等上下文做精准判定。
 * @param scope 可选作用域标签（如 'medical-ad'）。传入后该规则仅当运行策略的
 *   `scopes` 包含此标签时才生效；不传则始终生效。
 * @returns 反注册函数（调用后规则立即失效；领域规则热更新用）。
 */
export function registerContextualOutputRule(fn: ContextualOutputRule, scope?: string): () => void {
  const entry = { fn, scope };
  customContextualOutputRules.push(entry);
  return () => {
    const i = customContextualOutputRules.indexOf(entry);
    if (i >= 0) customContextualOutputRules.splice(i, 1);
  };
}

/**
 * 业务自定义规则是否对当前策略生效（按 scope 收窄）。
 * - 规则未声明 scope → 始终生效（全局安全底线 / 业务方希望全局适用）；
 * - 调用方未传 scopes（旧路径、测试）→ 不收窄，全部生效（向后兼容）；
 * - 调用方传了 scopes 数组 → 仅当 ruleScope ∈ scopes 时生效。
 */
export function ruleInScope(ruleScope: string | undefined, pol?: GuardrailPolicy): boolean {
  if (!ruleScope) return true;
  if (!pol || !Array.isArray(pol.scopes)) return true;
  return pol.scopes.includes(ruleScope);
}

// ---------------------------------------------------------------------------
// 语义级注入打分器注册（可接分类模型 / 第三方服务，如 Jev）
// ---------------------------------------------------------------------------

export const customInjectionScorers: InjectionScorer[] = [];

/** 注册一个语义级注入打分器（返回 0~1）。返回 >0.5 即视为注入。 */
export function registerInjectionScorer(fn: InjectionScorer): void {
  customInjectionScorers.push(fn);
}

let jevInjectionEnabled = false;
/**
 * 启用 Jev 语义级注入打分（危险操作门禁增强）。
 * 仅在 JEV_INJECTION_GATE 开启时由 server 调用；注册一个异步打分器，复用
 * jevScoreInjection（未配置 Key / 出错时返回 0，天然回落正则基线）。
 * 旧的正则 / 短语基线始终先执行（check*Async 先跑同步分支），Jev 仅作语义层增补；
 * Jev 出错或超时也回落基线，符合「旧逻辑兜底」。
 */
export function enableJevInjection(): void {
  if (jevInjectionEnabled) return;
  jevInjectionEnabled = true;
  registerInjectionScorer(async (text) => jevScoreInjection(text));
}

/** 供类型引用的上下文形态（占位导出避免未用 import 告警；GuardrailOutputContext 在 types.ts）。 */
export type { GuardrailOutputContext };
