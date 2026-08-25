/**
 * ah-modal：统一弹框组件（components 目录 · 全应用唯一的模态对话框原语）。
 *
 * 取代散落各处的 window.confirm / window.prompt / 自绘浮层，提供：
 * - 变体：info（信息提示）/ confirm（确认）/ warning（警告，可配 danger 红色强调）；
 *   配合默认插槽即为「自定义内容」，showInput 开启内置输入行（替代原生 prompt）。
 * - API：
 *   - 声明式：<ah-modal ?open title message variant size mask-closable
 *     confirm-text cancel-text show-cancel show-input @ah-confirm @ah-cancel @close>
 *   - 命令式：AhModal.confirm(opts) → Promise<boolean>
 *             AhModal.alert(opts)  → Promise<void>
 *             AhModal.prompt(opts) → Promise<string | null>
 * - 关闭途径：Esc / 遮罩点击（maskClosable 可关）/ × 按钮 / 取消按钮；确认按钮走
 *   ah-confirm 后同样自动关闭。组件先播离场动画再置 open=false 并派发 close，
 *   调用方只需在 @close 里复位自己的 open 状态。
 * - 无障碍：role=dialog + aria-modal + aria-labelledby/describedby、打开时焦点移入
 *   （有输入行则聚焦输入框）、Tab 焦点圈闭环、关闭后焦点归还触发元素、
 *   prefers-reduced-motion 下禁用动画。
 * - 主题：仅引用 --ah-* 令牌，深浅色主题与全应用一致。
 *
 * 用法示例：
 *   <ah-modal
 *     ?open=${this.showDel}
 *     variant="warning" danger title="删除会话"
 *     message="删除该会话及其全部消息？此操作不可恢复。"
 *     confirm-text="删除"
 *     @ah-confirm=${this.doDelete}
 *     @close=${() => (this.showDel = false)}
 *   ></ah-modal>
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';

export type ModalVariant = 'info' | 'confirm' | 'warning';
export type ModalSize = 'sm' | 'md' | 'lg';

const SIZE_WIDTH: Record<ModalSize, string> = {
  sm: '360px',
  md: '480px',
  lg: '640px'
};

/** 关闭动画时长（ms），与 CSS .leaving 过渡保持一致。 */
const LEAVE_MS = 160;

export interface AhModalOptions {
  title?: string;
  /** 简单文本内容；复杂内容请用声明式默认插槽代替。 */
  message?: string;
  variant?: ModalVariant;
  /** 警告变体下把确认按钮渲染为红色破坏性样式。 */
  danger?: boolean;
  size?: ModalSize;
  confirmText?: string;
  cancelText?: string;
}

