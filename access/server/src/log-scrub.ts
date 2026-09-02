/**
 * 全局日志脱敏 scrubber（P2 生产化）。
 *
 * 拦截 JSON 日志中的敏感字段（API Key / token / password / 身份证等），
 * 避免调用方疏漏导致的密钥泄露。
 *
 * 使用方式：
 *   import { installScrubber, scrubFields } from './log-scrub';
 *   // 1) 启动时安装一次（推荐放在 server.ts bootstrap 早期）
 *   installScrubber({
 *     paths: ['body.password', 'body.token', 'headers.authorization', 'detail.apiKey'],
 *     patterns: [/sk-[a-zA-Z0-9]{20,}/, /\b\d{17}[\dXx]\b/],
 *   });
 *   // 2) 每次 structLog 前调用 scrubFields() 对 fields 对象做深拷贝脱敏
 *   structLog('info', 'login', scrubFields({ userId, passwordInput }));
 */

const DEFAULT_PATTERNS = [
  // OpenAI / OpenRouter 风格 API Key
  /(?:sk-|openai-|or-)[a-zA-Z0-9]{20,}/gi,
  // 手机号（含国家码）
  /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g,
  // 身份证号
  /\b\d{17}[\dXx]\b/gi,
  // JWT token（三个 base64 段）
  /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
  // Bearer token
  /(?<=bearer\s)[a-zA-Z0-9_.+-]+/gi
];

const DEFAULT_PATHS = [
  // 常见敏感字段名（精确匹配 key）
  'password',
  'passwd',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'x-api-key',
  'cookie',
  'credit_card',
  'card_number',
  'ssn',
  'id_card'
];

interface ScrubberOptions {
  /** 需要脱敏的路径前缀（用于路径级拦截，如 body.password）。为空则只走键名匹配。 */
  paths?: string[];

  /** 需要脱敏的值的正则模式（用于值级拦截）。 */
  patterns?: RegExp[];

  /** 替换为的字符串，默认 '[REDACTED]'。 */
  redaction?: string;
}

const defaultOptions: Required<ScrubberOptions> = {
  paths: [...DEFAULT_PATHS],
  patterns: [...DEFAULT_PATTERNS],
  redaction: '[REDACTED]'
};

let options: Required<ScrubberOptions> = { ...defaultOptions };

/** 安装/覆盖全局脱敏规则。应在 server 启动早期调用一次。 */
export function installScrubber(opts: ScrubberOptions): void {
  options = { ...defaultOptions, ...opts };
}

/**
 * 深拷贝并脱敏 fields 对象。
 * - 命中 DEFAULT_PATHS 中任意键名的值 → '[REDACTED]'
 * - 命中 DEFAULT_PATTERNS 中任意正则的值 → '[REDACTED]'
 * - 递归处理嵌套对象与数组
 */
export function scrubFields<
  T extends Record<string, unknown> | null | undefined
>(obj: T): T {
  if (obj == null) return obj;
  if (typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      typeof item === 'object' ? scrubFields(item) : redactValue(item)
    ) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (options.paths.some((p) => k.toLowerCase().includes(p.toLowerCase()))) {
      out[k] = options.redaction;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = scrubFields(v as Record<string, unknown>);
    } else {
      out[k] = redactValue(v);
    }
  }
  return out as T;
}

function redactValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  for (const re of options.patterns) {
    if (re.test(v)) return options.redaction;
  }
  return v;
}
