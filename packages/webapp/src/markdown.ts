import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

// 常见 Markdown 语法启发式：命中任一即视为需要富文本渲染。
// 即便误判（把纯文本当 Markdown），marked 也只会原样转义输出，无副作用。
const MD_HINT =
  /(^|\n)#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|```|^\s*>\s|\*\*|__|\[[^\]]+\]\(|^\s*\|.*\|\s*$|\| ?[-: |]+\||~~/m;

export function isMarkdownLike(text: string): boolean {
  return MD_HINT.test(text);
}

/** 转义 HTML 特殊字符（防 XSS 的第一道防线，也用于导出时的属性/文本插入）。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 自动识别并渲染：
 * - Markdown 文本 → 渲染为经 DOMPurify 净化的富文本 HTML；
 * - 纯文本 → 转义后保留换行（<br>），不引入多余标签。
 */
export function toRichHtml(text: string): string {
  if (!text) return '';
  if (!isMarkdownLike(text)) {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
  const raw = marked.parse(text) as string;
  return DOMPurify.sanitize(raw);
}
