/**
 * 全局样式注入（Svelte 迁移后取代 Lit 的 shadow DOM 样式分发）。
 * ----------------------------------------------------------------
 * Lit 时代：sharedStyles / chatStyles 以 `static styles` 进入各组件的 shadow root，
 * 每个 host 一份拷贝；`:host` 选择器指向各自的 shadow host，面板之间天然隔离。
 *
 * Svelte 时代：无 Shadow DOM。共享样式改为在应用启动时一次性注入 <head>。
 * 两层语义补偿：
 *  1. `:host { ... }` 已在转换脚本中改写为 `.ah-c { ... }`（各组件根元素携带 ah-c 类）；
 *  2. **chatStyles 必须作用域化到 `.chat-root`**：chat 的内部会话侧栏与 app 壳侧栏
 *     同名（`.sidebar`），`.content` / `.topbar` 等壳层类名亦然 —— Lit 的 shadow 边界
 *     隔离了它们，全局注入后会互相劫持（如 ≤900px 时 chat 的抽屉规则把 app 侧栏
 *     滑出屏幕）。scopeCss() 给 chatStyles 的每条规则前缀 `.chat-root`（chat 根内的
 *     元素全部命中，与原 shadow 作用域等价）；宿主级规则（`.ah-c`）已在源文件改写
 *     为 `.chat-root`，前缀器遇到含 .chat-root 的选择器原样保留。
 *
 * 调用点：main.ts 启动第一步（与 initTheme 并列），必须早于任何组件挂载。
 */
import { sharedStyles } from './styles';
import { chatStyles } from './chat-styles';

const CHAT_SCOPE = '.chat-root';

/**
 * 给 CSS 文本的每条顶层选择器加作用域前缀。
 * - 逐字符走大括号深度：只在「选择器上下文」（深度为 0 的前奏）改写；
 * - @media / @supports / @container / @layer 条件块递归处理内部规则；
 * - @keyframes / @font-face / @property 无选择器语义，整体保留；
 * - 逗号分隔的选择器逐段处理：含 `.chat-root` 的段原样保留（宿主级规则已手工改名），
 *   以 `&` 开头的嵌套选择器把 `&` 替换为作用域，其余加 `SCOPE ` 前缀。
 */
export function scopeCss(css: string, scope: string): string {
  const out: string[] = [];
  let i = 0;
  const n = css.length;

  while (i < n) {
    // 顶层注释原样输出
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push(css.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = css.charAt(i);
    if (/\s/.test(ch)) {
      out.push(ch);
      i++;
      continue;
    }
    // 读到 { 为止的「前奏」（选择器或 at-rule 头）；跳过前奏内的注释
    const brace = css.indexOf('{', i);
    if (brace === -1) {
      out.push(css.slice(i));
      break;
    }
    let prelude = css.slice(i, brace);
    i = brace + 1; // 消费 '{'
    // 读完整块（已配平的大括号），i 停在 '}' 之后
    const blockStart = i;
    let depth = 1;
    while (i < n && depth > 0) {
      const ch = css[i];
      if (ch === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const block = css.slice(blockStart, i);

    const trimmed = prelude.trimStart();
    if (trimmed.startsWith('@')) {
      if (
        trimmed.startsWith('@keyframes') ||
        trimmed.startsWith('@font-face') ||
        trimmed.startsWith('@property')
      ) {
        out.push(prelude + block);
      } else if (/^@(media|supports|container|layer)\b/.test(trimmed)) {
        out.push(prelude + '{' + scopeCss(block.slice(1, -1), scope) + '}');
      } else {
        out.push(prelude + block);
      }
      continue;
    }

    // 普通规则：改写选择器（保留前奏中的注释位置）
    const cm = /\/\*[\s\S]*?\*\//.exec(prelude);
    const transform = (sel: string): string =>
      sel
        .split(',')
        .map((part) => {
          const t = part.trim();
          if (!t) return part;
          if (t.includes('.chat-root')) return t;
          if (t.startsWith('&')) return scope + t.slice(1);
          return `${scope} ${t}`;
        })
        .join(', ');
    if (cm) {
      out.push(
        prelude.slice(0, cm.index) +
          cm[0] +
          transform(prelude.slice(cm.index + cm[0].length)) +
          ' {' +
          block
      );
    } else {
      out.push(transform(prelude) + ' {' + block);
    }
  }
  return out.join('');
}

/** 文档级全局 CSS：sharedStyles 全局注入 + chatStyles 作用域化到 .chat-root。 */
export const GLOBAL_CSS: string = [
  sharedStyles,
  scopeCss(chatStyles.join('\n'), CHAT_SCOPE)
].join('\n');

const STYLE_ID = 'ah-global-styles';

/** 幂等注入：重复调用只会更新内容，不会叠加 <style> 节点。 */
export function installGlobalStyles(): void {
  if (typeof document === 'undefined') return;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== GLOBAL_CSS) style.textContent = GLOBAL_CSS;
}
