import { css } from 'lit';

/** 全局共享样式：顶部栏、Tab、表单、事件流。各组件通过 static styles 复用。 */
export const sharedStyles = css`
  :host {
    --bg: #0f1419;
    --panel: #171c24;
    --panel-2: #1f2630;
    --border: #2a323d;
    --text: #e6edf3;
    --muted: #8b97a6;
    --accent: #4f9dff;
    --ok: #3fb950;
    --warn: #d29922;
    --err: #f85149;
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .brand {
    font-weight: 700;
    font-size: 16px;
    white-space: nowrap;
  }
  .state {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    flex: 1;
  }
  .pill {
    padding: 2px 10px;
    border-radius: 999px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
  }
  .pill.ok {
    color: var(--ok);
    border-color: var(--ok);
  }
  .pill.err {
    color: var(--err);
    border-color: var(--err);
  }
  .token {
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 6px;
    padding: 6px 10px;
    width: 220px;
    font-size: 13px;
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 8px 20px 0;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 53px;
    z-index: 9;
  }
  .tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    padding: 8px 14px;
    cursor: pointer;
    font-size: 14px;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .tab.ghost {
    margin-left: auto;
    color: var(--muted);
  }
  .content {
    padding: 20px;
    max-width: 980px;
    margin: 0 auto;
  }
  section {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
  }
  h2 {
    margin: 0 0 12px;
    font-size: 17px;
  }
  h3 {
    margin: 16px 0 8px;
    font-size: 14px;
    color: var(--muted);
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
    color: var(--muted);
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
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 13px;
    font-family: inherit;
  }
  textarea {
    resize: vertical;
  }
  button {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
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
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
  }
  .error {
    background: rgba(248, 81, 73, 0.12);
    border: 1px solid var(--err);
    color: var(--err);
    border-radius: 6px;
    padding: 8px 12px;
    margin: 10px 0;
    font-size: 13px;
  }
  .warn {
    background: rgba(210, 153, 34, 0.12);
    border: 1px solid var(--warn);
    color: var(--warn);
    border-radius: 6px;
    padding: 8px 12px;
    margin: 10px 0;
    font-size: 13px;
  }
  .stream {
    margin-top: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    max-height: 340px;
    overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .ev {
    display: flex;
    gap: 8px;
    padding: 2px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }
  .ev-type {
    color: var(--accent);
    flex: 0 0 150px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ev-body {
    color: var(--muted);
    word-break: break-all;
  }
  .list {
    margin: 0;
    padding-left: 18px;
  }
  .list li {
    margin: 4px 0;
  }
`;
