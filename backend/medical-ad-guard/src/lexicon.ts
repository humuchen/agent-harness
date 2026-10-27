/**
 * lexicon.ts — 医疗广告词库（中期：外置化 + 可热更新）。
 *
 * 设计要点：
 * - 默认词库内置于代码（与既有行为一致，零配置可运行）；运维可通过
 *   MEDICAL_AD_LEXICON_PATH 指向 JSON 文件**追加**（或以 replace_defaults 替换）规则，
 *   无需改码重新构建。文件格式见 parseLexiconFile。
 * - 所有规则默认以 normalize 模式注册：core 侧 hardenText 先做「全半角折叠 +
 *   去零宽/emoji/符号/空白」再匹配（对抗归一化），封堵「保~证不留疤」「１００％安全」
 *   等廉价绕过。规则 pattern 应按**硬化后文本**（连续、无空白分隔）编写。
 * - 非法 JSON / 非法正则 fail-fast 抛错（配置错误必须显式暴露，不许静默跳过）。
 */

/** 单条词库规则（JSON 文件与内置默认共用同一形态）。 */
export interface LexiconRule {
  /** 规则 id（可读标识，审计/统计用；可选）。 */
  id?: string;
  /** 正则 pattern 源码（按 hardenText 硬化后的文本编写；硬化会剔除空白/符号/emoji）。 */
  pattern: string;
  /** 正则 flags（缺省 ''；如需忽略大小写写 'i'）。 */
  flags?: string;
  /** 命中原因（拦截时回给模型的合规依据，人工可读）。 */
  reason: string;
  /** 是否走硬化归一化匹配（缺省 true；false 时按原文匹配）。 */
  normalize?: boolean;
}

/** 词库 JSON 文件格式。 */
export interface LexiconFile {
  /** 词库版本（审计留痕用，可选）。 */
  version?: string;
  /** true：完全替换内置默认词库；缺省 false：追加到默认词库之后。 */
  replace_defaults?: boolean;
  /** 合规正则规则列表。 */
  rules?: LexiconRule[];
  /** 追加 KB 项目词（命中场景：知识库查空后仍推荐具体项目）。 */
  kb_project_terms?: string[];
}

/** 解析后的生效词库。 */
export interface ResolvedLexicon {
  rules: LexiconRule[];
  kbTerms: string[];
  version: string;
  source: string;
}

/**
 * 内置默认词库（与原 src/index.ts 的 6 条正则逐条等价；pattern 按硬化文本语义微调 ——
 * 硬化会剔除空白与符号，故 \s 类间隙一律移除，量词覆盖真实字符）。
 */
export const DEFAULT_LEXICON_RULES: LexiconRule[] = [
  // 1) 疗效/安全绝对化承诺（带医疗语境）
  {
    id: 'absolute-guarantee',
    pattern: '保证.{0,10}(不留疤|不失败|不反弹|不疼痛|不出血|成功|安全|有效|无风险|无副作用|零风险)',
    reason: '医疗广告法：不得对功效、安全性作绝对化保证（如「保证不留疤/绝对安全」）',
  },
  {
    id: 'absolute-assertion',
    // P2 词库边界修复：「成功」加负向限定——排除「预约/办理/发出/送达」等非疗效
    // 承诺（如「帮您把预约一定成功办理」是履约承诺而非疗效断言，此前误拦）；
    // 「手术一定成功」等疗效语境仍正常命中。
    pattern:
      '(100%|百分百|绝对|一定|肯定).{0,10}(成功(?!(办理|预约|发出|送达))|安全|有效|无风险|不留疤|不失败|根治)',
    reason: '医疗广告法：不得使用「100%/绝对/肯定」等表示功效、安全性的断言用语',
  },
  // 2) 诊断式话术（模型不得代替医生诊断）
  {
    id: 'diagnosis-claim',
    pattern: '你这(是|应该|可能|就是|多半是).{0,8}(炎|病|症|囊肿|增生|下垂|畸形|过敏|肌无力)',
    reason: '医疗广告法：AI 不得作诊断结论，应引导面诊',
  },
  // 3) 患者形象/术前术后对比
  {
    id: 'before-after',
    pattern: '(术前|术后).{0,8}(对比|真人|案例|效果图|前后照)',
    reason: '医疗广告法：不得使用患者术前术后形象作证明/对比',
  },
  // 4) 固定价承诺（应用区间/起）
  {
    id: 'fixed-price',
    // P2 词库边界修复：放宽两处漏拦——①「包干/一口价」可独立成句（不再强制
    // 「价格」前缀）；②「包干3千」「一口价998」等无货币词尾的数字同样命中
    //（货币词后缀改为可选）。「只要 20 分钟」这类非价格表述不受影响。
    pattern:
      '(价格.{0,4}(只要|仅|固定|包干|一口价)|(包干|一口价)).{0,12}[0-9]+(元|块|rmb)?',
    flags: 'i',
    reason: '医疗广告法：价格应示区间或「起」，不得承诺固定价',
  },
  // 5) 贬低同业 / 不实比较
  {
    id: 'disparage-peers',
    pattern: '(别去|千万别去|那家.{0,6}不行|比.{0,4}(某某|别家).{0,6}(好|强|便宜))',
    reason: '医疗广告法：不得贬低其他医疗机构或作不实比较',
  },
];

