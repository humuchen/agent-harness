<script lang="ts">
  /**
   * 上下文用量圆环（Context Usage Ring）—— Svelte 迁移版组件。
   * 原 renderCtxRing（lit TemplateResult + 事件绑定）→ 独立组件：
   *  - 悬停：显示「上下文已使用：xx.x% - 用量/总量」提示；
   *  - 点击：切换分类占比弹层（onToggle 由父级持有开关状态）；
   *  - >80% 时进度环转警示红。
   * 圆环/弹层样式在 chat 样式（composer.ts）中，已全局注入。
   */
  import {
    fmtK,
    type CtxUsage,
    type RunCumulative
  } from './chat-context-usage';

  let {
    usage,
    showCtxUsage = false,
    runCumulative = null,
    onToggle,
    onClose
  }: {
    usage: CtxUsage;
    showCtxUsage?: boolean;
    runCumulative?: RunCumulative | null;
    onToggle?: () => void;
    onClose?: () => void;
  } = $props();

  const pct = $derived(Math.min(100, usage.totalPct));
  const R = 15.5;
  const C = 2 * Math.PI * R;
  const offset = $derived(C * (1 - pct / 100));
</script>

<div class="ctx-ring-wrap">
  <button class="ctx-ring" aria-label="上下文用量" onclick={() => onToggle?.()}>
    <svg viewBox="0 0 36 36" role="img" aria-hidden="true">
      <circle
        class="ring-bg"
        cx="18"
        cy="18"
        r={R}
        stroke-width="5"
      ></circle>
      <circle
        class="ring-fg{pct > 80 ? ' warn' : ''}"
        cx="18"
        cy="18"
        r={R}
        stroke-width="4"
        stroke-dasharray={C.toFixed(2)}
        stroke-dashoffset={offset.toFixed(2)}
        transform="rotate(-90 18 18)"
      ></circle>
    </svg>
  </button>
  <span class="ctx-tip"
    >上下文已使用：~{pct.toFixed(1)}% -
    {fmtK(usage.totalTokens)}/{fmtK(usage.window)}</span
  >
  {#if showCtxUsage}
    <button
      class="ctx-scrim"
      aria-label="关闭上下文用量"
      onclick={() => onClose?.()}
    ></button>
    <div class="ctx-pop">
      <div class="ctx-pop-head">
        <span>上下文用量</span>
        <button
          class="ctx-pop-close"
          title="关闭"
          aria-label="关闭"
          onclick={() => onClose?.()}
        >
          ×
        </button>
      </div>
      <div class="ctx-bar-meta">
        <span class="ctx-bar-pct">~{usage.totalPct.toFixed(1)}%</span>
        <span class="ctx-bar-total">
          已使用 {fmtK(usage.totalTokens)} / {fmtK(usage.window)}</span
        >
      </div>
      <div class="ctx-seg">
        {#each usage.items as it (it.key)}
          <span
            class="ctx-seg-i {it.cls}"
            style="width:{it.pct}%"
            title="{it.label} ~{it.pct.toFixed(1)}%"
          ></span>
        {/each}
      </div>
      <ul class="ctx-list">
        {#each usage.items as it (it.key)}
          <li>
            <span class="ctx-dot {it.cls}"></span>
            <span class="ctx-label">{it.label}</span>
            <span class="ctx-val">~{it.pct.toFixed(1)}%</span>
          </li>
        {/each}
        {#if runCumulative}
          <li class="ctx-cum">
            <span class="ctx-dot c-cum"></span>
            <span class="ctx-label">本运行累计</span>
            <span class="ctx-val"
              >{fmtK(runCumulative.tokens)} ·
              {runCumulative.cost > 0
                ? `$${runCumulative.cost.toFixed(4)}`
                : '免费'}</span
            >
          </li>
        {/if}
      </ul>
    </div>
  {/if}
</div>
