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

import {
  registerInputRule,
  registerOutputRule,
  registerContextualOutputRule,
  type GuardrailOutputContext,
  type GuardrailResult,
} from '@agent-harness/core';

/** 医疗广告法违规模式（输入/输出共用同一组）。统一打 scope='medical-ad'，
 *  使本组规则仅在运行策略的 scopes 含 'medical-ad'（即医美 agent）时生效，
 *  默认/generic agent 传 scopes:[] 即自动排除，杜绝「没选医美 agent 也被拦」的误伤。 */
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
    re: /你这(是|应该|可能|就是|多半是).{0,8}(炎|病|症|囊肿|增生|下垂|畸形|过敏|肌无力)/,
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

/** 本插件注册的所有规则统一作用域标签。 */
export const MEDICAL_AD_SCOPE = 'medical-ad';

/**
 * 知识库查空硬拦截（输出侧护栏）：当 project_kb_search 返回 found:false（知识库未收录）时，
 * 仅凭 prompt 纪律不足以阻止模型自行编造项目/疗程/功效/恢复期推荐，故在此做硬保障。
 * 命中即拦截，回复回退为「建议预约面诊」。词表刻意只覆盖「具体项目/治疗手段」，
 * 避开纯诉求词（黑头/闭口/出油），以降低对正常面诊引导话术的误伤。
 */
const KB_EMPTY_PROJECT_HINT_RE =
  /化学焕肤|果酸|小气泡|光子嫩肤|光子|M22|点阵激光|二氧化碳激光|皮秒|超皮秒|微针|中胚层|水光|热玛吉|超声炮|超声刀|线雕|埋线|玻尿酸|肉毒素|瘦脸针|除皱针|植发|种睫毛|纹眉|半永久|激光脱毛|酷塑|溶脂|吸脂|双眼皮|开眼角|隆鼻|隆胸|私密|妊娠纹|瘢痕|疤痕|黄褐斑|红血丝|刷酸|清痘/;

/**
 * 解析 project_kb_search 的工具结果，兼容「对象 JSON」与「二次 stringify」两种形态，
 * 统一返回 { found, answer }（无法解析时返回 null）。检测 found:false 与提取 answer
 * 共用此解析，保证两层逻辑对序列化形态的处理一致。
 */
function parseKbResult(result: string): { found: unknown; answer?: string } | null {
  let obj: unknown = undefined;
  try {
    obj = JSON.parse(result);
    if (typeof obj === 'string') obj = JSON.parse(obj); // 二次 stringify 兜底
  } catch {
    return null;
  }
  if (obj && typeof obj === 'object') return obj as { found: unknown; answer?: string };
  return null;
}

/** 上下文感知规则：知识库查空后禁止模型输出任何具体项目推荐。 */
function kbEmptyGuard(text: string, ctx: GuardrailOutputContext): GuardrailResult {
  const tool = ctx.recentTool;
  if (!tool) return { ok: true };
  // 仅针对 project_kb_search（MCP 前缀形如 xxx__project_kb_search）。
  if (!/project_kb_search/.test(tool.name)) return { ok: true };
  // 解析工具结果：found===false 才视为「知识库未收录」；found:true 属正常命中，放行。
  const parsed = parseKbResult(tool.result);
  if (!parsed || parsed.found !== false) return { ok: true };
  if (KB_EMPTY_PROJECT_HINT_RE.test(text)) {
    const safeReply = typeof parsed.answer === 'string' ? parsed.answer : undefined;
    return {
      ok: false,
      reason:
        '医疗广告法：project_kb_search 返回 found:false（知识库未收录），不得自行推荐任何项目/功效/恢复期，仅可引导预约面诊',
      ...(safeReply ? { safeReply } : {}),
    };
  }
  return { ok: true };
}

let registered = false;

/**
 * 注册医疗广告合规护栏（幂等）。任一插件 setup 时调用一次即可；
 * 客服与客资插件都调用本函数，互不影响，也不会重复注册。
 */
export function registerMedicalAdGuardrail(): void {
  if (registered) return;
  for (const r of MEDICAL_AD_RULES) {
    registerInputRule(r.re, r.reason, MEDICAL_AD_SCOPE);
    registerOutputRule(r.re, r.reason, MEDICAL_AD_SCOPE);
  }
  registerContextualOutputRule(kbEmptyGuard, MEDICAL_AD_SCOPE);
  registered = true;
}

export const medicalAdRules = MEDICAL_AD_RULES;
