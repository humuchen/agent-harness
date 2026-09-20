/**
 * markdown 交付文件预览渲染（P4.6 后续：?preview=1 的 md → HTML 格式转换）。
 *
 * 背景：/api/artifacts/:id?preview=1 此前把 markdown 按 `text/plain` 原样返回，
 * 浏览器里看到的是未渲染的 md 源码。本模块在服务端把 md 转为可读 HTML。
 *
 * 安全模型（转义优先，零依赖）：
 * - 所有原始文本先经 escapeHtml，后续结构化只注入受控标签 → 任何 <script>、
 *   事件属性、伪协议注入在转义后都不再是可执行语法，无需运行时 sanitizer；
 * - 链接仅放行 http/https/mailto 相对安全协议，其余协议降级为纯文本；
 * - 代码块 / 行内码内容永远不参与行内语法解析。
 *
 * 覆盖语法（LLM 交付报告的高频子集）：ATX 标题、有序/无序/任务列表（含嵌套）、
 * 表格、围栏代码块、行内码、粗体/斜体/删除线、链接、引用块、水平线、段落。
 * 不追求完整 CommonMark —— 预览是「读」的场景，宁可保守降级为文本，不可放大攻击面。
 */

/** HTML 转义（与项目内其它 escapeHtml 语义一致）。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 允许的链接协议；其余（javascript:/vbscript:/data:…）一律降级为纯文本。 */
const SAFE_LINK_PROTOCOL = /^(https?:\/\/|mailto:|\/|#)/i;

/** 越界安全取行（tsconfig 开了 noUncheckedIndexedAccess）。 */
function at(lines: string[], i: number): string {
  return i >= 0 && i < lines.length ? lines[i] ?? '' : '';
}

interface InlineCtx {
  /** 占位符表：被保护的内容（行内码 / 链接）不参与后续行内规则。 */
  stash: string[];
}

/** 把一段受保护 HTML 存入占位符，返回不含行内语法字符的 token。 */
function stash(ctx: InlineCtx, html: string): string {
  ctx.stash.push(html);
  return `\u0000${ctx.stash.length - 1}\u0000`;
}

function restoreStash(text: string, ctx: InlineCtx): string {
  return text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => {
    const idx = Number(i);
    return Number.isInteger(idx) && idx >= 0 && idx < ctx.stash.length ? ctx.stash[idx] ?? '' : '';
  });
}

/** 粗体 / 斜体 / 删除线（链接 text 的回填也走这里，但不回填占位符）。 */
function renderInlineRest(escaped: string): string {
  return escaped
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

/**
 * 行内语法：`code` → 图片 → 链接 → 粗体/斜体/删除线。
 * 输入必须是已转义文本。
 */
function renderInline(escaped: string): string {
  const ctx: InlineCtx = { stash: [] };
  let s = escaped;

  // 1. 行内码：内容原样保留（已转义），不参与后续规则。
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(ctx, `<code>${code}</code>`));

  // 2. 图片 / 链接：url 只放行安全协议，其余降级为纯文本。
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) =>
    stash(ctx, SAFE_LINK_PROTOCOL.test(url) ? `<img src="${url}" alt="${alt}">` : `「图：${alt}」`)
  );
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const inner = renderInlineRest(text);
    return SAFE_LINK_PROTOCOL.test(url)
      ? stash(ctx, `<a href="${url}" target="_blank" rel="noopener noreferrer">${inner}</a>`)
      : stash(ctx, inner);
  });

  s = renderInlineRest(s);
  return restoreStash(s, ctx);
}

/* ────────────────────────── 块级结构 ────────────────────────── */

const HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d{1,9}[.)]\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const TABLE_SEP_RE = /^\|?[\s:|-]+\|[\s:|-]*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/** 单层块解析：输入已转义的行数组，输出 HTML 片段。 */
function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = at(lines, i);

    // 空行：块分隔
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 围栏代码块（``` 或 ~~~，围栏后其余字符视为语言标注）
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const mark = fence[1] ?? '```';
      const closeRe = new RegExp(`^\\s*\\${mark[0]}{${mark.length},}\\s*$`);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closeRe.test(at(lines, i))) {
        body.push(at(lines, i));
        i += 1;
      }
      i += 1; // 跳过收尾围栏（或耗尽）
      const lang = (fence[2] ?? '').trim();
      const cls = lang ? ` class="language-${lang.replace(/[^\w+-]/g, '')}"` : '';
      out.push(`<pre><code${cls}>${body.join('\n')}</code></pre>`);
      continue;
    }

    // ATX 标题
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      out.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      i += 1;
      continue;
    }

    // 水平线
    if (HR_RE.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    // 引用块：连续 > 行（转义后为 &gt;）
    if (/^\s*&gt;/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s*&gt;/.test(at(lines, i))) {
        inner.push(at(lines, i).replace(/^\s*&gt;\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(inner)}</blockquote>`);
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && TABLE_SEP_RE.test(at(lines, i + 1)) && at(lines, i + 1).includes('-')) {
      const cells = (row: string): string[] => {
        let t = row.trim();
        if (t.startsWith('|')) t = t.slice(1);
        if (t.endsWith('|')) t = t.slice(0, -1);
        return t.split('|').map((c) => c.trim());
      };
      const align = (c: string): string =>
        c.startsWith(':') && c.endsWith(':')
          ? ' style="text-align:center"'
          : c.endsWith(':')
            ? ' style="text-align:right"'
            : '';
      const head = cells(line);
      const aligns = cells(at(lines, i + 1)).map(align);
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && at(lines, i).includes('|') && at(lines, i).trim()) {
        const row = cells(at(lines, i));
        rows.push(`<tr>${row.map((c, ci) => `<td${aligns[ci] ?? ''}>${renderInline(c)}</td>`).join('')}</tr>`);
        i += 1;
      }
      out.push(
        `<div class="md-table-wrap"><table><thead><tr>${head
          .map((c, ci) => `<th${aligns[ci] ?? ''}>${renderInline(c)}</th>`)
          .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      );
      continue;
    }

    // 列表（含嵌套 + 任务标记）
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const { html, next } = renderList(lines, i, (line.length - line.trimStart().length));
      out.push(html);
      i = next;
      continue;
    }

    // 段落：聚合到下一个空行 / 块边界
    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const p = at(lines, i);
      if (
        !p.trim() ||
        HR_RE.test(p) ||
        FENCE_RE.test(p) ||
        /^#{1,6}\s/.test(p) ||
        UL_RE.test(p) ||
        OL_RE.test(p) ||
        /^\s*&gt;/.test(p)
      ) {
        break;
      }
      para.push(p);
      i += 1;
    }
    out.push(`<p>${para.map((p) => renderInline(p)).join('<br>')}</p>`);
  }

  return out.join('\n');
}

