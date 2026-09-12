/**
 * ah-drawer：通用抽屉组件（mac-ui 适配层）
 * ---------------------------------------------------------------
 * 基于 @humuchen/mac-ui 的 MacDrawer 实现，保持原有 AhDrawer 公开 API 不变：
 *   - 四个滑入方向：left / right（默认）/ top / bottom
 *   - 声明式 API：<ah-drawer ?open placement title size mask mask-closable esc-closable show-close>
 *   - 事件：@close(detail: "esc"|"mask"|"button"), @ah-open, @ah-confirm
 *
 * 实现方式：由于 MacDrawer 使用 portal 机制将子节点移到 document.body，导致
 * shadow DOM 内的样式（chat-styles.ts 等）全部丢失。因此本组件在 shadow DOM
 * 内自行渲染抽屉面板，仅复用 mac-ui 的视觉令牌（--md-drawer-*）。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';

export type DrawerPlacement = 'left' | 'right' | 'top' | 'bottom';
export type DrawerCloseReason = 'esc' | 'mask' | 'button';

/** 离场动画时长（ms），与 mac-ui 保持一致。 */
const LEAVE_MS = 220;

@customElement('ah-drawer')
export class AhDrawer extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
    :host([open]) {
      display: block;
    }

    /* 全屏定位层：默认不拦截指针，仅遮罩与面板各自开启 pointer-events，
       这样 mask=false 时抽屉为非模态，外部点击可穿透到下层页面。 */
    .overlay {
      position: fixed;
      inset: 0;
      z-index: var(--ahd-z, 1060);
      display: flex;
      pointer-events: none;
    }
    .scrim {
      position: absolute;
      inset: 0;
      background: var(--md-drawer-mask-bg, rgba(0, 0, 0, 0.45));
      pointer-events: auto;
      opacity: 0;
      animation: ahd-scrim-in 0.22s ease forwards;
    }
    .leaving .scrim {
      opacity: 0;
      transition: opacity ${LEAVE_MS}ms ease;
    }
    @keyframes ahd-scrim-in {
      to {
        opacity: 1;
      }
    }

    /* 方向布局：overlay 用 flex 把面板贴到对应边缘；面板非动画态 transform 为 none。 */
    .left {
      align-items: stretch;
      justify-content: flex-start;
      --ahd-from: translateX(-100%);
    }
    .right {
      align-items: stretch;
      justify-content: flex-end;
      --ahd-from: translateX(100%);
    }
    .top {
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-start;
      --ahd-from: translateY(-100%);
    }
    .bottom {
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-end;
      --ahd-from: translateY(100%);
    }

    .panel {
      position: relative;
      z-index: 1;
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      background: var(--md-drawer-bg, var(--ah-surface-1));
      color: var(--ah-text);
      border: 1px solid var(--md-drawer-border, var(--ah-border));
      box-shadow: var(--ah-shadow);
      overflow: hidden;
      animation: ahd-slide-in 0.22s cubic-bezier(0.2, 0.8, 0.3, 1);
    }
    .left .panel,
    .right .panel {
      width: var(--ahd-size, 320px);
      max-width: 100vw;
      height: 100%;
    }
    .top .panel,
    .bottom .panel {
      width: 100%;
      height: var(--ahd-size, 320px);
      max-height: 100dvh;
    }
    @keyframes ahd-slide-in {
      from {
        transform: var(--ahd-from);
      }
    }
    .leaving .panel {
      transform: var(--ahd-from);
      transition: transform ${LEAVE_MS}ms cubic-bezier(0.4, 0, 0.2, 1),
        opacity ${LEAVE_MS}ms ease;
      opacity: 0;
    }

    @media (prefers-reduced-motion: reduce) {
      .scrim,
      .panel,
      .leaving .scrim,
      .leaving .panel {
        animation: none !important;
        transition: none !important;
      }
    }

    .head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7.5px 16px;
      border-bottom: 1px solid var(--md-drawer-header-border, var(--ah-border));
      flex: 0 0 auto;
    }
    .title {
      font-family: var(--ah-font-display);
      font-weight: 600;
      font-size: 15px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1 1 auto;
      color: var(--md-drawer-title-color, var(--ah-text));
    }
    .close {
      flex: none;
      margin-left: auto;
      border: none;
      background: none;
      color: var(--md-drawer-close-color, var(--ah-text-faint));
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      padding: 0 8px;
      border-radius: var(--ah-radius-sm);
    }
    .close:hover {
      background: var(--md-drawer-close-hover-bg, var(--ah-surface-2));
    }

    .body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: 16px;
      font-size: 14px;
      line-height: 1.6;
      color: var(--ah-text);
    }
    .foot {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 12px 16px;
      border-top: 1px solid var(--md-drawer-footer-border, var(--ah-border));
      flex: 0 0 auto;
    }
    .foot .btn {
      min-width: 76px;
      padding: 8px 16px;
      font-size: 13px;
      font-family: var(--ah-font-sans);
      cursor: pointer;
      border-radius: var(--ah-radius-md);
      border: 1px solid var(--ah-border);
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    .foot .btn.ghost {
      background: transparent;
      color: var(--ah-text-muted);
    }
    .foot .btn.ghost:hover {
      color: var(--ah-text);
      border-color: var(--ah-text-faint);
    }
    .foot .btn.primary {
      background: var(--ah-accent);
      border-color: var(--ah-accent);
      color: #fff;
      font-weight: 600;
    }
    .foot .btn.primary:hover {
      background: var(--ah-accent-strong);
      border-color: var(--ah-accent-strong);
    }
    .foot .btn:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: 2px;
    }

    @media (max-width: 600px) {
      .left .panel,
      .right .panel {
        width: min(88vw, var(--ahd-size, 320px));
      }
      .top .panel,
      .bottom .panel {
        height: min(70dvh, var(--ahd-size, 320px));
      }
      .foot {
        flex-direction: row-reverse;
      }
      .foot > ::slotted(*) {
        flex: 1;
      }
      .foot .btn {
        flex: 1;
      }
    }
  `;

  @property({ type: Boolean, reflect: true })
  open = false;

  @property({ type: String })
  placement: DrawerPlacement = 'right';

  @property({ type: String })
  title = '';

  @property({ type: String })
  size = '320px';

  @property({ type: Boolean })
  mask = true;

  @property({ type: Boolean, attribute: 'mask-closable' })
  maskClosable = true;

  @property({ type: Boolean, attribute: 'esc-closable' })
  escClosable = true;

  @property({ type: Boolean, attribute: 'show-close' })
  showClose = true;

  @property({ type: String, attribute: 'confirm-text' })
  confirmText = '确定';

  @property({ type: String, attribute: 'cancel-text' })
  cancelText = '取消';

  @property({ type: Boolean, attribute: 'show-footer' })
  showFooter = false;

  @state()
  private leaving = false;

  private lastFocus: HTMLElement | null = null;

  updated(changed: PropertyValues) {
    if (!changed.has('open')) return;
    if (this.open) {
      this.lastFocus = document.activeElement as HTMLElement | null;
      if (this.mask) document.body.style.overflow = 'hidden';
      requestAnimationFrame(() => {
        const target = this.shadowRoot?.querySelector<HTMLElement>('.close') ??
          this.shadowRoot?.querySelector<HTMLElement>('.panel');
        target?.focus();
      });
      this.dispatchEvent(new CustomEvent('ah-open', { bubbles: true, composed: true }));
    } else if (this.lastFocus) {
      try { this.lastFocus.focus(); } catch {}
      this.lastFocus = null;
      if (this.mask) document.body.style.overflow = '';
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.mask) document.body.style.overflow = '';
  }

  private finish(reason: DrawerCloseReason) {
    if (!this.open || this.leaving) return;
    this.leaving = true;
    window.setTimeout(() => {
      this.leaving = false;
      this.open = false;
      this.dispatchEvent(new CustomEvent('close', {
        detail: reason,
        bubbles: true,
        composed: true
      }));
    }, LEAVE_MS);
  }

  private onConfirm() {
    this.dispatchEvent(new CustomEvent('ah-confirm', { bubbles: true, composed: true }));
  }

  private onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (!this.escClosable) return;
      e.stopPropagation();
      this.finish('esc');
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = this.getFocusableElements();
    if (!focusables.length) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = this.shadowRoot?.activeElement as HTMLElement | null;
    const activeIn = active !== null && focusables.includes(active);
    if (e.shiftKey && (active === first || !activeIn)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !activeIn)) {
      e.preventDefault();
      first.focus();
    }
  }

  private getFocusableElements(): HTMLElement[] {
    const panelEls = this.shadowRoot?.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, [tabindex]'
    ) ?? [];
    const slotEls = Array.from(this.children)
      .filter(c => !(c as HTMLElement).hasAttribute?.('slot'))
      .flatMap(c =>
        c.matches('button, input, select, textarea, a[href], [tabindex]')
          ? [c as HTMLElement]
          : Array.from(c.querySelectorAll<HTMLElement>(
              'button, input, select, textarea, a[href], [tabindex]'
            ))
      );
    return [...Array.from(panelEls), ...slotEls]
      .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
  }

  private renderFooter() {
    if (!this.showFooter) return nothing;
    const footerSlot = this.querySelector('[slot="footer"]');
    if (footerSlot) {
      return html`<div class="foot"><slot name="footer"></slot></div>`;
    }
    return html`<div class="foot">
      <button type="button" class="btn ghost" @click=${() => this.finish('button')}>
        ${this.cancelText}
      </button>
      <button type="button" class="btn primary" @click=${this.onConfirm}>
        ${this.confirmText}
      </button>
    </div>`;
  }

  render() {
    if (!this.open) return nothing;
    const showHead = !!this.title || this.showClose;
    return html`
      <div class="overlay ${this.placement} ${this.leaving ? 'leaving' : ''}">
        ${this.mask
          ? html`<div
              class="scrim"
              @click=${(e: MouseEvent) => {
                if (this.maskClosable && e.target === e.currentTarget)
                  this.finish('mask');
              }}
            ></div>`
          : nothing}
        <aside
          class="panel"
          style="--ahd-size:${this.size}"
          role="dialog"
          aria-modal="true"
          aria-label=${this.title || '抽屉'}
          tabindex="-1"
          @keydown=${this.onKeydown}
        >
          ${showHead
            ? html`<div class="head">
                ${this.title
                  ? html`<div class="title">${this.title}</div>`
                  : ''}
                <slot name="header"></slot>
                ${this.showClose
                  ? html`<button
                      type="button"
                      class="close"
                      title="关闭"
                      aria-label="关闭"
                      @click=${() => this.finish('button')}
                    >
                      ×
                    </button>`
                  : nothing}
              </div>`
            : nothing}
          <div class="body"><slot></slot></div>
          ${this.renderFooter()}
        </aside>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ah-drawer': AhDrawer;
  }
}
