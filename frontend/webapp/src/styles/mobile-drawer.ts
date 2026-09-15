import { css } from 'lit';

// 切片自 styles.ts 原文件第 933-970 行，CSS 文本逐字节保留（LF 行尾），仅外层改用 css 组合。
export const mobileDrawer = css`
  /* 移动端抽屉相关：桌面端默认隐藏，窄屏下由媒体查询启用 */
  .menu-btn {
    display: none;
    width: 34px;
    height: 34px;
    padding: 0;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    line-height: 1;
    border-radius: var(--ah-radius-sm);
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text);
    cursor: pointer;
  }
  .menu-btn:hover {
    border-color: var(--ah-accent);
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
  }

  /* 移动端底栏：桌面默认隐藏，≤760px 启用见 @media 块 */
  .mobile-tabbar {
    display: none;
  }

`;
