// 内容安全护栏（企业级可配置策略引擎）。
//
import type { IsolationLevel } from './sandbox/types';

// 三个层面：输入校验、输出校验、工具参数校验。相比早期纯正则版本，本版增强：
//   1) 可配置策略（configureGuardrails）：开关 / 敏感度 / 最大长度 / 允许列表；
//   2) 归一化注入检测：先去除零宽字符、折叠空白、去标点后做子串匹配，
//      对大小写变形、字符间插空格、零宽字符等常见绕过手段显著更鲁棒；
//   3) 输出侧 PII 脱敏（redactOutput / redactPII）：识别邮箱、手机号、身份证、
//      银行卡、IPv4、常见 API Key 并打码，避免敏感信息随模型输出外泄；
//   4) 可插拔：registerInputRule（输入规则）、registerInjectionScorer（语义级
//      注入打分器，可接外部分类模型）、registerPiiRedactor（自定义 PII 模式）。
//
// 默认行为保持向后兼容：checkInput / checkOutput / checkToolArgs 签名不变。

export interface GuardrailResult {
  ok: boolean;
  reason?: string;
  /**
   * 合规安全回复（可选）：拦截规则命中时可附带一段「合规、有事实依据」的兜底话术，
   * 调用方（harness）优先采用它作为最终回复，而非暴露 [guardrail] blocked 内部文本。
   * 例：知识库查空时，直接返回工具的标准「建议预约面诊」话术。
   */
  safeReply?: string;
}

export interface PiiRedactor {
  label: string;
  re: RegExp;
  mask: (m: string) => string;
}

export type InjectionSensitivity = 'low' | 'medium' | 'high';

/** 出网管控策略（P0.3）：约束 web_fetch 可访问的域名范围。 */
export interface NetworkPolicy {
  /**
   * open：允许所有域名（默认，向后兼容）；
   * allowlist：仅允许 listed 域名（含子域）出网；
   * denylist：禁止 listed 域名（含子域），其余放行。
   */
  mode: 'open' | 'allowlist' | 'denylist';
  /** allowlist 模式下仅允许这些域名（支持 `*.example.com` 通配子域）。 */
  allowedDomains?: string[];
  /** denylist 模式下禁止这些域名（支持 `*.example.com` 通配子域）。 */
  deniedDomains?: string[];
}

export interface GuardrailPolicy {
  /** 输入最大字符数，超过即拦截（防超大输入 / 资源耗尽）。 */
  maxInputLength: number;
  /** 是否扫描密钥类敏感串。 */
  enableSecretScan: boolean;
  /** 是否做提示词注入检测。 */
  enableInjectionScan: boolean;
  /** 注入检测敏感度（影响短语集大小）。 */
  injectionSensitivity: InjectionSensitivity;
  /** 是否在输出侧做 PII 脱敏。 */
  enablePiiRedaction: boolean;
  /** 允许列表：命中这些关键词的输入/输出不会被注入检测拦截（如产品名恰好含 "system prompt"）。 */
  allowlist: string[];
  /**
   * 业务护栏作用域（P0.x，治本）：声明本次运行「启用」哪些业务护栏 scope。
   * 配合 registerInputRule/registerOutputRule 的 scope 参数实现「按 agent 绑定业务护栏」，
   * 而非进程级全局生效——
   *   - 未设置（undefined，旧路径/测试）→ 不收窄，所有自定义规则照常生效（向后兼容）；
   *   - 设为数组 → 未打 scope 的规则始终生效（全局安全底线，如业务方希望某规则全局适用），
   *     打了 scope 的规则仅当 scope ∈ 本数组时才评估。
   * 例：默认/generic agent 传 scopes:[] 即排除 medical-ad 等业务护栏；医美 agent 传
   * scopes:['medical-ad'] 才启用医疗广告法护栏。
   */
  scopes?: string[];
  /** 出网管控（P0.3）：约束 web_fetch 可访问域名；缺省 open（全部放行）。 */
  network?: NetworkPolicy;
  /**
   * web_fetch 工具参数 secret 扫描范围。
   * - 'headers-only'（默认）：仅扫描 headers 对象，URL 只做协议/egress 检查；
   *   避免把网页 URL 中常见的 token/api_key 查询参数误判为泄露 secret。
   * - 'full'：对 url + headers 全部扫描（旧行为）。
   * - 'off'：关闭 web_fetch 的 secret 扫描。
   */
  webFetchSecretScan?: 'headers-only' | 'full' | 'off';
  /**
   * 合规画像元数据（P2.c）：标注该策略所属合规框架 / 数据驻留要求 / 是否强制审计留痕。
   * 仅用于治理展示与 P2.d 隔离决策，不影响护栏判定逻辑；全字段可选。
   */
  compliance?: ComplianceProfile;
  /**
   * 最低执行隔离级别（P2.d）：要求承载该策略的 agent 至少以何种隔离后端执行。
   * 缺省 undefined 表示不强制（沿用 SANDBOX_BACKEND / AgentCard.isolation 决定）。
   * 'none' 仅用于完全可信的内部 agent；不可信 / 跨行业 agent 应设为 'os' 或 'container'。
   */
  isolation?: IsolationLevel;
}

