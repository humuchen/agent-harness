/**
 * mode-picker：运行模式选择器（输入框底部工具栏）。
 *
 * 参照主流客户端交互（参考截图设计）：胶囊触发按钮「图标 + 文字 + chevron」，
 * 点击向上弹出竖列面板，每项「左侧线性图标 + 名称 + 选中 ✓」，当前项高亮底色。
 *
 * 模式经 `mode-change` 事件抛给宿主（detail.value 为 'qa' | 'plan'），
 * 状态由宿主持有并持久化 —— 组件本身不保存选择结果。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/** 运行模式定义：值与宿主 interactionMode 对齐。 */
interface ModeItem {
  value: 'qa' | 'plan';
  label: string;
  /** 左侧 24×24 线性图标的 path。 */
  iconPath: string;
}

const MODES: ModeItem[] = [
  {
    value: 'qa',
    label: 'Ask',
    // 对话气泡
    iconPath:
      'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'
  },
  {
    value: 'plan',
    label: 'Plan',
    // 剪贴板清单
    iconPath:
      'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9l2 2 4-4'
  }
];

@customElement('ah-mode-picker')
export class AhModePicker extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
      position: relative;
    }
    /* 触发按钮：胶囊形（图标+文字+chevron），按模式区分色调：
       Ask=青绿，Plan=紫。低饱和底色 + 同系文字色 */
    .trigger {
      appearance: none;
      border: none;
      background: var(--mode-bg, rgba(40, 184, 148, 0.2));
      color: var(--mode-fg, rgb(40, 184, 148));
      font-size: 12px;
      font-weight: 500;
      height: var(--ah-h-lg);
      padding: 0 12px;
      border-radius: 16px;
      cursor: pointer;
      outline: none;
      display: flex;
      align-items: center;
      gap: 6px;
      max-width: 46vw;
      transition: background 0.15s, filter 0.15s;
    }
    .trigger:hover {
      filter: brightness(1.25);
    }
    /* Plan 模式：紫色调（Ask 默认即青绿色调） */
    .trigger.plan {
      --mode-bg: rgba(108, 77, 255, 0.2);
      --mode-fg: rgb(169, 151, 255);
    }
    .trigger svg {
      flex-shrink: 0;
      width: 15px;
      height: 15px;
    }

    .trigger .chev {
      width: 12px;
    }

    /* 弹层面板：锚定按钮、向上展开（工具栏位于页面底部） */
    .panel {
      position: absolute;
      left: 0;
      bottom: calc(100% + 10px);
      z-index: 60;
      width: 156px;
      max-width: calc(100vw - 24px);
      background: var(--ah-surface-1);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-lg, 12px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
      overflow: hidden;
      padding: 6px;
      box-sizing: border-box;
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
      padding: 4.5px 10px;
      border-radius: 8px;
      color: var(--ah-text);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      transition: background 0.12s;
      margin-bottom: 6px;

      &:last-child {
        margin-bottom: 0;
      }
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

  /** 当前模式（状态由宿主持有并透传）。 */
  @property({ type: String }) mode: 'qa' | 'plan' = 'qa';

  @state() private open = false;

  private select(v: 'qa' | 'plan') {
    this.open = false;
    if (v === this.mode) return;
    this.dispatchEvent(
      new CustomEvent('mode-change', {
        detail: { value: v },
        bubbles: true,
        composed: true
      })
    );
  }

  render() {
    const current = MODES.find((m) => m.value === this.mode) ?? MODES[0];
    return html`
      <button
        class="trigger ${this.mode === 'plan' ? 'plan' : ''}"
        title="运行模式：回答=直接回答；计划=先产出结构化执行计划，确认后逐步执行"
        aria-haspopup="dialog"
        aria-expanded=${this.open ? 'true' : 'false'}
        @click=${() => (this.open = !this.open)}
      >
        <!-- 当前模式的图标 -->
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d=${current?.iconPath ?? ''} />
        </svg>
        <span class="name">${current?.label ?? ''}</span>
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
              aria-label="关闭模式选择"
              @click=${() => (this.open = false)}
            ></button>
            <div class="panel" role="dialog" aria-label="运行模式">
              ${MODES.map(
                (m) => html`
                  <button
                    class="item ${this.mode === m.value ? 'selected' : ''}"
                    role="option"
                    aria-selected=${this.mode === m.value ? 'true' : 'false'}
                    @click=${() => this.select(m.value)}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d=${m.iconPath} />
                    </svg>
                    <span class="name">${m.label}</span>
                    ${this.mode === m.value
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
    'ah-mode-picker': AhModePicker;
  }
}
