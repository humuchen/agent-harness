import { describe, it, expect } from 'vitest';
import { CODE_FOLD_LINES, TABLE_FOLD_ROWS, toRichHtml } from './markdown';

/** 表格：渲染结构必须保住表格语义，且样式层依赖的钩子（wrapper / align / 空 td）不能被净化剥离。 */
describe('toRichHtml · 表格', () => {
  const mdTable = '| 现象 | 最可能的原因 |\n| --- | --- |\n| 一直转圈 | 网络超时 |';

  it('Markdown 表格外包一层滚动容器，table 保持表格结构', () => {
    const html = toRichHtml(mdTable);
    expect(html).toContain('<div class="md-table-wrap">');
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('</table></div>');
  });

  it('外层 wrapper 位于 table 之前（滚动容器必须是父级）', () => {
    const html = toRichHtml(mdTable);
    expect(html.indexOf('md-table-wrap')).toBeLessThan(html.indexOf('<table>'));
  });

  it('GFM 对齐语法输出的 align 属性不被净化剥离', () => {
    const html = toRichHtml('| 名称 | 数量 |\n| :--- | ---: |\n| 甲 | 12 |');
    expect(html).toContain('align="right"');
    expect(toRichHtml('| a | b |\n| :-: | --- |\n| 1 | 2 |')).toContain('align="center"');
  });

  it('空单元格保留为空 td（占位符由 CSS 渲染）', () => {
    const html = toRichHtml('| a | b |\n| --- | --- |\n| 1 | |');
    expect(html).toMatch(/<td[^>]*><\/td>/);
  });

  it('单元格内的注入被净化，表格结构仍完整', () => {
    const html = toRichHtml(
      '| a | b |\n| --- | --- |\n| <img src=x onerror=alert(1)> | <script>alert(2)</script> |'
    );
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).toContain('md-table-wrap');
  });

  it('表格不再依赖 display:block 的旧妥协（结构层面即无内联样式）', () => {
    expect(toRichHtml(mdTable)).not.toContain('style=');
  });
});

/** 块级 HTML 降级：模型直出 <table> 原文时不再以源码文本呈现。 */
describe('toRichHtml · 块级 HTML 降级修复', () => {
  const rawHtmlTable =
    '<table><thead><tr><th>现象</th></tr></thead><tbody><tr><td>卡住</td></tr></tbody></table>';

  it('默认关闭：纯 HTML 片段走纯文本分支（用户输入路径，行为不变）', () => {
    const html = toRichHtml(rawHtmlTable);
    expect(html).toContain('&lt;table&gt;');
    expect(html).not.toContain('<table>');
  });

  it('开启 htmlBlocks：渲染为真实表格并补齐滚动容器（助手输出路径）', () => {
    const html = toRichHtml(rawHtmlTable, { htmlBlocks: true });
    expect(html).toContain('<div class="md-table-wrap">');
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
  });

  it('开启 htmlBlocks 也不误渲染讲解 HTML 的正文', () => {
    const text = '在 HTML 里用 div 做容器、p 分段是最常见的写法。';
    const html = toRichHtml(text, { htmlBlocks: true });
    expect(html).not.toContain('<div');
    expect(html).toContain('在 HTML 里用 div 做容器');
  });
});

/** 两种表格来源（Markdown 语法 / 模型直出 HTML）必须产出同构结构，且不重复包裹。 */
describe('toRichHtml · 表格包裹一致性', () => {
  it('Markdown 表格与 HTML 直出表格各自恰好被包一层', () => {
    const fromMd = toRichHtml('| a | b |\n| --- | --- |\n| 1 | 2 |');
    const fromHtml = toRichHtml('<table><tr><td>1</td><td>2</td></tr></table>', {
      htmlBlocks: true
    });
    for (const html of [fromMd, fromHtml]) {
      expect((html.match(/md-table-wrap/g) ?? []).length).toBe(1);
      expect(html.indexOf('md-table-wrap')).toBeLessThan(html.indexOf('<table>'));
    }
  });

  it('同一段文本中的多个表格各自独立包裹', () => {
    const html = toRichHtml('| a |\n| --- |\n| 1 |\n\n中间说明\n\n| b |\n| --- |\n| 2 |');
    expect((html.match(/md-table-wrap/g) ?? []).length).toBe(2);
  });

  it('表格之外的标签不受影响（未产生多余 wrapper）', () => {
    const html = toRichHtml('# 标题\n\n- 列表项');
    expect(html).not.toContain('md-table-wrap');
  });
});

