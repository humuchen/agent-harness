import { css } from 'lit';

// 切片自 styles.ts 原文件第 12-484 行，CSS 文本逐字节保留（LF 行尾），仅外层改用 css 组合。
export const base = css`
  /* 组件根盒：修复样式模块化拆分时丢失 :host 选择器前缀导致整条规则失效的问题。
     缺 display:block 时自定义元素退回 display:inline；缺令牌则组件不随 [data-theme]
     切换（亮色主题下根背景仍为暗色）且丢失 Inter / 14px 基准排版。
     注意：此处刻意不写 height/overflow —— 移动端已在 responsive.ts 的
     @media (max-width:760px) 内改为文档自然滚动（:host height:auto / overflow:visible），
     .shell 与 .content 各自管理高度与滚动；若在 :host 上锁定 100dvh + overflow:hidden，
     反而会在内容超高时把底部内容裁掉且无法滚动。 */
  :host {
    display: block;
    background: var(--ah-canvas);
    color: var(--ah-text);
    font-family: var(--ah-font-sans);
    font-size: 14px;
    line-height: 1.5;
  }
  /* 滚动条：细轨道、圆角滑块，hover 才高亮，保持界面干净 */
  ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: var(--ah-border);
    border-radius: 4px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: var(--ah-text-muted);
  }
  /* 移动端（含 Capacitor WebView）整体隐藏滚动条：文档根、所有滚动容器、
     伪元素全部吃掉。Firefox/WebKit/IE-Edge 三套语法并写。 */
  @media (max-width: 760px), (pointer: coarse) {
    * {
      scrollbar-width: none !important;
      -ms-overflow-style: none !important;
    }
    ::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
      background: transparent !important;
    }
    *::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px;
    background: var(--ah-surface-1);
    border-bottom: 1px solid var(--ah-border);
    flex: 0 0 auto;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--ah-font-display);
    font-weight: 700;
    font-size: 16px;
    white-space: nowrap;
    justify-content: center;
  }
  .sidebar-toggle {
    margin-left: auto;
    width: 26px;
    height: var(--ah-h-md);
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--ah-radius-sm);
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    font-family: inherit;
  }
  .sidebar-toggle:hover {
    color: var(--ah-text);
    border-color: var(--ah-accent);
  }
  .logo {
    width: 22px;
    height: var(--ah-h-sm);
    flex: 0 0 auto;
    display: block;
    color: var(--ah-text);
  }
  /* 桌面端隐藏侧栏品牌块（logo + 产品名）：品牌不再出现在桌面各页面，统一收敛到
     「我的」页。此处刻意只做「桌面端隐藏」而不删 DOM —— ≤760px 时 .sidebar-toggle
     为 display:none，移动端抽屉顶部标题行完全由品牌块承担，删 DOM 会留下一条空白粘性栏。 */
  @media (min-width: 761px) {
    .sidebar .brand .logo,
    .sidebar .brand .brand-text {
      display: none;
    }
  }
  .state {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    flex: 1;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: var(--ah-radius-pill);
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    font-size: 12px;
    color: var(--ah-text-muted);
    white-space: nowrap;
    font-family: var(--ah-font-mono);
  }
  .pill.ok {
    color: var(--ah-success);
    background: var(--ah-success-soft);
    border-color: transparent;
  }
  .pill.err {
    color: var(--ah-danger);
    background: var(--ah-danger-soft);
    border-color: transparent;
  }
  .token {
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text);
    border-radius: var(--ah-radius-sm);
    padding: 6px 10px;
    width: 220px;
    font-size: 13px;
  }
  .theme-toggle {
    padding: 4px 12px;
    border-radius: var(--ah-radius-pill);
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .theme-toggle:hover {
    color: var(--ah-text);
    border-color: var(--ah-accent);
  }
  .theme-icon {
    display: none;
  }
  .sidebar.collapsed .theme-text {
    display: none;
  }
  .sidebar.collapsed .theme-icon {
    display: inline;
    font-size: 14px;
  }
  .sidebar.collapsed .theme-toggle {
    padding: 6px;
    border-radius: var(--ah-radius-md);
  }
  /* 应用骨架：左侧 240 导航 + 右侧主区（顶栏 + 内容），对齐设计稿。
     整个 shell 占满视口；内容区按内容自然高度，超出可视区时内部滚动，避免 body 全局滚动条。
     background/color 用 --ah-canvas 等语义令牌，随 [data-theme] 切换，
     确保移动端 WebView（不渲染 html/body 背景）下内容区也能正确亮/暗。 */
  .shell {
    display: flex;
    height: 100%;
    min-height: 100dvh;
    background: var(--ah-canvas);
    color: var(--ah-text);
    overflow: hidden;
  }
  .sidebar {
    flex: 0 0 240px;
    width: 240px;
    background: var(--ah-surface-1);
    border-right: 1px solid var(--ah-border);
    padding: 20px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    // height: 100%;
    box-sizing: border-box;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--ah-border) transparent;
    transition: width 180ms ease, padding 180ms ease;
  }
  .sidebar.collapsed {
    flex: 0 0 64px;
    width: 64px;
    padding: 20px 10px;
  }
  .sidebar.collapsed .brand-text {
    display: none;
  }
  .sidebar.collapsed .sidebar-toggle {
    margin-left: 0;
  }
  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* 分组标题：桌面侧边栏隐藏（.nav-group-title display:none），移动端抽屉内可见 */
  .nav-group-title {
    display: none;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 10px;
    color: var(--ah-text-muted);
    padding: 9px 12px;
    cursor: pointer;
    font-size: 14px;
    font-family: inherit;
    position: relative;
  }
  .nav-item:hover {
    background: var(--ah-surface-2);
    color: var(--ah-text);
  }
  .nav-item.active {
    background: var(--ah-accent-soft);
    color: var(--ah-accent);
    font-weight: 600;
    border-left: 3px solid var(--ah-accent);
    border-radius: 0 10px 10px 0;
    padding-left: 9px;
  }
  .sidebar.collapsed .nav-text {
    display: none;
  }
  .sidebar.collapsed .nav-item {
    justify-content: center;
    padding: 9px 4px;
    border-left: none;
    border-radius: 10px;
  }
  .sidebar.collapsed .nav-item.active {
    border-left: none;
    border-radius: 10px;
    padding-left: 4px;
  }
  .sidebar.collapsed .nav-item.active::after {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 18px;
    border-radius: 0 2px 2px 0;
    background: var(--ah-accent);
  }
  .sidebar.collapsed .nav-item::before {
    content: attr(data-short);
    font-size: 14px;
    font-weight: 500;
  }
  .nav-spacer {
    flex: 1;
  }
  .sidebar-foot {
    border-top: 1px solid var(--ah-border);
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .topbar {
    /* 移动端安全区：顶部状态栏（刘海）占用空间 */
    padding-top: max(12px, env(safe-area-inset-top));
  }
  .content {
    flex: 1 1 0%;
    min-height: 0;
    overflow: hidden;
    padding: 24px 32px;
    /* 移动端安全区：底部导航条（手势条）占用空间 */
    padding-bottom: calc(24px + env(safe-area-inset-bottom));
    width: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  /* 对话页全幅铺满：去掉外边距与外层滚动，由 ah-chat 内部自管滚动。 */
  .content.chat {
    flex: 1 1 auto;
    height: 100%;
    padding: 0;
    overflow: hidden;
    display: block;
  }
  /* 各页面根元素填充剩余空间，内容超高时内部滚动 */
  section,
  .mcp-layout,
  .plugin-view,
  .wrap {
    flex: 1 1 0%;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  section {
    background: var(--ah-surface-1);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-lg);
    padding: 24px 24px;
    box-shadow: var(--ah-shadow);
  }

  .card {
    background: var(--ah-surface-1);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-md);
    padding: 16px 18px;
    max-height: 800px;
    overflow-y: auto;
  }

  h2 {
    margin: 0 0 12px;
    font-family: var(--ah-font-display);
    font-size: 18px;
  }
  h3 {
    margin: 16px 0 8px;
    font-size: 14px;
    color: var(--ah-text-muted);
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

    &:first-child {
      margin-top: 10px;
    }
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--ah-text-muted);
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
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text);
    border-radius: var(--ah-radius-sm);
    padding: 7px 10px;
    font-size: 13px;
    font-family: inherit;
  }
  textarea {
    resize: vertical;
  }
  button {
    background: var(--ah-accent);
    color: #fff;
    border: none;
    border-radius: var(--ah-radius-pill);
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.ghost {
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
    border-radius: var(--ah-radius-pill);
    font-weight: 500;
  }
  button.ghost:hover {
    color: var(--ah-text);
    border-color: var(--ah-accent);
  }
  button.danger {
    background: var(--ah-danger-soft);
    color: var(--ah-danger);
    border-radius: var(--ah-radius-sm);
  }
  .muted {
    color: var(--ah-text-muted);
  }
  .error {
    // background: var(--ah-danger-soft);
    // border: 1px solid var(--ah-danger);
    color: var(--ah-danger);
    border-radius: var(--ah-radius-sm);
    padding: 8px 12px;
    margin: 10px 0;
    font-size: 13px;
  }
  .warn {
    // background: var(--ah-warning-soft);
    // border: 1px solid var(--ah-warning);
    color: var(--ah-warning) !important;
    border-radius: var(--ah-radius-sm);
    // padding: 8px 12px;
    // margin: 10px 0;
    font-size: 13px;
  }
  .stream {
    margin-top: 12px;
    background: var(--ah-canvas);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-md);
    padding: 10px;
    max-height: 340px;
    overflow: auto;
    font-family: var(--ah-font-mono);
    font-size: 12px;
  }
  .ev {
    display: flex;
    gap: 8px;
    padding: 2px 0;
    border-bottom: 1px solid var(--ah-border);
  }
  .ev-type {
    color: var(--ah-accent);
    flex: 0 0 150px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ev-body {
    color: var(--ah-text-muted);
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
