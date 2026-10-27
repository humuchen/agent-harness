// 对外校验接口（签名与行为与拆分前逐条一致）。P1#21 拆分自 guardrails.ts。
// 组合：detection（注入）+ registry（自定义规则/scope）+ audit（命中留痕）+
// harden（对抗归一化）+ egress（出网管控）+ policy state（模块级策略兜底）。
import type { GuardrailOutputContext, GuardrailPolicy, GuardrailResult } from './types';
import { detectInjection, detectInjectionAsync } from './detection';
import { hardenText } from './harden';
import { checkEgress, checkEgressAsync } from './egress';
import { redactPII } from './pii';
import {
  customContextualOutputRules,
  customInputRules,
  customOutputRules,
  ruleInScope,
} from './registry';
import { emitRuleHit, hasAuditSinks } from './audit';
import { getModulePolicy, PLAN_MAX_INPUT_LENGTH } from './policy';

// ---------------------------------------------------------------------------
// 密钥扫描
// ---------------------------------------------------------------------------

export const SECRET_PATTERNS: RegExp[] = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bpassword\s*[:=]\s*\S+/i,
  /\bsecret\s*[:=]\s*\S+/i,
  /\bapi[_-]?key\s*[:=]\s*\S+/i,
  /\btoken\s*[:=]\s*[A-Za-z0-9._-]{16,}/i,
];

// ── G4b 共享扫描原语：四个 check 的 secret 扫描与两个 check 的自定义规则遍历
// 此前逐字复制（改文案需同步 4 处），收敛为单一实现 ──

/** 密钥扫描：命中返回拒绝结果，否则 null。phase 决定 reason 文案（input/output）。 */
function scanSecretPatterns(
  patterns: RegExp[],
  text: string,
  phase: 'input' | 'output'
): GuardrailResult | null {
  for (const re of patterns) {
    if (re.test(text)) return { ok: false, reason: `possible secret in ${phase}` };
  }
  return null;
}

/**
 * 自定义规则遍历（G4b 共享原语）：scope 收窄 → normalize 惰性硬化（共享一次计算，
 * 无 normalize 规则时零开销）→ 命中即 emit 审计并返回拒绝结果；无命中返回 null。
 * checkInput / checkOutput 的规则段此前逐字相同（仅 side 与规则数组不同）。
 */
function scanCustomRules(
  rules: { re: RegExp; reason: string; scope?: string; normalize?: boolean }[],
  text: string,
  side: 'input' | 'output',
  pol: GuardrailPolicy
): GuardrailResult | null {
  let hardened: string | null = null;
  for (const r of rules) {
    if (!ruleInScope(r.scope, pol)) continue;
    if (r.normalize) {
      if (hardened === null) hardened = hardenText(text);
      if (r.re.test(hardened)) {
        if (hasAuditSinks()) emitRuleHit(side, r.scope, r.re, hardened, r.reason);
        return { ok: false, reason: r.reason };
      }
    } else if (r.re.test(text)) {
      if (hasAuditSinks()) emitRuleHit(side, r.scope, r.re, text, r.reason);
      return { ok: false, reason: r.reason };
    }
  }
  return null;
}

export function checkInput(
  text: string,
  pol?: GuardrailPolicy,
  /**
   * 强信号模式（计划任务派发专用）：仅用句子级强信号短语（PHRASES_LOW）做注入检测，
   * 跳过 'system prompt' 等 medium 弱信号短短语 —— 与输出侧 checkTaskOutput 对称。
   * 计划任务的步骤描述合理地提到「阅读 system prompt 文档 / 优化 system prompt」，
   * 弱信号命中会把整次任务派发拦死；安全底线（真密钥格式 + 强信号注入）不放松。
   */
  strongOnly = false,
  /**
   * 是否为计划任务输入。当 isPlanTask 且部署显式配置了 GUARDRAIL_PLAN_MAX_INPUT 时，
   * 计划类输入（需求文档）允许更长（见下方 plan 分支，取 max(通用上限, 配置值)），
   * 避免被通用 maxInputLength 长度闸误拦；未配置该环境变量时本标志不生效，沿用通用上限。
   * 该标志默认跟随 strongOnly（harness 把 planTask 当作 strongOnly 透传），
   * 现有 plan 派发 / 回退路径无需改动即生效。
   */
  isPlanTask = strongOnly
): GuardrailResult {
  const p = pol ?? getModulePolicy();
  if (typeof text !== 'string') {
    return { ok: false, reason: 'input must be a string' };
  }
  const maxLen =
    isPlanTask && PLAN_MAX_INPUT_LENGTH != null
      ? Math.max(p.maxInputLength, PLAN_MAX_INPUT_LENGTH)
      : p.maxInputLength;
  if (text.length > maxLen) {
    return { ok: false, reason: `input too long (${text.length} > ${maxLen})` };
  }
  if (p.enableSecretScan) {
    const secret = scanSecretPatterns(SECRET_PATTERNS, text, 'input');
    if (secret) return secret;
  }
  const inj = detectInjection(text, p, strongOnly);
  if (inj) return { ok: false, reason: `possible prompt injection in input (matched: ${inj})` };
  const ruleHit = scanCustomRules(customInputRules, text, 'input', p);
  if (ruleHit) return ruleHit;
  return { ok: true };
}

