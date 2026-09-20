import { css } from 'lit';

/**
 * ah-swipe-item 操作区按钮的通用宿主侧样式（可复用）。
 *
 * 背景：actions slot 内容由宿主 light DOM 投影，组件 shadow 内的选择器无法
 * 直接命中投影内容，因此按钮视觉约定交给本模块 —— 任何接入 ah-swipe-item 的
 * 宿主把本模块并入自身样式即可获得一致的操作区按钮外观（仅用 --ah-* 语义令牌）。
 */
export const swipeActStyles = css`
  /* 滑动操作区按钮（ah-swipe-item 的 actions slot 内容约定类名）。
     入场动画：展开时按钮自右向左错落缩放入场（nth-child 错峰 60ms），
     收起时（open 属性移除）延迟归零、快速淡出，与内容回弹节奏匹配。
     入场曲线同内容回弹（略过冲）保持手感一致。 */
  .swipe-act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 56px;
    border: none;
    background: var(--ah-surface-2);
    color: var(--ah-text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    touch-action: manipulation;
    opacity: 0;
    transform: translateX(10px) scale(0.96);
    transition: opacity 0.16s ease,
      transform 0.24s cubic-bezier(0.22, 1.2, 0.36, 1);
  }
  .swipe-act:active {
    filter: brightness(0.88);
  }
  .swipe-act.danger {
    background: var(--ah-danger-soft, var(--ah-surface-2));
    color: var(--ah-danger);
  }
  /* 展开态：按钮入场 + 错峰（第 1 个先出、第 2 个跟上，制造「滑出」层次感）。
     宿主 CSS 能命中投影内容的选择器：按钮留在宿主 shadow 树中，
     ah-swipe-item[open] 是 host 属性反射，可作前缀。 */
  ah-swipe-item[open] .swipe-act {
    opacity: 1;
    transform: none;
  }
  ah-swipe-item[open] .swipe-act:nth-child(1) {
    transition-delay: 0.06s;
  }
  ah-swipe-item[open] .swipe-act:nth-child(2) {
    transition-delay: 0.12s;
  }
  ah-swipe-item[open] .swipe-act:nth-child(3) {
    transition-delay: 0.18s;
  }
  @media (prefers-reduced-motion: reduce) {
    .swipe-act {
      opacity: 1;
      transform: none;
      transition: none;
    }
  }
`;
