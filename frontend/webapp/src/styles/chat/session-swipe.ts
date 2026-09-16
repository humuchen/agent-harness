import { css } from 'lit';

/**
 * 会话列表「滑动露出操作」宿主布局（配合通用组件 ah-swipe-item）。
 *
 * 约定：
 * - 行间距从 .session 移到 ah-swipe-item（操作区 .bg 铺满 host，行内 margin
 *   会把背景区顶出间隙，圆角裁切也失效）；
 * - 触屏（≤900px 且 hover:none）：旧「常驻 .acts」入口隐藏，改用滑动露出的
 *   操作区（组件 @media 内按 hover 判定，纯触屏才显示 .bg）；
 *   带指针的触屏设备（iPad + 鼠标）保留 hover .acts 入口；
 * - 桌面 hover 设备：组件自身隐藏 .bg（见 ah-swipe-item），沿用 .acts hover 浮现。
 */
export const sessionSwipe = css`
  .session-inner ah-swipe-item {
    margin-bottom: 10px;
    /* 与行圆角对齐：host overflow:hidden 裁切操作区时保持 10px 圆角，
       展开态按钮区边缘与行外观一致。 */
    border-radius: 10px;
  }
  .session-inner ah-swipe-item:last-of-type {
    margin-bottom: 0;
  }
  /* 行内 margin 归零（host 承担行间距）；两条规则同特异度且均高于
     .session 基础与 :last-child 规则，保证任何顺序下宿主行距正确。 */
  .session-inner ah-swipe-item .session {
    margin-bottom: 0;
  }
  .session-inner ah-swipe-item .session:last-child {
    margin-bottom: 0;
  }

  /* 纯触屏手机端：滑动操作区取代「常驻 .acts」，避免双入口。
     带指针触屏设备（hover:hover，如 iPad 接鼠标）保留 .acts hover 入口。 */
  @media (max-width: 900px) and (hover: none) {
    .session .acts {
      display: none;
    }
  }
`;
