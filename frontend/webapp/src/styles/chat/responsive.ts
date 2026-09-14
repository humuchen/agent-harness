import { css } from 'lit';

export const responsive = css`
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
      /* 固定 top:0 的会话列表抽屉：顶/底 padding 含安全区，避开状态栏与手势条。
           box-sizing 必须显式声明：content-box 下 height:100% 是「内容高」，
           再叠加安全区 padding 会让抽屉总高超出视口 (24px + safe-top + safe-bottom)，
           滚动到底时最后若干条会话被推出屏幕且无法回滚到。
           改为 border-box 后 padding 计入 100%，抽屉正好铺满视口，末条可达。 */
      box-sizing: border-box;
      padding: calc(12px + env(safe-area-inset-top, 0px)) 0
        calc(12px + env(safe-area-inset-bottom, 0px));
    }
    .sidebar.open {
      transform: none;
    }
    /* 移动端忽略 PC 折叠态：始终展示完整侧栏 */
    .sidebar.collapsed {
      width: 264px;
      flex: 0 0 264px;
    }
    .sidebar.collapsed .session .title,
    .sidebar.collapsed .new-btn {
      display: flex;
    }
    .sidebar.collapsed .session {
      justify-content: flex-start;
      padding: 9px 10px;
    }
    .sidebar.collapsed .session .acts {
      display: flex;
    }
    .collapse-btn {
      display: none;
    }
    /* 移动端侧栏抽屉：新对话按钮 + 关闭按钮横排，会话区占满 */
    .sidebar .side-head {
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 12px 14px;
    }
    .sidebar .new-btn {
      width: auto;
      flex: 1;
      padding: 7px 12px;
    }
    .sidebar .close-btn {
      display: inline-flex;
      flex: 0 0 auto;
      width: 30px;
      height: 30px;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--ah-border);
      border-radius: 8px;
      background: var(--ah-surface-2);
      color: var(--ah-text-muted);
      font-size: 13px;
      cursor: pointer;
    }
    .sidebar .close-btn:hover {
      color: var(--ah-text);
      border-color: var(--ah-accent);
    }
    .menu-btn {
      display: inline-flex;
    }
    /* 移动端：顶栏显示「新对话」快捷按钮（桌面隐藏） */
    .new-chat-btn {
      display: inline-flex;
    }
    .scrim.show {
      display: block;
    }
    .chat-head {
      padding: calc(8px + env(safe-area-inset-top, 0px)) 12px 8px;
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
      border: none !important;
    }
    .avatar {
      flex: 0 0 26px;
      width: 26px;
      height: var(--ah-h-md);
      font-size: 12px;
    }
    .msg {
      gap: 9px;
    }
    /* 骨架屏同步收窄断点：头像 26px / 间距 9px / 内边距 10px 12px，
         与上方 .avatar / .bubble / .msg 的 ≤600px 规则逐项对齐。 */
    .sk-msg {
      gap: 9px;
    }
    .sk-avatar {
      flex: 0 0 26px;
      width: 26px;
      height: 26px;
    }
    .sk-msg.assistant .sk-bubble {
      padding: 10px 12px;
    }
    .sk-msg.user .sk-bubble {
      width: 72%;
      max-width: none;
      padding: 10px 12px;
    }
    .sk-msg.user .sk-bubble.short {
      width: 54%;
      min-width: 0;
    }
    /* 轮次间距同步收窄，保持骨架与真实消息一致。 */
    .sk-msg.assistant,
    .msg.assistant {
      margin-top: 14px;
    }
    .sk-msg.user,
    .msg.user {
      margin-top: 22px;
    }
    .chat-head {
      padding: calc(8px + env(safe-area-inset-top, 0px)) 10px 8px;
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
      height: var(--ah-h-lg);
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
    /* 「+」入口 + 结果胶囊：手机端给足点击热区，并限宽避免顶到右侧模型选择器
         （胶囊的省略号截断由组件内部媒体查询处理）。 */
    .composer-footer-left ah-composer-plus {
      max-width: calc(100vw - 170px);
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
`;