export function checkOutput(
  text: string,
  pol?: GuardrailPolicy,
  ctx?: GuardrailOutputContext
): GuardrailResult {
  const p = pol ?? getModulePolicy();
  if (typeof text !== 'string') return { ok: true };
  if (p.enableSecretScan) {
    const secret = scanSecretPatterns(SECRET_PATTERNS, text, 'output');
    if (secret) return secret;
  }
  const inj = detectInjection(text, p);
  if (inj) return { ok: false, reason: `possible prompt injection in output (matched: ${inj})` };
  const ruleHit = scanCustomRules(customOutputRules, text, 'output', p);
  if (ruleHit) return ruleHit;
  // 上下文感知规则：仅当调用方注入了上下文时运行（无 ctx 的旧调用方不受影响），
  // 让领域插件据最近工具结果等业务上下文做精准拦截（如知识库查空后禁止自行推荐）。
  if (ctx) {
    for (const r of customContextualOutputRules) {
      if (!ruleInScope(r.scope, p)) continue;
      const res = r.fn(text, ctx);
      if (!res.ok) return res;
    }
  }
  return { ok: true };
}

/**
 * 结构化输出校验（计划模式等）：仅做密钥扫描与注入检测，跳过业务自定义规则与上下文规则。
 * 背景：planner 产出的计划 JSON 是结构化产物，其任务描述字段极易被业务合规正则
 * （如医疗广告法关键词）误命中；且拦截后的「合规话术重试」会破坏 JSON 格式，
 * 导致计划永远解析失败。调用方应先用 parsePlanOutput 确认文本可解析为目标结构，
 * 再走本函数做安全兜底扫描（secret / injection 仍然生效，安全底线不放松）。
 *
 * 注入检测仅用句子级强信号短语（PHRASES_LOW，如 "ignore previous instructions"），
 * 跳过 'system prompt' / 'dan' / 'jailbreak' 等弱信号短短语：计划任务描述合理地
 * 提到「优化 system prompt」这类内容不是注入，误拦会让计划永远生成失败。
 * 若仍被误拦，可用 GUARDRAIL_ALLOWLIST 配置允许关键词兜底。
 */
export function checkStructuredOutput(
  text: string,
  pol?: GuardrailPolicy
): GuardrailResult {
  const p = pol ?? getModulePolicy();
  if (typeof text !== 'string') return { ok: true };
  if (p.enableSecretScan) {
    const secret = scanSecretPatterns(SECRET_PATTERNS, text, 'output');
    if (secret) return secret;
  }
  const inj = detectInjection(text, p, true);
  if (inj) return { ok: false, reason: `possible prompt injection in output (matched: ${inj})` };
  return { ok: true };
}

/**
 * 计划任务执行输出校验（计划模式逐任务派发的 run）。
 *
 * 与 checkStructuredOutput 同级的安全底线扫描（真实密钥格式 + 强信号注入短语），
 * 但面向「自由文本教学内容」而非结构化 JSON，无需先经 parsePlanOutput 确认：
 * - 跳过 medium/high 弱信号短短语（'system prompt' / 'dan' 等）：架构教学讲解
 *   必然出现这些词（如「编排循环把 system prompt 注入每轮请求」），medium 敏感度
 *   会把正常内容误拦成兜底话术 —— 实测 stealth/ox-alpha 的 t1 概念综述即被误拦；
 * - 密钥扫描收紧为「高置信格式」：sk- 前缀 ≥20 位、AWS AKIA/ASIA、JWT 三段式。
 *   宽松的 `password: xxx` / `token: yyy` 赋值样例正则会把讲解中的示例代码误拦，
 *   故此处不复用 SECRET_PATTERNS，只保留几乎零误报的高置信模式；
 * - 跳过业务自定义规则与上下文规则（与 propose 一致）。
 */
const TASK_SECRET_PATTERNS: RegExp[] = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT 三段式
];

export function checkTaskOutput(
  text: string,
  pol?: GuardrailPolicy
): GuardrailResult {
  const p = pol ?? getModulePolicy();
  if (typeof text !== 'string') return { ok: true };
  if (p.enableSecretScan) {
    const secret = scanSecretPatterns(TASK_SECRET_PATTERNS, text, 'output');
    if (secret) return secret;
  }
  const inj = detectInjection(text, p, true);
  if (inj) return { ok: false, reason: `possible prompt injection in output (matched: ${inj})` };
  return { ok: true };
}