/** 合规画像元数据（P2.c）。 */
export interface ComplianceProfile {
  /** 适用合规框架标签，如 "等保三级"、"个人信息保护法"、"金融行业数据安全"。 */
  framework?: string;
  /**
   * 数据驻留要求：'domestic' 表示数据不得出境（金融/医疗常用），'any' 无限制。
   * 与 network 策略联动（domestic 通常配合 denylist: ['*'] 默认禁出网）。
   */
  dataResidency?: 'domestic' | 'any';
  /** 是否强制审计留痕（关键动作须调用 audit()）。 */
  auditRequired?: boolean;
  /** PII 留存天数上限（治理展示用，实际留存由记忆后端配置）。 */
  piiRetentionDays?: number;
}

const DEFAULT_POLICY: GuardrailPolicy = {
  maxInputLength: 20000,
  enableSecretScan: true,
  enableInjectionScan: true,
  injectionSensitivity: 'medium',
  enablePiiRedaction: true,
  allowlist: [],
  network: { mode: 'denylist', deniedDomains: ['*'] },
};

/** 允许通过环境变量调整护栏默认策略（无需改代码即可按部署收紧 / 放松）。 */
function resolveDefaultPolicy(): GuardrailPolicy {
  const sens = (process.env.GUARDRAIL_SENSITIVITY || '').toLowerCase();
  const sensitivity: InjectionSensitivity = sens === 'low' || sens === 'high' ? sens : 'medium';
  const maxInput = Number(process.env.GUARDRAIL_MAX_INPUT ?? '');
  const webFetchScan = (process.env.GUARDRAIL_WEB_FETCH_SECRET_SCAN || '').toLowerCase();
  // 网络出口管控：GUARDRAIL_NETWORK_MODE 支持 open/allowlist/denylist（默认 denylist）。
  // - denylist + GUARDRAIL_DENIED_DOMAINS：显式禁止的域名列表（默认 ['*'] 即禁所有，需显式放开）；
  // - allowlist + GUARDRAIL_ALLOWED_DOMAINS：白名单模式，仅允许指定域名出网；
  // - open：放行所有（仅内部测试/离线场景启用）。
  const netMode = (process.env.GUARDRAIL_NETWORK_MODE || 'denylist').toLowerCase();
  const deniedRaw = process.env.GUARDRAIL_DENIED_DOMAINS;
  const allowedRaw = process.env.GUARDRAIL_ALLOWED_DOMAINS;
  let network: NetworkPolicy | undefined;
  if (netMode === 'open') {
    network = { mode: 'open' };
  } else if (netMode === 'allowlist') {
    network = {
      mode: 'allowlist',
      allowedDomains: allowedRaw ? allowedRaw.split(',').map((s) => s.trim()).filter(Boolean) : [],
    };
  } else {
    // denylist（默认）：解析禁止域名，缺省 ['*'] 表示禁止所有出网。
    const denied = deniedRaw
      ? deniedRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : ['*'];
    network = { mode: 'denylist', deniedDomains: denied };
  }
  return {
    maxInputLength:
      Number.isFinite(maxInput) && maxInput > 0 ? maxInput : DEFAULT_POLICY.maxInputLength,
    enableSecretScan: process.env.GUARDRAIL_SECRET_SCAN !== 'false',
    enableInjectionScan: process.env.GUARDRAIL_INJECTION_SCAN !== 'false',
    injectionSensitivity: sensitivity,
    enablePiiRedaction: process.env.GUARDRAIL_PII !== 'false',
    allowlist: (process.env.GUARDRAIL_ALLOWLIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    webFetchSecretScan: webFetchScan === 'full' || webFetchScan === 'off' ? webFetchScan : 'headers-only',
    network,
  };
}

let policy: GuardrailPolicy = resolveDefaultPolicy();

/** 运行时调整护栏策略（例如按租户级别收紧 / 放松）。 */
export function configureGuardrails(p: Partial<GuardrailPolicy>): void {
  policy = { ...policy, ...p };
}

/** 读取当前策略（只读），供 UI / 调试展示。 */
export function getGuardrailPolicy(): Readonly<GuardrailPolicy> {
  return policy;
}

// ---------------------------------------------------------------------------
// 密钥扫描
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bpassword\s*[:=]\s*\S+/i,
  /\bsecret\s*[:=]\s*\S+/i,
  /\bapi[_-]?key\s*[:=]\s*\S+/i,
  /\btoken\s*[:=]\s*[A-Za-z0-9._-]{16,}/i,
];