interface ListResult {
  html: string;
  next: number;
}

/**
 * 从 lines[start] 起解析一个（可能嵌套的）列表。
 * baseIndent 为起始项的前导空格数；缩进 ≥ baseIndent+2 视为子列表。
 */
function renderList(lines: string[], start: number, baseIndent: number): ListResult {
  const startLine = at(lines, start);
  const first = UL_RE.exec(startLine) ?? OL_RE.exec(startLine);
  if (!first) return { html: '', next: start };
  const isOrdered = OL_RE.test(startLine) && !UL_RE.test(startLine);
  const items: string[] = [];
  let i = start;

  while (i < lines.length) {
    const cur = at(lines, i);
    const m = UL_RE.exec(cur) ?? OL_RE.exec(cur);
    if (!m) {
      // 非列表行：缩进 ≥ baseIndent+2 视为上一项的续行，否则列表结束
      if (items.length > 0 && /^\s{2,}\S/.test(cur) && cur.length - cur.trimStart().length >= baseIndent + 2) {
        items[items.length - 1] += ' ' + renderInline(cur.trim());
        i += 1;
        continue;
      }
      break;
    }
    const indent = (m[1] ?? '').length;
    if (indent < baseIndent) break; // 回到更浅层级，交还上层
    if (indent >= baseIndent + 2) {
      // 更深层级：递归为子列表，挂到当前项
      const sub = renderList(lines, i, indent);
      items[items.length - 1] += sub.html;
      i = sub.next;
      continue;
    }
    let content = m[2] ?? '';
    const task = TASK_RE.exec(content);
    if (task) {
      const box = task[1] === ' ' ? '☐' : '☑';
      content = `<span class="md-task">${box}</span> ${task[2] ?? ''}`;
    }
    items.push(renderInline(content));
    i += 1;
  }

  const tag = isOrdered ? 'ol' : 'ul';
  const html = `<${tag}>${items.map((it) => `<li>${it}</li>`).join('')}</${tag}>`;
  return { html, next: i };
}

/* ────────────────────────── 整页包装 ────────────────────────── */

/** 渲染为完整 HTML 文档（预览页：含基础排版样式，自动适配深色模式）。 */
export function markdownPreviewHtml(mdText: string, fileName: string): string {
  const normalized = (mdText ?? '').replace(/\r\n?/g, '\n');
  const body = renderBlocks(escapeHtml(normalized).split('\n'));
  const title = escapeHtml(fileName || '预览');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1rem;
    font: 15px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #1f2328; background: #ffffff;
  }
  main { max-width: 860px; margin: 0 auto; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.35; margin: 1.6em 0 .6em; }
  h1 { font-size: 1.7em; border-bottom: 1px solid #e5e7eb; padding-bottom: .35em; }
  h2 { font-size: 1.4em; border-bottom: 1px solid #eef0f3; padding-bottom: .3em; }
  h3 { font-size: 1.2em; }
  p { margin: .7em 0; }
  a { color: #0969da; }
  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: .9em; background: #f2f3f5; border-radius: 4px; padding: .15em .4em;
  }
  pre {
    background: #f6f8fa; border: 1px solid #e5e7eb; border-radius: 8px;
    padding: .9em 1em; overflow-x: auto; line-height: 1.55;
  }
  pre code { background: none; padding: 0; font-size: .88em; }
  blockquote {
    margin: .8em 0; padding: .2em 1em; color: #57606a;
    border-left: 4px solid #d0d7de;
  }
  table { border-collapse: collapse; margin: .9em 0; font-size: .93em; }
  th, td { border: 1px solid #d8dce2; padding: .45em .8em; }
  th { background: #f6f8fa; }
  .md-table-wrap { overflow-x: auto; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.6em 0; }
  ul, ol { padding-left: 1.6em; }
  li { margin: .25em 0; }
  .md-task { margin-right: .35em; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e8eb; background: #16181c; }
    h1, h2 { border-color: #2c3038; }
    a { color: #6cb2ff; }
    code { background: #24272d; }
    pre { background: #1d2026; border-color: #2c3038; }
    blockquote { color: #9aa1ab; border-color: #3a3f47; }
    th, td { border-color: #3a3f47; }
    th { background: #1d2026; }
    hr { border-color: #2c3038; }
  }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}
