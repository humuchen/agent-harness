/**
 * XSS 转义与 Markdown 启发式判定（零 DOM 依赖，可在 node 测试环境直接验证）。
 * 从 utils/markdown.ts 迁出纯逻辑部分，使「转义第一道防线」与 DOMPurify/marked
 * 等浏览器侧依赖解耦，便于单测覆盖。markdown.ts 仍从此处再导出以保持调用点不变。
 */

/** 转义 HTML 特殊字符（防 XSS 的第一道防线，也用于导出时的属性/文本插入）。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 常见 Markdown 语法启发式：命中任一即视为需要富文本渲染。
// 即便误判（把纯文本当 Markdown），marked 也只会原样转义输出，无副作用。
const MD_HINT =
  /(^|\n)#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|```|^\s*>\s|\*\*|__|\[[^\]]+\]\(|^\s*\|.*\|\s*$| \| ?[-: |]+ \||~~/m;

/** 判断文本是否像 Markdown（命中任一语法特征即视为需要富文本渲染）。 */
export function isMarkdownLike(text: string): boolean {
  return MD_HINT.test(text);
}

// 块级 HTML 标签：模型常直接输出 <table>/<ul> 等「原文」而非 Markdown 语法。
// 这类文本若走纯文本分支会被整体转义，表格将以源码形式显示在气泡里（已确认缺陷）。
// 刻意只收「结构性容器」，不含 div/span/code/p/hr 等高噪声标签 ——
// 讲解 HTML 的正文（如「用 <p> 标签分段」）不该被渲染成真实元素。
const HTML_BLOCK_HINT =
  /<(table|thead|tbody|tfoot|tr|th|td|caption|ul|ol|li|dl|dt|dd|pre|blockquote|h[1-6]|details|summary|figure|figcaption)\b/i;

/**
 * 判断文本是否含块级 HTML 标签。
 * 注意：该判定**不参与** isMarkdownLike 的既有语义，由调用方按来源决定是否启用 ——
 * 助手输出启用（修复 HTML 表格降级），用户输入不启用（避免把用户粘贴内容当富文本渲染）。
 */
export function hasHtmlBlock(text: string): boolean {
  return HTML_BLOCK_HINT.test(text);
}