// ---------------------------------------------------------------------------
// 提示词注入检测（归一化 + 短语集，分敏感度）
// ---------------------------------------------------------------------------

// 完整句子级短语（低敏感度即启用）。
const PHRASES_LOW = [
  'ignore previous instructions',
  'ignore prior instructions',
  'disregard previous instructions',
  'disregard prior instructions',
  'ignore all instructions',
  'disregard all instructions',
  'forget your instructions',
  'forget previous instructions',
  'you are now',
  'override your instructions',
  'override the instructions',
  'ignore the above',
  'disregard the above',
  'new instructions',
  'repeat your instructions',
  'reveal your instructions',
  'print your instructions',
];

// 中等敏感度追加：短短语与伪装类。
// 注意：'system prompt' / 'fake system prompt' 已从本集合移除——二者是公认弱信号误拦词，
// 在「学习 / 讨论 / 优化 system prompt」这类正常输入中必然出现，却从不在真实注入里孤立出现
// （真实注入靠 PHRASES_LOW 的强信号句子兜底）。此前仅在输出侧（checkTaskOutput 等 strongOnly）
// 豁免，输入侧漏补导致正常含该词的输入被误拦；现与输出侧对称，任何敏感度均不因其单独命中。
const PHRASES_MED = [
  ...PHRASES_LOW,
  'act as dan',
  'developer mode',
];

// 高敏感度追加：强信号标记词。
const PHRASES_HIGH = [...PHRASES_MED, 'dan', 'jailbreak'];

function phraseSet(s: InjectionSensitivity): string[] {
  if (s === 'low') return PHRASES_LOW;
  if (s === 'high') return PHRASES_HIGH;
  return PHRASES_MED;
}

/**
 * 归一化用于扫描的文本：转小写、去除零宽字符与软连字符、去标点只留字母数字。
 * 这样 "i g n o r e   a l l   i n s t r u c t i o n s"、"IGNORE␣ALL␣INSTRUCTIONS"
 * 这类变形都能被捕获。
 */
function normalizeForScan(s: string): string {
  return s
    .toLowerCase()
    .replace(/[​­​‍﻿ᅟᅠ]/g, '') // 零宽/软连字符/词连接符
    .replace(/[^\p{L}\p{N}]/gu, ''); // 仅保留字母与数字，剔除空格与标点
}

