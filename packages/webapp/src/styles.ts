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
    min-height: 100vh;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px;
    background: var(--ah-surface-1);
    border-bottom: 1px solid var(--ah-border);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--ah-font-display);
    font-weight: 700;
    font-size: 16px;
    white-space: nowrap;
  }
  .sidebar-toggle {
    margin-left: auto;
    width: 26px;
    height: 26px;
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
    height: 22px;
    border-radius: 6px;
    background: var(--ah-accent);
    flex: 0 0 auto;
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
  /* 应用骨架：左侧 240 导航 + 右侧主区（顶栏 + 内容），对齐设计稿 */
  .shell {
    display: flex;
    min-height: 100vh;
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
    position: sticky;
    top: 0;
    height: 100vh;
    box-sizing: border-box;
    transition: width 180ms ease, padding 180ms ease;
    overflow: hidden;
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
  }
  .content {
    padding: 24px 32px;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
  }
  section {
    background: var(--ah-surface-1);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-lg);
    padding: 24px 24px;
    box-shadow: var(--ah-shadow);
  }
  .card {
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-md);
    padding: 16px 18px;
  }
  .mcp-layout {
    /* MCP 页面专用：标题 + 两栏独立卡片，无外层 section 卡片包裹 */
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
    background: var(--ah-danger-soft);
    border: 1px solid var(--ah-danger);
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
  /* 健康 hero */
  .hero {
    background: linear-gradient(135deg, var(--ah-accent-soft), transparent 70%), var(--ah-surface-1);
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
    background: var(--ah-surface-2);
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
  .matrix th,
  .matrix td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--ah-border);
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
`;