@customElement('ah-modal')
export class AhModal extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
    :host([open]) {
      display: block;
    }
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      animation: ahm-fade-in 0.18s ease;
    }
    .scrim.leaving {
      opacity: 0;
      transition: opacity ${LEAVE_MS}ms ease;
    }
    .panel {
      width: min(calc(100vw - 32px), var(--ahm-w, 480px));
      max-height: min(80vh, 720px);
      display: flex;
      flex-direction: column;
      background: var(--ah-surface-1);
      color: var(--ah-text);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-lg);
      box-shadow: var(--ah-shadow);
      overflow: hidden;
      outline: none;
      animation: ahm-pop-in 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.2);
    }
    .leaving .panel {
      opacity: 0;
      transform: scale(0.96);
      transition:
        opacity ${LEAVE_MS}ms ease,
        transform ${LEAVE_MS}ms ease;
    }
    @keyframes ahm-fade-in {
      from {
        opacity: 0;
      }
    }
    @keyframes ahm-pop-in {
      from {
        opacity: 0;
        transform: scale(0.96) translateY(6px);
      }
    }
    /* 无障碍：用户偏好减少动效时禁用所有过渡/动画 */
    @media (prefers-reduced-motion: reduce) {
      .scrim,
      .panel,
      .leaving .panel {
        animation: none;
        transition: none;
      }
    }

    .head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 16px 18px 0;
    }
    .icon {
      flex: none;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 15px;
      line-height: 1;
    }
    .icon.info,
    .icon.confirm {
      background: var(--ah-accent-soft);
      color: var(--ah-accent);
    }
    .icon.warning {
      background: var(--ah-warning-soft);
      color: var(--ah-warning);
    }
    .icon.warning.danger {
      background: var(--ah-danger-soft);
      color: var(--ah-danger);
    }
    .title {
      font-family: var(--ah-font-display);
      font-weight: 600;
      font-size: 15px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .close {
      margin-left: auto;
      border: none;
      background: none;
      color: var(--ah-text-faint);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 8px;
      border-radius: var(--ah-radius-sm);
    }
    .close:hover {
      color: var(--ah-text);
      background: var(--ah-surface-2);
    }

    .body {
      padding: 12px 18px 4px;
      overflow-y: auto;
      flex: 1 1 auto;
      font-size: 14px;
      line-height: 1.6;
      color: var(--ah-text-muted);
    }
    /* 有图标头时正文与标题对齐（图标 28 + gap 10） */
    .body.indent {
      padding-left: 56px;
    }

    .modal-input {
      width: 100%;
      box-sizing: border-box;
      margin-top: 10px;
      padding: 9px 12px;
      font-size: 14px;
      font-family: var(--ah-font-sans);
      color: var(--ah-text);
      background: var(--ah-surface-2);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-md);
      outline: none;
    }
    .modal-input:focus {
      border-color: var(--ah-accent);
      box-shadow: 0 0 0 3px var(--ah-accent-soft);
    }

    .foot {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 16px 18px 18px;
    }
    .btn {
      min-width: 76px;
      padding: 8px 16px;
      font-size: 13px;
      font-family: var(--ah-font-sans);
      cursor: pointer;
      border-radius: var(--ah-radius-md);
      border: 1px solid var(--ah-border);
      transition:
        background 120ms ease,
        border-color 120ms ease,
        color 120ms ease;
    }
    .btn.ghost {
      background: transparent;
      color: var(--ah-text-muted);
    }
    .btn.ghost:hover {
      color: var(--ah-text);
      border-color: var(--ah-text-faint);
    }
    .btn.primary {
      background: var(--ah-accent);
      border-color: var(--ah-accent);
      color: #fff;
      font-weight: 600;
    }
    .btn.primary:hover {
      background: var(--ah-accent-strong);
      border-color: var(--ah-accent-strong);
    }
    .btn.primary.danger {
      background: var(--ah-danger);
      border-color: var(--ah-danger);
    }
    .btn.primary.danger:hover {
      filter: brightness(1.08);
    }
    .btn:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: 2px;
    }

    @media (max-width: 600px) {
      .body.indent {
        padding-left: 18px;
      }
      .foot {
        flex-direction: row-reverse;
      }
      .btn {
        flex: 1;
      }
    }
  `;

  /** 是否打开（reflect，供 :host([open]) 与外部状态绑定）。 */
  @property({ type: Boolean, reflect: true })
  open = false;

  /** 变体：info 信息 / confirm 确认 / warning 警告。 */
  @property({ type: String })
  variant: ModalVariant = 'info';

  /** 标题。 */
  @property({ type: String })
  title = '';

  /** 简单文本消息（与默认插槽二选一；插槽优先用于复杂内容）。 */
  @property({ type: String })
  message = '';

  /** 尺寸预设 sm/md/lg；width 属性可精确覆盖。 */
  @property({ type: String })
  size: ModalSize = 'md';

  /** 宽度覆盖（CSS 值，如 "520px"）。 */
  @property({ type: String })
  width = '';

  /** 点击遮罩是否关闭（默认开；破坏性操作建议关闭以防误触）。 */
  @property({ type: Boolean, attribute: 'mask-closable' })
  maskClosable = true;

  /** 是否显示右上角 × 按钮。 */
  @property({ type: Boolean, attribute: 'show-close' })
  showClose = true;

  /** 是否显示取消按钮（alert 场景可关）。 */
  @property({ type: Boolean, attribute: 'show-cancel' })
  showCancel = true;

  @property({ type: String, attribute: 'confirm-text' })
  confirmText = '确定';

  @property({ type: String, attribute: 'cancel-text' })
  cancelText = '取消';

  /** 内置输入行（prompt 形态）：开启后确认事件 detail 携带 inputValue。 */
  @property({ type: Boolean, attribute: 'show-input' })
  showInput = false;

  @property({ type: String, attribute: 'input-value' })
  inputValue = '';

  @property({ type: String, attribute: 'input-placeholder' })
  inputPlaceholder = '';

  /** 警告变体的破坏性强调（红色确认按钮）。 */
  @property({ type: Boolean })
  danger = false;

  /** 离场动画进行中标记。 */
  @state()
  private leaving = false;

  /** 打开前聚焦的元素，关闭后归还焦点。 */
  private lastFocus: HTMLElement | null = null;

  updated(changed: PropertyValues) {
    if (changed.has('open')) {
      if (this.open) {
        this.lastFocus = document.activeElement as HTMLElement | null;
        // 等一帧让面板渲染完成后再移焦（输入行存在时优先聚焦输入框）。
        requestAnimationFrame(() => {
          const target =
            this.shadowRoot?.querySelector<HTMLElement>('.modal-input') ??
            this.shadowRoot?.querySelector<HTMLElement>('.panel');
          target?.focus();
          // prompt 形态：光标移到末尾并全选便于直接改写。
          const inp = this.shadowRoot?.querySelector<HTMLInputElement>(
            '.modal-input'
          );
          if (inp) {
            inp.focus();
            inp.select();
          }
        });
      } else if (this.lastFocus) {
        try {
          this.lastFocus.focus();
        } catch {
          /* 触发元素已被移除等场景忽略 */
        }
        this.lastFocus = null;
      }
    }
  }

  /** 确认：派发 ah-confirm（含输入值）→ 播离场动画 → 关闭并派发 close。 */
  private onConfirm() {
    this.dispatchEvent(
      new CustomEvent('ah-confirm', {
        detail: { inputValue: this.inputValue },
        bubbles: true,
        composed: true
      })
    );
    this.finish();
  }

  /** 取消（取消按钮 / Esc / 遮罩 / ×）：派发 ah-cancel → 关闭并派发 close。 */
  private onCancel() {
    this.dispatchEvent(
      new CustomEvent('ah-cancel', { bubbles: true, composed: true })
    );
    this.finish();
  }

  /** 播离场动画后真正关闭（open=false + close 事件）。 */
  private finish() {
    if (!this.open || this.leaving) return;
    this.leaving = true;
    window.setTimeout(() => {
      this.leaving = false;
      this.open = false;
      this.dispatchEvent(
        new CustomEvent('close', { bubbles: true, composed: true })
      );
    }, LEAVE_MS);
  }

  private onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    // 焦点圈闭环：Tab 循环限制在面板内（shadow 控件 + 插槽内容里的可聚焦元素）。
    const focusables: HTMLElement[] = [
      ...(this.shadowRoot?.querySelectorAll<HTMLElement>(
        '.panel button, .panel input, .panel [tabindex]'
      ) ?? []),
      ...Array.from(this.children)
        .filter((c) => !(c as HTMLElement).hasAttribute?.('slot'))
        .flatMap((c) =>
          c.matches('button, input, select, textarea, a[href], [tabindex]')
            ? [c as HTMLElement]
            : Array.from(
                c.querySelectorAll<HTMLElement>(
                  'button, input, select, textarea, a[href], [tabindex]'
                )
              )
        )
    ].filter((el) => !el.hasAttribute('disabled'));
    if (!focusables.length) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = this.shadowRoot?.activeElement as HTMLElement | null;
    const activeIn =
      active !== null && focusables.includes(active as HTMLElement);
    if (e.shiftKey && (active === first || !activeIn)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !activeIn)) {
      e.preventDefault();
      first.focus();
    }
  }

  render() {
    if (!this.open) return nothing;
    const iconChar =
      this.variant === 'warning' ? '!' : this.variant === 'confirm' ? '?' : 'i';
    const hasHeader = !!this.title || this.showClose;
    const describedBy =
      this.message && !this.showInput ? ' id="ahm-desc"' : '';
    return html`
      <div
        class="scrim ${this.leaving ? 'leaving' : ''}"
        @click=${(e: MouseEvent) => {
          if (this.maskClosable && e.target === e.currentTarget) this.onCancel();
        }}
      >
        <div
          class="panel"
          style="--ahm-w:${this.width || SIZE_WIDTH[this.size]}"
          role="dialog"
          aria-modal="true"
          aria-label=${this.title || '对话框'}
          tabindex="-1"
          @keydown=${this.onKeydown}
        >
          ${hasHeader
            ? html`<div class="head">
                <span
                  class="icon ${this.variant} ${this.danger &&
                  this.variant === 'warning'
                    ? 'danger'
                    : ''}"
                  aria-hidden="true"
                  >${iconChar}</span
                >
                <div class="title" id="ahm-title">${this.title}</div>
                <slot name="header"></slot>
                ${this.showClose
                  ? html`<button
                      type="button"
                      class="close"
                      title="关闭"
                      aria-label="关闭"
                      @click=${this.onCancel}
                    >
                      ×
                    </button>`
                  : nothing}
              </div>`
            : ''}
          <div class="body indent">
            ${this.message
              ? html`<div${describedBy}>${this.message}</div>`
              : nothing}
            ${this.showInput
              ? html`<input
                  class="modal-input"
                  placeholder=${this.inputPlaceholder}
                  .value=${this.inputValue}
                  @input=${(e: InputEvent) =>
                    (this.inputValue = (e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      this.onConfirm();
                    }
                  }}
                />`
              : nothing}
            <slot></slot>
          </div>
          <div class="foot">
            ${this.showCancel
              ? html`<button type="button" class="btn ghost" @click=${this.onCancel}>
                  ${this.cancelText}
                </button>`
              : nothing}
            <button
              type="button"
              class="btn primary ${this.danger && this.variant === 'warning'
                ? 'danger'
                : ''}"
              @click=${this.onConfirm}
            >
              ${this.confirmText}
            </button>
            <slot name="footer"></slot>
          </div>
        </div>
      </div>
    `;
  }

  /* ------------------------- 命令式快捷 API ------------------------- */

  /**
   * 确认框：resolve true=确认 / false=取消或关闭。
   * 动态创建实例挂到 body，结束后自清理，调用方零模板侵入。
   */
  static confirm(opts: AhModalOptions & { maskClosable?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      const el = document.createElement('ah-modal') as AhModal;
      Object.assign(el, {
        variant: 'confirm' as ModalVariant,
        confirmText: '确定',
        cancelText: '取消',
        ...opts
      });
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        resolve(v);
        el.remove();
      };
      el.addEventListener('ah-confirm', () => finish(true));
      el.addEventListener('ah-cancel', () => finish(false));
      el.addEventListener('close', () => finish(false));
      document.body.appendChild(el);
      el.open = true;
    });
  }

  /** 信息提示框：仅有确认按钮，resolve void。 */
  static alert(opts: AhModalOptions): Promise<void> {
    return new Promise((resolve) => {
      const el = document.createElement('ah-modal') as AhModal;
      Object.assign(el, {
        variant: 'info' as ModalVariant,
        confirmText: '知道了',
        showCancel: false,
        ...opts
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
        el.remove();
      };
      el.addEventListener('ah-confirm', finish);
      el.addEventListener('close', finish);
      document.body.appendChild(el);
      el.open = true;
    });
  }

  /** 输入框（prompt 形态）：resolve 输入值；取消/关闭返回 null。 */
  static prompt(opts: AhModalOptions & { inputValue?: string; inputPlaceholder?: string }): Promise<string | null> {
    return new Promise((resolve) => {
      const el = document.createElement('ah-modal') as AhModal;
      Object.assign(el, {
        variant: 'confirm' as ModalVariant,
        confirmText: '确定',
        cancelText: '取消',
        showInput: true,
        ...opts
      });
      let done = false;
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        resolve(v);
        el.remove();
      };
      el.addEventListener('ah-confirm', (e) =>
        finish(String((e as CustomEvent).detail?.inputValue ?? ''))
      );
      el.addEventListener('ah-cancel', () => finish(null));
      el.addEventListener('close', () => finish(null));
      document.body.appendChild(el);
      el.open = true;
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ah-modal': AhModal;
  }
}