// 外部语义级注入打分器（可接分类模型 / 第三方服务），得分 > 0.5 视为注入。
const customInjectionScorers: ((text: string) => number)[] = [];

/** 注册一个语义级注入打分器（返回 0~1）。返回 >0.5 即视为注入。 */
export function registerInjectionScorer(fn: (text: string) => number): void {
  customInjectionScorers.push(fn);
}

function isAllowlisted(textNorm: string, pol: GuardrailPolicy): boolean {
  return pol.allowlist.some((w) => textNorm.includes(normalizeForScan(w)));
}

function detectInjection(
  text: string,
  pol: GuardrailPolicy,
  /** 仅用句子级强信号短语（PHRASES_LOW）检测，跳过 medium/high 的弱信号短短语。 */
  strongOnly = false
): string | null {
  if (!pol.enableInjectionScan) return null;
  const norm = normalizeForScan(text);
  if (isAllowlisted(norm, pol)) return null;
  const phrases = strongOnly ? PHRASES_LOW : phraseSet(pol.injectionSensitivity);
  for (const p of phrases) {
    if (norm.includes(normalizeForScan(p))) {
      return p;
    }
  }
  for (const sc of customInjectionScorers) {
    try {
      if (sc(text) > 0.5) return 'semantic-injection';
    } catch {
      /* 打分器异常不影响主流程 */
    }
  }
  return null;
}

/** 域名是否匹配策略中的条目（`*` 表示全部；`*.example.com` 通配子域；普通条目精确匹配主机或任意子域）。 */
function domainMatches(host: string, entry: string): boolean {
  const h = host.toLowerCase();
  const e = entry.toLowerCase().trim();
  if (e === '*') return true; // 通配全部：denylist 含 '*' 即禁止一切外部出网。
  if (e.startsWith('*.')) {
    const base = e.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === e;
}

/** 判断 host 是否属于本地/私有网络地址（127.x.x.x、localhost、192.168.x.x、10.x.x.x、172.16-31.x.x）。 */
function isPrivateHost(host: string): boolean {
  // 强制非空后转小写，避免 TypeScript 的 strict null checks 报错
  const h = (host.split(':')[0] ?? '').toLowerCase();
  return (
    h === 'localhost' ||
    h.startsWith('127.') ||
    h.startsWith('192.168.') ||
    h.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.startsWith('[::1]') ||
    h === '::1'
  );
}

/**
 * 出网管控（P0.3）：依据策略判定某 URL 是否允许访问。
 * - open / 无 network：放行；
 * - allowlist：仅允许 listed 域名（含子域），其余拒绝；
 * - denylist：禁止 listed 域名（含子域），其余放行；
 * - 本地/私有地址（127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、localhost）豁免管控，始终放行。
 * 返回 null 表示放行，否则为拒绝原因。
 */
export function checkEgress(url: string, net?: NetworkPolicy): string | null {
  if (!net || net.mode === 'open') return null;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return 'invalid URL';
  }
  // 本地/私有网络豁免（测试用例与内网服务访问不受管控影响）
  if (isPrivateHost(host)) return null;
  if (net.mode === 'denylist') {
    const denied = (net.deniedDomains ?? []).some((d) => domainMatches(host, d));
    return denied ? `egress denied to ${host} (denylist)` : null;
  }
  // allowlist
  const allowed = (net.allowedDomains ?? []).some((d) => domainMatches(host, d));
  return allowed ? null : `egress not allowed to ${host} (not in allowlist)`;
}

// ---------------------------------------------------------------------------
// 自定义输入规则（向后兼容）
// ---------------------------------------------------------------------------

const customInputRules: { re: RegExp; reason: string; scope?: string }[] = [];

/**
 * 注册一条自定义输入校验规则（命中即拦截）。
 * @param scope 可选作用域标签（如 'medical-ad'）。传入后该规则仅当运行策略的
 *   `scopes` 包含此标签时才生效；不传则始终生效（全局安全底线）。
 */
