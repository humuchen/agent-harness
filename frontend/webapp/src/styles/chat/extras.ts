import { css } from 'lit';

export const extras = css`
    /* 折叠式附加信息（调用链路 / 关键信息）：默认收起，点按钮从侧滑抽屉展开。 */
    .extras {
      margin-top: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    /* 入口按钮：与气泡内操作控件同语言，悬停高亮，激活态（对应抽屉正打开）描边。 */
    .extra-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      color: var(--ah-accent, #2997ff);
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 6%,
        var(--ah-surface-2)
      );
      border: 1px solid var(--ah-border);
      border-radius: 999px;
      cursor: pointer;
      line-height: 1;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .extra-btn.alt {
      color: var(--ah-text-muted);
      background: var(--ah-surface-2);
    }
    .extra-btn:hover {
      border-color: var(--ah-accent, #2997ff);
    }
    .extra-btn.active {
      color: var(--ah-accent, #2997ff);
      border-color: var(--ah-accent, #2997ff);
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 14%,
        var(--ah-surface-2)
      );
    }
    .extra-btn .ticon {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      opacity: 0.95;
    }
    .extra-btn .tcount {
      font-weight: 400;
      font-size: 11px;
      color: var(--ah-text-muted);
      background: var(--ah-surface-3, var(--ah-surface-2));
      border-radius: 999px;
      padding: 1px 8px;
    }
    /* 抽屉内的链路树 / 洞察区：复用原有 .trace-body / .insights 排版，仅去掉容器边框/圆角
       （外层已由 ah-drawer 面板提供背景与边距）。 */
    .trace-drawer .trace-body {
      padding: 0;
    }
    .trace-drawer .insights {
      border: none;
      border-radius: 0;
      background: transparent;
      margin: 0;
      padding: 0;
    }

    /* 移动端「会话列表」按钮与抽屉遮罩（默认隐藏，窄屏媒体查询启用）。 */
    .menu-btn {
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
`;
