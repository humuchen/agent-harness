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
  /* P2.6：镜像回退来源标注（检查点 404 后从 planStatus 历史镜像水合）。 */
  .wf-replay-mirror-hint {
    border: 1px solid var(--ah-amber, rgba(245, 158, 11, 0.45));
    background: rgba(245, 158, 11, 0.1);
    color: var(--ah-text);
    font-size: 12px;
    line-height: 1.6;
    padding: 8px 10px;
    border-radius: 6px;
    margin-bottom: 10px;
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
  /* 「产出 / 错误」正文走 JSON 高亮视图（长文本独立一行、点击展开后下方折叠区呈现）。 */
  .wf-replay-detail .wf-detail-body {
    margin: 6px 0 0;
    padding: 8px 10px;
    background: var(--ah-surface-2);
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.5;
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
    padding: 8px;
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
    font-size: 12px;
  }
  /* 链路行 meta 区（模型 / 用量 / 参数）：独立可折叠子行，此前被 buildPlanWfTraceLines 丢弃导致数据不可见。
     按用户标注「用量和模型信息需要单独一行展示，点击才能展开/折叠，在它的下面」实现。 */
  .wf-trace-sub {
    margin-top: 2px;
  }
  .wf-trace-sub-head {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    user-select: none;
    font-size: 11px;
    color: var(--ah-text-muted);
    padding: 2px 8px;
    border-radius: 6px;
  }
  .wf-trace-sub-head::-webkit-details-marker,
  .wf-trace-sub-head::marker {
    display: none;
    content: '';
  }
  .wf-trace-sub-head:hover {
    color: var(--ah-accent);
  }
  .wf-trace-sub-caret {
    width: 7px;
    height: 7px;
    margin-left: auto;
    border-right: 1.5px solid var(--ah-text-muted);
    border-bottom: 1.5px solid var(--ah-text-muted);
    transform: rotate(-45deg);
    transition: transform 0.15s ease;
  }
  .wf-trace-sub[open] > .wf-trace-sub-head .wf-trace-sub-caret {
    transform: rotate(45deg);
  }
  .wf-trace-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 8px 2px 20px;
  }
  .wf-trace-meta-chip {
    font-size: 10px;
    line-height: 1.5;
    color: var(--ah-text-muted);
    background: var(--ah-surface-3, var(--ah-surface-2));
    border: 1px solid var(--ah-border);
    border-radius: 999px;
    padding: 0 7px;
    white-space: nowrap;
  }
  .wf-trace-meta-chip b {
    color: var(--ah-text);
    font-weight: 600;
    margin-right: 3px;
  }
  /* 有详情的行：原生 details 折叠 —— 标题单行（图标 + 标签 + 时间），点击在下方展开详情。 */
  .wf-trace-item {
    flex: 1 1 auto;
    min-width: 0;
  }
  .wf-trace-item-head {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
  }
  /* 隐藏原生 <summary> 折叠箭头（视觉指示统一走 .wf-trace-caret 的 CSS 旋转）。 */
  .wf-trace-item-head::-webkit-details-marker,
  .wf-trace-item-head::marker {
    display: none;
    content: '';
  }
  .wf-trace-item-head:hover .wf-trace-label {
    color: var(--ah-accent);
  }
  /* 展开指示箭头：CSS 旋转，与 .tcaret 同款语义。 */
  .wf-trace-caret {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    margin-left: auto;
    border-right: 1.5px solid var(--ah-text-muted);
    border-bottom: 1.5px solid var(--ah-text-muted);
    transform: rotate(-45deg);
    transition: transform 0.15s ease;
  }
  .wf-trace-item[open] > .wf-trace-item-head .wf-trace-caret {
    transform: rotate(45deg);
  }
  /* 详情正文：独立一行，JSON 高亮（非 JSON 原文回退），超长滚动。 */
  .wf-trace-detail {
    margin: 4px 0 0 22px;
    padding: 8px 10px;
    background: var(--ah-surface-2);
    border-radius: 8px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--ah-text-muted);
    word-break: break-word;
    max-height: 160px;
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

  /* ---- 计划模式（P0）：propose 阶段进度条（理解需求 → 调研中 → 生成计划） ---- */
  .plan-phase {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 2px 0 8px;
    font-size: 12px;
  }
  .pp-steps {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pp-step {
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
    white-space: nowrap;
    transition: color 0.2s, border-color 0.2s, background 0.2s;
  }
  .pp-step.on {
    color: #2997ff;
    border-color: rgba(41, 151, 255, 0.5);
    background: rgba(41, 151, 255, 0.1);
  }
  .pp-step.cur {
    background: rgba(41, 151, 255, 0.2);
    font-weight: 600;
  }
  .pp-arrow {
    color: var(--ah-text-muted);
    opacity: 0.7;
  }
  /* 实时活动行：当前动作 + 计时器（解决规划期「零反馈空等」）。 */
  .plan-activity {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--ah-text-muted);
  }
  .pa-spin {
    width: 12px;
    height: 12px;
    flex: 0 0 auto;
    border-radius: 50%;
    border: 2px solid rgba(41, 151, 255, 0.25);
    border-top-color: #2997ff;
    animation: pa-rotate 0.9s linear infinite;
  }
  .pa-text {
    color: #2997ff;
  }
  .plan-elapsed {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
    white-space: nowrap;
  }
  .pp-hint {
    color: var(--ah-text-muted);
    opacity: 0.7;
  }
  /* 规划中断态：流结束但计划未产出（断线/超时），明确提示可重试。 */
  .plan-aborted {
    color: #fbbf24;
    opacity: 0.9;
  }
  @keyframes pa-rotate {
    to {
      transform: rotate(360deg);
    }
  }

  /* ---- 计划模式（P0）：目标澄清卡（plan:clarify） ---- */
  .clarify-card {
    border: 1px solid rgba(251, 191, 36, 0.4);
    border-radius: 12px;
    background: rgba(251, 191, 36, 0.06);
    padding: 14px 16px;
    margin: 6px 0;
  }
  .clarify-head {
    font-weight: 600;
    margin-bottom: 8px;
  }
  .clarify-goal {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin-bottom: 8px;
  }
  .cg-label {
    flex-shrink: 0;
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(41, 151, 255, 0.15);
    color: #2997ff;
    white-space: nowrap;
  }
  .cg-text {
    font-size: 0.95em;
    opacity: 0.9;
  }
  .clarify-q {
    margin: 0 0 8px;
    padding-left: 20px;
    display: grid;
    gap: 4px;
    font-size: 0.95em;
  }
  .clarify-needs {
    font-size: 12px;
    color: var(--ah-text-muted);
    margin-bottom: 8px;
  }
  .clarify-input {
    width: 100%;
    box-sizing: border-box;
    min-height: 56px;
    resize: vertical;
    border: 1px solid var(--ah-border);
    border-radius: 8px;
    background: var(--ah-surface-2);
    color: var(--ah-text);
    padding: 8px 10px;
    font-size: 13px;
    font-family: inherit;
    margin-bottom: 8px;
  }
  .clarify-input:focus {
    outline: none;
    border-color: rgba(41, 151, 255, 0.6);
  }
  .clarify-actions {
    display: flex;
    justify-content: flex-end;
  }
  .clarify-actions .plan-btn:disabled {
    opacity: 0.55;
    cursor: default;
    filter: none;
  }
`;
