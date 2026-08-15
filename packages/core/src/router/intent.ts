/**
 * 意图路由（P0.2）：把自然语言 prompt 归类到行业领域 + 意图标签 + 所需能力。
 *
 * 设计：
 * - 默认规则引擎（领域词典 + 关键词），零网络、零依赖、结果可缓存；对「查询/计算/文件/执行」
 *   等动作自动推断 requiredCapabilities，供 AgentSelector 做能力匹配。
 * - INTENT_ROUTER=llm 时切换到小模型分类（复用核心 createOpenRouterLLM），精度更高但需 API key；
 *   任何解析失败/缺 key 都静默回退规则引擎（不中断，符合「一切降级可用」）。
 * - INTENT_ROUTER=auto 智能降级：有 OPENROUTER_API_KEY 用 llm（精准），否则用 rule（离线可用），
 *   免去运维「配了 key 还得记得改 INTENT_ROUTER=llm」的心智负担；缺省仍是 rule，向后兼容。
 * - 分类结果按 prompt 缓存（有界 LRU），避免重复分类成本。
 */

import type { IndustryDomain } from '../agents/types';
import type { Intent } from './types';

/** 领域词典：领域 → 中英文关键词（命中越多越可能是该领域）。 */
const DOMAIN_KEYWORDS: Record<Exclude<IndustryDomain, 'generic'>, string[]> = {
  'medical-aesthetics': [
    '医美', '整形', '整容', '注射', '玻尿酸', '肉毒素', '双眼皮', '隆鼻', '隆胸', '吸脂',
    '皮肤管理', '光子嫩肤', '热玛吉', '水光针', '线雕', '植发', '纹眉',
    'cosmetic', 'plastic', 'aesthetic', 'botox', 'filler', 'facelift', 'liposuction',
  ],
  finance: [
    '金融', '理财', '投资', '基金', '股票', '证券', '保险', '风控', '信贷', '贷款', '利率',
    '外汇', '期货', '期权', '资产配置', '净值', '收益', '回撤', '持仓', '止盈', '止损',
    'finance', 'invest', 'stock', 'fund', 'insurance', 'loan', 'credit', 'portfolio', 'trading',
  ],
  healthcare: [
    '医疗', '诊断', '病历', '处方', '患者', '健康档案', '临床', '医嘱', '影像', '病理',
    '随访', '慢病', '用药', '医保', '挂号',
    'diagnosis', 'patient', 'clinical', 'prescription', 'medical', 'icd', 'ehr',
  ],
  education: [
    '教育', '课程', '教学', '学生', '作业', '培训', '学习', '教案', '讲义', '考试', '习题',
    '知识点', '学情', '辅导', '班级',
    'education', 'course', 'student', 'learning', 'teaching', 'curriculum', 'quiz',
  ],
};

/** 动作 → 能力映射（从 prompt 推断任务所需能力 id）。 */
const ACTION_CAPABILITY_KEYWORDS: Array<{ keys: string[]; capability: string }> = [
  { keys: ['查询', '搜索', '搜一下', '查一下', '联网', '网络', '网址', 'url', 'http', 'fetch', '检索'], capability: 'web-search' },
  { keys: ['计算', '算一下', '利率', '收益率', '金额', '统计', '求和', '换算', 'calculate', 'compute'], capability: 'calculation' },
  { keys: ['文件', '读文件', '写文件', '目录', '保存', '导出', '读取', 'file', 'document'], capability: 'file-io' },
  { keys: ['执行', '命令', '运行脚本', 'shell', '脚本', 'terminal', '部署'], capability: 'command-exec' },
];

/** 意图标签启发式。 */
function labelIntent(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/[?？]/.test(prompt)) return 'qa';
  if (/(查询|搜索|搜一下|查一下|检索|search|lookup|find)/.test(p)) return 'lookup';
  if (/(计算|算一下|运行|执行|生成|写|帮我做|帮我整理|create|generate|build|run)/.test(p)) return 'task';
  if (/(你好|hi|hello|在吗|闲聊|聊天)/.test(p)) return 'conversation';
  return 'task';
}

