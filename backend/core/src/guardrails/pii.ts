// PII 脱敏（输出侧）。P1#21 拆分自 guardrails.ts。
// ipv4 mask 依赖 egress 的 isPrivateIp（私网/保留段才打码——版本号/公网地址不是隐私）。
import type { GuardrailPolicy, PiiRedactor } from './types';
import { isPrivateIp } from './egress';
import { getModulePolicy } from './policy';

/** Luhn 校验：真实银行卡号必过；时间戳 / 订单号等纯数字几乎不过（误杀防护核心）。 */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

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
    // P1 误杀修复：仅打码「段值合法且私网/保留段」的 IPv4——用户隐私风险来自
    // 内网拓扑（10.x/192.168.x/169.254 元数据等）；版本号（1.2.3.4、redis 7.2.4.1）
    // 与公网服务地址（8.8.8.8）不是隐私，技术问答的版本信息此前会被打码成 ***[ip]。
    mask: (m: string) => {
      const segs = m.split('.').map(Number);
      if (segs.some((n) => n > 255)) return m;
      return isPrivateIp(m) ? '***[ip]' : m;
    },
  },
  {
    label: 'apikey',
    re: /\b(?:sk|pk|AKIA)[-_A-Za-z0-9]{10,}\b/g,
    mask: () => '***[apikey]',
  },
  {
    // 银行卡：13~19 位数字且通过 Luhn 校验（在身份证/手机之后匹配，避免误伤）。
    // P1 误杀修复：13 位 Unix 毫秒时间戳与常见订单号此前一律被打码成 ***[card]。
    label: 'card',
    re: /\b\d{13,19}\b/g,
    mask: (m: string) => (luhnValid(m) ? '***[card]' : m),
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
  const p = pol ?? getModulePolicy();
  if (!p.enablePiiRedaction) return text;
  return redactPII(text);
}
