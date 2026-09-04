/**
 * 零依赖的中文/英文 token 估算器。
 *
 * 用途：把 LLM 返回的 `total_tokens` 拆成「系统 / 工具 / 历史 / 输出」四项占比，
 * 用于在调用链路的成本 span 里可视化各部分开销，便于定位 token 高消耗的来源
 * （例如「打招呼也 6501 tokens」的根因是 18 个工具 schema + 系统提示的固定开销）。
 *
 * 说明：这是启发式估算（字符数 / 系数），非精确 BPE 计数；真实 `total_tokens`
 * 仍由 provider 返回并作为权威值，估算仅用于展示占比趋势。
 *
 * 系数标定（以 tiktoken o200k_base / gpt-4o 同族为基准实测）：
 *  - 中文（CJK）：真实约 1.5~1.7 字/token，这里取 0.6 token/字（≈1.67 字/token），
 *    修正此前 1.0 token/字 导致的中文系统性高估 ~30%。
 *  - 英文词：取 0.75 token/词（实测接近）。
 *  - 其他字符（标点/空格等）：4 字符/token。
 */

const CJK = /[一-鿿]/g;
const NON_CJK_WORD = /[A-Za-z0-9_]+/g;

/** 一个中文（CJK）字符折算的 token 数。基准：o200k_base 实测约 1.5~1.7 字/token。 */
const CJK_TOKEN_PER_CHAR = 0.6;
/** 一个英文/数字词折算的 token 数。基准：o200k_base 实测接近 0.75。 */
const WORD_TOKEN_PER_WORD = 0.75;
/** 其他字符（非 CJK、非英文词）每多少字符折算 1 token。 */
const OTHER_CHARS_PER_TOKEN = 4;
/**
 * 超长「词」（连续无空格的非 CJK 串）的字符数阈值。
 * BPE 不会把 base64 / 超长 URL / 无空格 JSON 当成一个 token，而是按约 4 字符一片切分；
 * 此前实现只数「词的个数」不数长度，导致 'x'.repeat(20000) 被算成 1 token ——
 * 工具结果里的大段 base64 / 压缩 JSON / 长 URL 会让历史 token 被严重低估，
 * 进而使「上下文占用率」与「按 token 淘汰」的判定双双失真。
 */
const LONG_RUN_CHARS = 12;
/** 超长连续串每多少字符折算 1 token（BPE 对随机串的实测经验值）。 */
const LONG_RUN_CHARS_PER_TOKEN = 4;

/** 估算一段文本的 token 数。 */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = text.length;
  const m = text.match(CJK);
  if (m) {
    cjk = m.length;
    rest = text.length - cjk;
  }
  // 英文/数字词按系数折算，其余字符按 OTHER_CHARS_PER_TOKEN 折算。
  // 注意：长到不正常的「词」（base64 / 长 URL / 无空格 JSON）按字符数折算，
  // 否则一个 20000 字符的连续串只算 1 token，历史占用会被系统性低估。
  const words = text.match(NON_CJK_WORD);
  const wordChars = words ? words.join('').length : 0;
  const otherChars = Math.max(0, rest - wordChars);
  let wordTokens = 0;
  if (words) {
    for (const w of words) {
      wordTokens +=
        w.length > LONG_RUN_CHARS
          ? w.length / LONG_RUN_CHARS_PER_TOKEN
          : WORD_TOKEN_PER_WORD;
    }
  }
  const otherTokens = Math.ceil(otherChars / OTHER_CHARS_PER_TOKEN);
  // 中文不再按「1 字 = 1 token」，改用标定系数，避免中文 prompt 被系统性高估。
  const cjkTokens = Math.ceil(cjk * CJK_TOKEN_PER_CHAR);
  return cjkTokens + Math.ceil(wordTokens) + otherTokens;
}

/** 估算一组工具 schema 序列化后的 token 数（用于「工具」项占比）。
 *  注意：LLM 实际收到的是完整 JSON schema（含 `parameters` 结构），
 *  因此这里把 `name` + `description` + `parameters` 一并序列化估算，
 *  避免只算 name+description 时少算 parameters（schema 越大漏算越多，
 *  18 工具实测漏算约 54%）。 */
export function estimateToolsTokens(
  tools: Array<{ name: string; description?: string; parameters?: unknown }>
): number {
  let total = 0;
  for (const t of tools) {
    const blob = JSON.stringify({
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? {},
    });
    total += estimateTokens(blob);
  }
  return total;
}
