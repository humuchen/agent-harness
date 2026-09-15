import { css } from 'lit';

/**
 * 对话气泡内 Markdown 富文本元素的呈现规范（作用域严格限定在 .msg-text）。
 *
 * 从 message-bubble.ts 拆出：该文件已 480+ 行，表格与代码的适配是独立关注点。
 *
 * 约定：
 * - 全部使用 --ah-* 语义令牌，不写死色值（写死会导致亮色主题下不跟随切换）。
 * - 只新增选择器、不改动既有规则，因此追加到 chatStyles 末尾不会改变既有层叠结果。
 * - 代码 token 的**颜色**不在这里定义 —— 它在 styles/base.ts 的共享层，
 *   因为运行详情（.codeblock.rich）也要用同一套配色；此处只负责容器、布局与交互态。
 */
export const markdownRichText = css`
  /* ==================== 表格 ====================
     滚动与圆角由外层 wrapper 承担，table 保持 display:table。
     禁止改回 display:block —— 那会让列宽退化为「由内容决定」、表头与数据列错位，
     并丢失屏幕阅读器依赖的表格角色（旧实现即为此写法，是表格显示异常的直接根因）。 */
  .msg-text .md-table-wrap {
    margin: 12px 0;
    overflow-x: auto;
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-sm);
    /* 横向滚动提示：纯 CSS「滚动阴影」，无需 JS、不占布局空间。
       为什么不用滚动条：本产品在 ≤760px 用「*{scrollbar-width:none !important}」+
       「::-webkit-scrollbar{display:none !important}」全局隐藏滚动条（styles/base.ts，
       刻意如此以贴近原生观感），同权重 !important 覆盖不安全；且移动端覆盖式
       滚动条本就不常驻，即使放开也未必可见（实测 scrollbar-width 计算值为 none）。
       机制：cover 用 local 附着（随内容滚动），滚到该侧尽头时正好盖住对应阴影；
       shadow 用 scroll 附着（钉在元素上），只在「该方向还有内容」时露出。
       内容装得下时两侧 cover 与元素边缘重合，阴影被盖住、不会误报可滑。 */
    background-color: var(--ah-surface-1);
    background-image:
      linear-gradient(to right, var(--ah-surface-1) 30%, transparent),
      linear-gradient(to left, var(--ah-surface-1) 30%, transparent),
      radial-gradient(farthest-side at 0% 50%, var(--ah-scroll-shadow), transparent),
      radial-gradient(farthest-side at 100% 50%, var(--ah-scroll-shadow), transparent);
    background-position: left center, right center, left center, right center;
    background-repeat: no-repeat;
    background-size: 44px 100%, 44px 100%, 26px 100%, 26px 100%;
    background-attachment: local, local, scroll, scroll;
  }
  .msg-text .md-table-wrap > table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 13.5px;
  }
  /* 仅保留横向分隔线：暗色主题下纵向网格线过密会显著增加视觉噪声。 */
  .msg-text .md-table-wrap th,
  .msg-text .md-table-wrap td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--ah-border);
    text-align: left;
    vertical-align: top;
    /* 每列最低宽度。必需：中文可在任意字符间断行，仅靠 width:100% 会让多列表格
       被压成「每列一两个字」的竖排（实测 8 列表格在 484px 宽下即如此）。
       设了下限后，列不够放时表格自然超出容器 → 交由 wrapper 横向滚动。 */
    min-width: 84px;
    /* 单元格内的长 URL / 长标识符在列内折行，避免撑宽表格。 */
    overflow-wrap: anywhere;
  }
  .msg-text .md-table-wrap thead th {
    background: var(--ah-surface-2);
    font-size: 12.5px;
    font-weight: 600;
    white-space: nowrap;
  }
  .msg-text .md-table-wrap tbody tr:last-child td {
    border-bottom: none;
  }
  /* 用行高亮替代斑马纹：斑马纹在暗色下容易显脏，且与 hover 叠加会产生三色混乱。 */
  .msg-text .md-table-wrap tbody tr:hover td {
    background: var(--ah-surface-2);
  }
  /* GFM 对齐语法（:---:）由 marked 输出 align 属性，此处接住。 */
  .msg-text .md-table-wrap th[align='center'],
  .msg-text .md-table-wrap td[align='center'] {
    text-align: center;
  }
  .msg-text .md-table-wrap th[align='right'],
  .msg-text .md-table-wrap td[align='right'] {
    text-align: right;
  }
  /* 空单元格占位：避免列宽塌陷，同时明确「此格无数据」而非渲染失败。 */
  .msg-text .md-table-wrap td:empty::after {
    content: '—';
    color: var(--ah-text-faint);
  }
  /* 注：此处刻意不做 thead 的 position:sticky。wrapper 因 overflow-x:auto 已成为滚动容器
     （overflow-y 随之计算为 auto），sticky top 失去参照、视觉上不会生效。
     让长表格表头钉住需把滚动交给消息容器，与「宽表不撑破气泡」互斥，本批取后者。 */

  /* ==================== 表格折叠 ====================
     结构：.md-table-box（定位参照，不滚动）> .md-table-wrap（横滑+裁切）+ .md-fold-bar。
     为什么折叠裁切放在 wrap 上而不是 box 上：wrap 已是横向滚动容器，
     在其上追加 overflow-y:hidden 与 max-height 是合法组合（hidden 不会被提升为 auto，
     只有 visible 会被），因此横滑与纵向裁切可以由同一元素承担。
     box 只提供 position:relative，供底部渐隐遮罩定位。 */
  .msg-text .md-table-box {
    position: relative;
    margin: 12px 0;
  }
  /* 折叠栏出现时，间距归 box 统一管理，避免 wrap 与 bar 之间出现双倍外边距。 */
  .msg-text .md-table-box > .md-table-wrap {
    margin: 0;
  }
  .msg-text .md-table-box.is-folded > .md-table-wrap {
    max-height: 300px;
    overflow-y: hidden;
  }
  /* 底部渐隐：让「内容被截断」一眼可见，否则裁切边缘看起来像表格本来就结束了。
     高度须避开折叠栏（约 32px），遮罩只负责表格主体。 */
  .msg-text .md-table-box.is-folded::after {
    content: '';
    position: absolute;
    left: 1px;
    right: 1px;
    bottom: 32px;
    height: 48px;
    pointer-events: none;
    background: linear-gradient(to bottom, transparent, var(--ah-surface-1) 82%);
  }
  .msg-text .md-fold-bar {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }

  /* ==================== 代码块 ====================
     结构：.md-code > .md-code-head（语言/行数/复制/折叠）+ .md-code-body（横滑+裁切）> pre > code。
     注意「两种代码块」并存：
     - 已增强的（对话页助手答案，带 .md-code 容器）→ 由下方规则接管；
     - 未增强的（用户消息、运行详情等未接事件委托的容器）→ 仍走下面的裸 pre 规则。
       两条链路的规则必须同时成立，删掉任意一条都会让对应容器退化。 */
  .msg-text .md-code {
    position: relative;
    margin: 12px 0;
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-sm);
    background: var(--ah-code-bg);
    overflow: hidden;
  }
  .msg-text .md-code-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px 5px 12px;
    border-bottom: 1px solid var(--ah-border);
    background: var(--ah-surface-2);
  }
  .msg-text .md-lang {
    font-family: var(--ah-font-mono);
    font-size: 11px;
    color: var(--ah-text-muted);
  }
  .msg-text .md-lines {
    font-size: 11px;
    color: var(--ah-text-faint);
  }
  /* 复制按钮靠右（语言与行数留在左侧），后续按钮顺次排开。 */
  .msg-text .md-code-head .md-copy {
    margin-left: auto;
  }
  /* 工具条按钮。刻意不用全局的胶囊圆角约定（--sm-button-radius）：
     那是为「操作按钮」定的形态，工具条小按钮胶囊化会明显失衡。 */
  .msg-text .md-btn {
    appearance: none;
    display: inline-flex;
    align-items: center;
    border: 1px solid transparent;
    background: transparent;
    color: var(--ah-text-muted);
    font-family: var(--ah-font-sans);
    font-size: 12px;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .msg-text .md-btn:hover {
    background: var(--ah-surface-3);
    color: var(--ah-text);
  }
  .msg-text .md-btn:focus-visible {
    outline: 2px solid var(--ah-accent);
    outline-offset: 1px;
  }
  .msg-text .md-copy.is-copied {
    color: var(--ah-success);
  }
  /* 折叠按钮的箭头用 ::before 而非写入 textContent：
     文案由 applyFolds 按真实状态同步，箭头只反映状态、不参与文案，避免两处竞争。 */
  .msg-text .md-fold::before {
    content: '▾';
    margin-right: 4px;
    font-size: 10px;
    line-height: 1;
  }
  .msg-text .md-code.is-folded .md-fold::before,
  .msg-text .md-table-box.is-folded .md-fold::before {
    content: '▸';
  }
  .msg-text .md-code-body {
    overflow-x: auto;
    scrollbar-width: thin;
  }
  /* 容器内 pre：滚动职责已上移到 body，故这里必须解除自身滚动与外边距。
     width:max-content + min-width:100% 让短代码撑满、长代码不被压缩；
     box-sizing:border-box 保证 padding 计入宽度（否则 min-width:100% 会溢出 24px）。 */
  .msg-text .md-code-body > pre {
    margin: 0;
    width: max-content;
    min-width: 100%;
    box-sizing: border-box;
    overflow: visible;
  }
  .msg-text .md-code.is-folded .md-code-body {
    max-height: 320px;
    overflow-y: hidden;
  }
  /* 渐隐压在代码内容上方。用 --ah-code-bg 收尾（不透明），而不是 rgba 透明 ——
     透明收尾会让被遮住的内容以半透明形式透出，读起来像渲染故障。 */
  .msg-text .md-code.is-folded::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 56px;
    pointer-events: none;
    background: linear-gradient(to bottom, transparent, var(--ah-code-bg) 80%);
  }

  /* ==================== 未增强的裸代码块 ==================== */
  /* 行内 code：保留折行（长标识符/路径需在气泡内换行），加底色胶囊与正文区分。 */
  .msg-text code {
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--ah-surface-3);
    font-family: var(--ah-font-mono);
    font-size: 0.9em;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* 块级 code：必须不折行 —— pre-wrap 会破坏缩进层级与代码语义，
     超出部分交由块自身横向滚动。word-break / overflow-wrap 需显式归位，
     否则会继承 .msg-text 的 anywhere / break-word 继续切断长行。
     选择器带 pre >，特异性高于上面的行内规则，不依赖书写顺序。 */
  .msg-text pre {
    margin: 10px 0;
    max-width: 100%;
    padding: 10px 12px;
    overflow-x: auto;
    scrollbar-width: thin;
    white-space: pre;
    word-break: normal;
    overflow-wrap: normal;
  }
  .msg-text pre > code {
    padding: 0;
    border-radius: 0;
    background: none;
    font-size: 12.5px;
    line-height: 1.6;
    white-space: inherit;
    word-break: normal;
  }

  /* ==================== 窄屏（≤600px） ====================
     断点与 styles/chat/responsive.ts 的聊天端收紧一致。
     此时气泡可用宽度约 300px，表格几乎必然横滑，冻结首列（通常是「现象 / 参数名」）
     以免横滑后丢失行语义；首列须自带不透明底色，否则后列内容会从下面透出。
     此处 sticky left 有效 —— .md-table-wrap 本身就是横向滚动容器，left 有明确参照
     （与 thead 的 sticky top 失效原因不同，见上方表格段注释）。
     刻意就近写在本文件而非 responsive.ts：本模块位于 chatStyles 数组末尾，
     同特异性规则会反过来压过 responsive.ts 中的同名规则，跨文件维护易踩坑。 */
  @media (max-width: 600px) {
    .msg-text .md-table-wrap th,
    .msg-text .md-table-wrap td {
      padding: 7px 10px;
      font-size: 13px;
    }
    .msg-text .md-table-wrap th:first-child,
    .msg-text .md-table-wrap td:first-child {
      position: sticky;
      left: 0;
      background: var(--ah-surface-1);
    }
    .msg-text .md-table-wrap thead th:first-child {
      background: var(--ah-surface-2);
    }
    .msg-text .md-table-wrap tbody tr:hover td:first-child {
      background: var(--ah-surface-2);
    }
    /* 表格在窄屏保留横向滚动（折行会破坏行列对应关系，压窄又会退化成竖排），
       「右侧还有内容」的提示由 .md-table-wrap 的滚动阴影承担（见上方表格段），
       此处不重复处理滚动条 —— 全局 !important 隐藏规则不可覆盖。 */
    /* 窄屏屏幕高度更紧张，折叠上限收紧，让一个代码块不至于占满整屏。 */
    .msg-text .md-code.is-folded .md-code-body {
      max-height: 260px;
    }
    .msg-text .md-table-box.is-folded > .md-table-wrap {
      max-height: 240px;
    }
    .msg-text .md-code-head {
      padding: 4px 6px 4px 10px;
      gap: 6px;
    }

    /* ==================== 窄屏代码块：取消横滑，改为自动折行 ====================
       问题（实测反馈）：手机上没有滚动条提示、惯性滑动易误触，被藏到右侧的长行
       实际处于「既看不见也不知道它存在」的状态 —— 用户会把被截断的代码块当成内容已结束。
       手机屏幕只有 300px 左右可用宽度，靠横滑逐行对照代码的成本远高于折行。

       折行的前提是本产品**不做行号**：行号与折行后的视觉行不再一一对应。
       若将来增加行号，此处必须改回横滑、或改为逐行包裹后再折行。

       必须同时解开三处，缺任意一处都仍会横滑或被内容撑宽：
       ① .md-code-body 的 overflow-x —— 它才是滚动容器（增强态）；
       ② 其 pre 的 width:max-content —— 撑宽的直接原因；
       ③ pre 自身的 white-space:pre 与上一段显式归位过的 overflow-wrap。
       裸代码块（用户消息等未增强容器）只受 ③ 影响，同样一并生效，保持两条链路一致。 */
    .msg-text .md-code-body {
      overflow: hidden;
    }
    .msg-text .md-code-body > pre {
      width: auto;
    }
    .msg-text pre {
      white-space: pre-wrap;
      /* anywhere 而非 break-word：前者参与 min-content 宽度计算，
         长标识符/长 URL 才能真正在列内断开，而不是先把容器顶宽再溢出。 */
      overflow-wrap: anywhere;
      word-break: break-word;
    }
  }
`;
