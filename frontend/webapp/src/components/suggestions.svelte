<script module lang="ts">
  export interface SuggestionItem {
    label: string;
    prompt: string;
  }

  /** 归一化 items：既接受 {label,prompt} 对象，也接受裸字符串（label === prompt）。 */
  export function normalize(items: Array<string | SuggestionItem>): SuggestionItem[] {
    return items
      .map((it) =>
        typeof it === 'string'
          ? { label: it, prompt: it }
          : it && typeof it === 'object'
            ? { label: String(it.label ?? it.prompt ?? ''), prompt: String(it.prompt ?? '') }
            : null
      )
      .filter((it): it is SuggestionItem => !!it && !!it.label && !!it.prompt);
  }
</script>

<script lang="ts">
  /**
   * suggestions：快捷建议 chips（前端应用层「Suggestions」落地）—— Svelte 迁移版。
   *
   * 在输入框上方渲染一组可点的建议条，点击后派发 `suggestion-picked`
   * 自定义事件（detail 为要填入输入框的完整提示词），由父组件决定如何消费
   * （填入 prompt / 直接触发运行）。
   *
   * 用法：
   *   <Suggestions items={[{ label: '查天气', prompt: '帮我查上海的天气' }]} />
   *   // 父组件监听：
   *   root.addEventListener('suggestion-picked', (e) => { this.prompt = e.detail; });
   *
   * 样式：mobilePill 已全局注入（勿在组件内重复）；:host 规则改写为根类
   * .suggestions-root。
   */
  let {
    /** 建议列表：裸字符串或 {label,prompt} 对象。 */
    items = [],
    /** 运行中禁止点击（防打断正在进行的任务）。 */
    disabled = false
  }: { items?: Array<string | SuggestionItem>; disabled?: boolean } = $props();

  let rootEl: HTMLElement | undefined = $state();

  const normalized = $derived(normalize(items));

  function pick(prompt: string) {
    if (disabled || !prompt) return;
    rootEl?.dispatchEvent(
      new CustomEvent('suggestion-picked', {
        detail: prompt,
        bubbles: true,
        composed: true
      })
    );
  }
</script>

<div class="suggestions-root no-pill" bind:this={rootEl}>
  {#if normalized.length > 0}
    <div class="suggestions" role="listbox" aria-label="快捷建议">
      {#each normalized as it (it.prompt + '\u0000' + it.label)}
        <button
          type="button"
          class="chip"
          role="option"
          aria-selected={false}
          title={it.prompt}
          disabled={disabled}
          onclick={() => pick(it.prompt)}
        >
          {it.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* 原 :host 规则 → 根类 */
  .suggestions-root {
    display: block;
  }
  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .chip {
    font: inherit;
    font-size: 13px;
    line-height: 1.4;
    padding: 5px 12px;
    border-radius: var(--ah-radius-pill);
    border: 1px solid var(--ah-border);
    background: var(--ah-surface-2);
    color: var(--ah-text);
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
  }
  .chip:hover:not(:disabled) {
    border-color: var(--ah-accent);
    color: var(--ah-accent);
    background: var(--ah-accent-soft);
  }
  .chip:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
