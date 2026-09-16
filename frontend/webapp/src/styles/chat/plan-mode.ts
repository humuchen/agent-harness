import { css } from 'lit';

export const planMode = css`
  /* ---- 计划模式（P0）：计划卡片 ---- */
  .plan-card {
    border: 1px solid var(--ah-border);
    border-radius: 12px;
    background: var(--ah-surface-1);
    padding: 14px 16px;
    margin: 6px 0;
  }
  .plan-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .plan-title {
    font-weight: 600;
    white-space: nowrap;
  }
  .plan-goal {
    flex: 1;
    min-width: 120px;
    font-size: 0.92em;
    opacity: 0.85;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pill {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .pill.pending {
    background: rgba(250, 204, 21, 0.15);
    color: #facc15;
  }
  .pill.running {
    background: rgba(41, 151, 255, 0.18);
    color: #2997ff;
  }
  .pill.done {
    background: rgba(52, 211, 153, 0.16);
    color: #34d399;
  }
  .pill.cancelled {
    background: rgba(148, 163, 184, 0.18);
    color: #94a3b8;
  }
  .pill.failed {
    background: rgba(248, 113, 113, 0.16);
    color: #f87171;
  }
  .pill.awaiting {
    background: rgba(251, 191, 36, 0.18);
    color: #fbbf24;
  }
  .plan-btn {
    border: none;
    padding: 5px 14px;
    font-size: 13px;
    cursor: pointer;
    background: #2997ff;
    color: #fff;
  }
  .plan-btn:hover {
    filter: brightness(1.1);
  }
  .plan-btn.ghost {
    background: transparent;
    color: var(--ah-text);
    border: 1px solid var(--ah-border);
    padding: 5px 14px;
  }
  /* 计划操作区：置于卡片右下角一行 —— 状态 pill 在前（左），操作按钮在后（右）。 */
  .plan-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px dashed var(--ah-border);
  }
  .plan-action-btns {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
  }
  .plan-tasks {
    margin: 0;
    padding-left: 4px;
    list-style: none;
  }
  .plan-task {
    border-top: 1px dashed var(--ah-border);
    padding: 8px 0 8px 2px;
  }
  .plan-task:first-child {
    border-top: none;
  }
  .plan-task.active {
    background: rgba(41, 151, 255, 0.06);
    border-radius: 8px;
  }
  .pt-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pt-mark {
    width: 22px;
    height: var(--ah-h-sm);
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    flex-shrink: 0;
  }
  .plan-task.done .pt-mark {
    background: rgba(52, 211, 153, 0.18);
    color: #34d399;
    border-color: transparent;
  }
  .plan-task.done b {
    text-decoration: line-through;
    opacity: 0.65;
  }
  .plan-task.failed {
    background: rgba(248, 113, 113, 0.06);
    border-radius: 8px;
  }
  .plan-task.failed .pt-mark {
    background: rgba(248, 113, 113, 0.18);
    color: #f87171;
    border-color: transparent;
  }
  /* P3：待审批任务行（琥珀色高亮，与 pill.awaiting 同色系）。 */
  .plan-task.awaiting {
    background: rgba(251, 191, 36, 0.07);
    border-radius: 8px;
  }
  .plan-task.awaiting .pt-mark {
    background: rgba(251, 191, 36, 0.18);
    color: #fbbf24;
    border-color: transparent;
  }
  /* P3：任务标题旁的「🔒 需审批」徽章（requireApproval 任务静态标记）。 */
  .pt-approval {
    margin-left: 8px;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgba(251, 191, 36, 0.14);
    color: #fbbf24;
    vertical-align: middle;
    white-space: nowrap;
  }
  .pt-steps {
    margin: 6px 0 0 30px;
    padding-left: 16px;
    opacity: 0.85;
    font-size: 0.92em;
  }
  .pt-meta {
    margin: 4px 0 0 30px;
    font-size: 12px;
    opacity: 0.6;
  }

  /* ---- 计划模式：回答/计划下拉切换器（无边框无背景填充，仅文字+箭头） ---- */
  .mode-select {
    appearance: none;
    -webkit-appearance: none;
    border: none;
    background-color: transparent;
    color: var(--ah-text-muted);
    font-size: 13px;
    height: 36px;
    line-height: 36px;
    padding: 0 20px 0 4px;
    margin: 0;
    cursor: pointer;
    outline: none;
    flex-shrink: 0;
    transition: color 0.15s;
    background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2394a3b8' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 4px center;
  }
  .mode-select:hover {
    color: var(--ah-accent);
  }
  .mode-select:focus-visible {
    color: var(--ah-text);
  }
  .mode-select option {
    background: var(--ah-surface-2);
    color: var(--ah-text);
    border: none;
  }

  /* ---- P2（轨迹回放）：计划「执行详情」抽屉 ---- */
  .wf-replay {
    padding: 4px 2px;
    color: var(--ah-text);
    font-size: 13px;
  }
  .wf-replay-hint {
    color: var(--ah-text-muted);
    line-height: 1.7;
    padding: 8px 2px;
  }
  .wf-replay-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .wf-replay-total {
    color: var(--ah-text-muted);
    font-size: 12px;
  }
  .wf-replay-err {
    width: 100%;
    color: #f87171;
    font-size: 12px;
    line-height: 1.5;
  }
  .wf-replay-timeline {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .wf-replay-row {
    border: 1px solid var(--ah-border);
    border-radius: 10px;
    background: var(--ah-surface-1);
    padding: 10px 12px;
    margin: 0 0 8px;
  }
  .wf-replay-row.failed {
    border-color: rgba(248, 113, 113, 0.4);
  }
  .wf-replay-row.done {
    border-color: rgba(52, 211, 153, 0.3);
  }
  /* P3：待审批行（琥珀色边框 + 底色）。 */
  .wf-replay-row.awaiting {
    border-color: rgba(251, 191, 36, 0.4);
    background: rgba(251, 191, 36, 0.05);
  }
  /* P3：抽屉内「批准并继续 / 批准此节点」操作区。 */
  .wf-replay-approve {
    margin: 8px 0 4px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .wf-replay-approve-hint {
    font-size: 12px;
    color: var(--ah-muted, #94a3b8);
  }
  .wf-replay-row-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .wf-replay-row-head b {
    flex: 1;
    min-width: 80px;
  }
  .wf-replay-agent {
    font-size: 11px;
    color: var(--ah-text-muted);
    background: var(--ah-surface-2);
    border-radius: 999px;
    padding: 1px 8px;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wf-replay-state {
    font-size: 12px;
    color: var(--ah-text-muted);
    white-space: nowrap;
  }
  .wf-replay-detail {
    margin-top: 8px;
  }
  .wf-replay-detail summary {
    cursor: pointer;
    color: var(--ah-text-muted);
    font-size: 12px;
    user-select: none;
  }
  .wf-replay-detail summary:hover {
    color: var(--ah-accent);
  }
  .wf-replay-detail pre {
    margin: 6px 0 0;
    padding: 8px 10px;
    background: var(--ah-surface-2);
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 220px;
    overflow: auto;
  }

  /* P2.5 调用链路：每个 step 运行过程中的关键事件时间线（LLM 调用 / 工具 / 护栏 / 校验 / 收尾），
     比「完成后的耗时」更细一层——让用户看到节点内部发生了什么。 */
  .wf-replay-trace {
    margin-top: 8px;
  }
  .wf-replay-trace summary {
    cursor: pointer;
    color: var(--ah-text-muted);
    font-size: 12px;
    user-select: none;
  }
  .wf-replay-trace summary:hover {
    color: var(--ah-accent);
  }
  .wf-trace-lines {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .wf-trace-line {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12px;
    line-height: 1.5;
    padding: 4px 8px;
    border-radius: 8px;
    background: var(--ah-surface-2);
  }
  .wf-trace-icon {
    flex: 0 0 auto;
    width: 16px;
    text-align: center;
    user-select: none;
  }
  .wf-trace-label {
    flex: 0 1 auto;
    min-width: 60px;
    color: var(--ah-text);
  }
  .wf-trace-at {
    flex: 0 0 auto;
    color: var(--ah-text-muted);
    font-size: 11px;
  }
  .wf-trace-detail {
    flex: 1 1 auto;
    margin: 0;
    font-size: 11px;
    color: var(--ah-text-muted);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 120px;
    overflow: auto;
  }
  /* 状态着色：error/blocked 行提亮，其余默认 surface。 */
  .wf-trace-line.error {
    background: rgba(248, 113, 113, 0.1);
  }
  .wf-trace-line.error .wf-trace-label {
    color: #f87171;
  }
  .wf-trace-line.blocked {
    background: rgba(251, 191, 36, 0.12);
  }
  .wf-trace-line.blocked .wf-trace-label {
    color: #fbbf24;
  }
`;
