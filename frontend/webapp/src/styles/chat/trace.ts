import { css } from 'lit';

export const trace = css`
    /* ----------------------- 调用链路 (trace) ----------------------- */
    .trace {
      margin-bottom: 10px;
      border: 1px solid var(--ah-border);
      border-left: 3px solid var(--ah-accent, #2997ff);
      border-radius: 10px;
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 5%,
        var(--ah-surface-2)
      );
      overflow: hidden;
    }
    .trace > summary {
      cursor: pointer;
      padding: 9px 12px;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--ah-accent, #2997ff);
      list-style: none;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .trace > summary::-webkit-details-marker {
      display: none;
    }
    .trace .ticon {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      opacity: 0.95;
    }
    .trace .tcount {
      font-weight: 400;
      font-size: 11px;
      color: var(--ah-text-muted);
      background: var(--ah-surface-3, var(--ah-surface-2));
      border-radius: 999px;
      padding: 1px 8px;
    }
    .trace-body {
      padding: 2px 12px 10px 14px;
    }
    /* 树状节点：左侧连接线 + 圆点 */
    .tnode {
      border-left: 1px dashed var(--ah-border);
      margin-left: 6px;
      padding-left: 12px;
    }
    .tnode:last-child {
      border-left-color: transparent;
    }
    .tnode > summary.tnode-head {
      cursor: pointer;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 0;
      font-size: 12px;
    }
    .tnode > summary.tnode-head::-webkit-details-marker {
      display: none;
    }
    .tdot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: var(--ah-text-muted);
    }
    .tlabel {
      color: var(--ah-text);
      font-weight: 500;
    }
    .tbadge {
      font-size: 10px;
      padding: 0 6px;
      border-radius: 999px;
      line-height: 16px;
      flex: 0 0 auto;
    }
    .tbadge.err {
      background: color-mix(
        in srgb,
        var(--ah-danger, #e24b4a) 16%,
        transparent
      );
      color: var(--ah-danger, #e24b4a);
    }
    .tbadge.pend {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 16%,
        transparent
      );
      color: var(--ah-accent, #2997ff);
    }
    .tchips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-left: 2px;
    }
    .tchip {
      font-size: 10px;
      color: var(--ah-text-muted);
      background: var(--ah-surface-3, var(--ah-surface-2));
      border: 1px solid var(--ah-border);
      border-radius: 6px;
      padding: 0 6px;
      line-height: 16px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .tchip b {
      color: var(--ah-text);
      font-weight: 600;
      margin-right: 3px;
    }
    /* LLM 节点的「消息 N」chip：可点击展开消息上下文面板。 */
    .tchip-btn {
      cursor: pointer;
      user-select: none;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
    }
    .tchip-btn:hover {
      border-color: var(--ah-accent, #2997ff);
      color: var(--ah-accent, #2997ff);
    }
    .tchip-btn.active {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 18%,
        var(--ah-surface-3, #262a31)
      );
      border-color: var(--ah-accent, #2997ff);
      color: var(--ah-accent, #2997ff);
    }
    .tmsg-list {
      display: block;
      margin: 4px 0 6px 15px;
      border: 1px solid var(--ah-border);
      border-radius: 8px;
      background: var(--ah-surface-2, #1f2228);
      overflow: hidden;
    }
    .tmsg-list[hidden] {
      display: none !important;
    }
    /* LLM 调用节点：点击「LLM 调用」标题统一展开 / 收起消息与工具调用（受控容器，非原生 details）。 */
    .tnode.kind-llm {
      border-left: 1px dashed var(--ah-border);
      margin-left: 6px;
      padding-left: 12px;
    }
    .tnode.kind-llm > .tnode-head.tnode-head-btn {
      cursor: pointer;
      list-style: none;
    }
    .tnode.kind-llm > .tnode-head.tnode-head-btn::-webkit-details-marker {
      display: none;
    }
    .tnode.kind-llm > .tnode-head.tnode-head-btn:hover .tlabel {
      color: var(--ah-accent, #2997ff);
    }
    .tnode.kind-llm > .tnode-head.tnode-head-btn:focus-visible {
      outline: 1px solid var(--ah-accent, #2997ff);
      outline-offset: 2px;
      border-radius: 4px;
    }
    .tllm-body {
      /* 显隐由 ?hidden 属性控制（display:none !important 已全局生效），此处仅做过渡留白 */
      margin-top: 2px;
    }
    .tmsg-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px;
      font-size: 11px;
      color: var(--ah-text-muted);
      background: var(--ah-surface-3, #262a31);
      border-bottom: 1px solid var(--ah-border);
    }
    .tmsg-head-title {
      flex: 1;
      min-width: 0;
    }
    /* 抽屉级「折叠全部」工具栏：一次性收起整条调用链路中所有可折叠项。
       滚动时 sticky 吸顶，方便随时折叠。 */
    .trace-toolbar {
      position: sticky;
      top: -16px;
      z-index: 5;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-bottom: 8px;
      background: var(--ah-surface-1);
    }
    /* 在 ah-drawer 内：工具栏吸到抽屉 body 顶部，并抵消 body 的 16px padding，
       使按钮与标题栏之间无留白，内容滚动时始终可见。 */
    .trace-drawer .trace-toolbar {
      margin: -16px -16px 8px;
      padding: 12px 16px 4px;
    }
    .trace-collapse-all {
      flex: none;
      cursor: pointer;
      user-select: none;
      padding: 3px 12px;
      font-size: 11px;
      line-height: 1.5;
      color: var(--ah-text-muted);
      background: var(--ah-surface-2, #1f2228);
      border: 1px solid var(--ah-border);
      border-radius: 999px;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
    }
    .trace-collapse-all:hover {
      color: var(--ah-accent, #2997ff);
      border-color: var(--ah-accent, #2997ff);
    }
    .trace-collapse-all:active {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 14%,
        var(--ah-surface-2, #1f2228)
      );
    }
    .tmsg-item {
      border-bottom: 1px solid var(--ah-border);
    }
    .tmsg-item:last-child {
      border-bottom: none;
    }
    /* 单条消息折叠摘要行：点击展开完整内容（默认折叠）。 */
    .tmsg-sum {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      cursor: pointer;
      list-style: none;
    }
    .tmsg-sum::-webkit-details-marker {
      display: none;
    }
    .tmsg-sum:hover {
      background: var(--ah-surface-3, #262a31);
    }
    .tmsg-preview {
      flex: 1;
      min-width: 0;
      font-size: 11px;
      color: var(--ah-text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tmsg-caret {
      width: 0;
      height: 0;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 5px solid var(--ah-text-muted);
      transition: transform 120ms ease;
    }
    .tmsg-item[open] > .tmsg-sum > .tmsg-caret {
      transform: rotate(-180deg);
    }
    /* 工具/检索/自检等可折叠节点的折叠指示箭头：
       与 tmsg-caret 同款语义，但挂在 summary 末尾并随 details[open] 旋转。
       默认折叠态下显示 ▸，点开展开后旋转为 ▾，与「折叠全部」操作语言一致。 */
    .tnode > summary.tnode-head > .tcaret {
      width: 0;
      height: 0;
      margin-left: 6px;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 5px solid var(--ah-text-muted);
      transition: transform 120ms ease;
      flex: none;
      opacity: 0.7;
    }
    .tnode[open] > summary.tnode-head > .tcaret {
      transform: rotate(-180deg);
      opacity: 0.9;
    }
    .tnode > summary.tnode-head:hover > .tcaret {
      opacity: 1;
    }
    /* LLM 节点用受控容器而非原生 details，避免与 .tnode[open] 选择器撞车；
       它使用 ::after 三角箭头（在原 .kind-llm 样式中已定义），不在此处重复。 */
    .tmsg-role {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 5px;
      flex: 0 0 auto;
    }
    .tmsg-item.role-user .tmsg-role {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 20%,
        transparent
      );
      color: var(--ah-accent, #2997ff);
    }
    .tmsg-item.role-assistant .tmsg-role {
      background: color-mix(in srgb, #34c759 20%, transparent);
      color: #34c759;
    }
    .tmsg-item.role-system .tmsg-role {
      background: var(--ah-surface-3, #262a31);
      color: var(--ah-text-muted);
    }
    .tmsg-body {
      padding: 0 10px 8px;
      font-size: 11.5px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--ah-text);
    }
    .tmsg-empty {
      color: var(--ah-text-faint, #6b7280);
      font-style: italic;
    }
    .tmsg-reason {
      margin: 0 10px 8px;
      font-size: 11px;
      line-height: 1.5;
      color: var(--ah-text-muted);
      white-space: pre-wrap;
      border-left: 2px solid var(--ah-border);
      padding-left: 8px;
    }
    /* LLM 节点「工具 N」chip 收起时隐藏其下工具列表（点击再展开）。 */
    .tchildren-hidden {
      display: none;
    }
    .tdetail {
      margin: 2px 0 4px 15px;
      padding: 8px 10px;
      font-size: 11px;
      line-height: 1.5;
      overflow: auto;
      max-height: 180px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--ah-text-muted);
      font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
      background: var(--ah-canvas);
      border: 1px solid var(--ah-border);
      border-radius: 7px;
    }
    .tresult {
      margin: 2px 0 6px 15px;
      padding: 8px 10px;
      font-size: 11.5px;
      line-height: 1.55;
      color: var(--ah-text);
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--ah-surface-3, var(--ah-surface-2));
      border: 1px solid var(--ah-border);
      border-radius: 7px;
    }
    .tresult.retrieval {
      border-left: 3px solid var(--ah-success, #34c759);
      background: color-mix(
        in srgb,
        var(--ah-success, #34c759) 8%,
        var(--ah-surface-2)
      );
    }
    .tres-title {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--ah-success, #34c759);
      margin-bottom: 4px;
      letter-spacing: 0.03em;
    }
    /* 检索内容折叠框：标题行可点击展开/收起，短内容默认展开、长内容默认收起。 */
    .tresult.tres-fold {
      padding: 0;
    }
    .tresult.tres-fold > summary {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
      list-style: none;
    }
    .tresult.tres-fold > summary::-webkit-details-marker,
    .tresult.tres-fold > summary::marker {
      display: none;
      content: '';
    }
    /* 折叠指示箭头：收起 ▸ / 展开 ▾（旋转过渡） */
    .tresult.tres-fold > summary::before {
      content: '▸';
      font-size: 10px;
      line-height: 1;
      color: var(--ah-success, #34c759);
      transition: transform 0.15s ease;
    }
    .tresult.tres-fold[open] > summary::before {
      transform: rotate(90deg);
    }
    .tresult.tres-fold > summary:hover .tres-title {
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .tresult.tres-fold > summary .tres-title {
      margin-bottom: 0;
    }
    .tres-meta {
      font-size: 10px;
      font-weight: 400;
      color: var(--ah-text-muted);
    }
    .tresult.tres-fold .tres-body {
      padding: 0 10px 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    /* json-view：JSON 语法高亮 + 长值/大容器折叠（配色全走 --ah-* 令牌）。 */
    .jv,
    .jv-row {
      display: block;
      font-family: inherit;
      color: var(--ah-text);
      /* 外层容器可能是 <pre>（pre-wrap），会泄漏模板换行；块级布局下覆盖为 normal。 */
      white-space: normal;
    }
    .jv-row {
      line-height: 1.65;
    }
    .jv-key {
      color: var(--ah-accent);
    }
    .jv-str {
      color: var(--ah-warning);
      word-break: break-all;
    }
    .jv-num,
    .jv-bool,
    .jv-null {
      color: var(--ah-success);
    }
    .jv-punc {
      color: var(--ah-text-faint);
    }
    .jv-fold {
      display: inline;
    }
    .jv-fold > summary {
      display: inline;
      cursor: pointer;
      list-style: none;
    }
    .jv-fold > summary::-webkit-details-marker,
    .jv-fold > summary::marker {
      display: none;
      content: '';
    }
    .jv-fold[open] > summary {
      display: block;
    }
    .jv-fold-head:hover .jv-fold-btn {
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .jv-fold-btn {
      font-size: 10px;
      color: var(--ah-accent);
      background: var(--ah-accent-soft);
      border-radius: 5px;
      padding: 0 6px;
      margin-left: 4px;
      user-select: none;
    }
    .tchildren {
      margin-top: 2px;
    }
    /* 节点类型着色（圆点 + 标签前缀色） */
    .tnode.kind-step > summary .tdot {
      background: var(--ah-accent, #2997ff);
    }
    .tnode.kind-llm > summary .tdot {
      background: #9b6dff;
    }
    .tnode.kind-tool > summary .tdot {
      background: var(--ah-text-muted);
    }
    .tnode.kind-retrieval > summary .tdot {
      background: var(--ah-success, #34c759);
    }
    .tnode.kind-cost > summary .tdot {
      background: #f0a020;
    }
    /* 成本节点专属：竖排「成本 / 用量」标签 + 右侧指标卡片。
       与截图中的视觉意图一致但更精致；圆点带光晕、指标右对齐且不拥挤。 */
    .tnode.kind-cost {
      border-left: none;
      margin-top: 10px;
    }
    .tnode.kind-cost > summary.tnode-head {
      align-items: center;
      gap: 10px;
      padding: 9px 12px;
      border-radius: 10px;
      background: color-mix(in srgb, #f0a020 9%, var(--ah-surface-2));
      border: 1px solid color-mix(in srgb, #f0a020 30%, var(--ah-border));
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .tnode.kind-cost > summary.tnode-head:hover {
      background: color-mix(in srgb, #f0a020 15%, var(--ah-surface-2));
      border-color: color-mix(in srgb, #f0a020 45%, var(--ah-border));
    }
    .tnode.kind-cost > summary .tdot {
      width: 9px;
      height: 9px;
      box-shadow: 0 0 0 3px color-mix(in srgb, #f0a020 18%, transparent);
    }
    /* 成本节点折叠态（默认）：横排「成本 / 用量」标签，与图一展开态一致。 */
    .tnode.kind-cost:not([open]) > summary .tlabel {
      writing-mode: horizontal-tb;
      text-orientation: mixed;
      letter-spacing: normal;
      font-size: 12px;
      line-height: 1.4;
      padding: 0;
      white-space: nowrap;
    }

    .tnode.kind-cost[open] > summary .tlabel {
      // writing-mode: vertical-rl;
      text-orientation: upright;
      letter-spacing: 3px;
      font-size: 13px;
      font-weight: 600;
      color: #e8941a;
      line-height: 1;
      padding: 1px 0;
      white-space: nowrap;
    }
    /* 成本节点显式「展开 / 收起」按钮：与「折叠全部」操作语言对齐，
       给用户一个明显可点的入口，避免「这卡能不能点」的疑问。 */
    .tnode.kind-cost > summary .tcost-toggle {
      flex: none;
      margin-left: auto;
      cursor: pointer;
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 9px;
      font-size: 10.5px;
      line-height: 1.5;
      color: #e8941a;
      background: color-mix(in srgb, #f0a020 18%, var(--ah-surface-2));
      border: 1px solid color-mix(in srgb, #f0a020 42%, var(--ah-border));
      border-radius: 999px;
      transition: background 0.15s ease, border-color 0.15s ease,
        color 0.15s ease;
    }
    .tnode.kind-cost > summary .tcost-toggle:hover {
      background: color-mix(in srgb, #f0a020 28%, var(--ah-surface-2));
      border-color: color-mix(in srgb, #f0a020 60%, var(--ah-border));
    }
    .tnode.kind-cost > summary .tcost-toggle:active {
      background: color-mix(in srgb, #f0a020 38%, var(--ah-surface-2));
    }
    .tcost-caret {
      width: 0;
      height: 0;
      border-left: 3.5px solid transparent;
      border-right: 3.5px solid transparent;
      border-top: 4.5px solid currentColor;
      transition: transform 120ms ease;
      flex: none;
    }
    .tnode.kind-cost[open] > summary .tcost-caret {
      transform: rotate(-180deg);
    }
    /* 成本节点展开后承载明细的 body 区：左侧留出标题列的宽度，避免与竖排标题重叠。 */
    .tnode.kind-cost > .tcost-body {
      padding: 10px 12px 12px 28px;
      border: 1px dashed color-mix(in srgb, #f0a020 30%, var(--ah-border));
      margin: 5px;
    }
    .tnode.kind-cost > .tcost-body + .tchildren {
      padding-left: 14px;
    }
    /* 成本节点右侧：指标按语义竖排成三组，分组着色一眼可辨。
       选择器兼容旧 summary.tmetrics（理论上无）+ 新 .tcost-body .tmetrics。 */
    .tnode.kind-cost .tmetrics {
      margin-left: auto;
      display: flex;
      flex-direction: column;
      gap: 5px;
      align-items: flex-end;
    }
    .tnode.kind-cost .tgrp {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      justify-content: flex-end;
    }
    /* 组标题色：成本=橙黄、用量=蓝、模型=中性灰；组内 chip 用对应淡色底。 */
    .tnode.kind-cost .tgrp-cost .tchip {
      background: color-mix(in srgb, #f0a020 16%, var(--ah-surface-2));
      border-color: color-mix(in srgb, #f0a020 40%, var(--ah-border));
      color: #f0a020;
    }
    .tnode.kind-cost .tgrp-cost .tchip b {
      color: #ffb84d;
    }
    .tnode.kind-cost .tgrp-usage .tchip {
      background: color-mix(in srgb, #2997ff 15%, var(--ah-surface-2));
      border-color: color-mix(in srgb, #2997ff 38%, var(--ah-border));
      color: var(--ah-accent, #2997ff);
    }
    .tnode.kind-cost .tgrp-usage .tchip b {
      color: #6db5ff;
    }
    .tnode.kind-cost .tgrp-model .tchip {
      background: var(--ah-surface-3, var(--ah-surface-2));
      border-color: var(--ah-border);
      color: var(--ah-text-muted);
    }
    .tnode.kind-cost .tgrp-model .tchip b {
      color: var(--ah-text);
    }
    .tnode.kind-tokencache > summary .tdot {
      background: #2dd4bf;
    }
    /* Token 缓存命中率节点专属：内容样式与 .tnode.kind-cost 一致，
       颜色沿用 .tdot 的 #2dd4bf，分组 chip 用浅色底 + 对应强色。 */
    .tnode.kind-tokencache {
      border-left: none;
      margin-top: 10px;
    }
    .tnode.kind-tokencache > summary.tcache-head {
      align-items: center;
      gap: 10px;
      padding: 9px 12px;
      border-radius: 10px;
      background: color-mix(in srgb, #2dd4bf 9%, var(--ah-surface-2));
      border: 1px solid color-mix(in srgb, #2dd4bf 30%, var(--ah-border));
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .tnode.kind-tokencache > summary.tcache-head:hover {
      background: color-mix(in srgb, #2dd4bf 15%, var(--ah-surface-2));
      border-color: color-mix(in srgb, #2dd4bf 45%, var(--ah-border));
    }
    .tnode.kind-tokencache > summary .tdot {
      width: 9px;
      height: 9px;
      box-shadow: 0 0 0 3px color-mix(in srgb, #2dd4bf 18%, transparent);
    }
    .tnode.kind-tokencache > summary .tlabel {
      writing-mode: horizontal-tb;
      text-orientation: mixed;
      letter-spacing: normal;
      font-size: 12px;
      line-height: 1.4;
      padding: 0;
      white-space: nowrap;
    }
    .tnode.kind-tokencache > summary .tcache-toggle {
      flex: none;
      margin-left: auto;
      cursor: pointer;
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 9px;
      font-size: 10.5px;
      line-height: 1.5;
      color: #2dd4bf;
      background: color-mix(in srgb, #2dd4bf 18%, var(--ah-surface-2));
      border: 1px solid color-mix(in srgb, #2dd4bf 42%, var(--ah-border));
      border-radius: 999px;
      transition: background 0.15s ease, border-color 0.15s ease,
        color 0.15s ease;
    }
    .tnode.kind-tokencache > summary .tcache-toggle:hover {
      background: color-mix(in srgb, #2dd4bf 28%, var(--ah-surface-2));
      border-color: color-mix(in srgb, #2dd4bf 60%, var(--ah-border));
    }
    .tnode.kind-tokencache > summary .tcache-toggle:active {
      background: color-mix(in srgb, #2dd4bf 38%, var(--ah-surface-2));
    }
    .tcache-caret {
      width: 0;
      height: 0;
      border-left: 3.5px solid transparent;
      border-right: 3.5px solid transparent;
      border-top: 4.5px solid currentColor;
      transition: transform 120ms ease;
      flex: none;
    }
    .tnode.kind-tokencache[open] > summary .tcache-caret {
      transform: rotate(-180deg);
    }
    .tnode.kind-tokencache > .tcache-body {
      padding: 10px 12px 12px 28px;
      border: 1px dashed color-mix(in srgb, #2dd4bf 30%, var(--ah-border));
      margin: 5px;
    }
    /* token cache 指标分组布局：与成本节点保持一致的 flex 布局，
       右对齐 + 换行，保证长模型名不挤烂相邻分组。 */
    .tnode.kind-tokencache .tmetrics {
      margin-left: auto;
      display: flex;
      flex-direction: column;
      gap: 5px;
      align-items: flex-end;
    }
    .tnode.kind-tokencache .tgrp {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      justify-content: flex-end;
    }
    /* 长文本 chip：单行省略，hover 显示完整内容。
       min-width: 0 让 flex 子项按 max-width 收缩（默认 auto 会按内容固有宽度撑开，
       导致长模型名在窄屏顶出 .tcache-body 虚线边框）。 */
    .tnode.kind-tokencache .tchip {
      max-width: 100%;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* 分模型下被拆分的子容器：换行包裹，靠右对齐。 */
    .tnode.kind-tokencache .tgrp-sub {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      justify-content: flex-end;
      align-items: center;
    }
    /* 单个模型的缓存统计 chip：沿用中性 model 组配色，
       避免蓝色链接样式误导用户点击。 */
    .tnode.kind-tokencache .model-chip {
      max-width: 140px;
      background: var(--ah-surface-3, var(--ah-surface-2));
      border-color: var(--ah-border);
      color: var(--ah-text-muted);
    }
    .tnode.kind-tokencache > .tcache-body + .tchildren {
      padding-left: 14px;
    }
    .tnode.kind-tokencache .tgrp-hit .tchip {
      background: color-mix(in srgb, #2dd4bf 16%, var(--ah-surface-2));
      border-color: color-mix(in srgb, #2dd4bf 40%, var(--ah-border));
      color: #2dd4bf;
    }
    .tnode.kind-tokencache .tgrp-hit .tchip b {
      color: #5ee9d4;
    }
    .tnode.kind-tokencache .tgrp-info .tchip {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 15%,
        var(--ah-surface-2)
      );
      border-color: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 38%,
        var(--ah-border)
      );
      color: var(--ah-accent, #2997ff);
    }
    .tnode.kind-tokencache .tgrp-info .tchip b {
      color: #6db5ff;
    }
    .tnode.kind-tokencache .tgrp-model .tchip {
      background: var(--ah-surface-3, var(--ah-surface-2));
      border-color: var(--ah-border);
      color: var(--ah-text-muted);
    }
    .tnode.kind-tokencache .tgrp-model .tchip b {
      color: var(--ah-text);
    }
    /* 窄屏（≤640px）token cache 节点布局：
       - .tmetrics 改为 stretch：让每个 .tgrp 占满父容器宽度，
         解决窄屏下 chip 因 align-items: flex-end 而按内容固有宽度撑开、顶出 .tcache-body 边框的问题；
       - .tgrp 改为 flex-start：去掉右对齐在窄屏下的拥挤感；
       - .model-chip（分模型拆出的子 chip）缩窄到 110px 以容纳更多 chip；
       - .tcache-body 减小水平内边距，给 chip 留出横向空间。
       成本节点（kind-cost）与此完全一致：model chip 名长（如 gpt-4.1-2025-04-14），
       在窄屏下同样会因 justify-content: flex-end 顶出容器，故镜像相同的窄屏适配。 */
    @media (max-width: 640px) {
      .tnode.kind-tokencache .tmetrics {
        align-items: stretch;
      }
      .tnode.kind-tokencache .tgrp {
        justify-content: flex-start;
      }
      .tnode.kind-tokencache .model-chip {
        max-width: 110px;
      }
      .tnode.kind-tokencache > .tcache-body {
        padding: 8px 8px 10px 20px;
        margin: 4px;
      }
      .tnode.kind-cost .tmetrics {
        align-items: stretch;
      }
      .tnode.kind-cost .tgrp {
        justify-content: flex-start;
      }
      .tnode.kind-cost > .tcost-body {
        padding: 8px 8px 10px 20px;
        margin: 4px;
      }
    }
    .tnode.kind-verify > summary .tdot {
      background: var(--ah-success, #34c759);
    }
    .tnode.kind-guardrail > summary .tdot,
    .tnode.kind-budget > summary .tdot,
    .tnode.kind-error > summary .tdot {
      background: var(--ah-danger, #e24b4a);
    }
    .tnode.status-error > summary .tlabel {
      color: var(--ah-danger, #e24b4a);
    }
`;
