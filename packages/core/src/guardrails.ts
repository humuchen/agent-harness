// 内容安全护栏（企业级可配置策略引擎）。
//
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
  /** 出网管控（P0.3）：约束 web_fetch 可访问域名；缺省 open（全部放行）。 */
  network?: NetworkPolicy;
}

const DEFAULT_POLICY: GuardrailPolicy = {
  maxInputLength: 20000,
  enableSecretScan: true,
  enableInjectionScan: true,
  injectionSensitivity: 'medium',
  enablePiiRedaction: true,
  allowlist: [],
};

/** 允许通过环境变量调整护栏默认策略（无需改代码即可按部署收紧 / 放松）。 */
function resolveDefaultPolicy(): GuardrailPolicy {
  const sens = (process.env.GUARDRAIL_SENSITIVITY || '').toLowerCase();
  const sensitivity: InjectionSensitivity = sens === 'low' || sens === 'high' ? sens : 'medium';
  const maxInput = Number(process.env.GUARDRAIL_MAX_INPUT ?? '');
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
const PHRASES_MED = [
  ...PHRASES_LOW,
  'system prompt',
  'fake system prompt',
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

function detectInjection(text: string, pol: GuardrailPolicy): string | null {
  if (!pol.enableInjectionScan) return null;
  const norm = normalizeForScan(text);
  if (isAllowlisted(norm, pol)) return null;
  for (const p of phraseSet(pol.injectionSensitivity)) {
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

/**
 * 出网管控（P0.3）：依据策略判定某 URL 是否允许访问。
 * - open / 无 network：放行；
 * - allowlist：仅允许 listed 域名（含子域），其余拒绝；
 * - denylist：禁止 listed 域名（含子域），其余放行。
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

const customInputRules: { re: RegExp; reason: string }[] = [];

/** 注册一条自定义输入校验规则（命中即拦截）。 */
export function registerInputRule(re: RegExp, reason: string): void {
  customInputRules.push({ re, reason });
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

export function checkInput(text: string, pol?: GuardrailPolicy): GuardrailResult {
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
  const inj = detectInjection(text, p);
  if (inj) return { ok: false, reason: `possible prompt injection in input (matched: ${inj})` };
  for (const r of customInputRules) {
    if (r.re.test(text)) return { ok: false, reason: r.reason };
  }
  return { ok: true };
}

export function checkOutput(text: string, pol?: GuardrailPolicy): GuardrailResult {
  const p = pol ?? policy;
  if (typeof text !== 'string') return { ok: true };
  if (p.enableSecretScan) {
    for (const re of SECRET_PATTERNS) {
      if (re.test(text)) return { ok: false, reason: 'possible secret in output' };
    }
  }
  const inj = detectInjection(text, p);
  if (inj) return { ok: false, reason: `possible prompt injection in output (matched: ${inj})` };
  return { ok: true };
}

export function checkToolArgs(
  name: string,
  args: Record<string, unknown>,
  pol?: GuardrailPolicy
): GuardrailResult {
  const p = pol ?? policy;
  const serialized = JSON.stringify(args);
  if (p.enableSecretScan) {
    for (const re of SECRET_PATTERNS) {
      if (re.test(serialized)) {
        return { ok: false, reason: `possible secret in tool args for ${name}` };
      }
    }
  }
  const inj = detectInjection(serialized, p);
  if (inj) return { ok: false, reason: `possible injection in tool args for ${name} (matched: ${inj})` };
  // P0.3 出网管控：web_fetch 的目标 URL 受租户 network 策略约束。
  if (name === 'builtin__web_fetch' && typeof args.url === 'string') {
    const eg = checkEgress(String(args.url), p.network);
    if (eg) return { ok: false, reason: `network egress blocked: ${eg}` };
  }
  return { ok: true };
}
