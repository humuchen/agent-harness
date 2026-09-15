import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { escapeHtml, hasHtmlBlock, isMarkdownLike } from './html-safe';
import { getLangLabel, highlightToHtml, normalizeLang } from './highlight';

// 使用独立 Marked 实例而非全局单例：配置只作用于本模块，
// 不会污染其它调用方（marked 的 use/setOptions 是全局生效的）。
const md = new Marked({ gfm: true, breaks: false });

export { escapeHtml, isMarkdownLike };

/* ────────────────────────── 折叠阈值 ────────────────────────── */

/** 代码块超过该行数才提供折叠入口。 */
export const CODE_FOLD_LINES = 20;

/** 表格超过该数据行数才提供折叠入口。 */
export const TABLE_FOLD_ROWS = 12;

/* ────────────────────────── 渲染缓存 ────────────────────────── */

/**
 * 渲染结果缓存。
 *
 * 必需而非优化：对话区每条消息的 `.msg-text` 走 `unsafeHTML` 注入，
 * 意味着任意一次组件更新（hover、其他消息追加、流式 token …）都会重建**全部**
 * 历史消息的富文本 DOM。没有缓存时，每次 hover 都要重新解析 + 重新高亮整段历史，
 * 长会话下会明确卡顿。缓存命中时只做一次 Map 读取。
 *
 * 键含选项位：同一段文本在流式（无工具条）与定型（有工具条）两种形态下产物不同，
 * 不可互相污染。容量用「插入序 + 命中续期」实现近似 LRU —— 历史消息反复命中，
 * 自然沉淀在队尾，被淘汰的是久未渲染的中间态文本（流式每帧产生一个新键）。
 */
const CACHE_MAX = 80;
const cache = new Map<string, string>();

function cacheKey(text: string, htmlBlocks: boolean, richBlocks: boolean, finalize: boolean): string {
  return `${htmlBlocks ? 1 : 0}${richBlocks ? 1 : 0}${finalize ? 1 : 0}\u0000${text}`;
}

/** 清空渲染缓存（仅测试使用；运行时不需要手动清理）。 */
export function clearRichHtmlCache(): void {
  cache.clear();
}

/* ────────────────────────── 结构增强 ────────────────────────── */

interface EnhanceOpts {
  /** 是否输出代码块工具条（语言/复制/折叠）与表格折叠栏。 */
  richBlocks: boolean;
  /** 消息是否已定型：只有定型后才提供折叠入口，流式中内容持续增长、不应被收走。 */
  finalize: boolean;
}

/**
 * 提取围栏语言标注。
 * marked 会输出 `<code class="language-ts">`；模型直出的 `<code class="lang-ts">` 一并接住。
 */
function extractLang(code: HTMLElement): string {
  const m = /(?:^|\s)(?:language|lang)-([^\s]+)/.exec(code.className);
  return m?.[1] ?? '';
}

/** 代码行数。末尾换行不代表多出一行，需先剥掉再计数。 */
function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n+$/, '').split('\n').length;
}

/**
 * 代码块增强：语法高亮 + 工具条容器。
 *
 * 高亮在 DOMPurify 之后进行，取的是已净化的 `textContent`（完整原文），
 * 由 hljs 重新分词并输出转义过的 token 标记，写回前再过一次净化 ——
 * 因此不存在「净化放宽白名单」的问题，也不需要为 class 之外的东西开口子。
 *
 * 高亮与容器同开关（richBlocks）而非各自独立：高亮会产出 token 着色，
 * 但若没有 `.md-code` 的底色分层，着色 token 会直接落在气泡底色上 ——
 * 「彩色文字」比「无色代码块」更糟（看起来像误染色，且失去代码块的视觉边界）。
 * 两者是一套完整形态，不做半套。
 */
function enhanceCodeBlocks(root: HTMLElement, o: EnhanceOpts): void {
  if (!o.richBlocks) return;
  const doc = root.ownerDocument ?? document;
  let idx = 0;
  Array.from(root.querySelectorAll('pre > code')).forEach((node) => {
    const codeEl = node as HTMLElement;
    const pre = codeEl.parentElement as HTMLElement | null;
    if (!pre) return;
    const langRaw = extractLang(codeEl);
    const text = codeEl.textContent ?? '';

    const highlighted = highlightToHtml(text, langRaw);
    if (highlighted !== null) {
      codeEl.innerHTML = DOMPurify.sanitize(highlighted);
      codeEl.classList.add('hljs');
      const norm = normalizeLang(langRaw);
      if (norm) codeEl.classList.add(`language-${norm}`);
    }
    // 未标注或未注册语言：保持纯文本，不猜语言（见 utils/highlight.ts 的取舍说明）。

    const lines = countLines(text);
    const wrap = doc.createElement('div');
    wrap.className = 'md-code';
    wrap.dataset.mdBlock = `code:${idx++}`;
    wrap.dataset.mdLines = String(lines);

    const head = doc.createElement('div');
    head.className = 'md-code-head';

    const label = getLangLabel(langRaw);
    if (label) {
      const langEl = doc.createElement('span');
      langEl.className = 'md-lang';
      langEl.textContent = label;
      head.appendChild(langEl);
    }

    const linesEl = doc.createElement('span');
    linesEl.className = 'md-lines';
    linesEl.textContent = `${lines} 行`;
    head.appendChild(linesEl);

    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'md-btn md-copy';
    copyBtn.title = '复制代码';
    copyBtn.textContent = '复制';
    head.appendChild(copyBtn);

    const foldable = o.finalize && lines > CODE_FOLD_LINES;
    if (foldable) {
      wrap.dataset.mdFoldable = '1';
      const foldBtn = doc.createElement('button');
      foldBtn.type = 'button';
      foldBtn.className = 'md-btn md-fold';
      foldBtn.title = '展开 / 收起代码';
      // 初始文案对应「默认折叠」态，随后的 applyFolds 会按真实状态改写。
      foldBtn.textContent = '展开全部';
      foldBtn.setAttribute('aria-expanded', 'false');
      head.appendChild(foldBtn);
    }

    const body = doc.createElement('div');
    body.className = 'md-code-body';

    pre.replaceWith(wrap);
    body.appendChild(pre);
    wrap.appendChild(head);
    wrap.appendChild(body);
  });
}

