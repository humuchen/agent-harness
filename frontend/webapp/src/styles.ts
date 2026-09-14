import { css } from 'lit';
import { base } from './styles/base';
import { mcp } from './styles/mcp';
import { dashboard } from './styles/dashboard';
import { mobileDrawer } from './styles/mobile-drawer';
import { runtime } from './styles/runtime';
import { richtext } from './styles/richtext';
import { responsive } from './styles/responsive';
import { mobilePill } from './styles/mobile-pill';

/**
 * 全局共享样式：顶部栏、Tab、表单、事件流。各组件通过 static styles 复用。
 *
 * 注意：这里只引用语义令牌（--ah-*），不写死任何颜色 / 具体像素色值。
 * 真正的色值由 src/theme/tokens.ts 按 [data-theme] 注入 <head>，组件随主题自动切换。
 * 若要新增主题，只改 tokens.ts，本文件无需变动。
 *
 * 实现说明：sharedStyles 由 ./styles/ 下 8 个聚焦模块按顺序组合而成
 * （base → mcp → dashboard → mobileDrawer → runtime → richtext → responsive → mobilePill），
 * 前 7 项的组合结果与历史单一 css 字面量逐字节一致，CSS 层叠顺序不变；
 * 19 个消费者组件的 `import { sharedStyles }` 与 `static styles = [sharedStyles, ...]` 无需改动。
 *
 * mobilePill 必须保持在**最后**（详见其文件头）：它是移动端按钮胶囊化的强制覆盖层，
 * 依赖 !important + 位于组件自有规则之前仍能胜出的特性；顺序变动不影响正确性，
 * 但请勿把它前置到 base 之前，以免后续维护者误判层叠意图。
 *
 * ── P3 审计结论 ──
 * 对 7 个模块的选择器归属统计：`.pill`(8 文件)、`.content`(7)、`.kpi`(4) 为多组件共享，
 * 必须留在共享层；`preset`/`server-list`/`run-col`/`matrix-scroll`/`mobile-tabbar` 各仅 1 文件引用。
 * 多数选择器本质属于 app-shell / 基础组件（全局），真正单页专属者极少。将页面模块回迁各组件
 * 需改动全部 19 个消费者文件，且 Shadow DOM 下漏引会导致 build 无法捕捉的视觉回归，收益
 * （减少每页无关 CSS 注入）远低于风险。当前拆分已彻底解决「单文件过大、难维护」的原始诉求。
 *
 * 渐进瘦身路径（如需）：某组件确定不需要某页面模块时，将其 `import { sharedStyles }`
 * 改为 `import { base } from './styles/base'` 并仅追加所需模块（如 `dashboard`），随后真机回归。
 * 注意：chat 与 plan-board 的计划卡片 pill 分别用 `chat/plan-mode` 与 `base`+`dashboard` 两套定义
 * （硬编码 rgba vs CSS 变量），属设计语言分裂但功能正常；统一前需真机比对视觉。
 */
export const sharedStyles = css`
  ${base}
  ${mcp}
  ${dashboard}
  ${mobileDrawer}
  ${runtime}
  ${richtext}
  ${responsive}
  ${mobilePill}
`;
