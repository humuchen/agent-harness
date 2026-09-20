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

/**
 * 内置工具显示名映射：链路节点用「人话标签」替代原始 builtin__xxx 名，
 * 让「是否被调用」在调用链里一眼可辨（如 Jev 显示为「Jev 决策 · TypeSafe」）。
 */
const BUILTIN_TOOL_LABELS: Record<string, string> = {
  builtin__jev_decide: 'Jev 决策 · TypeSafe',
  builtin__rag_retrieve: '知识检索 · RAG'
};

export function toolDisplayName(name: string): string {
  if (BUILTIN_TOOL_LABELS[name]) return BUILTIN_TOOL_LABELS[name];
  // 兜底：剥掉 builtin__ 前缀，保留可读部分。
  return name.startsWith('builtin__') ? name.slice('builtin__'.length) : name;
}

/**
 * 从 Jev 决策工具返回的 JSON 中提炼一行可读摘要，供链路节点 meta 直接展示
 * （如「category=billing (0.92) · urgency=78」）。
 * Jev 响应为结构化决策（answers: { 问题名 -> { type, choice|score|noul, ... } }），
 * 此函数防御式兜底：取不到精确字段时返回 undefined，由调用方退化为完整 JSON。
 */
export function summarizeJevDecision(resultStr: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(resultStr);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object') return undefined;
  const root = data as Record<string, unknown>;
  const answersRaw = root['answers'];
  const answers =
    answersRaw && typeof answersRaw === 'object' && !Array.isArray(answersRaw)
      ? (answersRaw as Record<string, unknown>)
      : root;
  const parts: string[] = [];
  for (const [q, a] of Object.entries(answers)) {
    if (!a || typeof a !== 'object') continue;
    const av = a as Record<string, unknown>;
    if ('choice' in av) {
      const conf = typeof av['confidence'] === 'number' ? ` (${av['confidence']})` : '';
      parts.push(`${q}=${String(av['choice'])}${conf}`);
    } else if ('score' in av) {
      parts.push(`${q}=${String(av['score'] ?? av['value'])}`);
    } else if ('noul' in av) {
      parts.push(`${q}=${String(av['noul'])}`);
    } else if ('value' in av) {
      parts.push(`${q}=${String(av['value'])}`);
    }
  }
  return parts.length ? parts.join(' · ') : undefined;
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
      vars.push([(vm[1] ?? '').trim(), (vm[2] ?? '').trim()]);
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
