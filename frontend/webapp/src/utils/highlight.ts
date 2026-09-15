/**
 * 代码语法高亮：highlight.js core + 按需注册语言。
 *
 * 为什么用 `highlight.js/lib/core` 而非默认入口：
 * 默认入口会注册全部 190+ 种语言（未压缩约 900KB），而对话场景实际只会遇到十几种。
 * core + 显式注册把增量压到可控范围，代价是「未注册语言一律不着色」——
 * 这正是本模块想要的保守行为，见下。
 *
 * 为什么不做语言自动检测（highlightAuto）：
 * 1) 成本：需在每帧流式渲染中对每个代码块试跑全部已注册语言，实测 >10ms/块，
 *    与流式帧预算（P95 < 8ms）直接冲突；
 * 2) 准确性：JSON / JavaScript / TypeScript 之间，以及纯文本与代码之间误判率不低。
 *    错误着色比不着色更误导读者（把普通文本染成关键字会让人以为那是代码语义）。
 * 故只有「显式标注 + 在白名单内」的语言才着色，其余保持现状（继承正文色）。
 *
 * 安全性：本模块只接收「已由 marked 转义、且经 DOMPurify 净化」后的纯文本，
 * 返回的是 hljs 自身转义过的 token 标记；调用方还会对写回结果再做一次净化。
 * 全程不引入任何未经净化的内容。hljs 只产出 <span class>，无内联 style，
 * 因此配色可以完全交给 CSS 变量，天然支持明暗主题切换。
 */
import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** 已注册语言的规范名集合（顺序即注册顺序，与展示无关）。 */
const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml
};

export const SUPPORTED_LANGS: readonly string[] = Object.keys(LANGUAGES);

for (const [name, def] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, def);
}

/**
 * 围栏语言别名 → 已注册的规范名。
 * 覆盖模型与用户最常写错的那些写法（sh / py / yml / tsx / docker …），
 * 未命中时回落到「小写原名」，再由 normalizeLang 判断是否已注册。
 */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsonc: 'json',
  json5: 'json',
  html: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  svg: 'xml',
  vue: 'xml',
  scss: 'css',
  less: 'css',
  sass: 'css',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ksh: 'bash',
  console: 'bash',
  shellsession: 'bash',
  py: 'python',
  python3: 'python',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  toml: 'ini',
  conf: 'ini',
  cfg: 'ini',
  docker: 'dockerfile',
  golang: 'go',
  rs: 'rust',
  psql: 'sql',
  mysql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  sqlite: 'sql'
};

/**
 * 语言标签的展示上限：超长标签会挤掉工具条右侧的按钮。
 * 真实的围栏标注极少超过这个长度（最长如 `dockerfile` 共 10 字符）。
 */
const LABEL_MAX = 16;

/**
 * 归一化围栏语言标注。
 * @returns 已注册语言的规范名；返回 '' 表示「不应着色」（未标注 / 未注册 / 明确纯文本）。
 */
export function normalizeLang(raw: string | undefined | null): string {
  const l = (raw ?? '').trim().toLowerCase().replace(/^language-/, '');
  if (!l) return '';
  const mapped = ALIASES[l] ?? l;
  return Object.prototype.hasOwnProperty.call(LANGUAGES, mapped) ? mapped : '';
}

/**
 * 语言标签文案：优先显示用户实际书写的形式（如 `ts` 而非 `typescript`），
 * 因为它与原文一致、更贴近用户预期。未标注时返回 ''（不渲染标签元素）。
 */
export function getLangLabel(raw: string | undefined | null): string {
  const l = (raw ?? '').trim().toLowerCase().replace(/^language-/, '');
  if (!l) return '';
  return l.length > LABEL_MAX ? l.slice(0, LABEL_MAX) : l;
}

/**
 * 高亮一段代码。
 * @param code 原始代码文本（调用方保证已净化）
 * @returns 含 `<span class="hljs-*">` 的 HTML；语言未注册时返回 null（调用方保持纯文本）
 */
export function highlightToHtml(code: string, lang: string | undefined | null): string | null {
  const name = normalizeLang(lang);
  if (!name) return null;
  try {
    // ignoreIllegals：代码片段常不完整（流式中尤其），不加此项 hljs 会抛错。
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    // 语言定义异常 / 极端输入：降级为不着色，绝不让渲染链路失败。
    return null;
  }
}
