export interface GuardrailResult {
  ok: boolean;
  reason?: string;
}

// 三层防护：输入、输出、工具参数。
// 默认规则：拒绝包含密钥、提示词注入，以及过长的输入。可按需扩展。

const SECRET_PATTERNS: RegExp[] = [
  /(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|password\s*[:=]\s*\S+|secret\s*[:=]\s*\S+)/i,
];

// 常见提示词注入特征（heuristics，非完备）。命中即视为可疑输入/输出。
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\b[\s\S]*?instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above|the)\b[\s\S]*?(instructions|prompt)/i,
  /you\s+are\s+now\s+[^.]{0,40}/i,
  /\bDAN\b/i,
  /system\s+prompt/i,
  /override\s+(your\s+)?(previous|system|instructions)/i,
];

const MAX_INPUT = 20000;

// 自定义规则注册表（运行时扩展护栏，例如按业务加敏感词）。
const customInputRules: { re: RegExp; reason: string }[] = [];

/** 注册一条自定义输入校验规则（命中即拦截）。 */
export function registerInputRule(re: RegExp, reason: string): void {
  customInputRules.push({ re, reason });
}

export function checkInput(text: string): GuardrailResult {
  if (typeof text !== 'string') {
    return { ok: false, reason: 'input must be a string' };
  }
  if (text.length > MAX_INPUT) {
    return { ok: false, reason: `input too long (${text.length} > ${MAX_INPUT})` };
  }
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, reason: 'possible secret in input' };
  }
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) return { ok: false, reason: 'possible prompt injection in input' };
  }
  for (const r of customInputRules) {
    if (r.re.test(text)) return { ok: false, reason: r.reason };
  }
  return { ok: true };
}

export function checkOutput(text: string): GuardrailResult {
  if (typeof text !== 'string') return { ok: true };
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, reason: 'possible secret in output' };
  }
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) return { ok: false, reason: 'possible prompt injection in output' };
  }
  return { ok: true };
}

export function checkToolArgs(
  name: string,
  args: Record<string, unknown>
): GuardrailResult {
  const serialized = JSON.stringify(args);
  for (const re of SECRET_PATTERNS) {
    if (re.test(serialized)) {
      return { ok: false, reason: `possible secret in tool args for ${name}` };
    }
  }
  return { ok: true };
}
