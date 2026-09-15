import { css } from 'lit';

// 切片自 styles.ts 原文件第 1299-1442 行，CSS 文本逐字节保留（LF 行尾），仅外层改用 css 组合。
export const richtext = css`
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
`;
