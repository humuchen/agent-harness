/**
 * 医疗广告合规护栏（可插拔、跨插件共用）。
 *
 * 设计要点：
 * - 本包**不含任何 harness 业务语义决策**，只把「医疗广告法」相关违规模式注册进
 *   core 的通用 guardrails（registerInputRule / registerOutputRule）。core 保持零业务词，
 *   业务规则集中在可独立版本化的本包。
 * - 规则刻意**足够具体**，避免误伤普通电商客服（如「我们保证退款」不应被医疗规则拦截）：
 *   仅命中「疗效/安全绝对化 + 医疗语境」「诊断式话术」「术前术后真人对比」「固定价承诺」等。
 * - 输入/输出双向注册：既防止用户诱导模型作承诺（输入），也拦截模型最终输出（输出）。
 * - 幂等：进程内只注册一次（双插件调用安全）。
 */

import { registerInputRule, registerOutputRule } from '@agent-harness/core';

/** 医疗广告法违规模式（输入/输出共用同一组）。 */
const MEDICAL_AD_RULES: Array<{ re: RegExp; reason: string }> = [
  // 1) 疗效/安全绝对化承诺（带医疗语境）
  {
    re: /保证.{0,10}(不留疤|不失败|不反弹|不疼痛|不出血|成功|安全|有效|无风险|无副作用|零风险)/,
    reason: '医疗广告法：不得对功效、安全性作绝对化保证（如「保证不留疤/绝对安全」）',
  },
  {
    re: /(100%|百分百|绝对|一定|肯定).{0,10}(成功|安全|有效|无风险|不留疤|不失败|根治)/,
    reason: '医疗广告法：不得使用「100%/绝对/肯定」等表示功效、安全性的断言用语',
  },
  // 2) 诊断式话术（模型不得代替医生诊断）
  {
    re: /你这(是|应该|可能|就是|多半是).{0,8}(炎|病|症|囊肿|增生|下垂|畸形|过敏)/,
    reason: '医疗广告法：AI 不得作诊断结论，应引导面诊',
  },
  {
    re: /(术前|术后).{0,8}(对比|真人|案例|效果图|前后照)/,
    reason: '医疗广告法：不得使用患者术前术后形象作证明/对比',
  },
  // 3) 固定价承诺（应用区间/起）
  {
    re: /价格(只要|仅|固定|包干|一口价).{0,12}\d+\s*(元|块|rmb)/i,
    reason: '医疗广告法：价格应示区间或「起」，不得承诺固定价',
  },
  // 4) 贬低同业 / 虚构资质
  {
    re: /(别去|千万别去|那家.{0,6}不行|比.{0,4}(某某|别家).{0,6}(好|强|便宜))/,
    reason: '医疗广告法：不得贬低其他医疗机构或作不实比较',
  },
];

let registered = false;

/**
 * 注册医疗广告合规护栏（幂等）。任一插件 setup 时调用一次即可；
 * 客服与客资插件都调用本函数，互不影响，也不会重复注册。
 */
export function registerMedicalAdGuardrail(): void {
  if (registered) return;
  for (const r of MEDICAL_AD_RULES) {
    registerInputRule(r.re, r.reason);
    registerOutputRule(r.re, r.reason);
  }
  registered = true;
}

export const medicalAdRules = MEDICAL_AD_RULES;
