import { describe, it, expect } from 'vitest';
import { escapeHtml, hasHtmlBlock, isMarkdownLike } from './html-safe';

describe('escapeHtml', () => {
  it('转义全部 5 种 HTML 危险字符', () => {
    expect(escapeHtml(`<a href="x" 'y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; &#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
  });

  it('对脚本注入做无害化（防 XSS 第一道防线）', () => {
    const evil = `<img src=x onerror=alert(1)>`;
    expect(escapeHtml(evil)).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('普通文本与中文原样保留', () => {
    expect(escapeHtml('你好 world 123')).toBe('你好 world 123');
  });

  it('空串与 undefined 安全（undefined 经隐式转串）', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('isMarkdownLike', () => {
  it('识别标题/列表/代码块/粗体等语法', () => {
    expect(isMarkdownLike('# 标题')).toBe(true);
    expect(isMarkdownLike('- 列表项')).toBe(true);
    expect(isMarkdownLike('```\ncode\n```')).toBe(true);
    expect(isMarkdownLike('**粗体**')).toBe(true);
    expect(isMarkdownLike('[链接](https://x.com)')).toBe(true);
    expect(isMarkdownLike('| a | b |\n| - | - |')).toBe(true);
  });

  it('纯文本不被误判为 Markdown', () => {
    expect(isMarkdownLike('今天天气不错，我们去散步吧。')).toBe(false);
    expect(isMarkdownLike('这是一段没有任何 markdown 符号的普通中文说明文字。')).toBe(false);
  });

  it('空串返回 false', () => {
    expect(isMarkdownLike('')).toBe(false);
  });
});

describe('hasHtmlBlock', () => {
  it('识别模型直出的结构性 HTML 块（表格/列表/引用等）', () => {
    expect(hasHtmlBlock('<table><thead><tr><th>现象</th></tr></thead></table>')).toBe(true);
    expect(hasHtmlBlock('<ul><li>a</li></ul>')).toBe(true);
    expect(hasHtmlBlock('<blockquote>引用</blockquote>')).toBe(true);
    expect(hasHtmlBlock('<pre>code</pre>')).toBe(true);
    expect(hasHtmlBlock('<h3>小标题</h3>')).toBe(true);
    expect(hasHtmlBlock('<details><summary>x</summary></details>')).toBe(true);
  });

  it('高噪声标签不触发，避免把讲解 HTML 的正文当成富文本', () => {
    expect(hasHtmlBlock('在 HTML 里用 <div> 做容器、<p> 分段是最常见的写法。')).toBe(false);
    expect(hasHtmlBlock('行内可用 <span> 或 <code> 标记。')).toBe(false);
    expect(hasHtmlBlock('<br>')).toBe(false);
  });

  it('普通文本与空串返回 false', () => {
    expect(hasHtmlBlock('今天天气不错，我们去散步吧。')).toBe(false);
    expect(hasHtmlBlock('')).toBe(false);
    // 大小写不敏感
    expect(hasHtmlBlock('<TABLE><TR><TD>a</TD></TR></TABLE>')).toBe(true);
  });

  it('与 isMarkdownLike 相互独立：纯 HTML 文本不被判为 Markdown', () => {
    const html = '<table><tr><td>卡住</td></tr></table>';
    expect(hasHtmlBlock(html)).toBe(true);
    expect(isMarkdownLike(html)).toBe(false);
  });
});