export function registerInputRule(re: RegExp, reason: string, scope?: string): void {
  customInputRules.push({ re, reason, scope });
}

// ---------------------------------------------------------------------------
// 自定义输出规则（与输入规则对称；供业务插件注册领域合规过滤，如医疗广告法）
// ---------------------------------------------------------------------------

const customOutputRules: { re: RegExp; reason: string; scope?: string }[] = [];

/**
 * 注册一条自定义输出校验规则（命中即拦截模型最终输出）。
 * @param scope 可选作用域标签（如 'medical-ad'）。传入后该规则仅当运行策略的
 *   `scopes` 包含此标签时才生效；不传则始终生效（全局安全底线）。
 */
export function registerOutputRule(re: RegExp, reason: string, scope?: string): void {
  customOutputRules.push({ re, reason, scope });
}

// ---------------------------------------------------------------------------
// 上下文感知输出规则（P0.x）：可据「最近一次工具调用」等业务上下文做精准拦截，
// 突破纯文本正则无法感知会话状态的局限。例如：知识库查空后禁止模型自行推荐项目。
// core 只透传通用上下文（recentTool），具体业务判定由领域插件（如 medical-ad-guard）注册。
// ---------------------------------------------------------------------------

/** 输出侧校验可携带的上下文（由 harness 在调用 checkOutput 时注入，core 不假定任何业务语义）。 */
export interface GuardrailOutputContext {
  /** 最近一次执行的工具调用（name 含 server 前缀，result 为工具返回文本）。 */
  recentTool?: { name: string; result: string } | null;
}

/** 上下文感知输出规则：接收输出文本与上下文，返回拦截结果。 */
export type ContextualOutputRule = (text: string, ctx: GuardrailOutputContext) => GuardrailResult;

const customContextualOutputRules: { fn: ContextualOutputRule; scope?: string }[] = [];

/**
 * 注册一条上下文感知的输出校验规则（命中即拦截模型最终输出）。
 * 与 registerOutputRule（纯文本正则）互补：可据 recentTool 等上下文做精准判定。
 * @param scope 可选作用域标签（如 'medical-ad'）。传入后该规则仅当运行策略的
 *   `scopes` 包含此标签时才生效；不传则始终生效。
 */
export function registerContextualOutputRule(fn: ContextualOutputRule, scope?: string): void {
  customContextualOutputRules.push({ fn, scope });
}

/**
 * 业务自定义规则是否对当前策略生效（按 scope 收窄）。
 * - 规则未声明 scope → 始终生效（全局安全底线 / 业务方希望全局适用）；
 * - 调用方未传 scopes（旧路径、测试）→ 不收窄，全部生效（向后兼容）；
 * - 调用方传了 scopes 数组 → 仅当 ruleScope ∈ scopes 时生效。
 */
function ruleInScope(ruleScope: string | undefined, pol?: GuardrailPolicy): boolean {
  if (!ruleScope) return true;
  if (!pol || !Array.isArray(pol.scopes)) return true;
  return pol.scopes.includes(ruleScope);
}

// ---------------------------------------------------------------------------
// PII 脱敏
// ---------------------------------------------------------------------------

// 注意顺序：先匹配特异性高的（邮箱/手机/身份证/IP/Key），最后才是宽泛的银行卡。
const PII_REDACTORS: PiiRedactor[] = [
  {
    label: 'email',
    re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    mask: () => '***[email]',
  },
  {
    label: 'phone',
    // 前后加数字边界，避免把身份证/银行卡等长数字串里的 11 位子串误判为手机号。
    re: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g,
    mask: () => '***[phone]',
  },
  {
    label: 'cnid',
    re: /\b\d{17}[\dXx]\b/g,
    mask: () => '***[id]',
  },
  {
    label: 'ipv4',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    mask: () => '***[ip]',
  },
  {
    label: 'apikey',
    re: /\b(?:sk|pk|AKIA)[-_A-Za-z0-9]{10,}\b/g,
    mask: () => '***[apikey]',
  },
  {
    // 银行卡：13~19 位数字（在身份证/手机之后匹配，避免误伤）。
    label: 'card',
    re: /\b\d{13,19}\b/g,
    mask: () => '***[card]',
  },
];

