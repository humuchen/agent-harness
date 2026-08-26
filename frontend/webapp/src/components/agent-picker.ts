/**
 * agent-picker：业务 Agent 选择器（输入框底部工具栏）。
 *
 * 与 mode-picker 同一套视觉（参考截图设计）：胶囊触发按钮「图标 + 名称 + chevron」，
 * 点击向上弹出竖列面板，每项「左侧线性图标 + 名称 + 选中 ✓」，当前项高亮底色。
 *
 * 列表与当前值均由宿主持有并透传；选择结果经 `agent-change`
 * 事件抛出（detail.value 为 agent id）。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/** 宿主传入的 Agent 条目。 */
export interface AgentOption {
  id: string;
  name: string;
}

/** 统一机器人图标：所有 Agent 共用，仅名称区分。 */
const BOT_ICON =
  'M12 2v2m0 0a2 2 0 0 1 2 2h-4a2 2 0 0 1 2-2zM8 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2M9 13h.01M15 13h.01M9.5 16.5h5';

@customElement('ah-agent-picker')
export class AhAgentPicker extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
      position: relative;
    }
    /* 触发按钮：胶囊形（图标+文字+chevron），低饱和强调底色 —— 与 mode-picker 一致 */
    .trigger {
      appearance: none;
      border: none;
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 14%,
        transparent
      );
      color: var(--ah-accent, #2997ff);
      font-size: 13px;
      font-weight: 500;
      height: 32px;
      padding: 0 12px;
      border-radius: 16px;
      cursor: pointer;
      outline: none;
      display: flex;
      align-items: center;
      gap: 6px;
      max-width: 46vw;
      transition:
        background 0.15s,
        filter 0.15s;
    }
    .trigger:hover {
      filter: brightness(1.25);
    }
    .trigger svg {
      flex-shrink: 0;
      width: 15px;
      height: 15px;
    }
    .trigger .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* 弹层面板：锚定按钮、向上展开（工具栏位于页面底部） */
    .panel {
      position: absolute;
      left: 0;
      bottom: calc(100% + 10px);
      z-index: 60;
      width: 208px;
      max-width: calc(100vw - 24px);
      max-height: min(320px, 60vh);
      overflow-y: auto;
      background: var(--ah-surface-1);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-lg, 12px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
      padding: 6px;
      box-sizing: border-box;
      scrollbar-width: thin;
    }
    /* 选项行：图标 + 名称 + 选中✓，选中项高亮底色 */
    .item {
      appearance: none;
      border: none;
      background: transparent;
      width: 100%;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 10px;
      border-radius: 8px;
      color: var(--ah-text);
      font-size: 13.5px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      transition: background 0.12s;
    }
    .item:hover {
      background: color-mix(
        in srgb,
        var(--ah-text-muted, #999) 12%,
        transparent
      );
    }
    .item.selected {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 14%,
        transparent
      );
    }
    .item svg {
      flex-shrink: 0;
      width: 17px;
      height: 17px;
      color: var(--ah-text-muted);
    }
    .item.selected svg {
      color: var(--ah-accent, #2997ff);
    }
    .item .name {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .item .check {
      flex-shrink: 0;
      color: var(--ah-accent, #2997ff);
      font-size: 14px;
    }

    /* 遮罩：点击空白处关闭（移动端友好） */
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 50;
      width: 100%;
      height: 100%;
      background: transparent;
      border: none;
      padding: 0;
      cursor: default;
    }
  `;

  /** 可选 Agent 列表（由宿主持有）。 */
  @property({ attribute: false }) agents: AgentOption[] = [];

  /** 当前选中的 agent id。 */
  @property({ type: String }) value = '';

  @state() private open = false;

  private select(id: string) {
    this.open = false;
    if (id === this.value) return;
    this.dispatchEvent(
      new CustomEvent('agent-change', {
        detail: { value: id },
        bubbles: true,
        composed: true
      })
    );
  }

  render() {
    const current = this.agents.find((a) => a.id === this.value);
    return html`
      <button
        class="trigger"
        title="选择业务 Agent（默认走通用 Agent）"
        aria-haspopup="dialog"
        aria-expanded=${this.open ? 'true' : 'false'}
        @click=${() => (this.open = !this.open)}
      >
        <!-- 统一机器人图标 -->
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d=${BOT_ICON} />
        </svg>
        <span class="name">${current?.name ?? '默认'}</span>
        <!-- 下拉 chevron -->
        <svg
          class="chev"
          viewBox="0 0 10 6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M1 1l4 4 4-4" />
        </svg>
      </button>
      ${this.open
        ? html`
            <button
              class="scrim"
              aria-label="关闭 Agent 选择"
              @click=${() => (this.open = false)}
            ></button>
            <div class="panel" role="dialog" aria-label="业务 Agent">
              ${this.agents.map(
                (a) => html`
                  <button
                    class="item ${this.value === a.id ? 'selected' : ''}"
                    role="option"
                    aria-selected=${this.value === a.id ? 'true' : 'false'}
                    title=${a.name}
                    @click=${() => this.select(a.id)}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d=${BOT_ICON} />
                    </svg>
                    <span class="name">${a.name}</span>
                    ${this.value === a.id
                      ? html`<span class="check">✓</span>`
                      : nothing}
                  </button>
                `
              )}
            </div>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ah-agent-picker': AhAgentPicker;
  }
}
