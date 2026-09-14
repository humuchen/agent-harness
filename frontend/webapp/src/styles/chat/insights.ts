import { css } from 'lit';

export const insights = css`
    /* ----------------------- 关键信息 (insights) ----------------------- */
    .insights {
      margin-bottom: 10px;
      border: 1px solid var(--ah-border);
      border-radius: 10px;
      background: var(--ah-surface-2);
      padding: 10px 12px 12px;
    }
    .insights-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--ah-text);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .insights-title::before {
      content: '';
      width: 3px;
      height: 12px;
      border-radius: 2px;
      background: var(--ah-accent, #2997ff);
    }
    .ins-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
      gap: 8px;
    }
    .ins-item {
      background: var(--ah-surface-3, var(--ah-surface-1));
      border: 1px solid var(--ah-border);
      border-radius: 8px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .ins-k {
      font-size: 10px;
      color: var(--ah-text-muted);
    }
    .ins-v {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--ah-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ins-retrieval {
      margin-top: 10px;
      border-top: 1px dashed var(--ah-border);
      padding-top: 10px;
    }
    .ins-breakdown {
      margin-top: 10px;
      border-top: 1px dashed var(--ah-border);
      padding-top: 10px;
    }
    .ins-bd-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--ah-accent, #2997ff);
      margin-bottom: 8px;
    }
    /* 「估算」角标：提示 Token 拆解四项占比是启发式估算而非 provider 真实分项计数。 */
    .ins-bd-est {
      font-size: 9px;
      font-weight: 500;
      color: var(--ah-text-muted);
      border: 1px solid var(--ah-border);
      border-radius: 4px;
      padding: 0 4px;
      margin-left: 6px;
      vertical-align: middle;
      white-space: nowrap;
    }
    .ins-bd-row {
      margin-bottom: 7px;
    }
    /* 分项缺失时的稳定占位（有总量、无明细），避免模块静默消失。 */
    .ins-bd-empty {
      font-size: 11px;
      color: var(--ah-text-muted);
      padding: 2px 0 4px;
    }
    .ins-bd-head {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      margin-bottom: 3px;
    }
    .ins-bd-name {
      color: var(--ah-text-muted);
    }
    .ins-bd-val {
      color: var(--ah-text);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .ins-bd-track {
      height: 6px;
      border-radius: 4px;
      background: color-mix(in srgb, var(--ah-border) 60%, transparent);
      overflow: hidden;
    }
    .ins-bd-fill {
      height: 100%;
      border-radius: 4px;
      background: linear-gradient(
        90deg,
        var(--ah-accent, #2997ff),
        color-mix(in srgb, var(--ah-accent, #2997ff) 55%, #34c759)
      );
      transition: width 0.35s ease;
    }
    .ins-ret-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--ah-success, #34c759);
      margin-bottom: 6px;
    }
    .ins-ret-card {
      border: 1px solid var(--ah-border);
      border-left: 3px solid var(--ah-success, #34c759);
      border-radius: 8px;
      background: color-mix(
        in srgb,
        var(--ah-success, #34c759) 6%,
        var(--ah-surface-1)
      );
      padding: 8px 10px;
      margin-bottom: 8px;
    }
    /* 检索内容折叠框（关键信息区）：与调用链 .tres-fold 同款交互 ——
         短内容(≤240字)默认展开、长内容默认收起，标题行点击切换。 */
    details.ins-ret-fold {
      padding: 0;
    }
    .ins-ret-fold > summary {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
      list-style: none;
    }
    .ins-ret-fold > summary::-webkit-details-marker,
    .ins-ret-fold > summary::marker {
      display: none;
      content: '';
    }
    /* 折叠指示箭头：收起 ▸ / 展开 ▾（旋转过渡） */
    .ins-ret-fold > summary::before {
      content: '▸';
      font-size: 10px;
      line-height: 1;
      color: var(--ah-success, #34c759);
      transition: transform 0.15s ease;
    }
    .ins-ret-fold[open] > summary::before {
      transform: rotate(90deg);
    }
    .ins-ret-fold > summary:hover .ins-ret-name {
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .ins-ret-fold > summary .ins-ret-name {
      margin-bottom: 0;
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ins-ret-name {
      font-size: 11px;
      font-weight: 600;
      color: var(--ah-text);
      margin-bottom: 4px;
    }
    /* 折叠标题行的字数 meta。 */
    .ins-ret-meta {
      flex: 0 0 auto;
      font-size: 10px;
      color: var(--ah-text-muted);
      font-variant-numeric: tabular-nums;
    }
    .ins-ret-body {
      margin: 0;
      padding: 0 10px 8px;
      font-size: 11px;
      line-height: 1.5;
      max-height: 160px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--ah-text-muted);
      font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    }
`;
