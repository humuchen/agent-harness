/**
 * 聊天页专属样式（从 chat.ts static styles 拆出，内容零改动）。
 * 三栏式布局与全部组件样式，严格使用 --ah-* 语义令牌；含多个 css 片段，以数组导出。
 */
import { css } from 'lit';

export const chatStyles = [
  css`
    :host {
      display: flex;
      flex-direction: row;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      background: var(--ah-canvas);
    }
    .sidebar {
      width: 264px;
      flex: 0 0 264px;
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--ah-border);
      background: var(--ah-surface-1);
      min-height: 0;
    }
    // .side-head {
    //   padding: 14px 14px 10px;
    // }
    .new-btn {
      width: 100%;
      justify-content: center;
      gap: 8px;
    }
    .session-list {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 6px 8px 14px;
      min-height: 0;
    }
    .session {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 10px;
      border-radius: 10px;
      cursor: pointer;
      color: var(--ah-text);
      margin-bottom: 10px;
      background: var(--ah-surface-3, var(--ah-surface-2));
      transition: background 0.15s ease;
    }
    .session:last-child {
      margin-bottom: 0;
    }
    .session:hover {
      background: var(--ah-surface-2);
    }
    .session.active {
      background: var(--ah-surface-3, var(--ah-surface-2));
      outline: 1px solid var(--ah-accent, #2997ff);
    }
    .session .title {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .session .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--ah-text-muted);
      flex: 0 0 auto;
    }
    .session.active .dot {
      background: var(--ah-success);
    }
    .session .acts {
      display: none;
      gap: 4px;
    }
    /* 仅真实悬停设备（鼠标）hover 才浮现操作按钮：触屏没有 hover，
       点按会话行时浏览器先置 hover 态、按钮在指尖下瞬间出现并截获本次 click，
       导致「选会话」误触发重命名弹框。触屏端改为常驻显示（见 ≤900px 媒体查询）。 */
    @media (hover: hover) {
      .session:hover .acts {
        display: flex;
      }
    }
    .icon-btn {
      border: none;
      background: transparent;
      color: var(--ah-text-muted);
      cursor: pointer;
      font-size: 12px;
      padding: 2px 5px;
      border-radius: 6px;
    }
    .icon-btn:hover {
      background: var(--ah-border);
      color: var(--ah-text);
    }
    .main {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }
    .chat-head {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 18px;
      border-bottom: 1px solid var(--ah-border);
      background: var(--ah-surface-1);
    }
    .chat-head .title {
      font-weight: 600;
      font-size: 14px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-head .spacer {
      flex: 1 1 auto;
    }
    .toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      border-radius: 50%;
      border: 1px solid var(--ah-border);
      background: var(--ah-surface-2);
      color: var(--ah-text-muted);
      cursor: pointer;
      user-select: none;
      transition: color 0.15s ease, border-color 0.15s ease,
        background 0.15s ease, box-shadow 0.15s ease;
    }
    .toggle:hover {
      border-color: var(--ah-accent, #2997ff);
      color: var(--ah-text);
      background: var(--ah-surface-3);
    }
    .toggle svg {
      width: 15px;
      height: 15px;
      flex: 0 0 auto;
    }
    .toggle.on {
      color: var(--ah-accent, #2997ff);
      border-color: var(--ah-accent, #2997ff);
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 12%,
        transparent
      );
      box-shadow: 0 0 0 1px
        color-mix(in srgb, var(--ah-accent, #2997ff) 28%, transparent);
    }
    .model-input {
      width: 180px;
      background: var(--ah-surface-2);
      border: 1px solid var(--ah-border);
      border-radius: 8px;
      color: var(--ah-text);
      padding: 5px 9px;
      font-size: 12px;
    }
    /* 滚动区外壳：相对定位，作为「回到底部」浮动按钮的定位上下文；
         按钮 absolute 钉在其底部中央，不进入文档流、不挤压/遮挡内容与输入框。 */
    .scroll-region {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .scroll {
      flex: 1 1 auto;
      overflow-y: auto;
      min-height: 0;
      padding: 18px 0;
    }
    /* 回到底部悬浮按钮：默认隐藏（由 showScrollDown 控制挂载），
         仅在用户向上滚动离开底部时出现；点击平滑滚回底部后由滚动事件自动消失。 */
    .scroll-down {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: 16px;
      z-index: 6;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      border: 1px solid var(--ah-border);
      background: var(--ah-surface-2);
      color: var(--ah-text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
      transition: color 0.15s ease, background 0.15s ease,
        border-color 0.15s ease, transform 0.18s ease, opacity 0.18s ease;
      animation: sdown-in 0.18s ease;
    }
    .scroll-down:hover {
      color: var(--ah-text);
      background: var(--ah-surface-3, var(--ah-surface-2));
      border-color: var(--ah-accent, #2997ff);
      transform: translateX(-50%) translateY(-1px);
    }
    .scroll-down svg {
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
    }
    @keyframes sdown-in {
      from {
        opacity: 0;
        transform: translateX(-50%) translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    }
    /* 上下文用量圆环（环形进度条）：置于输入框发送按钮旁；hover 显示提示，
         点击切换分类占比弹层（点击显示逻辑与原实现一致）。 */
    .ctx-ring-wrap {
      position: relative;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
    }
    .ctx-ring {
      display: block;
      width: 36px;
      height: 36px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: transparent;
      cursor: pointer;
      transition: transform 0.15s ease;
    }
    .ctx-ring:hover {
      transform: scale(1.08);
    }
    .ctx-ring svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .ring-bg {
      fill: none;
      stroke: var(--ah-surface-3, rgba(255, 255, 255, 0.14));
    }
    .ring-fg {
      fill: none;
      stroke: var(--ah-accent, #2997ff);
      stroke-linecap: round;
      transition: stroke-dashoffset 0.25s ease, stroke 0.25s ease;
    }
    .ring-fg.warn {
      stroke: #ff453a;
    }
    .ring-num {
      font-size: 9.5px;
      font-weight: 600;
      fill: var(--ah-text);
      font-variant-numeric: tabular-nums;
    }
    /* hover 提示：圆环上方浮出「上下文已使用：xx.x% - 用量K/总量K」。 */
    .ctx-tip {
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%) translateY(2px);
      white-space: nowrap;
      padding: 5px 10px;
      border-radius: 8px;
      border: 1px solid var(--ah-border);
      background: var(--ah-surface-1);
      color: var(--ah-text);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.32);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease, transform 0.15s ease;
      z-index: 21;
    }
    .ctx-ring-wrap:hover .ctx-tip {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    /* 移动端（≤600px）：无 hover 语义，且触屏长按/点按易误触发提示，
       直接禁用 hover 浮出的 tip（分类明细仍可点击圆环查看）。 */
    @media (max-width: 600px) {
      .ctx-tip {
        display: none;
      }
    }
    .ctx-pop {
      position: absolute;
      bottom: calc(100% + 10px);
      right: -6px;
      z-index: 22;
      width: 280px;
      max-width: calc(100vw - 24px);
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid var(--ah-border);
      background: var(--ah-surface-1);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      animation: ctx-in 0.16s ease;
    }
    /* 弹层打开时的透明遮罩：点击弹层外任意处关闭（置于弹层之下、页面之上）。 */
    .ctx-scrim {
      position: fixed;
      inset: 0;
      z-index: 21;
      background: transparent;
      border: none;
      padding: 0;
      cursor: default;
    }
    .ctx-pop-close {
      flex-shrink: 0;
      align-self: center;
      width: 20px;
      height: 20px;
      line-height: 18px;
      text-align: center;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--ah-text-muted);
      font-size: 15px;
      cursor: pointer;
      padding: 0;
      margin-left: auto;
      transition: color 0.15s, background 0.15s;
    }
    .ctx-pop-close:hover {
      color: var(--ah-text);
      background: var(--ah-surface-3, var(--ah-surface-2));
    }
    @keyframes ctx-in {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    .ctx-pop-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .ctx-pop-head > span:first-child {
      font-weight: 600;
      font-size: 13px;
      color: var(--ah-text);
    }
    .ctx-pop-total {
      font-size: 11px;
      color: var(--ah-text-muted);
      font-variant-numeric: tabular-nums;
      margin-left: 20px;
    }
    .ctx-seg {
      display: flex;
      height: 8px;
      border-radius: 4px;
      overflow: hidden;
      gap: 2px;
      margin-bottom: 10px;
      background: var(--ah-surface-3, rgba(255, 255, 255, 0.08));
    }
    .ctx-seg-i {
      height: 100%;
    }
    .ctx-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ctx-list li {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }
    .ctx-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex: 0 0 auto;
    }
    .ctx-label {
      flex: 1 1 auto;
      color: var(--ah-text-muted);
    }
    .ctx-val {
      font-variant-numeric: tabular-nums;
      color: var(--ah-text);
      font-weight: 600;
    }
    .c-sys {
      background: #ff9f0a;
    }
    .c-tools {
      background: #5ac8fa;
    }
    .c-msg {
      background: #2997ff;
    }
    .c-mcp {
      background: #34c759;
    }
    .c-skill {
      background: #bf5af2;
    }
    .empty {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 18px;
      text-align: center;
      padding: 0 20px;
    }
    .empty h1 {
      font-size: 26px;
      font-weight: 600;
      margin: 0;
    }
    .empty p {
      color: var(--ah-text-muted);
      margin: 0;
      font-size: 14px;
    }
    .thread {
      max-width: 820px;
      margin: 0 auto;
      padding: 0 18px;
      display: flex;
      flex-direction: column;
      // gap: 18px;
    }
    .msg {
      display: flex;
      gap: 12px;
      align-items: flex-start;
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
      height: 26px;
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
      /* 防溢出三件套：长单词/URL/连续标点在任意位置折行，杜绝气泡内横向滚动条。
         pre/code/table 由下方子规则单独处理（内部滚动而非撑破气泡）。 */
      overflow-wrap: anywhere;
      word-break: break-word;
      min-width: 0;
    }
    /* 富文本内的代码块 / 表格：限制在气泡宽度内，自身横向滚动，不撑破外层。 */
    .msg-text pre,
    .msg-text code {
      max-width: 100%;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg-text pre {
      overflow-x: auto;
      scrollbar-width: thin;
    }
    .msg-text table {
      display: block;
      max-width: 100%;
      overflow-x: auto;
      scrollbar-width: thin;
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
    /* ----------------------- 调用链路 (trace) ----------------------- */
    .trace {
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
    }
    .trace > summary {
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
    .trace > summary::-webkit-details-marker {
      display: none;
    }
    .trace .ticon {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      opacity: 0.95;
    }
    .trace .tcount {
      font-weight: 400;
      font-size: 11px;
      color: var(--ah-text-muted);
      background: var(--ah-surface-3, var(--ah-surface-2));
      border-radius: 999px;
      padding: 1px 8px;
    }
    .trace-body {
      padding: 2px 12px 10px 14px;
    }
    /* 树状节点：左侧连接线 + 圆点 */
    .tnode {
      border-left: 1px dashed var(--ah-border);
      margin-left: 6px;
      padding-left: 12px;
    }
    .tnode:last-child {
      border-left-color: transparent;
    }
    .tnode > summary.tnode-head {
      cursor: pointer;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 0;
      font-size: 12px;
    }
    .tnode > summary.tnode-head::-webkit-details-marker {
      display: none;
    }
    .tdot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: var(--ah-text-muted);
    }
    .tlabel {
      color: var(--ah-text);
      font-weight: 500;
    }
    .tbadge {
      font-size: 10px;
      padding: 0 6px;
      border-radius: 999px;
      line-height: 16px;
      flex: 0 0 auto;
    }
    .tbadge.err {
      background: color-mix(
        in srgb,
        var(--ah-danger, #e24b4a) 16%,
        transparent
      );
      color: var(--ah-danger, #e24b4a);
    }
    .tbadge.pend {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 16%,
        transparent
      );
      color: var(--ah-accent, #2997ff);
    }
    .tchips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-left: 2px;
    }
    .tchip {
      font-size: 10px;
      color: var(--ah-text-muted);
      background: var(--ah-surface-3, var(--ah-surface-2));
      border: 1px solid var(--ah-border);
      border-radius: 6px;
      padding: 0 6px;
      line-height: 16px;
      white-space: nowrap;
    }
    .tchip b {
      color: var(--ah-text);
      font-weight: 600;
      margin-right: 3px;
    }
    .tdetail {
      margin: 2px 0 4px 15px;
      padding: 8px 10px;
      font-size: 11px;
      line-height: 1.5;
      overflow: auto;
      max-height: 180px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--ah-text-muted);
      font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
      background: var(--ah-canvas);
      border: 1px solid var(--ah-border);
      border-radius: 7px;
    }
    .tresult {
      margin: 2px 0 6px 15px;
      padding: 8px 10px;
      font-size: 11.5px;
      line-height: 1.55;
      color: var(--ah-text);
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--ah-surface-3, var(--ah-surface-2));
      border: 1px solid var(--ah-border);
      border-radius: 7px;
    }
    .tresult.retrieval {
      border-left: 3px solid var(--ah-success, #34c759);
      background: color-mix(
        in srgb,
        var(--ah-success, #34c759) 8%,
        var(--ah-surface-2)
      );
    }
    .tres-title {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--ah-success, #34c759);
      margin-bottom: 4px;
      letter-spacing: 0.03em;
    }
    /* 检索内容折叠框：标题行可点击展开/收起，短内容默认展开、长内容默认收起。 */
    .tresult.tres-fold {
      padding: 0;
    }
    .tresult.tres-fold > summary {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
      list-style: none;
    }
    .tresult.tres-fold > summary::-webkit-details-marker,
    .tresult.tres-fold > summary::marker {
      display: none;
      content: '';
    }
    /* 折叠指示箭头：收起 ▸ / 展开 ▾（旋转过渡） */
    .tresult.tres-fold > summary::before {
      content: '▸';
      font-size: 10px;
      line-height: 1;
      color: var(--ah-success, #34c759);
      transition: transform 0.15s ease;
    }
    .tresult.tres-fold[open] > summary::before {
      transform: rotate(90deg);
    }
    .tresult.tres-fold > summary:hover .tres-title {
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .tresult.tres-fold > summary .tres-title {
      margin-bottom: 0;
    }
    .tres-meta {
      font-size: 10px;
      font-weight: 400;
      color: var(--ah-text-muted);
    }
    .tresult.tres-fold .tres-body {
      padding: 0 10px 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    /* json-view：JSON 语法高亮 + 长值/大容器折叠（配色全走 --ah-* 令牌）。 */
    .jv,
    .jv-row {
      display: block;
      font-family: inherit;
      color: var(--ah-text);
      /* 外层容器可能是 <pre>（pre-wrap），会泄漏模板换行；块级布局下覆盖为 normal。 */
      white-space: normal;
    }
    .jv-row {
      line-height: 1.65;
    }
    .jv-key {
      color: var(--ah-accent);
    }
    .jv-str {
      color: var(--ah-warning);
      word-break: break-all;
    }
    .jv-num,
    .jv-bool,
    .jv-null {
      color: var(--ah-success);
    }
    .jv-punc {
      color: var(--ah-text-faint);
    }
    .jv-fold {
      display: inline;
    }
    .jv-fold > summary {
      display: inline;
      cursor: pointer;
      list-style: none;
    }
    .jv-fold > summary::-webkit-details-marker,
    .jv-fold > summary::marker {
      display: none;
      content: '';
    }
    .jv-fold[open] > summary {
      display: block;
    }
    .jv-fold-head:hover .jv-fold-btn {
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .jv-fold-btn {
      font-size: 10px;
      color: var(--ah-accent);
      background: var(--ah-accent-soft);
      border-radius: 5px;
      padding: 0 6px;
      margin-left: 4px;
      user-select: none;
    }
    .tchildren {
      margin-top: 2px;
    }
    /* 节点类型着色（圆点 + 标签前缀色） */
    .tnode.kind-step > summary .tdot {
      background: var(--ah-accent, #2997ff);
    }
    .tnode.kind-llm > summary .tdot {
      background: #9b6dff;
    }
    .tnode.kind-tool > summary .tdot {
      background: var(--ah-text-muted);
    }
    .tnode.kind-retrieval > summary .tdot {
      background: var(--ah-success, #34c759);
    }
    .tnode.kind-cost > summary .tdot {
      background: #f0a020;
    }
    .tnode.kind-tokencache > summary .tdot {
      background: #2dd4bf;
    }
    .tnode.kind-verify > summary .tdot {
      background: var(--ah-success, #34c759);
    }
    .tnode.kind-guardrail > summary .tdot,
    .tnode.kind-budget > summary .tdot,
    .tnode.kind-error > summary .tdot {
      background: var(--ah-danger, #e24b4a);
    }
    .tnode.status-error > summary .tlabel {
      color: var(--ah-danger, #e24b4a);
    }

    /* ----------------------- 关键信息 (insights) ----------------------- */
    .insights {
      margin-bottom: 10px;
      border: 1px solid var(--ah-border);
      border-radius: 10px;
      background: var(--ah-surface-2);
      padding: 10px 12px 12px;
    }
    .insights-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--ah-text);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .insights-title::before {
      content: '';
      width: 3px;
      height: 12px;
      border-radius: 2px;
      background: var(--ah-accent, #2997ff);
    }
    .ins-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
      gap: 8px;
    }
    .ins-item {
      background: var(--ah-surface-3, var(--ah-surface-1));
      border: 1px solid var(--ah-border);
      border-radius: 8px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .ins-k {
      font-size: 10px;
      color: var(--ah-text-muted);
    }
    .ins-v {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--ah-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ins-retrieval {
      margin-top: 10px;
      border-top: 1px dashed var(--ah-border);
      padding-top: 10px;
    }
    .ins-breakdown {
      margin-top: 10px;
      border-top: 1px dashed var(--ah-border);
      padding-top: 10px;
    }
    .ins-bd-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--ah-accent, #2997ff);
      margin-bottom: 8px;
    }
    .ins-bd-row {
      margin-bottom: 7px;
    }
    /* 分项缺失时的稳定占位（有总量、无明细），避免模块静默消失。 */
    .ins-bd-empty {
      font-size: 11px;
      color: var(--ah-text-muted);
      padding: 2px 0 4px;
    }
    .ins-bd-head {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      margin-bottom: 3px;
    }
    .ins-bd-name {
      color: var(--ah-text-muted);
    }
    .ins-bd-val {
      color: var(--ah-text);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .ins-bd-track {
      height: 6px;
      border-radius: 4px;
      background: color-mix(in srgb, var(--ah-border) 60%, transparent);
      overflow: hidden;
    }
    .ins-bd-fill {
      height: 100%;
      border-radius: 4px;
      background: linear-gradient(
        90deg,
        var(--ah-accent, #2997ff),
        color-mix(in srgb, var(--ah-accent, #2997ff) 55%, #34c759)
      );
      transition: width 0.35s ease;
    }
    .ins-ret-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--ah-success, #34c759);
      margin-bottom: 6px;
    }
    .ins-ret-card {
      border: 1px solid var(--ah-border);
      border-left: 3px solid var(--ah-success, #34c759);
      border-radius: 8px;
      background: color-mix(
        in srgb,
        var(--ah-success, #34c759) 6%,
        var(--ah-surface-1)
      );
      padding: 8px 10px;
      margin-bottom: 8px;
    }
    /* 检索内容折叠框（关键信息区）：与调用链 .tres-fold 同款交互 ——
         短内容(≤240字)默认展开、长内容默认收起，标题行点击切换。 */
    details.ins-ret-fold {
      padding: 0;
    }
    .ins-ret-fold > summary {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
      list-style: none;
    }
    .ins-ret-fold > summary::-webkit-details-marker,
    .ins-ret-fold > summary::marker {
      display: none;
      content: '';
    }
    /* 折叠指示箭头：收起 ▸ / 展开 ▾（旋转过渡） */
    .ins-ret-fold > summary::before {
      content: '▸';
      font-size: 10px;
      line-height: 1;
      color: var(--ah-success, #34c759);
      transition: transform 0.15s ease;
    }
    .ins-ret-fold[open] > summary::before {
      transform: rotate(90deg);
    }
    .ins-ret-fold > summary:hover .ins-ret-name {
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .ins-ret-fold > summary .ins-ret-name {
      margin-bottom: 0;
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ins-ret-name {
      font-size: 11px;
      font-weight: 600;
      color: var(--ah-text);
      margin-bottom: 4px;
    }
    /* 折叠标题行的字数 meta。 */
    .ins-ret-meta {
      flex: 0 0 auto;
      font-size: 10px;
      color: var(--ah-text-muted);
      font-variant-numeric: tabular-nums;
    }
    .ins-ret-body {
      margin: 0;
      padding: 0 10px 8px;
      font-size: 11px;
      line-height: 1.5;
      max-height: 160px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--ah-text-muted);
      font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    }
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
    }
    .think.collapsed .think-body {
      display: none;
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
    /* 折叠式附加信息（调用链路 / 关键信息）：默认收起，不干扰主阅读流。 */
    .extras {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .extra {
      border: 1px solid var(--ah-border);
      border-radius: 10px;
      background: var(--ah-surface-2);
      overflow: hidden;
    }
    .extra > summary {
      cursor: pointer;
      list-style: none;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--ah-text);
      display: flex;
      align-items: center;
      gap: 8px;
      user-select: none;
    }
    .extra > summary::-webkit-details-marker {
      display: none;
    }
    .extra[open] > summary {
      border-bottom: 1px solid var(--ah-border);
    }
    .extra .ticon {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      opacity: 0.95;
    }
    .extra .tcount {
      font-weight: 400;
      font-size: 11px;
      color: var(--ah-text-muted);
      background: var(--ah-surface-3, var(--ah-surface-2));
      border-radius: 999px;
      padding: 1px 8px;
    }
    .extra .trace-body {
      padding: 10px 12px;
    }
    .extra .insights {
      border: none;
      border-radius: 0;
      background: transparent;
      margin: 0;
      padding: 10px 12px 12px;
    }

    /* 移动端「会话列表」按钮与抽屉遮罩（默认隐藏，窄屏媒体查询启用）。 */
    .menu-btn {
      display: none;
      flex: 0 0 auto;
      width: 34px;
      height: 34px;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      background: var(--ah-surface-2);
      border: 1px solid var(--ah-border);
      color: var(--ah-text);
      cursor: pointer;
      padding: 0;
    }
    .menu-btn svg {
      width: 17px;
      height: 17px;
    }
    .menu-btn:hover {
      border-color: var(--ah-accent, #2997ff);
    }
    .scrim {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      z-index: 40;
      opacity: 0;
      transition: opacity 200ms ease;
    }
    .scrim.show {
      opacity: 1;
      display: block;
    }

    /* ===================== 响应式适配 ===================== */
    /* 平板 / 手机（≤900px）：侧栏离屏为抽屉，汉堡按钮唤出，主区占满。 */
    @media (max-width: 900px) {
      :host {
        /* 移动端：ah-chat 嵌在 ah-app 的 .content 中，对话 Tab 时外壳已被
             .shell.chat-mode 锁定为整屏（fixed + inset:0）。这里让 ah-chat 填满
             .content（height:100%），输入框自然钉在视口底部，无需滚动外层页面。
             min-height:0 必须显式中和 sharedStyles ≤760px 设的 min-height:100dvh，
             否则它把组件顶高、仍需滚动。 */
        height: 100%;
        min-height: 0;
        overflow: hidden;
      }
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        height: 100%;
        width: 264px;
        max-width: 84vw;
        transform: translateX(-100%);
        transition: transform 220ms ease;
        z-index: 50;
        box-shadow: 2px 0 18px rgba(0, 0, 0, 0.45);
      }
      .sidebar.open {
        transform: none;
      }
      .menu-btn {
        display: inline-flex;
      }
      .scrim.show {
        display: block;
      }
      .chat-head {
        padding: 10px 12px;
        gap: 8px;
      }
      /* 触屏无 hover：会话操作按钮常驻显示，避免点按时按钮在指尖下浮现截获 click
         （选会话误触发重命名弹框的根因）。 */
      .session .acts {
        display: flex;
      }
      .session .acts .icon-btn {
        padding: 6px 8px; /* 触屏加大点击热区 */
      }
      .model-input {
        width: 120px;
      }
      .thread {
        max-width: 100%;
      }
      .composer,
      .hint {
        max-width: 100%;
      }
    }
    /* 手机（≤600px）：进一步收紧内边距 / 字号，确保完整显示与流畅操作。 */
    @media (max-width: 600px) {
      .scroll {
        padding: 12px 0;
      }
      .thread {
        padding: 0 12px;
        gap: 14px;
      }
      .bubble {
        padding: 10px 12px;
      }
      .avatar {
        flex: 0 0 26px;
        width: 26px;
        height: 26px;
        font-size: 12px;
      }
      .msg {
        gap: 9px;
      }
      .chat-head {
        padding: 8px 10px;
        gap: 6px;
      }
      .title {
        font-size: 13px;
      }
      .model-input {
        width: 88px;
        font-size: 11px;
        padding: 4px 8px;
      }
      .toggle {
        width: 28px;
        height: 28px;
      }
      .toggle svg {
        width: 14px;
        height: 14px;
      }
      .composer-wrap {
        padding: 10px 10px calc(12px + env(safe-area-inset-bottom));
      }
      .composer {
        border-radius: 14px;
      }
      .composer textarea {
        font-size: 14px;
      }
      .send {
        width: 34px;
        height: 34px;
        font-size: 15px;
      }
      .composer .composer-footer {
        padding: 4px 6px 8px 8px;
        gap: 6px;
      }
      .attach-btn {
        width: 36px;
        height: 36px;
        font-size: 22px;
      }
      .mode-select {
        height: 36px;
        line-height: 36px;
      }
      /* 手机：模型选择器只显示厂商 logo（隐藏文字与箭头，组件内部媒体查询处理），
         宿主只需放宽宽度预算并保持点击热区。 */
      .composer-footer-right ah-model-picker {
        max-width: 40px;
      }
      .composer-footer-right ah-model-picker::part(trigger) {
        max-width: 40px;
        height: 34px;
        line-height: 34px;
        justify-content: center;
        overflow: hidden;
      }
      .hint {
        font-size: 10.5px;
        margin-top: 6px;
      }
      .empty h1 {
        font-size: 22px;
      }
      .empty p {
        font-size: 13px;
      }
      .think-body {
        font-size: 12px;
        line-height: 1.55;
      }
      .sep {
        font-size: 11px;
        margin: 4px 0 8px;
      }
    }
    /* 中屏（901–1100px）：侧栏收窄但常驻，兼顾 iPad 横屏与窄笔记本。 */
    @media (min-width: 901px) and (max-width: 1100px) {
      .sidebar {
        width: 220px;
        flex-basis: 220px;
      }
    }

    .composer-wrap {
      /* 悬浮输入：去除底部背景块与顶部分隔线，让输入框像卡片一样浮在对话区之上。 */
      border-top: none;
      background: transparent;
      padding: 10px 18px 16px;
    }
    .composer {
      max-width: 820px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 0;
      // border: 1px solid var(--ah-border);
      border-radius: 18px;
      background: var(--ah-surface-2);
      /* 悬浮阴影（聚焦抬升已移除：transform 会劫持内部 fixed 遮罩的包含块） */
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22),
        0 4px 12px rgba(0, 0, 0, 0.12);
      transition: box-shadow 0.2s ease, border-color 0.2s ease;
      min-height: 80px;
    }
    .composer:focus-within {
      border-color: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 45%,
        var(--ah-border)
      );
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.2),
        0 0 0 3px color-mix(in srgb, var(--ah-accent, #2997ff) 14%, transparent);
      /* 注意：不可在此加 transform（哪怕是 translateY(-1px)）——
         祖先一旦有 transform，其内部所有 position:fixed 的后代（模型选择器 /
         上下文用量的全视口透明遮罩）都会改以 composer 为包含块，
         遮罩不再铺满视口，「点击空白处关闭」随之失效。 */
    }
    /* 附件预览条：顶部，横向滚动 */
    .composer .attachments-preview {
      flex-shrink: 0;
      display: flex;
      flex-wrap: nowrap;
      gap: 8px;
      padding: 8px 12px;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--ah-text-muted) 28%, transparent)
        transparent;
      border-bottom: 1px solid var(--ah-border);
    }
    /* 主体区：textarea 填满剩余高度 */
    .composer .composer-body {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      align-items: stretch;
    }
    .composer textarea {
      flex: 1 1 auto;
      resize: none;
      border: none;
      outline: none;
      background: transparent;
      color: var(--ah-text);
      font: inherit;
      font-size: 14px;
      line-height: 1.6;
      max-height: 140px;
      min-height: 75px;
      padding: 10px 12px;
      width: 100%;
      box-sizing: border-box;
    }
    /* 底部按钮行：固定高度，左 attach / 右 圆环+send */
    .composer .composer-footer {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px 8px 12px;
      gap: 8px;
    }
    .composer-footer-left {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    .composer-footer-right {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    /* 深度思考 / 联网搜索 快捷开关图标（激活态 accent 高亮） */
    .tool-toggle {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--ah-text-muted, #9e9e9e);
      width: 32px;
      height: 32px;
      border-radius: 50%;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      transition:
        color 0.15s ease,
        background 0.15s ease;
    }
    .tool-toggle svg {
      width: 18px;
      height: 18px;
      display: block;
    }
    .tool-toggle:hover {
      color: var(--ah-text);
      background: rgba(125, 125, 125, 0.14);
    }
    .tool-toggle.on {
      color: var(--ah-accent, #2997ff);
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 16%,
        transparent
      );
    }
    /* 断连恢复横幅：置于消息区顶部，warn=自动恢复中 / lost=需手动重试。 */
    .conn-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 0 auto 12px;
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 13px;
      max-width: 720px;
      width: 100%;
      box-sizing: border-box;
    }
    .conn-banner.warn {
      background: color-mix(in srgb, var(--ah-warn, #e6a23c) 14%, transparent);
      border: 1px solid var(--ah-warn, #e6a23c);
      color: var(--ah-text);
    }
    .conn-banner.lost {
      background: color-mix(
        in srgb,
        var(--ah-danger, #e5484d) 14%,
        transparent
      );
      border: 1px solid var(--ah-danger, #e5484d);
      color: var(--ah-text);
    }
    .conn-retry {
      flex: 0 0 auto;
      padding: 4px 12px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      font-size: 13px;
      background: var(--ah-accent, #2997ff);
      color: var(--ah-accent-contrast, #fff);
    }
    .send {
      flex: 0 0 auto;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      line-height: 32px;
    }
    .hint {
      max-width: 820px;
      margin: 8px auto 0;
      text-align: center;
      color: var(--ah-text-muted);
      font-size: 11px;
    }
    /* 附件上传区域样式 */
    .attachments-preview {
      /* 行内横向滚动，不占用固定高度 */
      display: flex;
      flex-wrap: nowrap;
      gap: 8px;
      padding: 2px 12px;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--ah-text-muted) 28%, transparent)
        transparent;
    }
    .attach-preview-item {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 4px 30px 4px 6px;
      background: var(--ah-surface-3);
      border: 1px solid var(--ah-border);
      border-radius: 12px;
      font-size: 12px;
      max-width: 170px;
      min-width: 110px;
      cursor: default;
      transition: background 0.18s ease, border-color 0.18s ease,
        box-shadow 0.18s ease, transform 0.18s ease;
      position: relative;
      flex-shrink: 0;
    }
    /* 图片附件：可点击预览 */
    .attach-preview-item.is-image {
      cursor: zoom-in;
    }
    .attach-preview-item.is-image:hover {
      border-color: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 50%,
        var(--ah-border)
      );
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28), 0 1px 3px rgba(0, 0, 0, 0.18);
      transform: translateY(-2px);
    }
    /* 上传失败：去掉单独徽标，整框上红色边框 + 底色提示 */
    .attach-preview-item.error {
      border-color: var(--ah-danger, #e24b4a);
      background: color-mix(
        in srgb,
        var(--ah-danger, #e24b4a) 14%,
        var(--ah-surface-3)
      );
    }
    .attach-err {
      flex-shrink: 0;
      font-size: 11px;
      color: var(--ah-danger, #e24b4a);
      white-space: nowrap;
    }
    .attach-preview-item:hover {
      background: var(--ah-surface-2);
      border-color: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 35%,
        var(--ah-border)
      );
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28), 0 1px 3px rgba(0, 0, 0, 0.18);
      transform: translateY(-2px);
    }
    .attach-thumb {
      width: 18px;
      height: 18px;
      object-fit: cover;
      border-radius: 50%;
      flex-shrink: 0;
      /* transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1),
          box-shadow 0.22s cubic-bezier(0.4, 0, 0.2, 1); */
      display: block;
    }
    .attach-preview-item:hover .attach-thumb {
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
      z-index: 2;
      position: relative;
    }
    .attach-icon {
      font-size: 22px;
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--ah-surface-2);
      border: 1px solid var(--ah-border);
      border-radius: 8px;
      transition: background 0.18s ease, transform 0.18s ease;
    }
    .attach-preview-item:hover .attach-icon {
      background: var(--ah-surface-1);
      transform: scale(1.1);
    }
    .attach-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--ah-text);
      font-size: 12px;
    }
    .attach-rm {
      position: absolute;
      right: 0;
      top: 0;
      transform: translate(6px, -10px);
      border: none;
      background: transparent;
      color: var(--ah-text-muted);
      width: 20px;
      height: 20px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      opacity: 0;
      transition: opacity 0.18s ease, background 0.15s ease, color 0.15s ease;
    }
    .attach-preview-item:hover .attach-rm {
      opacity: 1;
    }
    .attach-rm:hover {
      background: color-mix(
        in srgb,
        var(--ah-danger, #e24b4a) 18%,
        transparent
      );
      color: var(--ah-danger, #e24b4a);
      /* transform: scale(1.15); */
    }
    .attach-status {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: #fff;
    }
    .attach-status.uploading {
      background: var(--ah-accent);
      animation: ah-spin 1s linear infinite;
    }
    .attach-status.done {
      background: var(--ah-success);
    }
    /* 消息气泡中的附件 */
    .attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }
    .attachments.has-images {
      flex-direction: row;
    }
    .attach-img.is-previewable {
      cursor: zoom-in;
    }
    .attach-img img {
      max-width: 200px;
      max-height: 200px;
      border-radius: var(--ah-radius-sm);
      object-fit: cover;
      transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1),
        box-shadow 0.22s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: inherit;
      display: block;
    }
    .attach-img:hover img {
      transform: scale(1.06);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.2);
    }
    .attach-file {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: var(--ah-surface-3);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-sm);
      font-size: 12px;
      color: var(--ah-text);
    }
    .attach-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      cursor: pointer;
      color: var(--ah-text-muted);
      transition: color 0.15s, background 0.15s;
      flex-shrink: 0;
      font-size: 20px;
      line-height: 20px;
    }
    .attach-btn:hover {
      color: var(--ah-accent);
      background: var(--ah-surface-3);
    }
    /* 移动端适配 */
    @media (max-width: 640px) {
      .attach-preview-item {
        max-width: 140px;
        min-width: 90px;
        height: 28px;
        padding: 3px 26px 3px 5px;
      }
      .attach-thumb {
        width: 24px;
        height: 24px;
      }
      .attach-icon {
        font-size: 18px;
        width: 24px;
        height: 24px;
      }
    }
    .caret {
      display: inline-block;
      width: 8px;
      height: 14px;
      margin-left: 2px;
      vertical-align: text-bottom;
      background: var(--ah-text);
      animation: blink 1s steps(2, start) infinite;
    }
    @keyframes blink {
      to {
        visibility: hidden;
      }
    }

    /* 移动端长按弹出的全屏编辑器（与主输入框共享 this.input） */
    .fullscreen-edit {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      background: var(--ah-surface-1, #141414);
      /* 顶栏 + 输入区避开刘海 / 手势条 */
      padding: calc(12px + env(safe-area-inset-top)) 14px
        calc(12px + env(safe-area-inset-bottom));
      box-sizing: border-box;
      animation: ah-slideUp 0.2s ease;
    }
    @keyframes ah-slideUp {
      from {
        opacity: 0;
        transform: translateY(24px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    .fe-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .fe-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--ah-text);
    }
    /* 收起按钮：圆形图标钮 */
    .fe-collapse {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      padding: 0;
      border: none;
      background: var(--ah-surface-3, var(--ah-surface-2, #1c1c1c));
      color: var(--ah-text, #fff);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease, transform 0.15s ease;
    }

    .fe-collapse svg {
      width: 12px;
      height: 12px;
    }
    .fe-collapse:hover {
      background: var(--ah-surface-2, #1c1c1c);
      transform: scale(1.06);
    }
    .fe-collapse:active {
      transform: scale(0.94);
    }
    .fe-input {
      flex: 1 1 auto;
      min-height: 0;
      resize: none;
      border: 1px solid var(--ah-border);
      border-radius: 14px;
      background: var(--ah-surface-2, #1c1c1c);
      color: var(--ah-text);
      font: inherit;
      font-size: 15px;
      line-height: 1.6;
      padding: 14px;
      outline: none;
      box-sizing: border-box;
    }
    .fe-input:focus {
      border-color: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 45%,
        var(--ah-border)
      );
    }

    /* 图片预览 Lightbox */
    .lightbox {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      padding: 40px;
      cursor: zoom-out;
      animation: ah-fadeIn 0.18s ease;
    }
    @keyframes ah-fadeIn {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
    .lightbox img {
      max-width: 90vw;
      max-height: 88vh;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
      object-fit: contain;
      animation: ah-zoomIn 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    @keyframes ah-zoomIn {
      from {
        transform: scale(0.85);
        opacity: 0;
      }
      to {
        transform: scale(1);
        opacity: 1;
      }
    }
    .lightbox-close {
      position: absolute;
      top: 16px;
      right: 20px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
      font-size: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }
    .lightbox-close:hover {
      background: rgba(255, 255, 255, 0.28);
    }
    .lightbox-info {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.6);
      color: #fff;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      white-space: nowrap;
      pointer-events: none;
    }
    button {
      font-family: inherit;
    }
    button.primary {
      background: var(--ah-accent, #2997ff);
      color: #fff;
      border: none;
      border-radius: 9px;
      padding: 8px 14px;
      font-size: 13px;
      cursor: pointer;
    }
    button.ghost {
      background: transparent;
      border: 1px solid var(--ah-border);
      color: var(--ah-text);
      border-radius: 9px;
      padding: 8px 14px;
      font-size: 13px;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `,

  css`
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
    .plan-btn {
      border: none;
      border-radius: 8px;
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
      height: 22px;
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
  `
];