export function checkToolArgs(
  name: string,
  args: Record<string, unknown>,
  pol?: GuardrailPolicy
): GuardrailResult {
  const p = pol ?? getModulePolicy();

  // web_fetch 单独处理：URL 中常见的 token/api_key 查询参数不应直接视为 secret 泄露，
  // 默认仅扫描 headers；需要更严格时可切回 'full'。
  const webFetchScan = name === 'builtin__web_fetch' ? p.webFetchSecretScan ?? 'headers-only' : 'full';
  const secretTargets: string[] = [];
  if (p.enableSecretScan && webFetchScan !== 'off') {
    if (name === 'builtin__web_fetch') {
      if (webFetchScan === 'headers-only') {
        if (args.headers && typeof args.headers === 'object') {
          secretTargets.push(JSON.stringify(args.headers));
        }
      } else {
        secretTargets.push(JSON.stringify(args));
      }
    } else {
      secretTargets.push(JSON.stringify(args));
    }
    for (const text of secretTargets) {
      for (let i = 0; i < SECRET_PATTERNS.length; i++) {
        const re = SECRET_PATTERNS[i];
        if (!re) continue;
        const m = re.exec(text);
        if (m) {
          const snippet = redactPII(m[0] ?? '');
          return {
            ok: false,
            reason: `possible secret in tool args for ${name} (pattern #${i}: ${snippet})`,
          };
        }
      }
    }
  }

  // 注入检测仍针对完整参数做，防止模型在 URL/headers 中夹带 prompt-injection 载荷。
  const serialized = JSON.stringify(args);
  const inj = detectInjection(serialized, p);
  if (inj) return { ok: false, reason: `possible injection in tool args for ${name} (matched: ${inj})` };

  // P0.3 出网管控：web_fetch 的目标 URL 受租户 network 策略约束。
  if (name === 'builtin__web_fetch' && typeof args.url === 'string') {
    const eg = checkEgress(String(args.url), p.network);
    if (eg) return { ok: false, reason: `network egress blocked: ${eg}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 异步校验变体（叠加 Jev 语义层）：旧逻辑（正则/短语/secret/规则）先执行作为基线，
// 仅当旧逻辑放行时再跑异步语义打分（如 Jev）；Jev 缺配/出错/超时返回 0，不阻断，
// 自动回落旧逻辑。供 harness 主循环（异步上下文）调用，非异步调用方仍用同步 check*。
// ---------------------------------------------------------------------------

/** 异步输入校验：旧逻辑先判，Jev 语义注入打分增补（失败回落基线）。 */
export async function checkInputAsync(
  text: string,
  pol?: GuardrailPolicy,
  strongOnly = false,
  isPlanTask = strongOnly
): Promise<GuardrailResult> {
  const sync = checkInput(text, pol, strongOnly, isPlanTask);
  if (!sync.ok) return sync; // 旧逻辑已拦截，直接返回
  const inj = await detectInjectionAsync(text, pol ?? getModulePolicy(), strongOnly);
  if (inj) return { ok: false, reason: `possible prompt injection in input (matched: ${inj})` };
  return { ok: true };
}

/** 异步输出校验：旧逻辑先判，Jev 语义注入打分增补（失败回落基线）。 */
export async function checkOutputAsync(
  text: string,
  pol?: GuardrailPolicy,
  ctx?: GuardrailOutputContext
): Promise<GuardrailResult> {
  const sync = checkOutput(text, pol, ctx);
  if (!sync.ok) return sync;
  const inj = await detectInjectionAsync(text, pol ?? getModulePolicy());
  if (inj) return { ok: false, reason: `possible prompt injection in output (matched: ${inj})` };
  return { ok: true };
}

/** 异步工具参数校验：旧逻辑先判，Jev 语义注入打分增补（失败回落基线）。 */
export async function checkToolArgsAsync(
  name: string,
  args: Record<string, unknown>,
  pol?: GuardrailPolicy
): Promise<GuardrailResult> {
  const sync = checkToolArgs(name, args, pol);
  if (!sync.ok) return sync;
  // DNS rebinding 防护：web_fetch 出网目标做解析级私网校验（仅 allowPrivateNetwork=false
  // 时激活 DNS 展开；字面量校验已在同步路径完成）。检查时机从「策略检查时」前移到
  // 「每次调用时」，显著收窄 TOCTOU 窗口。
  if (name === 'builtin__web_fetch' && typeof args.url === 'string') {
    const eg = await checkEgressAsync(String(args.url), pol?.network);
    if (eg) return { ok: false, reason: `network egress blocked: ${eg}` };
  }
  const inj = await detectInjectionAsync(JSON.stringify(args), pol ?? getModulePolicy());
  if (inj)
    return { ok: false, reason: `possible injection in tool args for ${name} (matched: ${inj})` };
  return { ok: true };
}
