import { css } from 'lit';

export const composer = css`
  .composer-wrap {
    /* 悬浮输入：去除底部背景块与顶部分隔线，让输入框像卡片一样浮在对话区之上。 */
    border-top: none;
    background: transparent;
    padding: 0 10px 15px;
  }
  .composer {
    max-width: 820px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 0;
    /* 定位上下文：命令联想面板 / 命令胶囊条以 composer 为锚点。
         只加 position:relative —— 不可加 transform，否则内部 position:fixed
         的后代（模型选择器遮罩等）会改以 composer 为包含块而失效。 */
    position: relative;
    // border: 1px solid var(--ah-border);
    border-radius: 18px;
    background: var(--ah-surface-2);
    /* 悬浮阴影（聚焦抬升已移除：transform 会劫持内部 fixed 遮罩的包含块） */
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22), 0 4px 12px rgba(0, 0, 0, 0.12);
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
  /* 附件预览条：顶部，单行；条目溢出由 .attach-strip / .attach-more 接管 */
  .composer .attachments-preview {
    flex-shrink: 0;
    border-bottom: 1px solid var(--ah-border);
  }
  /* 主体区：textarea 填满剩余高度 */
  .composer .composer-body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: stretch;
    position: relative;
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
  /* 对话输入框不参与全局表单聚焦蓝框（base.ts input/textarea:focus）：
     它是无边框悬浮卡片，聚焦态由 .composer:focus-within 的柔和光晕表达。 */
  .composer textarea:focus,
  .composer input:focus,
  .composer select:focus {
    border: none;
    outline: none;
    box-shadow: none;
  }
  /* 注：ah-command-suggestions（联想面板 + 命令胶囊条）的视觉全部在其自身
       static styles（shadow DOM）内，与 ah-agent-picker 视觉对齐；本文件原
       .command-suggestions / .cmd-* 块已失效删除。
       此处只保留锚点契约：.composer 提供 position:relative，
       面板 bottom:calc(100% + 8px) 浮在整个 composer 之上，胶囊条则是
       composer 的第一个 flex 子项（位于输入框上方）。 */

  /* 底部按钮行：左侧「+ 统一入口」/ 右侧 模型+圆环+send */
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
    /* 右侧模型选择器固定占位后，剩余宽度全给「+ 入口 + 结果胶囊」。
         ⚠️ 这里绝不能加 overflow:hidden —— 「+」面板是 absolute 向上浮出
         footer 的，一旦祖先裁剪，面板会被切掉只剩一条边。
         截断交给组件内部的 .chips{overflow:hidden} + 胶囊省略号。 */
    flex: 1 1 auto;
  }
  /* 「+」统一入口：可压缩（0 1 auto）以免把右侧模型选择器挤出 composer；
       面板由组件自身 shadow DOM 绝对定位锚定，宿主不做任何裁剪。 */
  .composer-footer-left ah-composer-plus {
    flex: 0 1 auto;
    min-width: 0;
  }
  .composer-footer-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
  }
  /* 深度思考 / 联网搜索 快捷开关图标（激活态 accent 高亮） */
  .tool-toggle {
    padding: 0;
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
    transition: color 0.15s ease, background 0.15s ease;
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
    background: color-mix(in srgb, var(--ah-accent, #2997ff) 16%, transparent);
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
    background: color-mix(in srgb, var(--ah-danger, #e5484d) 14%, transparent);
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
  /* 外层：条目条 + 「+N」按钮并排。
       按钮作为独立 flex 兄弟节点而非绝对定位浮层 —— 浮层会盖住条目，
       并排则无论条目多少、是否滚动，按钮都恒在右侧且绝不遮挡内容。 */
  .attachments-preview {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 12px;
  }
  .attach-strip {
    display: flex;
    gap: 8px;
    /* 允许收缩到比内容窄，否则 flex 子项不会产生滚动条而会撑破容器 */
    flex: 1 1 auto;
    min-width: 0;
  }
  /* 折叠态：单行 + 横向滚动（窄屏也不会把条目挤变形） */
  .attachments-preview.collapsed .attach-strip {
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--ah-text-muted) 28%, transparent)
      transparent;
  }
  /* 展开态：多行换行 + 容器内纵向滚动（约 4 行后封顶），
       避免一次性铺开把输入框顶出可视区。 */
  .attachments-preview.expanded .attach-strip {
    flex-wrap: wrap;
    row-gap: 8px;
    max-height: 168px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--ah-text-muted) 28%, transparent)
      transparent;
  }
  /* 「+N / 收起」：只在条目溢出时出现，恒在右侧 */
  .attach-more {
    flex: 0 0 auto;
    /* 高度与条目首行对齐（条目高 28px，按钮 26px + 1px 上边距居中） */
    margin-top: 1px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding: 0 10px;
    border-radius: var(--ah-radius-pill, 999px);
    border: 1px solid
      color-mix(in srgb, var(--ah-accent, #2997ff) 42%, var(--ah-border));
    background: color-mix(
      in srgb,
      var(--ah-accent, #2997ff) 16%,
      var(--ah-surface-1)
    );
    color: var(--ah-accent, #2997ff);
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .attach-more:hover {
    background: color-mix(
      in srgb,
      var(--ah-accent, #2997ff) 28%,
      var(--ah-surface-1)
    );
    border-color: color-mix(
      in srgb,
      var(--ah-accent, #2997ff) 62%,
      var(--ah-border)
    );
  }
  .attach-more .am-chev {
    width: 9px;
    height: 6px;
    flex: 0 0 auto;
    transition: transform 0.18s ease;
  }
  /* 展开后箭头翻转指向上方，与「收起」语义一致 */
  .attachments-preview.expanded .attach-more .am-chev {
    transform: rotate(180deg);
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
    height: var(--ah-h-lg);
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
    background: color-mix(in srgb, var(--ah-danger, #e24b4a) 18%, transparent);
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
  /* 多图：独立附件卡片（置于气泡上方）—— 交错堆叠 ↔ 展开网格 */
  .attach-card {
    width: 100%;
    max-width: 320px;
    margin-bottom: 8px;
  }
  /* 折叠态：交错堆叠（错位 + 旋转层叠，围绕中点对称） */
  .attach-card-stack {
    position: relative;
    height: 120px;
    width: 100%;
    cursor: pointer;
  }
  .attach-card-stack .attach-img {
    position: absolute;
    top: 6px;
    left: 50%;
    width: 148px;
    height: 100px;
    margin-left: -74px;
    transform: translate(
        calc((var(--i) - var(--mid)) * 20px),
        calc(var(--i) * 4px)
      )
      rotate(calc((var(--i) - var(--mid)) * 4deg));
    z-index: calc(var(--i) + 1);
    transition: transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .attach-card-stack .attach-img img {
    width: 148px;
    height: 100px;
    object-fit: cover;
    border-radius: var(--ah-radius-sm);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.42);
    display: block;
  }
  .attach-card-stack .attach-img:hover {
    z-index: 99;
    filter: brightness(1.08);
  }
  .attach-card-badge {
    position: absolute;
    right: 6px;
    bottom: 6px;
    font-size: 11px;
    line-height: 1;
    color: #fff;
    background: rgba(0, 0, 0, 0.55);
    border-radius: 6px;
    padding: 3px 7px;
    pointer-events: none;
  }
  /* 展开态：头部（含「收起」）+ 平铺网格 */
  .attach-card-expanded {
    display: none;
  }
  .attach-card.expanded .attach-card-stack {
    display: none;
  }
  .attach-card.expanded .attach-card-expanded {
    display: block;
  }
  .attach-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 12px;
    color: var(--ah-text-dim, #98a2b3);
  }
  .attach-card-collapse {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    font-size: 12px;
    line-height: 1.2;
    color: var(--ah-text);
    background: var(--ah-surface-3);
    border: 1px solid var(--ah-border);
    border-radius: 7px;
    cursor: pointer;
  }
  .attach-card-collapse:hover {
    filter: brightness(1.15);
  }
  .attach-card-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    width: 100%;
  }
  .attach-card-grid .attach-img img {
    max-width: 148px;
    max-height: 148px;
  }
  /* 注：原 .attach-btn（裸「+」label）已由 <ah-composer-plus> 取代，
       上传入口与模式/专家选择一并收口到该组件，此处不再保留其样式。 */
  /* 移动端适配 */
  @media (max-width: 640px) {
    .attach-preview-item {
      max-width: 140px;
      min-width: 90px;
      height: var(--ah-h-lg);
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
    /* 窄屏：按钮收窄，展开态高度压缩到约 3 行 */
    .attach-more {
      height: 24px;
      padding: 0 8px;
      font-size: 11px;
    }
    .attachments-preview.expanded .attach-strip {
      max-height: 132px;
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
    border-color: var(--ah-accent, #2997ff);
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
    padding: 8px 14px;
    font-size: 13px;
    cursor: pointer;
  }
  button.ghost {
    background: transparent;
    border: 1px solid var(--ah-border);
    color: var(--ah-text);
    padding: 8px 14px;
    font-size: 13px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;
