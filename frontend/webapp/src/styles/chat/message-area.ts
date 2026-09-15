import { css } from 'lit';

export const messageArea = css`
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
      margin-right: 5px;
    }
    .ctx-ring {
      display: block;
      width: 20px;
      height: 20px;
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
      stroke: var(--ah-accent-soft, rgba(255, 255, 255, 0.14));
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
    /* 「已压缩」徽标：历史上下文达压缩阈值、最旧对话被自动压缩/淘汰时显示。
       置于圆环右侧，琥珀色提示用户上下文已被主动收敛（非错误态）。 */
    .ctx-compressed {
      display: inline-flex;
      align-items: center;
      margin-left: 6px;
      padding: 1px 7px;
      border-radius: 999px;
      border: 1px solid rgba(255, 159, 10, 0.55);
      background: rgba(255, 159, 10, 0.14);
      color: #ffb340;
      font-size: 10.5px;
      line-height: 1.5;
      font-weight: 600;
      letter-spacing: 0.02em;
      white-space: nowrap;
      user-select: none;
    }
    /* 「已压缩」标识（迁移版）：不再贴在用量圆环旁，而是随对应气泡显示在其下方，
       使标识与所属对话的视觉关联清晰准确。沿用与圆环版一致的琥珀色系。 */
    .msg-compressed {
      display: inline-flex;
      align-items: center;
      margin-top: 8px;
      padding: 1px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255, 159, 10, 0.55);
      background: rgba(255, 159, 10, 0.14);
      color: #ffb340;
      font-size: 11px;
      line-height: 1.6;
      font-weight: 600;
      letter-spacing: 0.02em;
      white-space: nowrap;
      user-select: none;
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
    .ctx-bar-meta {
      margin-bottom: 6px;
      font-size: 12px;
      color: var(--ah-text-muted);
    }
    .ctx-bar-pct {
      font-size: 20px;
      font-weight: 800;
      color: var(--ah-text);
    }
    .ctx-bar-total {
      font-variant-numeric: tabular-nums;
      padding-left: 5px;
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
    /* 本运行累计 token（与单轮窗口占用区分的高亮项） */
    .ctx-cum {
      margin-top: 2px;
      padding-top: 6px;
      border-top: 1px dashed var(--ah-border);
    }
    .c-cum {
      background: var(--ah-accent, #2997ff);
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
    /* ---- 历史会话加载骨架屏（切换会话时内容区占位）----
       与真实消息共用同一套尺寸规格，保证「加载态 → 内容态」不发生位移：
       · 结构对齐：用户消息靠右带头像、助手消息靠左带头像，气泡外壳
         （背景 / 边框 / 圆角 / 内边距）与 .bubble 逐项相同；
       · 高度对齐：每个 .sk-line 是一个完整行盒（14px × 1.65 = 23.1px），
         可见光条由 ::before 居中绘制，故气泡总高 = 24 + 23.1 × 行数，
         与真实气泡逐像素一致；
       · 宽度近似：真实用户气泡宽度由内容决定（≤62%），骨架无法预知，
         取 56% / 短句 38% 作为典型值。
       行宽由模板写入内联 --w（见 chat.ts 的 renderSessionSkeleton）。 */
    .sk-thread {
      padding-top: 2px;
    }
    .sk-msg {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    /* 用户 → 助手 20px；助手 → 用户 30px（与 .msg.user 的 margin-top 一致）。 */
    .sk-msg.assistant {
      margin-top: 20px;
    }
    .sk-msg.user {
      flex-direction: row-reverse;
      margin-top: 30px;
    }
    .sk-msg.user:first-child {
      margin-top: 0;
    }
    .sk-avatar {
      flex: 0 0 30px;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: linear-gradient(
        90deg,
        var(--ah-skeleton-base) 25%,
        var(--ah-skeleton-peak) 37%,
        var(--ah-skeleton-base) 63%
      );
      background-size: 400% 100%;
      animation: ah-shimmer 1.4s ease infinite;
    }
    /* 行盒自带首尾半行留白，因此这里不能设 gap。 */
    .sk-bubble {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    /* 助手：与 .msg.assistant .bubble 同规格，加载完成时外壳不「凭空出现」。 */
    .sk-msg.assistant .sk-bubble {
      flex: 1 1 auto;
      max-width: 745px;
      padding: 12px 14px;
      background: var(--ah-surface-1);
      border: 1px solid var(--ah-border);
      border-radius: 14px;
      border-top-left-radius: 4px;
    }
    /* 用户：与 .msg.user .bubble 同规格（accent 14% 混色底），宽度模拟 1~2 行短消息。 */
    .sk-msg.user .sk-bubble {
      flex: 0 0 auto;
      width: 56%;
      max-width: 520px;
      padding: 12px 14px;
      background: color-mix(in srgb, var(--ah-accent) 14%, var(--ah-surface-2));
      border-radius: 14px;
      border-top-right-radius: 4px;
    }
    .sk-msg.user .sk-bubble.short {
      width: 38%;
      min-width: 180px;
    }
    /* 每行占一个完整行盒，可见光条由 ::before 垂直居中绘制；
       宽度取自模板写入的内联 --w。
       注意：sharedStyles 里的 .sk-line（12px 实体条 + 渐变底，供插件骨架屏使用）
       会同时命中本元素，因此这里必须把 background / border-radius / animation
       显式中和，否则会在行盒上再叠出一条 23.1px 高的色带。 */
    .sk-line {
      position: relative;
      flex: 0 0 auto;
      height: 23.1px;
      border-radius: 0;
      background: none;
      animation: none;
    }
    .sk-line::before {
      content: '';
      position: absolute;
      left: 0;
      top: 6.5px;
      width: var(--w, 100%);
      height: 10px;
      border-radius: 5px;
      background: linear-gradient(
        90deg,
        var(--ah-skeleton-base) 25%,
        var(--ah-skeleton-peak) 37%,
        var(--ah-skeleton-base) 63%
      );
      background-size: 400% 100%;
      animation: ah-shimmer 1.4s ease infinite;
    }
    .sk-msg.user .sk-line::before {
      background: linear-gradient(
        90deg,
        color-mix(in srgb, var(--ah-accent) 22%, var(--ah-surface-2)) 25%,
        color-mix(in srgb, var(--ah-accent) 38%, var(--ah-surface-2)) 37%,
        color-mix(in srgb, var(--ah-accent) 22%, var(--ah-surface-2)) 63%
      );
      background-size: 400% 100%;
    }
    /* 尊重系统「减少动态效果」偏好：关闭微光，保留静态占位。 */
    @media (prefers-reduced-motion: reduce) {
      .sk-avatar,
      .sk-line::before {
        animation: none;
      }
    }
`;
