/**
 * 零依赖的中文/英文 token 估算器。
 *
 * 用途：把 LLM 返回的 `total_tokens` 拆成「系统 / 工具 / 历史 / 输出」四项占比，
 * 用于在调用链路的成本 span 里可视化各部分开销，便于定位 token 高消耗的来源
 * （例如「打招呼也 6501 tokens」的根因是 18 个工具 schema + 系统提示的固定开销）。
 *
 * 说明：这是启发式估算（字符数 / 系数），非精确 BPE 计数；真实 `total_tokens`
 * 仍由 provider 返回并作为权威值，估算仅用于展示占比趋势。
 */
const CJK = /[一-鿿]/g;
const NON_CJK_WORD = /[A-Za-z0-9_]+/g;

/** 估算一段文本的 token 数。中文按字计 1 token/字，其余按 ~4 字符/token。 */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = text.length;
  const m = text.match(CJK);
  if (m) {
    cjk = m.length;
    rest = text.length - cjk;
  }
  // 英文/数字词按 ~0.75 token/词粗估，其余字符按 4/ token。
  const words = text.match(NON_CJK_WORD);
  const wordChars = words ? words.join('').length : 0;
  const otherChars = Math.max(0, rest - wordChars);
  const wordTokens = words ? Math.ceil(words.length * 0.75) : 0;
  const otherTokens = Math.ceil(otherChars / 4);
  return cjk + wordTokens + otherTokens;
}

/** 估算一组工具 schema 序列化后的 token 数（用于「工具」项占比）。 */
export function estimateToolsTokens(tools: Array<{ name: string; description?: string }>): number {
  let total = 0;
  for (const t of tools) {
    const blob = `${t.name} ${t.description ?? ''}`;
    total += estimateTokens(blob);
  }
  return total;
}
