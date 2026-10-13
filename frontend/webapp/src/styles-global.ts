/**
 * 全局样式注入（Svelte 迁移后取代 Lit 的 shadow DOM 样式分发）。
 * ----------------------------------------------------------------
 * Lit 时代：sharedStyles / chatStyles 以 `static styles` 进入各组件的 shadow root，
 * 每个 host 一份拷贝；`:host` 选择器指向各自的 shadow host。
 *
 * Svelte 时代：无 Shadow DOM。共享样式改为在应用启动时一次性注入 <head>，
 * 成为文档级样式表：
 *  - `:host { ... }` 已在转换脚本中改写为 `.ah-c { ... }`（各组件根元素携带 ah-c 类）；
 *  - 组件自有样式仍放各组件的 <style>（Svelte 自动加 scoping 哈希，语义接近 shadow 隔离）；
 *  - 注入顺序与 Lit 的 `static styles = [sharedStyles, chatStyles]` 一致
 *    （先 shared 后 chat，mobilePill 的 !important 覆盖不受顺序影响）。
 *
 * 调用点：main.ts 启动第一步（与 initTheme 并列），必须早于任何组件挂载。
 */
import { sharedStyles } from './styles';
import { chatStyles } from './chat-styles';

/** 文档级全局 CSS：sharedStyles（含 mobilePill 收尾）+ chatStyles 全量。 */
export const GLOBAL_CSS: string = [sharedStyles, ...chatStyles].join('\n');

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
