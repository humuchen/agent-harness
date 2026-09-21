'use strict';
// markdown 交付文件预览渲染单测（?preview=1 的 md → HTML 格式转换）。
// 覆盖：标题/列表/表格/代码块/行内语法/引用/水平线的结构转换、
// XSS 转义（script/事件属性/伪协议）、任务列表、空输入。
//
// 运行：cd access/server && ./node_modules/.bin/tsc -p tsconfig.json && node --test test/markdown-preview.test.cjs

const test = require('node:test');
const assert = require('node:assert');

const { markdownPreviewHtml } = require('../dist/markdown-preview.js');

/** 只取 <main> 内的正文片段，便于断言。 */
function bodyOf(md) {
  const html = markdownPreviewHtml(md, 'test.md');
  const m = /<main>\n([\s\S]*?)\n<\/main>/.exec(html);
  assert.ok(m, '应输出完整 HTML 文档（含 <main>）');
  return m[1];
}

test('完整文档结构：DOCTYPE + 转义后的标题', () => {
  const html = markdownPreviewHtml('# 报告', '计划报告-分析.md');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>计划报告-分析\.md<\/title>/);
});

test('标题 / 水平线 / 段落', () => {
  const md = '# 一级\n\n## 二级\n\n正文段落\n---\n后续段落';
  const b = bodyOf(md);
  assert.match(b, /<h1>一级<\/h1>/);
  assert.match(b, /<h2>二级<\/h2>/);
  assert.match(b, /<hr>/);
  assert.match(b, /<p>后续段落<\/p>/);
});

test('行内语法：粗体 / 斜体 / 行内码 / 删除线', () => {
  const b = bodyOf('**粗体** 与 *斜体* 与 `code()` 与 ~~删除~~');
  assert.match(b, /<strong>粗体<\/strong>/);
  assert.match(b, /<em>斜体<\/em>/);
  assert.match(b, /<code>code\(\)<\/code>/);
  assert.match(b, /<del>删除<\/del>/);
});

test('无序 / 有序 / 嵌套列表与任务标记', () => {
  const b = bodyOf([
    '- 顶层 A',
    '- 顶层 B',
    '  - 子项 B1',
    '- [ ] 待办',
    '- [x] 已完成',
    '',
    '1. 第一',
    '2. 第二'
  ].join('\n'));
  assert.match(b, /<ul>/);
  assert.match(b, /<li>顶层 A<\/li>/);
  assert.match(b, /<ul><li>子项 B1<\/li><\/ul>/);
  assert.match(b, /<span class="md-task">☐<\/span> 待办/);
  assert.match(b, /<span class="md-task">☑<\/span> 已完成/);
  assert.match(b, /<ol><li>第一<\/li><li>第二<\/li><\/ol>/);
});

test('表格：表头 / 对齐 / 数据行', () => {
  const md = '| 名称 | 数值 |\n|:----:|-----:|\n| 甲 | 12 |\n| 乙 | 34 |';
  const b = bodyOf(md);
  assert.match(b, /<th style="text-align:center">名称<\/th>/);
  assert.match(b, /<th style="text-align:right">数值<\/th>/);
  assert.match(b, /<td style="text-align:center">甲<\/td><td style="text-align:right">12<\/td>/);
  assert.match(b, /<tr><td style="text-align:center">乙<\/td><td style="text-align:right">34<\/td><\/tr><\/tbody>/);
});

test('围栏代码块：内容转义且不参与行内语法', () => {
  const md = '```js\nconst s = "**not-bold** & <tag>";\n```';
  const b = bodyOf(md);
  assert.match(b, /<pre><code class="language-js">/);
  assert.ok(b.includes('**not-bold** &amp; &lt;tag&gt;'), '代码内容应原样转义保留');
  assert.ok(!b.includes('<strong>not-bold'), '代码内容不应被行内语法改写');
});

test('XSS：脚本 / 事件属性 / 伪协议全部失效', () => {
  const b = bodyOf('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n<img src=x onerror=alert(1)>');
  assert.ok(!/<script>/.test(b), 'script 标签必须被转义');
  assert.ok(b.includes('&lt;script&gt;'));
  assert.ok(!/href="javascript:/i.test(b), '伪协议链接必须被降级');
  assert.ok(!/<img src=x/.test(b), '原生 img 标签必须被转义');
});

test('安全链接保留、锚点可用、带 rel 防护', () => {
  const b = bodyOf('[官网](https://example.com/a) 与 [相对](/api/x) 与 [锚](#sec)');
  assert.match(b, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">官网<\/a>/);
  assert.match(b, /<a href="\/api\/x"/);
  assert.match(b, /<a href="#sec"/);
});

test('引用块与多行段落（硬换行）', () => {
  const b = bodyOf('> 引用一\n> 引用二\n\n第一行\n第二行');
  assert.match(b, /<blockquote><p>引用一<br>引用二<\/p><\/blockquote>/);
  assert.match(b, /<p>第一行<br>第二行<\/p>/);
});

test('空输入产出空正文', () => {
  assert.equal(bodyOf('').trim(), '');
});

test('未闭合围栏不抛异常（耗尽即收尾）', () => {
  const b = bodyOf('```txt\n未闭合内容');
  assert.match(b, /<pre><code class="language-txt">未闭合内容<\/code><\/pre>/);
});
