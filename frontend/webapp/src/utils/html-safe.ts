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
