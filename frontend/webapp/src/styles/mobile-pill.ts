import { css } from 'lit';

/**
 * 移动端按钮「胶囊化」覆盖层（≤760px 或触屏设备）
 * ---------------------------------------------------------------
 * 目标：移动端所有按钮统一为胶囊形（--ah-radius-pill），且不带描边。
 *
 * ── 为什么必须用 !important ──
 * 1) Shadow DOM 隔离：外层 <head> 的全局样式表无法穿透到各组件 shadow root，
 *    因此本覆盖层只能作为「组件自身 styles」的一部分下发（见 styles.ts 与
 *    各组件 static styles）。
 * 2) 层叠顺序劣势：绝大多数组件的写法是 `static styles = [sharedStyles, 自有样式]`，
 *    本模块挂在 sharedStyles 末尾，位置上**早于**组件自有规则；同特异性下必输。
 *    （styles/base.ts 的 `button{border-radius:pill}` 之所以在桌面端生效，
 *    仅因为桌面端少有组件覆盖它；移动端各组件普遍自带小圆角+描边，必须强制覆盖。）
 * 3) 特异性劣势：组件多以 `button.ghost`(0,1,1)、`.foot .btn`(0,2,0) 这类
 *    比 `button`(0,0,1) 更高的选择器书写，靠堆特异性做覆盖既脆弱又难维护。
 *
 * ── 为什么用 border-color:transparent 而不是 border:none ──
 * 描边按钮普遍是 `border: 1px solid var(--ah-border)`。改成 `border:none` 会让
 * 盒模型少 2px，按钮尺寸与相邻元素位置发生跳动（移动端会看到明显抖动）。
 * 把颜色置透明可保留占位、视觉上等价于「无边框」，且零重排。
 *
 * ── 去边框后的可辨识度补偿 ──
 * 原先靠描边提供唯一轮廓的「幽灵按钮」在去边框后会退化成一段纯文字，
 * 故为其补浅色填充底（--ah-surface-2 / --ah-surface-3）。填充色刻意**不**做成
 * 通配 `button{background:...}` —— 那样会把 base.ts 默认的 accent 实心按钮
 * 一并染成灰色，属于严重回归。因此只枚举「原本背景为透明/无」的按钮类。
 *
 * ── 例外与刻意保留 ──
 * - `.footer button + button`（model-picker）：该边框是**两个相邻按钮之间的分隔线**，
 *   不是按钮轮廓，故显式保留。
 * - `button.row`（settings-center）不在覆盖范围：它是历史死规则 —— 模板里 `.row` 是 <div>。
 *   同类的 `.session` 亦非 button。二者若被误伤会破坏列表行分隔线。
 * - `composer-plus` **整体退出**本覆盖层（其 static styles 不再引入 mobilePill）：
 *   面板内的 `.mode-card`（问答/计划）与 `.agent-item` 是卡片/列表行而非按钮语义，
 *   胶囊化会吞掉卡片圆角与选中描边（用户实测反馈，2026-09-14 还原）。
 * - `mac-button`（@humuchen/mac-ui）**不在本文件的覆盖范围内**：它要么在库自身 shadow root、
 *   要么被 slot 投影到 document（light DOM），都不在本样式表作用的树中。
 *   其圆角覆盖写在 theme/tokens.ts 的 THEME_CSS（文档级），见该处注释。
 *
 * ── 需要知晓的副作用（已实测确认） ──
 * - `.nav-item` / `.s-item` 确为 <button>，因此也会被胶囊化。二者背景透明，
 *   胶囊形仅在 hover / 选中态可见：`.nav-item.active` 的左侧 3px accent 竖条因
 *   `border-color:transparent` 而不可见（其 padding-left 9px + 3px 边框 = 12px，
 *   与非选中项对齐，故无位移），选中态改由 accent-soft 胶囊底 + accent 字承担。
 * - `button.avatar`（user-menu）原本 radius:50% + 描边，描边同样被置透明。
 *
 * 维护提示：新增按钮若自带「透明底 + 描边」造型，需把其类名补进下方「幽灵按钮补填充底」。
 */