/** KB 项目词默认表（原 KB_EMPTY_PROJECT_HINT_RE 的枚举展开）。 */
export const DEFAULT_KB_PROJECT_TERMS: string[] = [
  '化学焕肤', '果酸', '小气泡', '光子嫩肤', '光子', 'M22', '点阵激光', '二氧化碳激光',
  '皮秒', '超皮秒', '微针', '中胚层', '水光', '热玛吉', '超声炮', '超声刀', '线雕', '埋线',
  '玻尿酸', '肉毒素', '瘦脸针', '除皱针', '植发', '种睫毛', '纹眉', '半永久', '激光脱毛',
  '酷塑', '溶脂', '吸脂', '双眼皮', '开眼角', '隆鼻', '隆胸', '私密', '妊娠纹', '瘢痕',
  '疤痕', '黄褐斑', '红血丝', '刷酸', '清痘',
];

/**
 * KB 项目词的负向上下文（P2#40 词库边界防护）。
 *
 * KB 项目词按「字面子串」拼接匹配（中文无词边界，\b 不可用）——短而多义的词
 * （如「私密」「水光」）在非项目语义的连字词（私密文件 / 水光灯）里同样命中，
 * 在「知识库查空后禁止推荐项目」的硬拦截场景造成误伤（正常回答被整段替换为
 * 面诊引导文案）。本表只对**明确多义**的词收紧：命中词且紧跟负向上下文连字
 * → 不判命中；其余项目词保持宽松子串匹配（查空语境下「宁拦勿漏」的既有口径
 * 不变）。新增多义词在此登记即可，无需改匹配逻辑。
 */
export const KB_TERM_NEGATIVE_CONTEXTS: ReadonlyArray<readonly [string, string]> = [
  ['私密', '(文件|信息|数据|空间|相册|对话)'],
  ['水光', '灯'],
];

/** 正则源码转义（KB 项目词按字面拼接时防元字符注入）。 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 校验并编译一条规则（非法 pattern fail-fast，附规则 id/索引定位）。 */
export function compileRule(rule: LexiconRule, index: number): RegExp {
  if (typeof rule.pattern !== 'string' || !rule.pattern) {
    throw new Error(`[medical-ad-guard] 词库规则 #${index}（${rule.id ?? '未命名'}）pattern 必须为非空字符串`);
  }
  if (typeof rule.reason !== 'string' || !rule.reason) {
    throw new Error(`[medical-ad-guard] 词库规则 #${index}（${rule.id ?? '未命名'}）reason 必须为非空字符串`);
  }
  try {
    return new RegExp(rule.pattern, rule.flags ?? '');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[medical-ad-guard] 词库规则 #${index}（${rule.id ?? '未命名'}）正则非法：${detail}；pattern=${rule.pattern}`,
    );
  }
}

/** 解析词库 JSON 文件（不存在/非法 JSON/非法正则 fail-fast）。 */
export function parseLexiconFile(raw: string, path: string): LexiconFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[medical-ad-guard] 词库文件 JSON 非法（${path}）：${e instanceof Error ? e.message : e}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`[medical-ad-guard] 词库文件应为对象（${path}）：{ version?, replace_defaults?, rules?, kb_project_terms? }`);
  }
  return data as LexiconFile;
}

/**
 * 解析生效词库：环境变量 MEDICAL_AD_LEXICON_PATH 指向 JSON 时加载并合并（默认追加），
 * 否则仅用内置默认。返回的规则列表为最终生效集。
 */
export function resolveLexicon(env: NodeJS.ProcessEnv = process.env): ResolvedLexicon {
  const path = (env.MEDICAL_AD_LEXICON_PATH ?? '').trim();
  if (!path) {
    return { rules: [...DEFAULT_LEXICON_RULES], kbTerms: [...DEFAULT_KB_PROJECT_TERMS], version: 'builtin', source: 'builtin' };
  }
  // 延迟 require node:fs：保持包在浏览器/边缘形态的纯类型导入能力（运行时才触盘）。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync, statSync } = require('node:fs') as typeof import('node:fs');
  let stat: { mtimeMs: number };
  try {
    stat = statSync(path);
  } catch (e) {
    throw new Error(`[medical-ad-guard] 词库文件不可读（${path}）：${e instanceof Error ? e.message : e}`);
  }
  void stat;
  const file = parseLexiconFile(readFileSync(path, 'utf8'), path);
  const fileRules = Array.isArray(file.rules) ? file.rules : [];
  const base = file.replace_defaults === true ? [] : [...DEFAULT_LEXICON_RULES];
  const kbTerms =
    Array.isArray(file.kb_project_terms) && file.kb_project_terms.length
      ? file.replace_defaults === true
        ? [...file.kb_project_terms.map(String)]
        : [...DEFAULT_KB_PROJECT_TERMS, ...file.kb_project_terms.map(String)]
      : [...DEFAULT_KB_PROJECT_TERMS];
  return {
    rules: [...base, ...fileRules],
    kbTerms,
    version: typeof file.version === 'string' && file.version ? file.version : 'untagged',
    source: path,
  };
}
