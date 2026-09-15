import { css } from 'lit';

export const mergedView = css`
    /* ----------------------- 合并视图：深度思考 + 最终回答 ----------------------- */
    /* 思考区：合并视图顶部，实时流式呈现模型推理（随 token 增量逐字揭示）。 */
    .think {
      margin-bottom: 10px;
      border: 1px solid var(--ah-border);
      border-left: 3px solid var(--ah-accent, #2997ff);
      border-radius: 10px;
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 5%,
        var(--ah-surface-2)
      );
      overflow: hidden;
      animation: think-in 0.28s ease;
    }
    @keyframes think-in {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
    .think-head {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 10px 7px 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--ah-accent, #2997ff);
      cursor: pointer;
      user-select: none;
    }
    .think-ico {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      opacity: 0.95;
    }
    .think-title {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .think-status {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 500;
      font-style: normal;
      color: var(--ah-accent, #2997ff);
      flex: 0 0 auto;
    }
    .think-count {
      font-size: 11px;
      font-weight: 500;
      color: var(--ah-text-muted);
      flex: 0 0 auto;
    }
    .think-chev {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      color: var(--ah-text-muted);
      transition: transform 0.18s ease;
    }
    .think.collapsed .think-chev {
      transform: rotate(-90deg);
    }
    /* 高度封顶 + 内部滚动：超长推理不再撑高整条消息，降低视觉占用。 */
    .think-body {
      padding: 2px 12px 8px 34px;
      color: var(--ah-text-muted);
      font-size: 12.5px;
      line-height: 1.65;
      max-height: 180px;
      overflow-y: auto;
      overflow-x: hidden;
      overflow-wrap: anywhere;
      position: relative;
      scrollbar-width: thin;
      scrollbar-color: var(--ah-border) transparent;
      transition: max-height 0.25s ease, opacity 0.2s ease, padding 0.25s ease;
    }
    .think.collapsed .think-body {
      max-height: 0 !important;
      opacity: 0;
      padding-top: 0;
      padding-bottom: 0;
      overflow: hidden;
    }
    .think-body::-webkit-scrollbar {
      width: 4px;
    }
    .think-body::-webkit-scrollbar-thumb {
      background: var(--ah-border);
      border-radius: 2px;
    }
    .think-text {
      white-space: normal;
    }
    .think-text.muted {
      opacity: 0.85;
    }
    /* 关键变量卡（深度思考内高亮） */
    .dvars {
      margin-bottom: 10px;
      border: 1px dashed var(--ah-border);
      border-radius: 8px;
      padding: 8px 10px;
      background: var(--ah-canvas);
    }
    .dvars-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--ah-success, #34c759);
      margin-bottom: 6px;
    }
    .dvars-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 6px;
    }
    .dvar {
      background: var(--ah-surface-3, var(--ah-surface-1));
      border: 1px solid var(--ah-border);
      border-radius: 7px;
      padding: 5px 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .dvar-k {
      font-size: 10px;
      color: var(--ah-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dvar-v {
      font-size: 12px;
      font-weight: 600;
      color: var(--ah-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* 思考区与回答区之间的清晰分隔 */
    .sep {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 4px 0 10px;
      color: var(--ah-text-muted);
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .sep::before,
    .sep::after {
      content: '';
      flex: 1 1 auto;
      height: 1px;
      background: var(--ah-border);
    }
    /* 回答区：合并视图底部，承载最终回答（流式逐字）。 */
    .answer {
      font-size: 14px;
      line-height: 1.65;
    }
    /* “模型正在回复…” 文字动效：循环脉冲 + 跳动圆点，提示模型仍在处理。 */
    .replying {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      font-size: 12.5px;
      font-style: italic;
      color: var(--ah-text-muted);
      animation: replying-pulse 1.5s ease-in-out infinite;
    }
    @keyframes replying-pulse {
      0%,
      100% {
        opacity: 0.5;
      }
      50% {
        opacity: 1;
      }
    }
    /* 通用跳动圆点（思考中 / 模型正在回复 共用 blinkdot 动效） */
    .dots {
      display: inline-flex;
      gap: 3px;
      vertical-align: middle;
    }
    .dots i {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: currentColor;
      animation: blinkdot 1.2s infinite ease-in-out;
    }
    .dots i:nth-child(2) {
      animation-delay: 0.2s;
    }
    .dots i:nth-child(3) {
      animation-delay: 0.4s;
    }
`;