/** 回归：既有行为不得因「表格包裹后处理」而改变。 */
describe('toRichHtml · 既有行为回归', () => {
  it('纯文本转义并保留换行', () => {
    expect(toRichHtml('第一行\n第二行')).toBe('第一行<br>第二行');
  });

  it('空文本与空白文本返回空串', () => {
    expect(toRichHtml('')).toBe('');
    expect(toRichHtml('   \n  ')).toBe('');
  });

  it('标题/列表仍正常渲染', () => {
    expect(toRichHtml('## 标题')).toContain('<h2>标题</h2>');
    expect(toRichHtml('- a\n- b')).toContain('<ul>');
  });

  it('代码块仍渲染为 pre/code，且内容被转义', () => {
    const html = toRichHtml('```\nconst a = 1 < 2;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('<code>');
    expect(html).toContain('&lt;');
  });
});

/* ══════════════════ B 批：代码高亮与折叠 ══════════════════ */

/** 生成 n 行看起来像真代码的文本（用于阈值与高亮断言）。 */
const codeOf = (n: number) =>
  Array.from({ length: n }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n');

/** 生成 n 行数据行的 Markdown 表格。 */
const tableOf = (n: number) =>
  [
    '| 现象 | 原因 |',
    '| --- | --- |',
    ...Array.from({ length: n }, (_, i) => `| 现象${i + 1} | 原因${i + 1} |`)
  ].join('\n');

/**
 * richBlocks 是「代码块增强」的总开关。
 * 关闭时必须逐字节保持 A 批的产物形态 —— 用户消息、运行详情等未接委托的容器
 * 都依赖这一点（结构变了却没人处理按钮，就会得到点了没反应的死按钮）。
 */
describe('toRichHtml · 代码块增强开关', () => {
  const md = '```ts\nconst a: number = 1;\n```';

  it('默认关闭：结构不变、无高亮、无工具条', () => {
    const html = toRichHtml(md);
    expect(html).not.toContain('md-code');
    expect(html).not.toContain('hljs');
    expect(html).not.toContain('md-copy');
  });

  it('开启后：容器 / 语言标签 / 行数 / 复制按钮齐备', () => {
    const html = toRichHtml(md, { richBlocks: true });
    expect(html).toContain('class="md-code"');
    expect(html).toContain('class="md-code-head"');
    expect(html).toContain('class="md-code-body"');
    expect(html).toContain('class="md-lang">ts<');
    expect(html).toContain('class="md-lines">1 行<');
    expect(html).toContain('md-copy');
    expect(html).toContain('data-md-block="code:0"');
  });

  it('开启后产出高亮 token', () => {
    const html = toRichHtml(md, { richBlocks: true });
    expect(html).toContain('hljs');
    expect(html).toContain('hljs-keyword');
  });

  it('未标注语言的代码块：不着色，但仍给容器与行数', () => {
    const html = toRichHtml('```\nplain text here\n```', {
      richBlocks: true
    });
    expect(html).not.toContain('hljs-keyword');
    expect(html).toContain('md-code');
    expect(html).toContain('class="md-lines">1 行<');
    // 无语言标注时不渲染语言标签。
    expect(html).not.toContain('class="md-lang"');
  });

  it('未注册语言：不着色，但保留标签说明它是什么语言', () => {
    const html = toRichHtml('```foobar\nsome content\n```', {
      richBlocks: true
    });
    expect(html).not.toContain('hljs-keyword');
    expect(html).toContain('class="md-lang">foobar<');
  });

  it('高亮产物不含内联样式（配色由 CSS 变量接管）', () => {
    expect(toRichHtml(md, { richBlocks: true })).not.toContain('style=');
  });
});

/** 折叠入口只在消息定型后出现：流式中内容还在增长，中途收起会丢失阅读位置。 */
describe('toRichHtml · 代码块折叠', () => {
  it('流式中（finalize 缺省）不给折叠入口，无论多长', () => {
    const html = toRichHtml('```ts\n' + codeOf(80) + '\n```', {
      richBlocks: true
    });
    expect(html).not.toContain('data-md-foldable');
    expect(html).not.toContain('md-fold');
  });

  it('定型且超过阈值：给出折叠入口与可折叠标记', () => {
    const html = toRichHtml('```ts\n' + codeOf(CODE_FOLD_LINES + 1) + '\n```', {
      richBlocks: true,
      finalize: true
    });
    expect(html).toContain('data-md-foldable="1"');
    expect(html).toContain('md-fold');
    expect(html).toContain(`data-md-lines="${CODE_FOLD_LINES + 1}"`);
  });

  it('恰好等于阈值不折叠（阈值语义为「超过」）', () => {
    const html = toRichHtml('```ts\n' + codeOf(CODE_FOLD_LINES) + '\n```', {
      richBlocks: true,
      finalize: true
    });
    expect(html).not.toContain('data-md-foldable');
  });

  it('行数统计不受末尾换行影响', () => {
    const html = toRichHtml('```ts\n' + codeOf(3) + '\n```', {
      richBlocks: true,
      finalize: true
    });
    expect(html).toContain('data-md-lines="3"');
  });

  it('finalize 在未开启 richBlocks 时不产生任何影响', () => {
    const long = '```ts\n' + codeOf(80) + '\n```';
    expect(toRichHtml(long, { finalize: true })).toBe(toRichHtml(long));
  });
});

/** 表格折叠：容器栈为 box（定位）> wrap（横滑）> table。 */
describe('toRichHtml · 表格折叠', () => {
  it('开启 richBlocks 时补一层 box，wrapper 仍恰好一层', () => {
    const html = toRichHtml(tableOf(3), { richBlocks: true });
    expect(html).toContain('class="md-table-box"');
    expect((html.match(/md-table-wrap/g) ?? []).length).toBe(1);
    expect(html.indexOf('md-table-box')).toBeLessThan(html.indexOf('md-table-wrap'));
  });

  it('定型且超过阈值：给出折叠栏', () => {
    const html = toRichHtml(tableOf(TABLE_FOLD_ROWS + 1), {
      richBlocks: true,
      finalize: true
    });
    expect(html).toContain('data-md-foldable="1"');
    expect(html).toContain('md-fold-bar');
    expect(html).toContain(`data-md-lines="${TABLE_FOLD_ROWS + 1}"`);
  });

  it('恰好等于阈值不折叠', () => {
    const html = toRichHtml(tableOf(TABLE_FOLD_ROWS), {
      richBlocks: true,
      finalize: true
    });
    expect(html).not.toContain('data-md-foldable');
  });

  it('行数取自 tbody 行数（不含表头行）', () => {
    const html = toRichHtml(tableOf(5), { richBlocks: true });
    expect(html).toContain('data-md-lines="5"');
  });

  it('未定型的长表格也不折叠', () => {
    const html = toRichHtml(tableOf(TABLE_FOLD_ROWS + 5), { richBlocks: true });
    expect(html).not.toContain('data-md-foldable');
  });
});

/** 同一段文本内的多个块按出现顺序编号；编号是折叠态定位的唯一键。 */
describe('toRichHtml · 块编号', () => {
  it('多个代码块按顺序编号', () => {
    const html = toRichHtml(
      '```ts\nconst a = 1;\n```\n\n文字\n\n```json\n{"a":1}\n```',
      { richBlocks: true }
    );
    expect(html).toContain('data-md-block="code:0"');
    expect(html).toContain('data-md-block="code:1"');
  });

  it('代码块与表格各自独立编号', () => {
    const html = toRichHtml('```ts\nconst a = 1;\n```\n\n' + tableOf(2), {
      richBlocks: true
    });
    expect(html).toContain('data-md-block="code:0"');
    expect(html).toContain('data-md-block="table:0"');
  });
});

/**
 * 渲染缓存的正确性约束：产物是纯函数结果。
 * 选项不同必须得到不同产物，且互不污染 —— 这是缓存键必须含选项位的原因。
 */
describe('toRichHtml · 缓存一致性', () => {
  const md = '```ts\nconst a: number = 1;\n```';

  it('同一输入重复调用结果稳定', () => {
    const a = toRichHtml(md, { richBlocks: true, finalize: true });
    const b = toRichHtml(md, { richBlocks: true, finalize: true });
    const c = toRichHtml(md, { richBlocks: true, finalize: true });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('richBlocks 开关切换不互相污染', () => {
    const rich = toRichHtml(md, { richBlocks: true });
    const plain = toRichHtml(md);
    expect(rich).not.toBe(plain);
    // 再次取用必须仍与首次一致（若缓存键缺少选项位，这里会拿到错误的那一份）。
    expect(toRichHtml(md, { richBlocks: true })).toBe(rich);
    expect(toRichHtml(md)).toBe(plain);
  });

  it('finalize 切换不互相污染', () => {
    const long = '```ts\n' + codeOf(CODE_FOLD_LINES + 1) + '\n```';
    const streamed = toRichHtml(long, { richBlocks: true });
    const done = toRichHtml(long, { richBlocks: true, finalize: true });
    expect(streamed).not.toBe(done);
    expect(toRichHtml(long, { richBlocks: true })).toBe(streamed);
    expect(toRichHtml(long, { richBlocks: true, finalize: true })).toBe(done);
  });
});

/** 净化边界：高亮在净化之后进行，写回的 token 标记不得成为注入面。 */
describe('toRichHtml · 高亮链路的安全边界', () => {
  it('代码块内的脚本标签不产生可执行节点', () => {
    const html = toRichHtml('```html\n<script>alert(1)</script>\n```', {
      richBlocks: true
    });
    expect(html).not.toContain('<script');
  });

  it('围栏标注里的注入不逃逸到属性之外', () => {
    const html = toRichHtml('```" onmouseover="alert(1)\nx\n```', {
      richBlocks: true
    });
    expect(html).not.toContain('onmouseover="alert(1)"');
  });

  it('代码内容里的 img onerror 不成为可执行属性', () => {
    const html = toRichHtml('```html\n<img src=x onerror=alert(1)>\n```', {
      richBlocks: true
    });
    // 注意：`onerror` 作为被转义后的**文本**留在代码块里是正确的（它就是源码内容），
    // 要断言的是它没有变成元素属性。
    expect(html).not.toMatch(/<[^>]*\sonerror=/);
    expect(html).toContain('&lt;');
  });
});
