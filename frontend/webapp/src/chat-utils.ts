/**
 * chat.ts 拆分 · 纯函数工具集（零状态、零副作用）。
 * 从 chat.ts 原样迁出：检索工具判定、JSON 预览、深度思考解析。
 */

/** 检索/搜索类工具名特征：命中则归类为 retrieval 节点，结果以「检索内容」突出展示。 */
export const RETRIEVAL_RE =
  /retriev|search|fetch|query|lookup|wiki|web|rag|google|bing|knowledge|document|semantic/i;
export function isRetrievalTool(name: string): boolean {
  return RETRIEVAL_RE.test(name);
}

/** 把任意值安全转成单行/多行 JSON 预览，失败则原样字符串化。 */
export function safeJson(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.length > 800 ? v.slice(0, 800) + '…' : v;
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > 800 ? s.slice(0, 800) + '…' : s;
  } catch {
    return String(v);
  }
}

/**
 * 格式化工具卡入参/结果供 <pre> 展示。
 * 只转义 < > & 三种 HTML 危险字符，保留引号和换行不被转义，
 * 避免 JSON 中的 " 被 escapeHtml 转成 &quot; 导致渲染异常。
 */
/**
 * 深度思考解析：从模型实际返回的推理文本中提取「有价值内容」并解析为结构化呈现。
 * - 按行切分，剔除空行噪声；
 * - 识别「关键变量」（`key: value` / `key=value`，且非编号步骤），单独抽取供高亮；
 * - 其余推理文本保留原结构（编号 / 项目符号 / 段落），以 Markdown 输出，最终由打字机读逐字揭示。
 */
export function parseDeepThinking(raw: string): {
  text: string;
  vars: Array<[string, string]>;
} {
  if (!raw || !raw.trim()) return { text: '', vars: [] };
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim());
  const vars: Array<[string, string]> = [];
  const out: string[] = [];
  const varRe = /^(.{1,40})[:：=]\s*(.+)$/;
  const stepRe = /^\d+[\.、\)]/;
  for (const line of lines) {
    if (!line) continue;
    const vm = line.match(varRe);
    // 仅当不是「编号步骤」且形如 key-value 时，才判定为关键变量，避免误吞步骤描述。
    if (vm && !stepRe.test(line)) {
      vars.push([vm[1].trim(), vm[2].trim()]);
      continue;
    }
    out.push(line);
  }
  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, vars };
}

export function formatToolJson(raw: string): string {
  if (!raw) return '';
  // 先尝试解码已有的 HTML 实体（防御服务端已转义的情况），全部 5 种与 escapeHtml 对称。
  let decoded = raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  // 尝试美化 JSON（解析成功则缩进；否则原样展示）
  try {
    const parsed = JSON.parse(decoded);
    decoded = JSON.stringify(parsed, null, 2);
  } catch {
    /* 不是合法 JSON，原样展示 */
  }
  // 统一转义全部 5 种 HTML 危险字符，与 escapeHtml 保持一致，杜绝引号漏转义的 XSS 缝隙。
  return decoded
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
