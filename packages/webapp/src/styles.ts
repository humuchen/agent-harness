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
    color: var(--ah-text);
    font-family: var(--ah-font-sans);
    font-size: 14px;
    line-height: 1.5;
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
    padding: 2px 10px;
    border-radius: var(--ah-radius-pill);
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    font-size: 12px;
    color: var(--ah-text-muted);
    white-space: nowrap;
  }
  .pill.ok {
    color: var(--ah-success);
    border-color: var(--ah-success);
  }
  .pill.err {
    color: var(--ah-danger);
    border-color: var(--ah-danger);
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
  }
  .theme-toggle:hover {
    color: var(--ah-text);
    border-color: var(--ah-accent);
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 8px 20px 0;
    background: var(--ah-surface-1);
    border-bottom: 1px solid var(--ah-border);
    position: sticky;
    top: 53px;
    z-index: 9;
  }
  .tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--ah-text-muted);
    padding: 8px 14px;
    cursor: pointer;
    font-size: 14px;
    font-family: inherit;
  }
  .tab:hover {
    color: var(--ah-text);
  }
  .tab.active {
    color: var(--ah-accent);
    border-bottom-color: var(--ah-accent);
  }
  .tab.ghost {
    margin-left: auto;
    color: var(--ah-text-muted);
  }
  .content {
    padding: 20px;
    max-width: 1200px;
    margin: 0 auto;
  }
  section {
    background: var(--ah-surface-1);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-lg);
    padding: 18px 20px;
    box-shadow: var(--ah-shadow);
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
    border-radius: var(--ah-radius-sm);
    padding: 8px 16px;
    font-size: 13px;
    cursor: pointer;
    font-family: inherit;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.ghost {
    background: transparent;
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
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
    background: var(--ah-warning-soft);
    border: 1px solid var(--ah-warning);
    color: var(--ah-warning);
    border-radius: var(--ah-radius-sm);
    padding: 8px 12px;
    margin: 10px 0;
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
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
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
    border-color: var(--ah-accent);
  }
  .pill.queued {
    color: var(--ah-warning);
    border-color: var(--ah-warning);
  }
  .pill.done,
  .pill.ready {
    color: var(--ah-success);
    border-color: var(--ah-success);
  }
  .pill.error,
  .pill.cancelled {
    color: var(--ah-danger);
    border-color: var(--ah-danger);
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
