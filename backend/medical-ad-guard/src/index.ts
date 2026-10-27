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
 *
 * 中期增强（词库外置化 + 对抗归一化 + 热更新）：
 * - 词库外置：MEDICAL_AD_LEXICON_PATH 指向 JSON 词库（追加/替换内置默认），见 lexicon.ts。
 * - 对抗归一化：规则以 normalize 模式注册 —— core hardenText 先做「全半角折叠 +
 *   去零宽/emoji/符号/空白」再匹配，封堵「保~证不留疤」「１００％安全」等绕过。
 * - 热更新：reloadMedicalAdLexicon() 反注册全部旧规则并按当前词库重注册；
 *   MEDICAL_AD_LEXICON_POLL_MS > 0 时自动 mtime 轮询热更（默认关闭）。
 */

import {
  hardenText,
  registerInputRule,
  registerOutputRule,
  registerContextualOutputRule,
  registerGuardrailAuditSink,
  type GuardrailOutputContext,
  type GuardrailResult,
  type GuardrailRuleHit,
} from '@agent-harness/core';
import {
  compileRule,
  resolveLexicon,
  escapeRegExp,
  KB_TERM_NEGATIVE_CONTEXTS,
  type LexiconRule,
} from './lexicon';

/** 本插件注册的所有规则统一作用域标签。 */
export const MEDICAL_AD_SCOPE = 'medical-ad';

/** 编译后的生效规则（lexicon 形态 + 编译产物），供插件内自检与导出。 */
export interface CompiledAdRule {
  re: RegExp;
  reason: string;
  id?: string;
  normalize: boolean;
}

/** 当前生效的编译规则（随词库热更新重建）。 */
let activeRules: CompiledAdRule[] = [];

/** 当前生效的 KB 项目词正则（随词库热更新重建）。 */
let activeKbTermsRe: RegExp = new RegExp('(?!)'); // 恒不匹配的空态

/** 当前词库元信息（reload 后更新）。 */
let lexiconMeta = { version: 'builtin', source: 'builtin', ruleCount: 0, kbTermCount: 0 };

/**
 * 按词库编译全部规则（normalize 缺省 true —— 默认规则享受硬化匹配）。
 * fail-fast：任一非法 pattern 直接抛错，绝不带着残缺词库上线。
 */
function compileLexicon(rules: LexiconRule[]): CompiledAdRule[] {
  return rules.map((r, i) => {
    const re = compileRule(r, i);
    return { re, reason: r.reason, ...(r.id !== undefined ? { id: r.id } : {}), normalize: r.normalize !== false };
  });
}

/**
 * 知识库查空硬拦截（输出侧护栏）：当 project_kb_search 返回 found:false（知识库未收录）时，
 * 仅凭 prompt 纪律不足以阻止模型自行编造项目/疗程/功效/恢复期推荐，故在此做硬保障。
 * 命中即拦截，回复回退为「建议预约面诊」。词表刻意只覆盖「具体项目/治疗手段」，
 * 避开纯诉求词（黑头/闭口/出油），以降低对正常面诊引导话术的误伤。
 * 对抗：对输出文本先 hardenText（剥分隔符/零宽/全半角），封堵「热-玛-吉」式拆词绕过。
 */