export const mobilePill = css`
  /* 断点写法注意：@media 条件必须是字面量 —— lit 的 css 标签模板出于安全考虑
     只接受 CSSResultGroup / number 插值，把条件抽成字符串常量插值会触发 TS2345。
     条件与项目既有「移动端」约定一致（theme/tokens.ts 触屏样式、base.ts 滚动条隐藏）。 */
  @media (max-width: 760px), (pointer: coarse) {
    /* ═══ 1) 胶囊形 + 去描边 ═══
       直接命中 button 元素即可覆盖所有组件自带的 border-radius：
       因 !important 优先于任意非 important 声明，无需再堆特异性。
       「.seg」（分段控件外壳）与「.pill」（状态标签）非 button 元素，单独列出。 */
    button,
    .seg,
    .pill {
      border-radius: var(--ah-radius-pill, 999px) !important;
      border-color: transparent !important;
    }

    /* ═══ 2) 幽灵按钮补填充底 ═══
       仅收录「原本 background 为 transparent/none 且依赖 1px 描边提供轮廓」的类。
       它们各自的语义变体（.primary/.danger/.active）在下方 §4 还原，
       因 !important 同级比特异性，变体选择器天然更高故可胜出。 */
    .ghost,
    .btn,
    .btn-sso,
    .prov-tab,
    .collapse-btn {
      background: var(--ah-surface-2) !important;
    }
    /* 工作台磁贴：既是按钮也是卡片。原底色写的是 var(--ah-surface, ...)，
       而主题令牌只定义了 --ah-surface-1/2/3（--ah-surface 未定义 → 落到几乎不可见的
       2% 白兜底）。桌面端靠描边撑出卡片轮廓，移动端去掉描边后必须给卡片级底色。 */
    .tile {
      background: var(--ah-surface-1) !important;
    }
    /* 沙箱「销毁」：原为透明底 + danger 描边 */
    button.destroy {
      background: var(--ah-danger-soft) !important;
    }

    /* ═══ 3) 悬停反馈补偿 ═══
       原 hover 多靠「border-color: accent」提示，描边透明后该反馈消失，改以底色加深替代。 */
    .ghost:hover:not(:disabled),
    .btn:hover:not(:disabled),
    .btn-sso:hover:not(:disabled),
    .prov-tab:not(.active):hover,
    .collapse-btn:hover {
      background: var(--ah-surface-3) !important;
    }
    .tile:hover {
      background: var(--ah-surface-2) !important;
    }

    /* ═══ 4) 语义变体还原 ═══
       必须用 !important 显式还原：§2 的填充底是 important，而各组件的变体声明
       （如 .btn.primary{background:accent}）是普通声明 —— important 优先于特异性，
       若不还原，实心主按钮/危险按钮会被一并染成浅灰底。 */
    .primary,
    .btn.primary,
    .plan-btn,
    .edit-btn.primary {
      background: var(--ah-accent) !important;
    }
    .primary:hover:not(:disabled),
    .btn.primary:hover:not(:disabled),
    .edit-btn.primary:hover:not(:disabled) {
      background: var(--ah-accent-strong, var(--ah-accent)) !important;
    }
    .btn.danger,
    button.destroy {
      background: var(--ah-danger-soft) !important;
      color: var(--ah-danger) !important;
    }
    .btn.danger:hover:not(:disabled),
    button.destroy:hover:not(:disabled) {
      background: color-mix(in srgb, var(--ah-danger) 24%, transparent) !important;
    }
    /* 厂商 Tab 选中态：原为 accent 实心，属 important 同级、特异性更高，此处显式声明以便阅读 */
    .prov-tab.active {
      background: var(--ah-accent) !important;
      color: #fff !important;
    }

    /* ═══ 5) 刻意保留的分隔线（非按钮轮廓） ═══
       模型选择器底部「刷新模型 | 关闭」两枚按钮共享一条左边框作分隔；
       去掉后两个按钮会挤成一段连续文字，故还原。 */
    .footer button + button {
      border-left-color: var(--ah-border, #2a2a2a) !important;
    }

    /* ═══ 6) 外部组件库 @humuchen/mac-ui 的按钮 ═══
       不在此处处理：mac-button 实际位于 document（light DOM）或库自身的 shadow root 内，
       均不在本样式表作用的树中，写在这里不会生效。
       其圆角覆盖见 theme/tokens.ts 的 THEME_CSS（文档级、含 !important 说明）。 */
  }
`;
