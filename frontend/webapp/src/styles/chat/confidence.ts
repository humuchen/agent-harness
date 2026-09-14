import { css } from 'lit';

export const confidence = css`
    /* ----------------------- 链路信心 (confidence) ----------------------- */
    /* 卡片外壳：与 insights / trace 同款（边框 + 圆角 + 表面色），承载环形量表与语义进度条。 */
    .confidence-wrap {
      border: 1px solid var(--ah-border);
      border-radius: 10px;
      background: var(--ah-surface-2);
      padding: 12px 14px 14px;
    }
    .confidence {
      /* 等级主色：驱动量表环、分数、等级文字三处统一着色。 */
      --conf-c: var(--ah-accent, #2997ff);
      display: flex;
      flex-direction: column;
      gap: 13px;
    }
    .confidence.level-high {
      --conf-c: var(--ah-success, #34c759);
    }
    .confidence.level-mid {
      --conf-c: var(--ah-warning, #ff9f0a);
    }
    .confidence.level-low {
      --conf-c: var(--ah-danger, #e24b4a);
    }
    .conf-head {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    /* 环形量表：SVG 描边环，按 score 百分比填充，等级色随 level 切换。 */
    .conf-gauge {
      position: relative;
      width: 72px;
      height: 72px;
      flex: 0 0 auto;
    }
    .conf-gauge-svg {
      width: 72px;
      height: 72px;
      transform: rotate(-90deg);
      display: block;
    }
    .conf-gauge-bg {
      fill: none;
      stroke: var(--ah-surface-3, rgba(255, 255, 255, 0.1));
      stroke-width: 7;
    }
    .conf-gauge-fg {
      fill: none;
      stroke: var(--conf-c);
      stroke-width: 7;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.45s ease, stroke 0.25s ease;
    }
    /* 环心数字：分数 + 单位，基线对齐，分数用等级色。 */
    .conf-gauge-num {
      position: absolute;
      inset: 25px;
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: 1px;
    }
    .conf-num {
      font-size: 22px;
      font-weight: 800;
      color: var(--conf-c);
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .conf-unit {
      font-size: 10.5px;
      color: var(--ah-text-muted);
    }
    .conf-meta {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: flex-start;
    }
    .conf-level {
      font-size: 13px;
      font-weight: 600;
      color: var(--conf-c);
    }
    .conf-badge {
      font-size: 10.5px;
      font-weight: 500;
      padding: 1px 8px;
      border-radius: 999px;
      line-height: 17px;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .conf-badge.synth {
      color: var(--ah-text-muted);
      background: var(--ah-surface-3, var(--ah-surface-1));
      border-color: var(--ah-border);
    }
    .conf-badge.ok {
      color: var(--ah-success, #34c759);
      background: color-mix(
        in srgb,
        var(--ah-success, #34c759) 14%,
        transparent
      );
      border-color: color-mix(
        in srgb,
        var(--ah-success, #34c759) 36%,
        transparent
      );
    }
    .conf-badge.err {
      color: var(--ah-danger, #e24b4a);
      background: color-mix(
        in srgb,
        var(--ah-danger, #e24b4a) 14%,
        transparent
      );
      border-color: color-mix(
        in srgb,
        var(--ah-danger, #e24b4a) 36%,
        transparent
      );
    }
    .conf-bars {
      display: flex;
      flex-direction: column;
      gap: 9px;
    }
    .conf-row {
      display: grid;
      grid-template-columns: 72px 1fr auto;
      align-items: center;
      gap: 10px;
    }
    .conf-name {
      font-size: 12px;
      color: var(--ah-text-muted);
      white-space: nowrap;
    }
    .conf-track {
      height: 7px;
      border-radius: 4px;
      background: var(--ah-surface-3, rgba(255, 255, 255, 0.08));
      overflow: hidden;
    }
    .conf-fill {
      height: 100%;
      border-radius: 4px;
      background: var(--ah-accent, #2997ff);
      transition: width 0.45s ease;
    }
    /* 进度条语义着色：成功率=绿、缓存=蓝、错误节点=红。 */
    .conf-fill.ok {
      background: linear-gradient(90deg, var(--ah-success, #34c759), #6ee7a8);
    }
    .conf-fill.info {
      background: linear-gradient(90deg, var(--ah-accent, #2997ff), #7dbeff);
    }
    .conf-fill.warn {
      background: linear-gradient(90deg, var(--ah-danger, #e24b4a), #ff7a72);
    }
    .conf-val {
      font-size: 12px;
      font-weight: 600;
      color: var(--ah-text);
      font-variant-numeric: tabular-nums;
      text-align: right;
      min-width: 38px;
    }
    .conf-reasons {
      border: 1px solid var(--ah-border);
      border-radius: 8px;
      background: var(--ah-canvas);
      overflow: hidden;
    }
    .conf-reasons > summary {
      cursor: pointer;
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 600;
      color: var(--ah-success, #34c759);
      list-style: none;
      user-select: none;
    }
    .conf-reasons > summary::-webkit-details-marker {
      display: none;
    }
    .conf-reasons pre {
      margin: 0;
      padding: 8px 10px;
      font-size: 11px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--ah-text-muted);
      font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    }
    /* 合成信心提示：淡蓝 callout + 信息图标，与合成徽标呼应。 */
    .conf-note {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      margin-top: 1px;
      padding: 8px 10px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--ah-accent, #2997ff) 7%, transparent);
      border: 1px solid
        color-mix(in srgb, var(--ah-accent, #2997ff) 22%, var(--ah-border));
      font-size: 11.5px;
      line-height: 1.55;
      color: var(--ah-text-muted);
    }
    .conf-note-ico {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      margin-top: 1px;
      color: var(--ah-accent, #2997ff);
    }
    .conf-note span {
      min-width: 0;
    }
`;
