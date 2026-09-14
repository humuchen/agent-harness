import { css } from 'lit';

// 切片自 styles.ts 原文件第 1444-1694 行，CSS 文本逐字节保留（LF 行尾），仅外层改用 css 组合。
export const responsive = css`
  /* ------------------- 移动端适配（≤760px） ------------------- */
  @media (max-width: 760px) {
    /* 移动端解除 100dvh 锁定 + overflow:hidden：子组件（ah-run 等）内容超高时
       原锁定会把底部裁掉且自身无内部滚动，导致「拉到最低展示不全」。
       改为文档自然滚动，底部始终可达；桌面端布局不受影响。 */
    :host {
      height: auto;
      min-height: 100dvh;
      overflow: visible;
    }
    .shell {
      height: auto;
      overflow: visible;
    }
    .main {
      height: auto;
      overflow: visible;
    }

    /* 侧边栏改为离屏抽屉：默认滑出屏幕，.open 时滑入，覆盖在内容之上 */
    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      height: 100dvh;
      width: 240px;
      max-width: 82vw;
      transform: translateX(-100%);
      transition: transform 200ms ease;
      z-index: 50;
      box-shadow: 2px 0 16px rgba(0, 0, 0, 0.45);
      /* 顶/底 padding 含安全区：固定 top:0 的抽屉会顶进原生状态栏（时钟/电量）与手势条。
         注意 safe-area-inset 仅在 Capacitor/浏览器视口撑满屏（edge-to-edge）时非 0；
         普通浏览器为 0，无副作用。品牌区（Agent Harness + logo）因此不会顶进状态栏。 */
      padding: calc(20px + env(safe-area-inset-top, 0px)) 14px
        calc(16px + env(safe-area-inset-bottom, 0px));
      overflow-y: auto;
    }

    /* 内容滚动时品牌头部固定：.sidebar 是滚动容器，.brand 用 sticky 钉在滚动顶，
       补背景 + 微阴影，滚过时遮住下方滚动的导航项。 */
    .sidebar .brand {
      position: sticky;
      top: 0;
      background: var(--ah-surface-1);
      box-shadow: 0 6px 8px -6px rgba(0, 0, 0, 0.35);
      z-index: 2;
      padding-bottom: 8px;
      margin-bottom: 4px;
    }
    .sidebar.open {
      transform: none;
      padding: 40px 10px 20px 10px;
    }

    /* 移动端抽屉内显示分组标题（桌面隐藏） */
    .sidebar .nav-group-title {
      display: block;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.4px;
      color: var(--ah-text-faint);
      padding: 12px 8px 4px;
      text-transform: uppercase;
    }
    .sidebar .nav-group-title:first-child {
      padding-top: 0;
    }

    /* 移动端忽略桌面折叠态：始终展示完整导航文字而非首字 */
    .sidebar.collapsed {
      width: 240px;
      max-width: 82vw;
    }
    .sidebar.collapsed .brand-text,
    .sidebar.collapsed .nav-text,
    .sidebar.collapsed .theme-text {
      display: inline;
    }
    .sidebar.collapsed .theme-icon {
      display: none;
    }
    .sidebar.collapsed .nav-item::before {
      content: none;
    }
    .sidebar.collapsed .nav-item {
      justify-content: flex-start;
      padding: 9px 12px;
    }
    .sidebar.collapsed .nav-item.active {
      border-left: 3px solid var(--ah-accent);
      border-radius: 0 10px 10px 0;
      padding-left: 9px;
    }
    .sidebar.collapsed .nav-item.active::after {
      content: none;
    }
    .sidebar-toggle {
      display: none;
    }
    .menu-btn {
      display: inline-flex;
    }

    /* 对话页顶栏不显示 ☰（由 ah-chat 自绘顶栏承担），但会话列表入口
       由 chat.ts 的 .menu-btn 承担（见 chat-styles.ts）；外层顶栏此处仅隐藏。 */
    .shell.chat-mode .menu-btn {
      display: none;
    }
    .scrim.show {
      display: block;
    }

    /* 顶栏状态行换行、令牌框与按钮占满宽度 */
    .topbar {
      flex-wrap: wrap;
      gap: 10px;
    }
    .token {
      order: 3;
      width: 100%;
      flex: 1 1 100%;
    }
    .topbar .ghost {
      order: 4;
    }

    /* 内容区改为文档自然滚动（解除固定高度 + 内部滚动），底部留白含安全区 */
    .content {
      padding: 16px 14px calc(64px + env(safe-area-inset-bottom, 0px));
      overflow: visible;
      height: auto;
      flex: none;
      display: block;
    }

    /* 顶栏吸顶，移动端长页面滚动时仍可随时操作 */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 30;
    }

    /* 移动端隐藏品牌脚：底栏固定在底部，品牌信息在「我的」页呈现 */
    ah-brand-foot {
      display: none;
    }

    /* ── 移动端底栏 Tab（方案 A）── 仅 ≤760px 显示 ── */
    .mobile-tabbar {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 45;
      display: flex;
      align-items: center;
      justify-content: space-around;
      gap: 4px;
      height: calc(48px + env(safe-area-inset-bottom, 0px));
      padding: 4px 4px calc(4px + env(safe-area-inset-bottom, 0px));
      border-top: 1px solid var(--ah-border);
      background: var(--ah-surface-1);
      box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.3);
    }
    .m-tab {
      flex: 1 1 0;
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 1px;
      padding: 6px 2px 2px;
      border: none;
      background: none;
      border-radius: 10px;
      font-size: 10px;
      font-family: var(--ah-font-sans);
      color: var(--ah-text-faint);
      cursor: pointer;
      /* 切换过渡：颜色 160ms + 图标轻微回弹（scale），更柔和 */
      transition: color 160ms ease,
        transform 220ms cubic-bezier(0.34, 1.4, 0.64, 1);
    }
    .m-tab .ti {
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: transform 220ms cubic-bezier(0.34, 1.4, 0.64, 1);
    }
    .m-tab .ti svg {
      width: 22px;
      height: 22px;
    }
    .m-tab.on,
    .m-tab:hover {
      color: var(--ah-text);
    }

    /* 选中态：仅颜色高亮（accent），不加任何矩形背景/阴影（去掉“后面的长方形”）。
       用 icon 轻微上浮 + 回弹体现选中，替代生硬底色。 */
    .m-tab.on {
      color: var(--ah-accent);
      font-weight: 600;
    }
    .m-tab.on .ti {
      color: var(--ah-accent);
      transform: translateY(-2px) scale(1.06);
    }
    .m-tab:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: 2px;
    }

    /* ── 我的 Tab 的 me-view / me-skeleton（ah-user-menu standalone 组件
       自带的 shadow 样式，见 user-menu.ts —— 此处只留外部布局壳）── */
    .me-view {
      padding: 4px 12px;
    }
    .me-skeleton {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      padding: 28px 0;
    }
    .me-skeleton .sk {
      width: 100%;
      height: 12px;
      border-radius: 6px;
      background: linear-gradient(
        90deg,
        var(--ah-skeleton-base) 25%,
        var(--ah-skeleton-peak) 37%,
        var(--ah-skeleton-base) 63%
      );
    }

    /* 移动端隐藏所有滚动条（Firefox scrollbar-width:none + WebKit 伪元素 display:none），
       保留可滚动但视觉无条，避免滚动条占宽与原生观感。 */
    * {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    ::-webkit-scrollbar {
      display: none;
      width: 0;
      height: 0;
    }
  }
`;
