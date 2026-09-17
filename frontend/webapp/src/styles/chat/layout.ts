import { css } from 'lit';

export const layout = css`
  :host {
    display: flex;
    flex-direction: row;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: var(--ah-canvas);
    /* 拖拽遮罩的定位上下文（遮罩 absolute; inset:0 即铺满整个 chat 组件）。
         ⚠️ 不可加 transform —— 会让内部 position:fixed 的后代改变包含块。 */
    position: relative;
  }
  /* 拖拽事件监听层：铺满 :host，本身不参与布局与视觉；三个拖拽事件绑在它上面，
       因此「拖到 chat 组件任意位置」都能被接住（含侧栏、消息区、输入区）。 */
  .chat-root {
    display: flex;
    flex-direction: row;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    height: 100%;
  }

  /* ===================== 整屏拖拽上传遮罩 ===================== */
  .drop-overlay {
    position: absolute;
    inset: 0;
    z-index: 90;
    display: flex;
    align-items: center;
    justify-content: center;
    /* 半透明压暗底层内容，让中央「松开即可添加文件」卡片成为唯一焦点 */
    background: color-mix(in srgb, var(--ah-canvas) 62%, transparent);
    backdrop-filter: blur(2px);
    /* 关键：遮罩只做视觉，不吃指针事件 ——
         drop 仍由 .chat-root 接住，否则光标停在遮罩上判定不到放置目标。 */
    pointer-events: none;
    animation: drop-fade 0.14s ease-out;
  }
  @keyframes drop-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  /* 中央卡片：虚线边框 + 圆角，对应设计稿的拖拽提示框 */
  .drop-overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: min(460px, calc(100% - 64px));
    padding: 40px 24px;
    box-sizing: border-box;
    border: 1.5px dashed color-mix(in srgb, var(--ah-text) 26%, transparent);
    border-radius: 14px;
    text-align: center;
  }
  /* 已达上传上限：卡片描边转警示色，与「松开即可添加」正向态区分 */
  .drop-overlay.full .drop-overlay-card {
    border-color: color-mix(
      in srgb,
      var(--ah-danger, #ff453a) 55%,
      transparent
    );
  }
  .drop-overlay.full .drop-overlay-icons,
  .drop-overlay.full .drop-overlay-title {
    color: var(--ah-danger, #ff453a);
  }
  .drop-overlay-icons {
    color: var(--ah-text);
    opacity: 0.85;
    margin-bottom: 8px;
  }
  .drop-overlay-icons svg {
    width: 46px;
    height: 46px;
    display: block;
  }
  .drop-overlay-title {
    font-size: 15px;
    font-weight: 500;
    color: var(--ah-text);
  }
  .drop-overlay-hint {
    font-size: 12.5px;
    color: var(--ah-text-muted);
  }
  /* 尊重「减少动效」系统偏好 */
  @media (prefers-reduced-motion: reduce) {
    .drop-overlay {
      animation: none;
    }
  }
  .sidebar {
    width: 264px;
    flex: 0 0 264px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--ah-border);
    background: var(--ah-surface-1);
    min-height: 0;
    transition: width 200ms ease, flex-basis 200ms ease;
  }
  .sidebar.collapsed {
    width: 64px;
    flex: 0 0 64px;
  }
  .sidebar.collapsed .session .title,
  .sidebar.collapsed .new-btn {
    display: none;
  }
  .sidebar.collapsed .session {
    justify-content: center;
    padding: 9px;
  }
  .sidebar.collapsed .session .acts {
    display: none;
  }
  /* 折叠态侧栏只有 64px 宽、仅显示状态点：加载更多 / 末尾提示挤不下，
       整体隐藏（此时 autoFillSessionList 仍在按需续拉，展开后内容已就绪）。 */
  .sidebar.collapsed .session-more,
  .sidebar.collapsed .session-end {
    display: none;
  }
  .side-head {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 14px 10px;
    align-items: center;
  }
  .collapse-btn {
    width: 28px;
    height: var(--ah-h-lg);
    line-height: 28px;
    padding: 0;
    border-radius: 6px;
    border: 1px solid var(--ah-border);
    background: transparent;
    color: var(--ah-text-muted);
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .collapse-btn:hover {
    color: var(--ah-text);
    border-color: var(--ah-accent);
    background: var(--ah-surface-3);
  }
  // .side-head {
  //   padding: 14px 14px 10px;
  // }
  .new-btn {
    width: 100%;
    justify-content: center;
    gap: 8px;
  }
  /* 移动端关闭按钮：桌面侧栏常驻可见（非抽屉），不需要 ✕，隐藏 */
  .close-btn {
    display: none;
  }
  .session-list {
    position: relative;
    flex: 1 1 auto;
    overflow-y: auto;
    /* 阻止原生下拉刷新 / 橡皮筋与自定义手势争抢（移动端触屏） */
    overscroll-behavior: contain;
    padding: 6px 8px 14px;
    min-height: 0;
  }
  /* 下拉刷新内容包裹层：手势中整体下移（橡皮筋），仅 transform、不触发重排 */
  .session-inner {
    will-change: transform;
  }
  /* ---- 会话列表下拉刷新指示器（触屏在列表顶部下拉时滑入）---- */
  .pull-refresh {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--ah-text-muted);
    font-size: 12px;
    transform: translateY(-48px);
    opacity: 0;
    pointer-events: none;
    z-index: 2;
  }
  .pull-refresh .spinner {
    width: 16px;
    height: 16px;
    border-width: 2px;
  }
  /* 已达阈值：提示「松开刷新」并高亮，给出明确的可释放反馈 */
  .pull-refresh.armed .pull-hint {
    color: var(--ah-accent);
  }
  .pull-refresh.refreshing .pull-hint {
    color: var(--ah-text-muted);
  }
  /* 折叠态（图标轨）无会话列表，隐藏下拉刷新指示器 */
  .sidebar.collapsed .pull-refresh {
    display: none;
  }
  /* ---- 会话列表底部：滚动加载状态行 ---- */
  .session-more {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    margin: 4px 0 2px;
    padding: 8px 10px;
    border: 1px dashed var(--ah-border);
    border-radius: 10px;
    background: transparent;
    color: var(--ah-text-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .session-more:hover {
    background: var(--ah-surface-2);
    color: var(--ah-text);
  }
  /* 加载中 / 失败重试：非按钮语义，取消指针与悬停反馈 */
  div.session-more,
  .session-more.retry {
    cursor: default;
  }
  div.session-more:hover {
    background: transparent;
    color: var(--ah-text-muted);
  }
  .session-more .spinner {
    width: 13px;
    height: 13px;
    border-width: 2px;
  }
  /* 失败态用告警色描边，与普通「加载更多」区分 */
  .session-more.retry {
    border-style: solid;
    border-color: var(--ah-warning);
    color: var(--ah-warning);
  }
  .session-end {
    margin: 6px 0 2px;
    text-align: center;
    font-size: 12px;
    color: var(--ah-text-faint);
  }
  .session {
    position: relative;
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
    border-bottom: 1px solid var(--ah-accent, #2997ff);
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
    position: absolute;
    right: 0px;
    background: var(--ah-surface-3);
    border-radius: 10px;
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
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease,
      box-shadow 0.15s ease;
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
    background: color-mix(in srgb, var(--ah-accent, #2997ff) 12%, transparent);
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
`;
