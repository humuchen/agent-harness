import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { escapeHtml, isMarkdownLike } from './html-safe';

marked.setOptions({ gfm: true, breaks: false });

export { escapeHtml, isMarkdownLike };

/**
 * 自动识别并渲染：
 * - Markdown 文本 → 渲染为经 DOMPurify 净化的富文本 HTML；
 * - 纯文本 → 转义后保留换行（<br>），不引入多余标签。
 */
export function toRichHtml(text: string): string {
  if (!text) return '';
  // 去掉首尾空白：模型常在回答/推理首尾填充换行，避免被转成无意义的 <br> 空行。
  const t = text.trim();
  if (!t) return '';
  if (!isMarkdownLike(t)) {
    return escapeHtml(t).replace(/\n/g, '<br>');
  }
  const raw = marked.parse(t) as string;
  return DOMPurify.sanitize(raw);
}
