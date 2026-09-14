/**
 * 聊天页专属样式（从单一 chatStyles 大数组拆出）。
 *
 * 原 chatStyles 是一段约 4150 行的巨型 css 数组，难以维护。现按功能域拆分为
 * src/styles/chat/*.ts 下的多个聚焦模块（每个模块仅导出 lit 的 css 结果），
 * 本文件仅做「组合」：按原数组顺序拼回 chatStyles，顺序不变 ⇒ CSS 层叠零变化。
 *
 * 约定：
 * - 所有模块严格使用 --ah-* 语义令牌，不在模块内写死色值。
 * - chat.ts 仍以 `static styles = [sharedStyles, chatStyles]` 采纳，import 不变。
 */
import { layout } from './styles/chat/layout';
import { messageArea } from './styles/chat/message-area';
import { messageBubble } from './styles/chat/message-bubble';
import { trace } from './styles/chat/trace';
import { insights } from './styles/chat/insights';
import { mergedView } from './styles/chat/merged-view';
import { extras } from './styles/chat/extras';
import { responsive } from './styles/chat/responsive';
import { composer } from './styles/chat/composer';
import { planMode } from './styles/chat/plan-mode';
import { confidence } from './styles/chat/confidence';

export const chatStyles = [
  layout,
  messageArea,
  messageBubble,
  trace,
  insights,
  mergedView,
  extras,
  responsive,
  composer,
  planMode,
  confidence,
];
