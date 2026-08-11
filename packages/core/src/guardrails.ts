export interface GuardrailResult {
  ok: boolean;
  reason?: string;
}

// 三层防护：输入、输出、工具参数。
// 默认规则：拒绝包含密钥和过长的输入。可按需扩展。

const SECRET_RE =
  /(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|password\s*[:=]\s*\S+|secret\s*[:=]\s*\S+)/i;

const MAX_INPUT = 20000;

export function checkInput(text: string): GuardrailResult {
  if (typeof text !== 'string') {
    return { ok: false, reason: 'input must be a string' };
  }
  if (text.length > MAX_INPUT) {
    return { ok: false, reason: `input too long (${text.length} > ${MAX_INPUT})` };
  }
  if (SECRET_RE.test(text)) {
    return { ok: false, reason: 'possible secret in input' };
  }
  return { ok: true };
}

export function checkOutput(text: string): GuardrailResult {
  if (SECRET_RE.test(text)) {
    return { ok: false, reason: 'possible secret in output' };
  }
  return { ok: true };
}

export function checkToolArgs(
  name: string,
  args: Record<string, unknown>
): GuardrailResult {
  const serialized = JSON.stringify(args);
  if (SECRET_RE.test(serialized)) {
    return { ok: false, reason: `possible secret in tool args for ${name}` };
  }
  return { ok: true };
}
