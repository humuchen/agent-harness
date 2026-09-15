import { css } from 'lit';

// 切片自 styles.ts 原文件第 485-610 行，CSS 文本逐字节保留（LF 行尾），仅外层改用 css 组合。
export const mcp = css`
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
    border-radius: var(--ah-radius-md);
    box-shadow: rgba(0, 0, 0, 0.3) 0 3px 15px;
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
  .preset .row {
    justify-content: flex-end;
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

  .mcp-server-list {
    max-height: 375px;
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
`;