/** 规则引擎分类（默认路径）。 */
function classifyByRule(prompt: string): Intent {
  const lower = prompt.toLowerCase();
  // 领域打分：每个领域统计命中词数，取最高分；并列取先定义者。
  let bestDomain: IndustryDomain = 'generic';
  let bestScore = 0;
  for (const [domain, keys] of Object.entries(DOMAIN_KEYWORDS) as [Exclude<IndustryDomain, 'generic'>, string[]][]) {
    let score = 0;
    for (const k of keys) {
      if (lower.includes(k.toLowerCase())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  // 能力推断。
  const requiredCapabilities: string[] = [];
  for (const { keys, capability } of ACTION_CAPABILITY_KEYWORDS) {
    if (keys.some((k) => lower.includes(k.toLowerCase()))) requiredCapabilities.push(capability);
  }
  return {
    domain: bestDomain,
    intent: labelIntent(prompt),
    requiredCapabilities,
    source: 'rule',
  };
}

/**
 * 解析意图路由的**生效模式**（把 'auto' 收敛为 'rule' | 'llm'）。
 * - 优先级：显式 `requested` > env INTENT_ROUTER > 缺省 'rule'（向后兼容）。
 * - `llm`：强制小模型分类（缺 key 时 classify 阶段仍会回退 rule，不中断）。
 * - `auto`：有 OPENROUTER_API_KEY → 'llm'（精准）；否则 → 'rule'（离线可用）—— 智能降级。
 * - 其它 / 缺省 → 'rule'。
 */
export function resolveIntentMode(
  requested?: 'rule' | 'llm' | 'auto',
  env: NodeJS.ProcessEnv = process.env
): 'rule' | 'llm' {
  const raw = (requested ?? env.INTENT_ROUTER ?? 'rule').toString().trim().toLowerCase();
  if (raw === 'llm') return 'llm';
  if (raw === 'auto') return env.OPENROUTER_API_KEY ? 'llm' : 'rule';
  return 'rule';
}

/**
 * 意图路由器。
 * - `mode` 来自 env INTENT_ROUTER：`rule`（默认）/ `llm`（小模型分类，需 OPENROUTER_API_KEY）/
 *   `auto`（有 key 用 llm、无 key 用 rule 的智能降级）。构造时即收敛为生效模式 'rule' | 'llm'。
 * - `cacheSize` 控制分类缓存上限（默认 256）。
 */
export class IntentRouter {
  private mode: 'rule' | 'llm';
  private cache = new Map<string, Intent>();
  private cacheSize: number;

  constructor(opts: { mode?: 'rule' | 'llm' | 'auto'; cacheSize?: number } = {}) {
    this.mode = resolveIntentMode(opts.mode);
    this.cacheSize = opts.cacheSize ?? 256;
  }

  /** 当前生效模式（'auto' 已解析）。供运维/启动横幅展示。 */
  get activeMode(): 'rule' | 'llm' {
    return this.mode;
  }

  /** 分类（带缓存）。rule 模式纯本地；llm 模式失败自动回退 rule。 */
  async classify(prompt: string): Promise<Intent> {
    const cached = this.cache.get(prompt);
    if (cached) return cached;
    let intent: Intent;
    if (this.mode === 'llm') {
      intent = await this.classifyByLlm(prompt).catch(() => classifyByRule(prompt));
    } else {
      intent = classifyByRule(prompt);
    }
    // 有界缓存：超上限时清掉最旧一项。
    if (this.cache.size >= this.cacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(prompt, intent);
    return intent;
  }

  /** 小模型分类：构造受限 prompt，要求返回 JSON，解析失败抛错由调用方回退。 */
  private async classifyByLlm(prompt: string): Promise<Intent> {
    // 惰性加载 LLM 适配器（import 本身无网络；仅调用时联网）。
    const { createOpenRouterLLM } = await import('../llm/openrouter');
    const llm = createOpenRouterLLM();
    const sys =
      '你是任务路由器。把用户请求归类到行业领域与所需能力。仅输出 JSON：' +
      '{"domain":"medical-aesthetics|finance|healthcare|education|generic",' +
      '"intent":"qa|lookup|task|conversation","requiredCapabilities":["web-search"|"calculation"|"file-io"|"command-exec"]}。' +
      '不要输出任何解释。';
    const res = await llm(
      [
        { role: 'system', content: sys },
        { role: 'user', content: prompt },
      ],
      []
    );
    const text = typeof res.content === 'string' ? res.content : '';
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) throw new Error('llm returned no json');
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<Intent>;
    const domain = (parsed.domain as IndustryDomain) || 'generic';
    const validDomains = ['medical-aesthetics', 'finance', 'healthcare', 'education', 'generic'];
    return {
      domain: validDomains.includes(domain) ? domain : 'generic',
      intent: parsed.intent ?? labelIntent(prompt),
      requiredCapabilities: Array.isArray(parsed.requiredCapabilities) ? parsed.requiredCapabilities : [],
      source: 'llm',
    };
  }
}

/** 进程内共享单例（默认 rule 模式）。 */
let _defaultIntentRouter: IntentRouter | null = null;
export function getIntentRouter(): IntentRouter {
  if (!_defaultIntentRouter) _defaultIntentRouter = new IntentRouter();
  return _defaultIntentRouter;
}
