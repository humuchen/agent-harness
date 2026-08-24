/**
 * json-view —— JSON 展示层优化（仅展示，不改数据）。
 *
 * 职责：把工具入参 / 检索结果等原始 JSON 文本渲染为「语法高亮 + 层级缩进 +
 * 长值折叠」的 Lit 模板。设计约束：
 * - 数据内容零改动：只消费字符串，不触碰任何业务状态；
 * - 非 JSON 文本原样回退（Lit 对插值自动转义，XSS 面与原 formatToolJson 一致）；
 * - 配色全部走 --ah-* 主题令牌（键=accent、字符串=warning、数字/布尔/null=success、
 *   标点=text-faint），深浅主题自动适配，不硬编码颜色；
 * - 折叠用原生 <details>（无组件状态、断线重连/重渲染后展开态由用户掌控）。
 */

import { html, nothing, type TemplateResult } from 'lit';

/** 字符串值超过该长度视为长值，折叠为一行预览 + 「展开」按钮。 */
const LONG_STR_THRESHOLD = 120;
/** 长值折叠时的预览保留字符数。 */
const STR_PREVIEW_CHARS = 80;
/** 数组 / 对象子项超过该数量时整体折叠为「… 共 N 项」。 */
const MAX_CHILDREN = 8;
/** 每层缩进像素。 */
const INDENT_PX = 14;

/** 与 chat.ts formatToolJson 相同的实体解码（防御服务端已转义的输入）。 */
function decodeEntities(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 长字符串值：<details> 折叠，summary 显示预览 + 展开提示。 */
function renderLongString(v: string): TemplateResult {
  const preview = v.slice(0, STR_PREVIEW_CHARS);
  return html`<details class="jv-fold">
    <summary class="jv-fold-head" title="点击展开完整内容">
      <span class="jv-str">"${preview}…"</span>
      <span class="jv-fold-btn">展开 ${v.length} 字 ▾</span>
    </summary>
    <span class="jv-str">"${v}"</span>
  </details>`;
}

/** 字符串值：超长走折叠，普通值直接渲染。 */
function renderString(v: string): TemplateResult {
  return v.length > LONG_STR_THRESHOLD
    ? renderLongString(v)
    : html`<span class="jv-str">"${v}"</span>`;
}

/** 数组：多子项时折叠为「… 共 N 项」，否则逐项平铺。 */
function renderArray(items: unknown[], depth: number): TemplateResult {
  if (items.length === 0) return html`<span class="jv-punc">[]</span>`;
  const body = items.map((item, i) =>
    html`<div class="jv-row" style=${`padding-left:${INDENT_PX}px`}>
      ${renderValue(item, depth + 1)}${i < items.length - 1
        ? html`<span class="jv-punc">,</span>`
        : nothing}
    </div>`
  );
  if (items.length > MAX_CHILDREN) {
    return html`<details class="jv-fold">
      <summary class="jv-fold-head">
        <span class="jv-punc">[</span>
        <span class="jv-fold-btn">… 共 ${items.length} 项 ▾</span>
        <span class="jv-punc">]</span>
      </summary>
      <span class="jv-punc">[</span>${body}<span class="jv-punc">]</span>
    </details>`;
  }
  return html`<span class="jv-punc">[</span>${body}<div
      class="jv-row"
      style=${`padding-left:${(depth - 1) * INDENT_PX}px`}
      ><span class="jv-punc">]</span></div
    >`;
}

/** 对象：键值对逐行对齐；多子项时折叠。 */
function renderObject(
  entries: [string, unknown][],
  depth: number
): TemplateResult {
  if (entries.length === 0) return html`<span class="jv-punc">{}</span>`;
  const body = entries.map(([k, v], i) =>
    html`<div class="jv-row" style=${`padding-left:${INDENT_PX}px`}>
      <span class="jv-key">"${k}"</span><span class="jv-punc">: </span>${renderValue(
        v,
        depth + 1
      )}${i < entries.length - 1 ? html`<span class="jv-punc">,</span>` : nothing}
    </div>`
  );
  if (entries.length > MAX_CHILDREN) {
    return html`<details class="jv-fold">
      <summary class="jv-fold-head">
        <span class="jv-punc">{</span>
        <span class="jv-fold-btn">… 共 ${entries.length} 项 ▾</span>
        <span class="jv-punc">}</span>
      </summary>
      <span class="jv-punc">{</span>${body}<span class="jv-punc">}</span>
    </details>`;
  }
  return html`<span class="jv-punc">{</span>${body}<div
      class="jv-row"
      style=${`padding-left:${(depth - 1) * INDENT_PX}px`}
      ><span class="jv-punc">}</span></div
    >`;
}

/** 值分发：按类型着色，容器递归。 */
function renderValue(v: unknown, depth = 1): TemplateResult {
  if (v === null || v === undefined) return html`<span class="jv-null">null</span>`;
  switch (typeof v) {
    case 'string':
      return renderString(v);
    case 'number':
      return html`<span class="jv-num">${String(v)}</span>`;
    case 'boolean':
      return html`<span class="jv-bool">${String(v)}</span>`;
    case 'object':
      return Array.isArray(v)
        ? renderArray(v as unknown[], depth)
        : renderObject(Object.entries(v as Record<string, unknown>), depth);
    default:
      return html`<span class="jv-str">${String(v)}</span>`;
  }
}

/**
 * 把原始文本渲染为高亮 JSON 内容（不含外层容器，嵌入调用方现有 <pre>/<div> 即可）。
 * - 解析成功：语法高亮 + 缩进 + 折叠；
 * - 解析失败：原文回退（Lit 插值自动 HTML 转义，安全性等同原实现）。
 */
export function renderJsonHtml(raw: string): TemplateResult {
  if (!raw || !raw.trim()) return html`${nothing}`;
  let data: unknown;
  try {
    data = JSON.parse(decodeEntities(raw));
  } catch {
    return html`${raw}`;
  }
  return html`<span class="jv">${renderValue(data, 1)}</span>`;
}
