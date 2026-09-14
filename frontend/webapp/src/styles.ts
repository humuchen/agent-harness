import { css } from 'lit';
import { base } from './styles/base';
import { mcp } from './styles/mcp';
import { dashboard } from './styles/dashboard';
import { mobileDrawer } from './styles/mobile-drawer';
import { runtime } from './styles/runtime';
import { richtext } from './styles/richtext';
import { responsive } from './styles/responsive';

/**
 * 全局共享样式：顶部栏、Tab、表单、事件流。各组件通过 static styles 复用。
 *
 * 注意：这里只引用语义令牌（--ah-*），不写死任何颜色 / 具体像素色值。
 * 真正的色值由 src/theme/tokens.ts 按 [data-theme] 注入 <head>，组件随主题自动切换。
 * 若要新增主题，只改 tokens.ts，本文件无需变动。
 *
 * 实现说明：sharedStyles 由 ./styles/ 下 7 个聚焦模块按原顺序组合而成
 * （base → mcp → dashboard → mobileDrawer → runtime → richtext → responsive），
 * 组合结果与历史单一 css 字面量逐字节一致，CSS 层叠顺序不变；
 * 19 个消费者组件的 `import { sharedStyles }` 与 `static styles = [sharedStyles, ...]` 无需改动。
 */
export const sharedStyles = css`
  ${base}
  ${mcp}
  ${dashboard}
  ${mobileDrawer}
  ${runtime}
  ${richtext}
  ${responsive}
`;
