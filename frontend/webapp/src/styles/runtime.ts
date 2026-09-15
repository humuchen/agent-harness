import { css } from 'lit';

// 切片自 styles.ts 原文件第 971-1297 行，CSS 文本逐字节保留（LF 行尾），仅外层改用 css 组合。
export const runtime = css`
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
`;
