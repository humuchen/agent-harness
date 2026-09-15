import { css } from 'lit';

export const messageBubble = css`
    .msg {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    /* 与骨架屏 .sk-msg.assistant 的 20px 对齐：否则历史会话加载完成时
       助手气泡会向上跳 20px（骨架留了间距、真实消息原本贴合）。 */
    .msg.assistant {
      margin-top: 20px;
    }
    .msg.assistant:first-child {
      margin-top: 0;
    }
    .msg.user {
      flex-direction: row-reverse;
      margin-top: 30px;
    }
    .msg.user:first-child {
      margin-top: 0;
    }
    .avatar {
      flex: 0 0 30px;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 600;
      background: var(--ah-surface-3, var(--ah-surface-2));
      color: var(--ah-text-muted);
    }
    .bubble {
      padding: 12px 14px;
      border-radius: 14px;
      line-height: 1.65;
      font-size: 14px;
      max-width: 745px;
      overflow-wrap: anywhere;
      /* 必须显式归零：.bubble 是 .msg（flex 行）的 flex item，其 min-width 默认为
         auto —— 意思是「不得窄于内容的最小宽度」。宽表格（每列 min-width:84px）
         的最小宽度轻易超过可用宽度，于是气泡被顶宽、整条消息撑出容器，
         页面出现横向滚动，表现是表格右侧被直接裁掉、而不是在气泡内横向滚动。
         归零后内容才真正被限制在气泡宽度内，交给 .md-table-wrap 自行滚动。 */
      min-width: 0;
    }
    .msg.assistant .bubble {
      /* 固定宽度：撑满可用空间并封顶，避免流式打字时气泡宽度随内容从窄到宽跳变。 */
      flex: 1 1 auto;
      width: 100%;
      background: var(--ah-surface-1);
      border: 1px solid var(--ah-border);
      border-top-left-radius: 4px;
    }
    .msg.user .bubble {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 14%,
        var(--ah-surface-2)
      );
      border-top-right-radius: 4px;
    }
    .msg.assistant.error .bubble {
      border-color: var(--ah-danger, #e24b4a);
    }
    /* ---- 用户消息悬停操作（复制 / 编辑）---- */
    .msg {
      position: relative;
    }
    .user-col {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      min-width: 0;
      max-width: 100%;
    }
    .msg-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      margin-top: 2px;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.15s ease, visibility 0.15s ease;
      flex: 0 0 auto;
    }
    /* 悬停整条消息时显示；触屏无 hover，保持常显兜底。 */
    .msg.user:hover .msg-actions {
      opacity: 1;
      visibility: visible;
    }
    @media (hover: none) {
      .msg-actions {
        opacity: 1;
        visibility: visible;
      }
    }
    .msg-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: var(--ah-h-md);
      padding: 0;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--ah-text-muted);
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .msg-action:hover {
      background: var(--ah-surface-2);
      color: var(--ah-text);
    }
    .msg-action svg {
      width: 14px;
      height: 14px;
    }
    /* 编辑态：气泡变为输入框 + 操作按钮。 */
    .bubble.editing {
      min-width: min(560px, calc(100vw - 140px));
    }
    .edit-input {
      width: 100%;
      box-sizing: border-box;
      min-height: 64px;
      max-height: 200px;
      resize: vertical;
      padding: 8px 10px;
      border: 1px solid var(--ah-accent, #2997ff);
      border-radius: 8px;
      background: var(--ah-surface-1);
      color: var(--ah-text);
      font: inherit;
      font-size: 14px;
      line-height: 1.55;
      outline: none;
    }
    .edit-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }
    .edit-btn {
      padding: 4px 12px;
      font-size: 12.5px;
      border: 1px solid var(--ah-border);
      border-radius: 8px;
      background: var(--ah-surface-2);
      color: var(--ah-text-muted);
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .edit-btn:hover {
      background: var(--ah-surface-3, var(--ah-surface-2));
      color: var(--ah-text);
    }
    .edit-btn.primary {
      background: var(--ah-accent, #2997ff);
      border-color: var(--ah-accent, #2997ff);
      color: #fff;
    }
    .edit-btn.primary:hover {
      filter: brightness(1.08);
    }
    .edit-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    /* ---- 助手消息右上角复制按钮 ---- */
    .assistant-copy {
      position: absolute;
      top: -10px;
      right: -10px;
      z-index: 2;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 1px solid var(--ah-border);
      border-radius: 7px;
      background: var(--ah-surface-2);
      color: var(--ah-text-muted);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease, background 0.12s ease, color 0.12s ease;
    }
    .msg.assistant:hover .assistant-copy,
    .assistant-copy.done {
      opacity: 1;
    }
    .assistant-copy:hover {
      background: var(--ah-surface-3, var(--ah-surface-2));
      color: var(--ah-text);
    }
    .assistant-copy svg {
      width: 13px;
      height: 13px;
    }
    .assistant-copy.done {
      color: var(--ah-ok, #34a853);
    }
    .msg-text {
      font-size: 14px;
      line-height: 1.65;
      /* 防溢出：长单词/URL/连续标点在任意位置折行，杜绝气泡内横向滚动条。
         代码块与表格由 styles/chat/markdown.ts 单独适配（内部滚动而非撑破气泡）。 */
      overflow-wrap: anywhere;
      word-break: break-word;
      min-width: 0;
    }
    .msg-text img,
    .msg-text video {
      max-width: 100%;
      height: auto;
    }
    .msg-text.placeholder {
      color: var(--ah-text-muted);
      font-style: italic;
    }
    /* 用户手动停止后的空气泡：以中性「已停止」标识替代「等待响应…」，避免误导仍在等待输入。 */
    .msg-text.placeholder.stopped {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--ah-text-muted);
      font-style: italic;
    }
    .msg-text.placeholder.stopped::before {
      content: '⏹';
      font-size: 10px;
      line-height: 1;
      color: var(--ah-text-muted);
    }
    .reasoning {
      margin-bottom: 10px;
      border: 1px solid var(--ah-border);
      border-left: 3px solid var(--ah-accent, #2997ff);
      border-radius: 10px;
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 7%,
        var(--ah-surface-2)
      );
      overflow: hidden;
    }
    .reasoning summary {
      cursor: pointer;
      padding: 9px 12px;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--ah-accent, #2997ff);
      list-style: none;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .reasoning summary::-webkit-details-marker {
      display: none;
    }
    .reasoning .ricon {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      opacity: 0.95;
    }
    .reasoning .body {
      padding: 2px 12px 10px 34px;
      color: var(--ah-text-muted);
      font-size: 13px;
      line-height: 1.7;
      max-height: 150px;
      overflow-y: auto;
      overflow-x: hidden;
      position: relative;
      scrollbar-width: thin;
      scrollbar-color: var(--ah-border) transparent;
    }
    .reasoning .body::-webkit-scrollbar {
      width: 4px;
    }
    .reasoning .body::-webkit-scrollbar-thumb {
      background: var(--ah-border);
      border-radius: 2px;
    }
    /* 底部渐变遮罩：提示内容被截断 */
    .reasoning .body::after {
      content: '';
      position: sticky;
      bottom: 0;
      left: 0;
      right: 0;
      height: 32px;
      background: linear-gradient(
        to bottom,
        transparent,
        color-mix(in srgb, var(--ah-surface-2) 80%, transparent)
      );
      pointer-events: none;
    }
    /* 工具摘要区：在深度思考框内统一展示所有工具调用 */
    .tool-summary {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed var(--ah-border);
    }
    .tool-summary-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 500;
      color: var(--ah-text);
      padding: 2px 0 6px;
    }
    .tool-summary-title svg {
      flex-shrink: 0;
      color: var(--ah-accent, #2997ff);
      opacity: 0.8;
    }
    /* 内嵌工具卡（在 reasoning body 内） */
    .inner-tool {
      margin-top: 4px;
      border: 1px solid var(--ah-border);
      border-radius: 7px;
      background: var(--ah-canvas);
      overflow: hidden;
    }
    .inner-tool summary {
      cursor: pointer;
      padding: 6px 10px;
      font-size: 11.5px;
      list-style: none;
      display: flex;
      gap: 6px;
      align-items: center;
      user-select: none;
    }
    .inner-tool summary::-webkit-details-marker {
      display: none;
    }
    .inner-tool .itag {
      width: 16px;
      height: 16px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      flex-shrink: 0;
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 12%,
        transparent
      );
      color: var(--ah-accent, #2997ff);
    }
    .inner-tool.errored .itag {
      background: color-mix(
        in srgb,
        var(--ah-danger, #e24b4a) 12%,
        transparent
      );
      color: var(--ah-danger, #e24b4a);
    }
    .inner-tool .iname {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--ah-text-muted);
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 11.5px;
    }
    .inner-tool .ichev {
      width: 9px;
      height: 9px;
      flex-shrink: 0;
      color: var(--ah-text-muted, #999);
      transition: transform 0.15s ease;
    }
    .inner-tool[open] .ichev {
      transform: rotate(180deg);
    }
    .reasoning .thinking {
      display: inline-flex;
      gap: 3px;
      margin-left: 2px;
      vertical-align: middle;
    }
    .reasoning .thinking i {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--ah-accent, #2997ff);
      animation: blinkdot 1.2s infinite ease-in-out;
    }
    .reasoning .thinking i:nth-child(2) {
      animation-delay: 0.2s;
    }
    .reasoning .thinking i:nth-child(3) {
      animation-delay: 0.4s;
    }
    @keyframes blinkdot {
      0%,
      80%,
      100% {
        opacity: 0.25;
        transform: translateY(0);
      }
      40% {
        opacity: 1;
        transform: translateY(-2px);
      }
    }
    .tool {
      margin: 8px 10px 10px;
      border: 1px solid var(--ah-border);
      border-radius: 10px;
      background: var(--ah-surface-2);
      overflow: hidden;
    }
    .tool summary {
      cursor: pointer;
      padding: 8px 12px;
      font-size: 12px;
      list-style: none;
      display: flex;
      gap: 7px;
      align-items: center;
      background: var(--ah-surface-3, var(--ah-surface-2));
      border-bottom: 1px solid var(--ah-border);
      user-select: none;
    }
    .tool summary::-webkit-details-marker {
      display: none;
    }
    .tool .tag {
      color: var(--ah-accent, #2997ff);
      font-weight: 500;
      flex-shrink: 0;
    }
    .tool .tname {
      color: var(--ah-text);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tool .chev {
      width: 10px;
      height: 10px;
      flex-shrink: 0;
      color: var(--ah-text-muted);
      transition: transform 0.15s ease;
    }
    .tool[open] .chev {
      transform: rotate(180deg);
    }
    .tool-pre {
      margin: 0;
      padding: 10px 12px;
      font-size: 11.5px;
      line-height: 1.55;
      overflow: auto;
      max-height: 200px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--ah-text-muted);
      font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
      background: var(--ah-canvas);
    }
    .tool-result {
      padding: 8px 12px 10px;
      font-size: 11.5px;
      line-height: 1.55;
      color: var(--ah-text-muted);
      white-space: pre-wrap;
      word-break: break-word;
      border-top: 1px dashed var(--ah-border);
    }
    .tool.errored .tag {
      color: var(--ah-danger, #e24b4a);
    }
`;
