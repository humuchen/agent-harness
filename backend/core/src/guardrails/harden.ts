// 文本硬化（对抗归一化，中期：领域护栏绕过对抗的基础设施）。P1#21 拆分自 guardrails.ts。
// 纯文本归一化，不含任何业务语义：全半角折叠、去零宽/变体选择符、
// 去 emoji/符号/标点/空白，仅保留字母、数字与 '%'（供 100% 类断言词存活）。
// 领域规则经 opts.normalize  opted-in 后按硬化文本匹配，封堵「保~证不留疤」
// 「１００％安全」等廉价绕过手段。核心保持零业务词。

/** 全角（FF01–FF5E）→ 半角（20–7E）；全角空格（U+3000）→ 空格。 */
function foldFullWidth(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else if (code === 0x3000) out += ' ';
    else out += ch;
  }
  return out;
}

/** 白名单保留：字母（含 CJK）+ 数字 + '%'；其余（符号/标点/空白/零宽/变体选择符）全剔除。 */
const HARDEN_STRIP_RE = /[^\p{L}\p{N}%]+/gu;

/** 硬化文本：全半角折叠 → 剔除符号/标点/空白/不可见字符。规则 pattern 应按其输出形态编写。 */
export function hardenText(text: string): string {
  if (typeof text !== 'string') return text;
  return foldFullWidth(text).replace(HARDEN_STRIP_RE, '');
}