/**
 * 表格增强：滚动容器 + （对话页）折叠元数据与折叠栏。
 *
 * 为什么用 DOM 后处理、而不是定制 renderer.table：
 * 表格有两个来源 —— Markdown 语法（走 renderer）与模型直出的 <table> 原文
 * （走 marked 的 HTML 直通路径，完全不经过 renderer.table）。只在 renderer 里包
 * wrapper 会让后者成为没有滚动容器的孤儿表，宽表依旧撑破气泡。
 * 统一在此处理可保证「任何来源的 table 都恰好被包一层」，且实现点唯一。
 */
function enhanceTables(root: HTMLElement, o: EnhanceOpts): void {
  const doc = root.ownerDocument ?? document;
  let idx = 0;
  Array.from(root.querySelectorAll('table')).forEach((node) => {
    const table = node as HTMLElement;
    if (table.parentElement?.classList.contains('md-table-wrap')) return;

    const rows =
      table.querySelectorAll('tbody tr').length ||
      Math.max(0, table.querySelectorAll('tr').length - 1);

    const wrap = doc.createElement('div');
    wrap.className = 'md-table-wrap';
    table.replaceWith(wrap);
    wrap.appendChild(table);
    if (!o.richBlocks) return;

    const box = doc.createElement('div');
    box.className = 'md-table-box';
    box.dataset.mdBlock = `table:${idx++}`;
    box.dataset.mdLines = String(rows);
    wrap.replaceWith(box);
    box.appendChild(wrap);

    if (o.finalize && rows > TABLE_FOLD_ROWS) {
      box.dataset.mdFoldable = '1';
      const bar = doc.createElement('div');
      bar.className = 'md-fold-bar';
      const foldBtn = doc.createElement('button');
      foldBtn.type = 'button';
      foldBtn.className = 'md-btn md-fold';
      foldBtn.title = '展开 / 收起表格';
      foldBtn.textContent = '展开全部';
      foldBtn.setAttribute('aria-expanded', 'false');
      bar.appendChild(foldBtn);
      box.appendChild(bar);
    }
  });
}

/* ────────────────────────── 对外入口 ────────────────────────── */

/** 富文本渲染选项。 */
export interface RichHtmlOptions {
  /**
   * 是否允许「块级 HTML 标签」触发富文本渲染，默认关闭。
   * 仅助手输出应开启：模型直接吐 <table> 原文、且全文不含 Markdown 特征时，
   * 原判定会整体转义，表格以源码形式显示。用户输入保持关闭，
   * 避免把用户粘贴的 HTML 片段当作富文本渲染。
   */
  htmlBlocks?: boolean;
  /**
   * 是否输出带工具条的增强块结构（代码块的「语言 / 行数 / 复制 / 折叠」头部，
   * 与表格的折叠栏），默认关闭。
   *
   * 为什么由调用方按容器决定而不是全局开启：这些按钮依赖容器侧的事件委托，
   * 只输出结构而不接委托会得到「点了没反应」的死按钮。对话页（ah-chat）已注册委托，
   * 运行详情等其它复用本函数的容器尚未接 —— 对它们保持旧结构，视觉不退化。
   */
  richBlocks?: boolean;
  /**
   * 消息是否已定型（流式结束），默认 false。
   * 流式中不提供折叠入口：内容仍在增长，中途被收起会让读者丢失阅读位置。
   * 仅在 richBlocks 为 true 时生效。
   */
  finalize?: boolean;
}

/**
 * 自动识别并渲染：
 * - Markdown 文本（或开启 htmlBlocks 时含块级 HTML 标签的文本）→ 渲染为经 DOMPurify 净化的富文本 HTML；
 * - 纯文本 → 转义后保留换行（<br>），不引入多余标签。
 */
export function toRichHtml(text: string, opts: RichHtmlOptions = {}): string {
  if (!text) return '';
  // 去掉首尾空白：模型常在回答/推理首尾填充换行，避免被转成无意义的 <br> 空行。
  const t = text.trim();
  if (!t) return '';

  const needRich = isMarkdownLike(t) || (opts.htmlBlocks === true && hasHtmlBlock(t));
  if (!needRich) {
    return escapeHtml(t).replace(/\n/g, '<br>');
  }

  const htmlBlocks = opts.htmlBlocks === true;
  const richBlocks = opts.richBlocks === true;
  const finalize = richBlocks && opts.finalize === true;

  const key = cacheKey(t, htmlBlocks, richBlocks, finalize);
  const hit = cache.get(key);
  if (hit !== undefined) {
    // 命中后移到队尾，使长期活跃的消息不被淘汰。
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const raw = md.parse(t) as string;
  // RETURN_DOM 以便对净化后的树做结构后处理；净化先行，后处理只做包裹与
  // 标注（不改动既有文本内容），因此不会让任何未净化内容进入产物。
  const clean = DOMPurify.sanitize(raw, { RETURN_DOM: true }) as HTMLElement;
  const o: EnhanceOpts = { richBlocks, finalize };
  enhanceCodeBlocks(clean, o);
  enhanceTables(clean, o);
  const out = clean.innerHTML;

  cache.set(key, out);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return out;
}