function parseKbResult(result: string): { found: unknown; answer?: string } | null {
  let obj: unknown;
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
  // 硬化后匹配：剥掉拆词混淆（热-玛-吉 / 玻 尿 酸 / 表情隔断）再比对项目词。
  if (activeKbTermsRe.test(hardenText(text))) {
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
/** 本次注册产生的反注册函数集合（reload 时逐个调用后重建）。 */
let unregisters: Array<() => void> = [];
/** 词库文件 mtime 轮询 timer（MEDICAL_AD_LEXICON_POLL_MS 开启时）。 */
let pollTimer: NodeJS.Timeout | null = null;
let lastMtimeMs = 0;

/**
 * 重建 KB 项目词正则（P2#40 词库边界）：项目词按字面拼接（防元字符注入）；
 * 多义词按 KB_TERM_NEGATIVE_CONTEXTS 追加负向上下文（私密文件/水光灯 等非项目
 * 连字不判命中）；词数 0 时恒不匹配。
 */
function rebuildKbTermsRe(terms: string[]): void {
  if (!terms.length) {
    activeKbTermsRe = new RegExp('(?!)');
    return;
  }
  const neg = new Map<string, string>(KB_TERM_NEGATIVE_CONTEXTS);
  const parts = terms.map((t) => {
    const src = escapeRegExp(t);
    const ctx = neg.get(t);
    return ctx ? `${src}(?!${ctx})` : src;
  });
  activeKbTermsRe = new RegExp(parts.join('|'));
}

/** 执行注册：编译当前词库 → 注册进 core（幂等由 registered 旗标与调用方纪律保证）。 */
function activate(): void {
  const lex = resolveLexicon();
  activeRules = compileLexicon(lex.rules);
  rebuildKbTermsRe(lex.kbTerms);
  lexiconMeta = {
    version: lex.version,
    source: lex.source,
    ruleCount: activeRules.length,
    kbTermCount: lex.kbTerms.length,
  };
  // 同步原位重写导出数组（消费方持引用自动可见新词库）。
  medicalAdRules.length = 0;
  medicalAdRules.push(...activeRules);
  unregisters = [];
  for (const r of activeRules) {
    // normalize 规则按硬化文本匹配（对抗分隔符/全半角/零宽绕过）。
    unregisters.push(
      registerInputRule(r.re, r.reason, MEDICAL_AD_SCOPE, { normalize: r.normalize }),
    );
    unregisters.push(
      registerOutputRule(r.re, r.reason, MEDICAL_AD_SCOPE, { normalize: r.normalize }),
    );
  }
  unregisters.push(registerContextualOutputRule(kbEmptyGuard, MEDICAL_AD_SCOPE));
}

/** 反注册全部规则（reload 前置步骤）。 */
function deactivate(): void {
  for (const unreg of unregisters) {
    try {
      unreg();
    } catch {
      /* 单条反注册失败不阻断重建 */
    }
  }
  unregisters = [];
}

/**
 * 词库热更新：反注册旧规则 → 按当前词库（含 MEDICAL_AD_LEXICON_PATH 外部文件）重注册。
 * 未注册过时等价于首次注册。返回词库元信息供调用方审计。
 */
export function reloadMedicalAdLexicon(): {
  version: string;
  source: string;
  ruleCount: number;
  kbTermCount: number;
} {
  if (registered) {
    deactivate();
    activate();
  } else {
    registerMedicalAdGuardrail();
  }
  return { ...lexiconMeta };
}

/** 当前生效词库元信息（注册/热更新后可查）。 */
export function medicalAdLexiconInfo(): Readonly<typeof lexiconMeta> {
  return lexiconMeta;
}

/**
 * 注册医疗广告合规护栏（幂等）。任一插件 setup 时调用一次即可；
 * 客服与客资插件都调用本函数，互不影响，也不会重复注册。
 * 词库文件自动热更：MEDICAL_AD_LEXICON_POLL_MS > 0 时启动 mtime 轮询（默认关闭）。
 */
export function registerMedicalAdGuardrail(): void {
  if (registered) return;
  activate();
  registered = true;

  // 可选：词库文件 mtime 轮询热更（毫秒级间隔下限 5s，防打满磁盘）。
  const pollMs = Number(process.env.MEDICAL_AD_LEXICON_POLL_MS ?? 0) || 0;
  const path = (process.env.MEDICAL_AD_LEXICON_PATH ?? '').trim();
  if (pollMs >= 5000 && path) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { statSync } = require('node:fs') as typeof import('node:fs');
    try {
      lastMtimeMs = statSync(path).mtimeMs;
    } catch {
      lastMtimeMs = 0;
    }
    pollTimer = setInterval(() => {
      try {
        const m = statSync(path).mtimeMs;
        if (m !== lastMtimeMs) {
          lastMtimeMs = m;
          const meta = reloadMedicalAdLexicon();
          // eslint-disable-next-line no-console
          console.warn(
            `[medical-ad-guard] 词库热更新完成：version=${meta.version} rules=${meta.ruleCount} kbTerms=${meta.kbTermCount}`,
          );
        }
      } catch (e) {
        // 轮询期文件不可读：保持旧词库继续生效（fail-safe），下次 tick 重试。
        // eslint-disable-next-line no-console
        console.warn(`[medical-ad-guard] 词库热更新检查失败（沿用旧词库）：${e instanceof Error ? e.message : e}`);
      }
    }, pollMs);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }
}

/**
 * 插件内自检入口：对任意文案跑当前生效词库（硬化归一化后匹配），
 * 返回命中列表（供内容先审后发 / A/B 创建 / 手动排期等前置筛查复用）。
 * 惰性激活：调用方（含测试）未显式 register 时，首次筛查自动编译词库并完成 core
 * 注册（幂等）—— 保证与旧版「导入 medicalAdRules 即可用」行为等价。
 */
export function screenMedicalAdText(text: string): Array<{ matched: string; reason: string }> {
  if (!registered || activeRules.length === 0) registerMedicalAdGuardrail();
  const hardened = hardenText(text);
  const hits: Array<{ matched: string; reason: string }> = [];
  for (const r of activeRules) {
    const target = r.normalize ? hardened : text;
    // P2 修复：改用 global 副本收集全部命中——此前 re.exec 只取每条规则首个命中，
    // 多处违规只报一处，影响先审后发的审计完整性。新建 global 副本避免污染
    // 共享编译结果的 lastIndex 状态。
    const re = r.re.global ? r.re : new RegExp(r.re.source, r.re.flags + 'g');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(target)) !== null) {
      hits.push({ matched: m[0] ?? '', reason: r.reason });
      if (hits.length >= 20) break; // 防超长命中列表
      if (m.index === re.lastIndex) re.lastIndex++; // 零宽匹配防死循环
    }
    if (hits.length >= 20) break;
  }
  return hits;
}

/**
 * 当前生效的规则编译列表（导出为稳定数组引用：词库热更新时**原位重写**，
 * 既有消费方（内容筛查/A-B/手动排期）无需重取引用即自动使用新词库）。
 * 兼容旧形态 { re, reason }（新增 id/normalize 为可选字段）。
 */
export const medicalAdRules: CompiledAdRule[] = [];

/** 进程退出时清理（可选调用）：停掉词库轮询 timer。 */
export function disposeMedicalAdGuard(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * 中期补全（命中审计闭环）：设置护栏命中审计 sink —— core 在自定义规则命中
 * （运行时输入/输出拦截）时回调，本函数附加规则 id 解析后转发给消费方
 * （如医美插件落 ma_guard_hits 表进人审队列）。
 * @returns 注销函数。
 */
export interface MedicalAdAuditHit extends GuardrailRuleHit {
  /** 命中规则的词库 id（外部词库规则可携带自定义 id，便于运营定位词条）。 */
  ruleId?: string;
}

export function setMedicalAdAuditSink(fn: (hit: MedicalAdAuditHit) => void): () => void {
  if (!registered || activeRules.length === 0) registerMedicalAdGuardrail();
  return registerGuardrailAuditSink((hit) => {
    const rule = activeRules.find((r) => r.reason === hit.reason);
    fn({ ...hit, ...(rule?.id ? { ruleId: rule.id } : {}) });
  });
}
