/**
 * 富文本块（超长代码块 / 表格）折叠的纯逻辑。
 *
 * 抽出的原因：本仓的组件级行为测不了一整套（AhChat 依赖 fetch / SSE / localStorage
 * 等大量运行时），因此约定「可判定逻辑一律与 Lit 解耦」后单测。
 * 折叠里真正容易改错的是**缺省语义**（可折叠的块未表态时该开还是该合），
 * 把它钉在纯函数里比埋在组件方法里安全 —— 组件只剩 DOM 读写。
 *
 * 键的形状为 `${scope}/${block}`：
 * - scope 由渲染容器给出（`data-md-scope`：`ans-12` = 第 12 条消息的回答区），
 *   因此渲染产物本身不需要知道消息 id，内容缓存才能只按文本建立；
 * - block 由渲染产物给出（`data-md-block`：`code:0` / `table:1`），
 *   是同一作用域内的出现序号，流式追加时既有块的序号不变。
 */

/** 折叠态覆盖表的键。 */
export function foldKey(scope: string, block: string): string {
  return `${scope}/${block}`;
}

/**
 * 某块的有效折叠态。
 *
 * 缺省（键不存在）语义：**可折叠即折叠**。
 * 能走到折叠入口的块，内容都已超过阈值（代码块 20 行 / 表格 12 行），
 * 默认展开等于把长内容直接倒在阅读流里；默认收起、需要时展开才是折叠的意义。
 * 不可折叠的块恒为展开 —— 这条必须在函数内兜住，否则一旦有调用方漏判 foldable，
 * 会把短代码块也裁掉。
 */
export function effectiveBlockFolded(
  folds: Record<string, boolean>,
  scope: string,
  block: string,
  foldable: boolean
): boolean {
  if (!foldable) return false;
  return folds[foldKey(scope, block)] ?? true;
}

/**
 * 点击后的新状态：以「当前 DOM 呈现态」取反。
 *
 * 不从 folds 表里读值再取反 —— 那样要复刻一遍缺省规则（见上），
 * 两处规则一旦不同步就会出现「点一下没反应」。DOM 已经过 applyFolds 同步，
 * 它就是当前真值。
 */
export function toggledBlockFolded(currentlyFolded: boolean): boolean {
  return !currentlyFolded;
}

/** 折叠按钮文案。箭头不在此列（由 CSS ::before 依状态渲染，避免两处竞争）。 */
export function foldButtonLabel(folded: boolean): string {
  return folded ? '展开全部' : '收起';
}
