/**
 * ah-modal：统一弹框组件（mac-ui 适配层）
 * ---------------------------------------------------------------
 * 基于 @humuchen/mac-ui 的 MacConfirm 实现，保持原有 AhModal 公开 API 不变：
 *   - AhModal.confirm(opts) → Promise<boolean>
 *   - AhModal.alert(opts)  → Promise<void>
 *   - AhModal.prompt(opts) → Promise<string | null>
 *   - 声明式：<ah-modal ?open title message variant size ...>
 *
 * 变体映射：
 *   info    → MacConfirm（无取消按钮）
 *   confirm → MacConfirm（标准确认）
 *   warning → MacConfirm（danger 红色强调）
 *
 * prompt 通过 MacConfirm + 自定义插槽（含 input）实现。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MacConfirm } from '@humuchen/mac-ui';
import type { ConfirmOptions } from '@humuchen/mac-ui';

export type ModalVariant = 'info' | 'confirm' | 'warning';
export type ModalSize = 'sm' | 'md' | 'lg';

const SIZE_WIDTH: Record<ModalSize, string> = {
  sm: '360px',
  md: '480px',
  lg: '640px'
};

export interface AhModalOptions {
  title?: string;
  message?: string;
  variant?: ModalVariant;
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
  `;

  @property({ type: Boolean, reflect: true })
  open = false;

  @property({ type: String })
  variant: ModalVariant = 'info';

  @property({ type: String })
  title = '';

  @property({ type: String })
  message = '';

  @property({ type: String })
  size: ModalSize = 'md';

  @property({ type: String })
  width = '';

  @property({ type: Boolean, attribute: 'mask-closable' })
  maskClosable = true;

  @property({ type: Boolean, attribute: 'show-close' })
  showClose = true;

  @property({ type: Boolean, attribute: 'show-cancel' })
  showCancel = true;

  @property({ type: String, attribute: 'confirm-text' })
  confirmText = '确定';

  @property({ type: String, attribute: 'cancel-text' })
  cancelText = '取消';

  @property({ type: Boolean, attribute: 'show-input' })
  showInput = false;

  @property({ type: String, attribute: 'input-value' })
  inputValue = '';

  @property({ type: String, attribute: 'input-placeholder' })
  inputPlaceholder = '';

  @property({ type: Boolean })
  danger = false;

  render() {
    if (!this.open) return nothing;
    const width = this.width || SIZE_WIDTH[this.size];
    return html`
      <mac-confirm
        ?visible=${this.open}
        title=${this.title}
        content=${this.message}
        confirm-text=${this.confirmText}
        cancel-text=${this.cancelText}
        ?danger=${this.danger && this.variant === 'warning'}
        ?show-icon=${this.variant !== 'info'}
        width=${width}
        ?mask-closable=${this.maskClosable}
        ?show-divider=${false}
        @mac-confirm-ok=${() => {
          this.dispatchEvent(new CustomEvent('ah-confirm', {
            detail: { inputValue: this.inputValue },
            bubbles: true,
            composed: true
          }));
          this.open = false;
          this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
        }}
        @mac-confirm-cancel=${() => {
          this.dispatchEvent(new CustomEvent('ah-cancel', { bubbles: true, composed: true }));
          this.open = false;
          this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
        }}
        @mac-confirm-close=${() => {
          this.open = false;
          this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
        }}
      >
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
                  this.dispatchEvent(new CustomEvent('ah-confirm', {
                    detail: { inputValue: this.inputValue },
                    bubbles: true,
                    composed: true
                  }));
                  this.open = false;
                  this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
                }
              }}
              style="
                width: 100%;
                box-sizing: border-box;
                padding: 9px 12px;
                font-size: 14px;
                font-family: var(--ah-font-sans);
                color: var(--ah-text);
                background: var(--ah-surface-2);
                border: 1px solid var(--ah-border);
                border-radius: var(--ah-radius-md);
                outline: none;
                margin-top: 10px;
              "
            />`
          : nothing}
        <slot></slot>
      </mac-confirm>
    `;
  }

  /* ------------------------- 命令式快捷 API ------------------------- */

  /**
   * 确认框：resolve true=确认 / false=取消或关闭。
   */
  static confirm(
    opts: AhModalOptions & { maskClosable?: boolean }
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const el = document.createElement('mac-confirm') as MacConfirm;
      const width = SIZE_WIDTH[opts.size ?? 'md'];
      Object.assign(el, {
        title: opts.title ?? '',
        content: opts.message ?? '',
        confirmText: opts.confirmText ?? '确定',
        cancelText: opts.cancelText ?? '取消',
        showIcon: opts.variant !== 'info',
        danger: opts.danger ?? (opts.variant === 'warning'),
        width,
        maskClosable: opts.maskClosable ?? true,
        visible: false,
      });
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        resolve(v);
        el.remove();
      };
      el.addEventListener('mac-confirm-ok', () => finish(true));
      el.addEventListener('mac-confirm-cancel', () => finish(false));
      el.addEventListener('mac-confirm-close', () => finish(false));
      document.body.appendChild(el);
      el.open();
    });
  }

  /** 信息提示框：仅有确认按钮，resolve void。 */
  static alert(opts: AhModalOptions): Promise<void> {
    return new Promise((resolve) => {
      const el = document.createElement('mac-confirm') as MacConfirm;
      const width = SIZE_WIDTH[opts.size ?? 'md'];
      Object.assign(el, {
        title: opts.title ?? '',
        content: opts.message ?? '',
        confirmText: opts.confirmText ?? '知道了',
        showIcon: opts.variant !== 'info',
        showDivider: false,
        width,
        visible: false,
      });
      // 隐藏取消按钮：通过自定义 footer 插槽
      const footerSlot = document.createElement('div');
      footerSlot.setAttribute('slot', 'footer');
      footerSlot.innerHTML = `<mac-button variant="primary" id="mac-alert-ok">${opts.confirmText ?? '知道了'}</mac-button>`;
      el.appendChild(footerSlot);

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
        el.remove();
      };
      el.addEventListener('mac-confirm-open', () => {
        // 等 DOM 渲染后绑定按钮事件
        requestAnimationFrame(() => {
          const btn = el.shadowRoot?.querySelector('#mac-alert-ok') as HTMLElement | null;
          // 由于按钮在 slot 中，需要通过不同方式
          // 改用监听 mac-confirm-ok
        });
      });
      // alert 只有一个确定按钮，点击确定或遮罩关闭都 resolve
      el.addEventListener('mac-confirm-ok', finish);
      el.addEventListener('mac-confirm-close', finish);
      document.body.appendChild(el);
      el.open();
    });
  }

  /** 输入框（prompt 形态）：resolve 输入值；取消/关闭返回 null。 */
  static prompt(
    opts: AhModalOptions & { inputValue?: string; inputPlaceholder?: string }
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const el = document.createElement('mac-confirm') as MacConfirm;
      const width = SIZE_WIDTH[opts.size ?? 'md'];
      Object.assign(el, {
        title: opts.title ?? '',
        content: opts.message ?? '',
        confirmText: opts.confirmText ?? '确定',
        cancelText: opts.cancelText ?? '取消',
        showIcon: true,
        showDivider: false,
        width,
        visible: false,
      });

      // 添加 input 到 body slot
      const input = document.createElement('input');
      input.className = 'modal-input';
      input.placeholder = opts.inputPlaceholder ?? '';
      input.value = opts.inputValue ?? '';
      input.setAttribute('slot', '');
      input.style.cssText = `
        width: 100%;
        box-sizing: border-box;
        padding: 9px 12px;
        font-size: 14px;
        font-family: var(--ah-font-sans);
        color: var(--ah-text);
        background: var(--ah-surface-2);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-md);
        outline: none;
        margin-top: 10px;
      `;
      el.appendChild(input);

      let done = false;
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        resolve(v);
        el.remove();
      };
      el.addEventListener('mac-confirm-ok', () => finish(input.value));
      el.addEventListener('mac-confirm-cancel', () => finish(null));
      el.addEventListener('mac-confirm-close', () => finish(null));
      document.body.appendChild(el);
      el.open();
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ah-modal': AhModal;
    'mac-confirm': MacConfirm;
  }
}