const customPiiRedactors: PiiRedactor[] = [];

/** 注册一个自定义 PII 脱敏器（例如内部工号、证件号）。 */
export function registerPiiRedactor(r: PiiRedactor): void {
  customPiiRedactors.push(r);
}

/** 对文本做 PII 脱敏，返回打码后的文本。非字符串原样返回。 */
export function redactPII(text: string): string {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const r of PII_REDACTORS) out = out.replace(r.re, r.mask);
  for (const r of customPiiRedactors) out = out.replace(r.re, r.mask);
  return out;
}

/** 输出侧脱敏：受策略开关控制；关闭时原样返回。支持 per-call 策略覆盖（P0.3 租户隔离）。 */
export function redactOutput(text: string, pol?: GuardrailPolicy): string {
  const p = pol ?? policy;
  if (!p.enablePiiRedaction) return text;
  return redactPII(text);
}

// ---------------------------------------------------------------------------
// 对外校验接口（签名保持兼容）
// ---------------------------------------------------------------------------

export function checkInput(
  text: string,
  pol?: GuardrailPolicy,
  /**
   * 强信号模式（计划任务派发专用）：仅用句子级强信号短语（PHRASES_LOW）做注入检测，
   * 跳过 'system prompt' 等 medium 弱信号短短语 —— 与输出侧 checkTaskOutput 对称。
   * 计划任务的步骤描述合理地提到「阅读 system prompt 文档 / 优化 system prompt」，
   * 弱信号命中会把整次任务派发拦死；安全底线（真密钥格式 + 强信号注入）不放松。
   */
  strongOnly = false
): GuardrailResult {
  const p = pol ?? policy;
  if (typeof text !== 'string') {
    return { ok: false, reason: 'input must be a string' };
  }
  if (text.length > p.maxInputLength) {
    return { ok: false, reason: `input too long (${text.length} > ${p.maxInputLength})` };
  }
  if (p.enableSecretScan) {
    for (const re of SECRET_PATTERNS) {
      if (re.test(text)) return { ok: false, reason: 'possible secret in input' };
    }
  }
  const inj = detectInjection(text, p, strongOnly);
  if (inj) return { ok: false, reason: `possible prompt injection in input (matched: ${inj})` };
  for (const r of customInputRules) {
    if (!ruleInScope(r.scope, p)) continue;
    if (r.re.test(text)) return { ok: false, reason: r.reason };
  }
  return { ok: true };
}

export function checkOutput(
  text: string,
  pol?: GuardrailPolicy,
  ctx?: GuardrailOutputContext
): GuardrailResult {
  const p = pol ?? policy;
  if (typeof text !== 'string') return { ok: true };
  if (p.enableSecretScan) {
    for (const re of SECRET_PATTERNS) {
      if (re.test(text)) return { ok: false, reason: 'possible secret in output' };
    }
  }
  const inj = detectInjection(text, p);
  if (inj) return { ok: false, reason: `possible prompt injection in output (matched: ${inj})` };
  for (const r of customOutputRules) {
    if (!ruleInScope(r.scope, p)) continue;
    if (r.re.test(text)) return { ok: false, reason: r.reason };
  }
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
  const p = pol ?? policy;
  if (typeof text !== 'string') return { ok: true };
  if (p.enableSecretScan) {
    for (const re of SECRET_PATTERNS) {
      if (re.test(text)) return { ok: false, reason: 'possible secret in output' };
    }
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
  const p = pol ?? policy;
  if (typeof text !== 'string') return { ok: true };
  if (p.enableSecretScan) {
    for (const re of TASK_SECRET_PATTERNS) {
      if (re.test(text)) return { ok: false, reason: 'possible secret in output' };
    }
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
  const p = pol ?? policy;

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
