import { css } from 'lit';

// 切片自 styles.ts 原文件第 611-932 行，CSS 文本逐字节保留（LF 行尾），仅外层改用 css 组合。
export const dashboard = css`
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
    max-height: 150px;
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

`;
