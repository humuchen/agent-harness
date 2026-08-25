/**
 * suggestions：快捷建议 chips（前端应用层「Suggestions」落地）。
 *
 * 在输入框上方渲染一组可点的建议条，点击后派发 `suggestion-picked`
 * 自定义事件（detail 为要填入输入框的完整提示词），由父组件决定如何消费
 * （填入 prompt / 直接触发运行）。零依赖，纯 Lit。
 *
 * 用法：
 *   <ah-suggestions .items=${[{ label: '查天气', prompt: '帮我查上海的天气' }]}></ah-suggestions>
 *   // 父组件监听：
 *   el.addEventListener('suggestion-picked', (e) => { this.prompt = e.detail; });
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export interface SuggestionItem {
  label: string;
  prompt: string;
}

/** 归一化 items：既接受 {label,prompt} 对象，也接受裸字符串（label === prompt）。 */
function normalize(items: Array<string | SuggestionItem>): SuggestionItem[] {
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

@customElement('ah-suggestions')
export class AhSuggestions extends LitElement {
  static styles = css`
    :host {
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
  `;

  /** 建议列表：裸字符串或 {label,prompt} 对象。 */
  @property({ type: Array })
  items: Array<string | SuggestionItem> = [];

  /** 运行中禁止点击（防打断正在进行的任务）。 */
  @property({ type: Boolean })
  disabled = false;

  private pick(prompt: string) {
    if (this.disabled || !prompt) return;
    this.dispatchEvent(
      new CustomEvent('suggestion-picked', {
        detail: prompt,
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    const items = normalize(this.items);
    if (items.length === 0) return nothing;
    return html`
      <div class="suggestions" role="listbox" aria-label="快捷建议">
        ${items.map(
          (it) => html`
            <button
              type="button"
              class="chip"
              role="option"
              title=${it.prompt}
              ?disabled=${this.disabled}
              @click=${() => this.pick(it.prompt)}
            >
              ${it.label}
            </button>
          `
        )}
      </div>
    `;
  }
}
