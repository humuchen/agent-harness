import { css } from 'lit';

/**
 * 全局共享样式：顶部栏、Tab、表单、事件流。各组件通过 static styles 复用。
 *
 * 注意：这里只引用语义令牌（--ah-*），不写死任何颜色 / 具体像素色值。
 * 真正的色值由 src/theme/tokens.ts 按 [data-theme] 注入 <head>，组件随主题自动切换。
 * 若要新增主题，只改 tokens.ts，本文件无需变动。
 */
export const sharedStyles = css`
  :host {
    display: block;
    background: var(--ah-canvas);
    color: var(--ah-text);
    font-family: var(--ah-font-sans);
    font-size: 14px;
    line-height: 1.5;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }
  /* 滚动条：细轨道、圆角滑块，hover 才高亮，保持界面干净 */
  ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: var(--ah-border);
    border-radius: 4px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: var(--ah-text-muted);
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px;
    background: var(--ah-surface-1);
    border-bottom: 1px solid var(--ah-border);
    flex: 0 0 auto;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--ah-font-display);
    font-weight: 700;
    font-size: 16px;
    white-space: nowrap;
    justify-content: center;
  }
  .sidebar-toggle {
    margin-left: auto;
    width: 26px;
    height: var(--ah-h-md);
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--ah-radius-sm);
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    font-family: inherit;
  }
  .sidebar-toggle:hover {
    color: var(--ah-text);
    border-color: var(--ah-accent);
  }
  .logo {
    width: 22px;
    height: var(--ah-h-sm);
    flex: 0 0 auto;
    display: block;
    color: var(--ah-text);
  }
  .state {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    flex: 1;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: var(--ah-radius-pill);
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    font-size: 12px;
    color: var(--ah-text-muted);
    white-space: nowrap;
    font-family: var(--ah-font-mono);
  }
  .pill.ok {
    color: var(--ah-success);
    background: var(--ah-success-soft);
    border-color: transparent;
  }
  .pill.err {
    color: var(--ah-danger);
    background: var(--ah-danger-soft);
    border-color: transparent;
  }
  .token {
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text);
    border-radius: var(--ah-radius-sm);
    padding: 6px 10px;
    width: 220px;
    font-size: 13px;
  }
  .theme-toggle {
    padding: 4px 12px;
    border-radius: var(--ah-radius-pill);
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .theme-toggle:hover {
    color: var(--ah-text);
    border-color: var(--ah-accent);
  }
  .theme-icon {
    display: none;
  }
  .sidebar.collapsed .theme-text {
    display: none;
  }
  .sidebar.collapsed .theme-icon {
    display: inline;
    font-size: 14px;
  }
  .sidebar.collapsed .theme-toggle {
    padding: 6px;
    border-radius: var(--ah-radius-md);
  }
  /* 应用骨架：左侧 240 导航 + 右侧主区（顶栏 + 内容），对齐设计稿。
     整个 shell 占满视口；内容区按内容自然高度，超出可视区时内部滚动，避免 body 全局滚动条。 */
  .shell {
    display: flex;
    height: 100%;
    overflow: hidden;
  }
  .sidebar {
    flex: 0 0 240px;
    width: 240px;
    background: var(--ah-surface-1);
    border-right: 1px solid var(--ah-border);
    padding: 20px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    height: 100%;
    box-sizing: border-box;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--ah-border) transparent;
    transition: width 180ms ease, padding 180ms ease;
  }
  .sidebar.collapsed {
    flex: 0 0 64px;
    width: 64px;
    padding: 20px 10px;
  }
  .sidebar.collapsed .brand-text {
    display: none;
  }
  .sidebar.collapsed .sidebar-toggle {
    margin-left: 0;
  }
  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 10px;
    color: var(--ah-text-muted);
    padding: 9px 12px;
    cursor: pointer;
    font-size: 14px;
    font-family: inherit;
    position: relative;
  }
  .nav-item:hover {
    background: var(--ah-surface-2);
    color: var(--ah-text);
  }
  .nav-item.active {
    background: var(--ah-accent-soft);
    color: var(--ah-accent);
    font-weight: 600;
    border-left: 3px solid var(--ah-accent);
    border-radius: 0 10px 10px 0;
    padding-left: 9px;
  }
  .sidebar.collapsed .nav-text {
    display: none;
  }
  .sidebar.collapsed .nav-item {
    justify-content: center;
    padding: 9px 4px;
    border-left: none;
    border-radius: 10px;
  }
  .sidebar.collapsed .nav-item.active {
    border-left: none;
    border-radius: 10px;
    padding-left: 4px;
  }
  .sidebar.collapsed .nav-item.active::after {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 18px;
    border-radius: 0 2px 2px 0;
    background: var(--ah-accent);
  }
  .sidebar.collapsed .nav-item::before {
    content: attr(data-short);
    font-size: 14px;
    font-weight: 500;
  }
  .nav-spacer {
    flex: 1;
  }
  .sidebar-foot {
    border-top: 1px solid var(--ah-border);
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .content {
    flex: 1 1 0%;
    min-height: 0;
    overflow: hidden;
    padding: 24px 32px;
    width: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  /* 对话页全幅铺满：去掉外边距与外层滚动，由 ah-chat 内部自管滚动。 */
  .content.chat {
    flex: 1 1 auto;
    height: 100%;
    padding: 0;
    overflow: hidden;
    display: block;
  }
  /* 各页面根元素填充剩余空间，内容超高时内部滚动 */
  section,
  .mcp-layout,
  .plugin-view,
  .wrap {
    flex: 1 1 0%;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  section {
    background: var(--ah-surface-1);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-lg);
    padding: 24px 24px;
    box-shadow: var(--ah-shadow);
  }

  .card {
    background: var(--ah-surface-1);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-md);
    padding: 16px 18px;
    max-height: 800px;
    overflow-y: auto;
  }

  h2 {
    margin: 0 0 12px;
    font-family: var(--ah-font-display);
    font-size: 18px;
  }
  h3 {
    margin: 16px 0 8px;
    font-size: 14px;
    color: var(--ah-text-muted);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 12px;
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: flex-end;
    flex-wrap: wrap;
    margin-bottom: 10px;

    &:first-child {
      margin-top: 10px;
    }
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--ah-text-muted);
  }
  label.block {
    margin-bottom: 12px;
  }
  label.grow {
    flex: 1;
  }
  input,
  select,
  textarea {
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text);
    border-radius: var(--ah-radius-sm);
    padding: 7px 10px;
    font-size: 13px;
    font-family: inherit;
  }
  textarea {
    resize: vertical;
  }
  button {
    background: var(--ah-accent);
    color: #fff;
    border: none;
    border-radius: var(--ah-radius-pill);
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.ghost {
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
    border-radius: var(--ah-radius-pill);
    font-weight: 500;
  }
  button.ghost:hover {
    color: var(--ah-text);
    border-color: var(--ah-accent);
  }
  button.danger {
    background: var(--ah-danger-soft);
    color: var(--ah-danger);
    border-radius: var(--ah-radius-sm);
  }
  .muted {
    color: var(--ah-text-muted);
  }
  .error {
    // background: var(--ah-danger-soft);
    // border: 1px solid var(--ah-danger);
    color: var(--ah-danger);
    border-radius: var(--ah-radius-sm);
    padding: 8px 12px;
    margin: 10px 0;
    font-size: 13px;
  }
  .warn {
    // background: var(--ah-warning-soft);
    // border: 1px solid var(--ah-warning);
    color: var(--ah-warning) !important;
    border-radius: var(--ah-radius-sm);
    // padding: 8px 12px;
    // margin: 10px 0;
    font-size: 13px;
  }
  .stream {
    margin-top: 12px;
    background: var(--ah-canvas);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-md);
    padding: 10px;
    max-height: 340px;
    overflow: auto;
    font-family: var(--ah-font-mono);
    font-size: 12px;
  }
  .ev {
    display: flex;
    gap: 8px;
    padding: 2px 0;
    border-bottom: 1px solid var(--ah-border);
  }
  .ev-type {
    color: var(--ah-accent);
    flex: 0 0 150px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ev-body {
    color: var(--ah-text-muted);
    word-break: break-all;
  }
  .list {
    margin: 0;
    padding-left: 18px;
  }
  .list li {
    margin: 4px 0;
  }
  /* MCP 已接入错误：红色内联提示，让「添加后失败」可见原因 */
  .mcp-err {
    margin-top: 4px;
    color: var(--ah-danger);
    font-size: 12px;
    font-family: var(--ah-font-mono);
    word-break: break-all;
  }
  /* 预设市场卡片条目 */
  .preset {
    list-style: none;
    margin: 0 0 14px !important;
    padding: 12px 14px;
    background: var(--ah-surface-1);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-md);
  }
  .preset-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .preset-note {
    margin: 8px 0 0;
    font-size: 12px;
    line-height: 1.5;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
    border-radius: var(--ah-radius-pill);
    font-size: 11px;
    font-family: var(--ah-font-mono);
    background: var(--ah-surface-3);
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
  }
  .chip.ok {
    color: var(--ah-success);
    background: var(--ah-success-soft);
    border-color: transparent;
  }
  .preset-token {
    flex: 1;
    min-width: 160px;
  }
  /* MCP 表单：radio 单选钮标签样式 */
  label.radio {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--ah-text);
    cursor: pointer;
  }
  label.radio input[type='radio'] {
    cursor: pointer;
  }
  /* MCP 表单：环境变量编辑区 */
  .env-list {
    width: 100%;
    margin: 8px 0;
  }
  /* MCP 已接入列表：服务器项 + 工具列表 */
  ,
  .card.mcp-server-list {
    max-height: 490px;
  }
  .mcp-server-item {
    list-style: none;
    padding: 4px 0;
  }
  .mcp-server-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    user-select: none;
  }
  .mcp-server-header:hover .chevron {
    color: var(--ah-text);
  }
  .mcp-server-actions .ghost {
    height: var(--ah-h-lg);
    padding: 0 10px;
    font-size: 12px;
  }
  .mcp-tools {
    list-style: none;
    margin: 6px 0 0 14px;
    padding-left: 0;
    border-left: 1px solid var(--ah-border);
    padding-top: 4px;

    .mcp-tool-item {
      padding-left: 8px;
    }
  }
  .mcp-tool-name {
    font-family: var(--ah-font-mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--ah-text);
  }
  .mcp-tool-desc {
    font-size: 11px;
    color: var(--ah-text-muted);
    line-height: 1.4;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .ghost-link {
    color: var(--ah-accent);
    font-size: 13px;
    text-decoration: none;
  }
  .ghost-link:hover {
    text-decoration: underline;
  }

  /* ------------------- Dashboard / Observability 专用 ------------------- */
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 16px;
  }
  @media (max-width: 760px) {
    .two {
      grid-template-columns: 1fr;
    }
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .section-title {
    font-family: var(--ah-font-display);
    font-size: 13px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ah-text-faint);
    margin: 4px 0 10px;
  }
  .section-title.collapsible {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    user-select: none;
  }
  .section-title.collapsible:hover .chevron {
    color: var(--ah-text);
  }
  .chevron {
    color: var(--ah-text-muted);
    font-size: 12px;
    transition: transform 120ms ease;
  }
  /* 健康 hero */
  .hero {
    background: var(--ah-surface-1);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-lg);
    padding: 22px 24px;
    margin-bottom: 16px;
    box-shadow: var(--ah-shadow);
  }
  .hero h2 {
    margin: 0 0 6px;
    font-size: 22px;
  }
  .hero-sub {
    color: var(--ah-text-muted);
    font-size: 13px;
    margin-bottom: 16px;
  }
  .hero-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 28px;
  }
  .hero-stat .v {
    font-family: var(--ah-font-display);
    font-size: 20px;
    font-weight: 700;
    color: var(--ah-text);
  }
  .hero-stat .k {
    font-size: 12px;
    color: var(--ah-text-muted);
  }
  /* KPI 卡片网格 */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 14px;
    margin-bottom: 16px;
  }
  .kpi {
    background: var(--ah-surface-1);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-lg);
    padding: 16px;
  }
  .kpi .v {
    font-family: var(--ah-font-display);
    font-size: 26px;
    font-weight: 700;
    color: var(--ah-text);
    line-height: 1.1;
  }
  .kpi .k {
    font-size: 12px;
    color: var(--ah-text-muted);
    margin-top: 6px;
  }
  .kpi .v.accent {
    color: var(--ah-accent);
  }
  .kpi .v.ok {
    color: var(--ah-success);
  }
  .kpi .v.warn {
    color: var(--ah-warning);
  }
  /* 状态 pill（job / session / env） */
  .pill.running {
    color: var(--ah-accent);
    background: var(--ah-accent-soft);
    border-color: transparent;
    animation: ah-pulse 2s ease-in-out infinite;
  }
  @keyframes ah-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.6;
    }
  }
  .pill.queued {
    color: var(--ah-warning);
    background: var(--ah-warning-soft);
    border-color: transparent;
  }
  .pill.done,
  .pill.ready {
    color: var(--ah-success);
    background: var(--ah-success-soft);
    border-color: transparent;
  }
  .pill.error,
  .pill.cancelled {
    color: var(--ah-danger);
    background: var(--ah-danger-soft);
    border-color: transparent;
  }
  .pill.session {
    color: var(--ah-text-muted);
    background: var(--ah-surface-3);
    border-color: var(--ah-border);
    font-family: var(--ah-font-mono);
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-family: var(--ah-font-mono);
    font-size: 12px;
    color: var(--ah-text-muted);
  }
  .row-between {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  /* RBAC 权限矩阵 */
  .matrix {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  /* 矩阵独立滚动容器：即便外层 .content 滚动受限，矩阵自身也能滚动查看全部行。
     sticky 表头 + 首列在滚动时保持可见，避免「列表没展示全 / 看不到列名」。 */
  .matrix-scroll {
    max-height: 25vh;
    overflow: auto;
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-md);
    scrollbar-width: thin;
    scrollbar-color: var(--ah-border) transparent;
  }
  .matrix-scroll .matrix {
    border-collapse: separate;
    border-spacing: 0;
  }
  .matrix-scroll thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--ah-surface-1);
    border-bottom: 1px solid var(--ah-border);
  }
  /* 首列（ACTION）横向滚动时固定，保证行含义始终可读 */
  .matrix .sticky-col {
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--ah-surface-1);
  }
  .matrix-scroll thead th.sticky-col {
    z-index: 3;
  }
  .matrix th,
  .matrix td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--ah-border);
  }
  /* 运行队列 / 记忆会话 等列表：自带滚动区，不再静默截断 */
  .panel-scroll {
    max-height: 260px;
    overflow: auto;
    border-radius: var(--ah-radius-md);
    scrollbar-width: thin;
    scrollbar-color: var(--ah-border) transparent;
  }
  /* 区块标题上的数量徽标 */
  .section-title .count {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 9px;
    border-radius: var(--ah-radius-pill);
    font-size: 11px;
    font-family: var(--ah-font-mono);
    background: var(--ah-accent-soft);
    color: var(--ah-accent);
    vertical-align: middle;
  }
  .accent-sm {
    color: var(--ah-accent);
  }
  .scroll-hint {
    margin-top: 8px;
    font-size: 12px;
    color: var(--ah-text-faint);
  }
  .matrix th {
    font-family: var(--ah-font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--ah-text-faint);
  }
  .matrix td.act {
    font-family: var(--ah-font-mono);
    color: var(--ah-text);
  }
  .matrix td.center {
    text-align: center;
  }
  .check {
    color: var(--ah-accent);
  }
  .dash {
    color: var(--ah-text-faint);
  }
  .role-badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: var(--ah-radius-pill);
    font-size: 11px;
    font-family: var(--ah-font-mono);
    background: var(--ah-surface-3);
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
  }
  .note {
    padding: 8px 12px;
    border-radius: var(--ah-radius-sm);
    font-size: 12px;
    line-height: 1.6;
    background: var(--ah-surface-3);
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
  }
  .note code {
    font-family: var(--ah-font-mono);
    font-size: 11px;
    padding: 1px 5px;
    border-radius: var(--ah-radius-sm);
    background: var(--ah-surface-1);
    color: var(--ah-accent);
  }
  .note b {
    color: var(--ah-text);
  }
  .kv {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .kv .item {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 13px;
    padding: 6px 0;
    border-bottom: 1px solid var(--ah-border);
  }
  .kv .item:last-child {
    border-bottom: none;
  }
  .kv .item .m {
    color: var(--ah-text-muted);
  }
  .muted-sm {
    font-size: 12px;
    color: var(--ah-text-muted);
  }
  .link {
    background: none;
    border: none;
    color: var(--ah-accent);
    cursor: pointer;
    font-size: 13px;
    padding: 0;
    font-family: inherit;
  }
  /* 移动端抽屉相关：桌面端默认隐藏，窄屏下由媒体查询启用 */
  .menu-btn {
    display: none;
    width: 34px;
    height: 34px;
    padding: 0;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    line-height: 1;
    border-radius: var(--ah-radius-sm);
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text);
    cursor: pointer;
  }
  .menu-btn:hover {
    border-color: var(--ah-accent);
  }
  .scrim {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 40;
    opacity: 0;
    transition: opacity 200ms ease;
  }
  .scrim.show {
    opacity: 1;
  }

  /* ------------------- 运行时面板（思考 + 结果 双栏） ------------------- */
  .run-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .run-title {
    font-family: var(--ah-font-display);
    font-size: 20px;
    font-weight: 700;
    margin: 0;
  }
  .run-head-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  /* 分段控制（思考 / 结果 / 全览） */
  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-pill);
  }
  .seg button {
    background: transparent;
    border: none;
    border-radius: var(--ah-radius-pill);
    color: var(--ah-text-muted);
    padding: 6px 16px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  .seg button:hover {
    color: var(--ah-text);
  }
  .seg button.active {
    background: var(--ah-accent-soft);
    color: var(--ah-accent);
    font-weight: 600;
  }
  .run-task {
    margin-bottom: 16px;
  }
  .run-advanced {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
    margin-top: 12px;
  }
  /* 双栏：思考 Trace + 最终结果 */
  .run-two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    align-items: start;
  }
  .run-col-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
  }
  .run-col-title h3 {
    margin: 0;
    font-family: var(--ah-font-display);
    font-size: 14px;
    color: var(--ah-text);
  }
  /* 阶段步进器 */
  .phase-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 16px;
  }
  .phase {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 0;
    color: var(--ah-text-faint);
  }
  .phase .dot {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    border: 1.5px solid var(--ah-border);
    background: var(--ah-surface-2);
    color: var(--ah-text-faint);
  }
  .phase.active {
    color: var(--ah-text);
  }
  .phase.active .dot {
    border-color: var(--ah-accent);
    color: var(--ah-accent);
    box-shadow: 0 0 0 4px var(--ah-accent-soft);
    animation: ah-pulse 1.2s ease-in-out infinite;
  }
  .phase.done {
    color: var(--ah-text-muted);
  }
  .phase.done .dot {
    background: var(--ah-accent);
    border-color: var(--ah-accent);
    color: #fff;
  }
  .phase .label {
    font-size: 13px;
    font-weight: 500;
  }
  .phase .sub {
    font-size: 11px;
    color: var(--ah-text-faint);
    font-family: var(--ah-font-mono);
  }
  @keyframes ah-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 3px var(--ah-accent-soft);
    }
    50% {
      box-shadow: 0 0 0 6px var(--ah-accent-soft);
    }
  }
  /* 思考轨迹（流式） */
  .trace {
    background: var(--ah-canvas);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-md);
    padding: 12px 14px;
    max-height: 420px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--ah-border) transparent;
    font-family: var(--ah-font-mono);
    font-size: 12.5px;
    line-height: 1.6;
  }
  .trace-block {
    padding: 8px 0;
    border-bottom: 1px solid var(--ah-border);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .trace-block:last-child {
    border-bottom: none;
  }
  .trace-block .tb-head {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--ah-text-muted);
    margin-bottom: 3px;
  }
  .trace-block .tb-tag {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: var(--ah-radius-sm);
    background: var(--ah-surface-3);
    color: var(--ah-text-muted);
  }
  .trace-block.think .tb-tag {
    background: var(--ah-accent-soft);
    color: var(--ah-accent);
  }
  .trace-block.tool .tb-tag {
    background: rgba(48, 209, 88, 0.15);
    color: var(--ah-success);
  }
  .trace-block.tool-result .tb-tag {
    background: rgba(48, 209, 88, 0.1);
    color: var(--ah-text-muted);
  }
  .trace-block.warn .tb-tag {
    background: var(--ah-warning-soft);
    color: var(--ah-warning);
  }
  .trace-block.error .tb-tag {
    background: var(--ah-danger-soft);
    color: var(--ah-danger);
  }
  .trace-block.answer {
    border-left-color: var(--ah-accent);
  }
  .trace-block.answer .tb-tag {
    background: var(--ah-accent);
    color: #fff;
  }
  .trace-block .tb-body {
    color: var(--ah-text);
  }
  .trace-block .tb-detail {
    color: var(--ah-text-muted);
    font-size: 11.5px;
    margin-top: 4px;
    padding-left: 8px;
    border-left: 2px solid var(--ah-border);
  }
  .caret {
    display: inline-block;
    width: 7px;
    height: 1.05em;
    background: var(--ah-accent);
    border-radius: 1px;
    vertical-align: text-bottom;
    margin-left: 2px;
    animation: ah-blink 1s steps(2, start) infinite;
  }
  @keyframes ah-blink {
    to {
      visibility: hidden;
    }
  }
  /* 最终结果卡 */
  .result-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 28px 0;
    color: var(--ah-text-muted);
  }
  .spinner {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--ah-border);
    border-top-color: var(--ah-accent);
    animation: ah-spin 0.8s linear infinite;
  }
  @keyframes ah-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 0;
  }
  .sk-line {
    height: 12px;
    border-radius: 6px;
    background: linear-gradient(
      90deg,
      var(--ah-surface-3) 25%,
      var(--ah-surface-2) 37%,
      var(--ah-surface-3) 63%
    );
    background-size: 400% 100%;
    animation: ah-shimmer 1.4s ease infinite;
  }
  @keyframes ah-shimmer {
    0% {
      background-position: 100% 0;
    }
    100% {
      background-position: 0 0;
    }
  }
  .deliverable {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 0;
    border-bottom: 1px solid var(--ah-border);
    font-size: 13px;
  }
  .deliverable:last-of-type {
    border-bottom: none;
  }
  .deliverable .k {
    color: var(--ah-text-muted);
  }
  .deliverable .v {
    color: var(--ah-text);
    font-family: var(--ah-font-mono);
    font-size: 12.5px;
  }
  .deliverable .v.accent {
    color: var(--ah-accent);
  }
  .deliverable .v.ok {
    color: var(--ah-success);
  }
  .codeblock {
    margin-top: 14px;
    background: var(--ah-canvas);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-md);
    padding: 12px 14px;
    max-height: 340px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--ah-border) transparent;
    font-family: var(--ah-font-mono);
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--ah-text);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* 富文本渲染（Markdown → HTML）排版 */
  .codeblock.rich {
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC',
      'Microsoft YaHei', sans-serif;
    white-space: normal;
  }
  .codeblock.rich > :first-child {
    margin-top: 0;
  }
  .codeblock.rich > :last-child {
    margin-bottom: 0;
  }
  .codeblock.rich h1,
  .codeblock.rich h2,
  .codeblock.rich h3,
  .codeblock.rich h4 {
    margin: 14px 0 8px;
    line-height: 1.3;
  }
  .codeblock.rich h1 {
    font-size: 18px;
  }
  .codeblock.rich h2 {
    font-size: 16px;
  }
  .codeblock.rich h3 {
    font-size: 14.5px;
  }
  .codeblock.rich p {
    margin: 8px 0;
  }
  .codeblock.rich ul,
  .codeblock.rich ol {
    margin: 8px 0;
    padding-left: 22px;
  }
  .codeblock.rich li {
    margin: 3px 0;
  }
  .codeblock.rich code {
    background: var(--ah-surface-3);
    padding: 1px 5px;
    border-radius: 5px;
    font-family: var(--ah-font-mono);
    font-size: 0.9em;
  }
  .codeblock.rich pre {
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    padding: 12px 14px;
    border-radius: var(--ah-radius-md);
    overflow: auto;
  }
  .codeblock.rich pre code {
    background: none;
    padding: 0;
  }
  .codeblock.rich blockquote {
    margin: 10px 0;
    padding: 4px 14px;
    border-left: 3px solid var(--ah-accent);
    color: var(--ah-text-muted);
    background: var(--ah-accent-soft);
    border-radius: 0 var(--ah-radius-sm) var(--ah-radius-sm) 0;
  }
  .codeblock.rich table {
    border-collapse: collapse;
    width: 100%;
    margin: 10px 0;
  }
  .codeblock.rich th,
  .codeblock.rich td {
    border: 1px solid var(--ah-border);
    padding: 5px 9px;
    text-align: left;
  }
  .codeblock.rich th {
    background: var(--ah-surface-2);
  }
  .codeblock.rich a {
    color: var(--ah-accent);
  }
  .codeblock.rich img {
    max-width: 100%;
    border-radius: var(--ah-radius-sm);
  }

  /* 思考轨迹块内的富文本（轻量覆盖，避免与等宽容器冲突） */
  .trace-block .tb-body {
    white-space: normal;
  }
  .trace-block .tb-body code {
    background: var(--ah-surface-3);
    padding: 0 4px;
    border-radius: 4px;
    font-family: var(--ah-font-mono);
    font-size: 0.9em;
  }
  .trace-block .tb-body ul,
  .trace-block .tb-body ol {
    margin: 6px 0;
    padding-left: 20px;
  }
  .trace-block .tb-body p {
    margin: 6px 0;
  }
  .run-actions {
    display: flex;
    gap: 8px;
    margin-top: 14px;
    flex-wrap: wrap;
  }
  .run-actions button {
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
    border-radius: var(--ah-radius-pill);
    font-weight: 500;
  }
  .run-actions button:hover {
    color: var(--ah-text);
    border-color: var(--ah-accent);
  }
  .toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--ah-surface-3);
    border: 1px solid var(--ah-border);
    color: var(--ah-text);
    padding: 8px 16px;
    border-radius: var(--ah-radius-pill);
    font-size: 13px;
    box-shadow: var(--ah-shadow);
    z-index: 60;
    animation: ah-toast-in 0.2s ease;
  }
  @keyframes ah-toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
  }

  /* ------------------- 移动端适配（≤760px） ------------------- */
  @media (max-width: 760px) {
    /* 移动端解除 100dvh 锁定 + overflow:hidden：子组件（ah-run 等）内容超高时
       原锁定会把底部裁掉且自身无内部滚动，导致「拉到最低展示不全」。
       改为文档自然滚动，底部始终可达；桌面端布局不受影响。 */
    :host {
      height: auto;
      min-height: 100dvh;
      overflow: visible;
    }
    .shell {
      height: auto;
      overflow: visible;
    }
    .main {
      height: auto;
      overflow: visible;
    }
    /* 侧边栏改为离屏抽屉：默认滑出屏幕，.open 时滑入，覆盖在内容之上 */
    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      height: 100dvh;
      width: 240px;
      max-width: 82vw;
      transform: translateX(-100%);
      transition: transform 200ms ease;
      z-index: 50;
      box-shadow: 2px 0 16px rgba(0, 0, 0, 0.45);
      padding: 20px 14px;
      overflow-y: auto;
    }
    .sidebar.open {
      transform: none;
    }
    /* 移动端忽略桌面折叠态：始终展示完整导航文字而非首字 */
    .sidebar.collapsed {
      width: 240px;
      max-width: 82vw;
    }
    .sidebar.collapsed .brand-text,
    .sidebar.collapsed .nav-text,
    .sidebar.collapsed .theme-text {
      display: inline;
    }
    .sidebar.collapsed .theme-icon {
      display: none;
    }
    .sidebar.collapsed .nav-item::before {
      content: none;
    }
    .sidebar.collapsed .nav-item {
      justify-content: flex-start;
      padding: 9px 12px;
    }
    .sidebar.collapsed .nav-item.active {
      border-left: 3px solid var(--ah-accent);
      border-radius: 0 10px 10px 0;
      padding-left: 9px;
    }
    .sidebar.collapsed .nav-item.active::after {
      content: none;
    }
    .sidebar-toggle {
      display: none;
    }
    .menu-btn {
      display: inline-flex;
    }
    .scrim.show {
      display: block;
    }
    /* 顶栏状态行换行、令牌框与按钮占满宽度 */
    .topbar {
      flex-wrap: wrap;
      gap: 10px;
    }
    .token {
      order: 3;
      width: 100%;
      flex: 1 1 100%;
    }
    .topbar .ghost {
      order: 4;
    }
    /* 内容区改为文档自然滚动（解除固定高度 + 内部滚动），底部留白含安全区 */
    .content {
      padding: 16px 14px calc(24px + env(safe-area-inset-bottom));
      overflow: visible;
      height: auto;
      flex: none;
      display: block;
    }
    /* 顶栏吸顶，移动端长页面滚动时仍可随时操作 */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 30;
    }
    /* 运行时双栏在窄屏堆叠为单列 */
    .run-two {
      grid-template-columns: 1fr;
    }
  }
`;
