import { basename } from 'node:path';
/**
 * ah-drawer：通用抽屉组件（components 目录 · 全应用唯一的侧滑抽屉原语）。
 *
 * 取代散落在各处的移动端侧栏 / 临时浮层抽屉，提供：
 * - 四个滑入方向：left（左侧滑入）/ right（右侧滑入，默认）/ top（顶部下拉）/ bottom（底部上拉）。
 * - 声明式 API：
 *     <ah-drawer ?open placement title size mask mask-closable esc-closable show-close
 *       @ah-open=... @close=...>
 *       <p>默认插槽：抽屉主体内容</p>
 *       <div slot="footer">底部操作区</div>
 *     </ah-drawer>
 * - 关闭途径：Esc（escClosable 可关）/ 遮罩点击（mask + maskClosable 可关）/ × 按钮（showClose）。
 *   组件先播离场动画再置 open=false 并派发 close，调用方只需在 @close 里复位自己的 open 状态。
 * - 无障碍：role=dialog + aria-modal + aria-labelledby；打开时焦点移入面板（有标题则聚焦关闭按钮、
 *   否则聚焦面板）、Tab 焦点圈闭环、关闭后焦点归还触发元素、prefers-reduced-motion 下禁用动画。
 * - 滚动锁定：仅当显示遮罩（mask）时锁定 document.body 滚动，关闭后还原（与 app.ts 移动端抽屉一致）。
 * - 主题：仅引用 --ah-* 令牌，深浅色主题与全应用一致。
 *
 * 命名空间与 ah-modal 对齐：打开完成派发 `ah-open`，关闭完成派发 `close`（detail 为发起方式
 * "esc" | "mask" | "button"），调用方通常 @close=${() => (this.open = false)}。
 *
 * 用法示例：
 *   <ah-drawer
 *     ?open=${this.showFilter}
 *     placement="right"
 *     title="筛选"
 *     size="360px"
 *     @close=${() => (this.showFilter = false)}
 *   >
 *     <div class="filter-body">…</div>
 *     <div slot="footer"><button @click=${this.apply}>应用</button></div>
 *   </ah-drawer>
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';

export type DrawerPlacement = 'left' | 'right' | 'top' | 'bottom';
/** 关闭发起方式，随 close 事件 detail 派发，便于调用方区分场景。 */
export type DrawerCloseReason = 'esc' | 'mask' | 'button';

/** 离场动画时长（ms），与 CSS .leaving 过渡保持一致。 */
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
      background: rgba(0, 0, 0, 0.45);
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
      background: var(--ah-surface-1);
      color: var(--ah-text);
      border: 1px solid var(--ah-border);
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
    /* 离场：滑回屏幕外 + 淡出；.leaving 由 finish() 在关闭时挂上。 */
    .leaving .panel {
      transform: var(--ahd-from);
      transition: transform ${LEAVE_MS}ms cubic-bezier(0.4, 0, 0.2, 1),
        opacity ${LEAVE_MS}ms ease;
      opacity: 0;
    }

    /* 无障碍：用户偏好减少动效时禁用所有过渡/动画 */
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
      border-bottom: 1px solid var(--ah-border);
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
    }
    .close {
      flex: none;
      margin-left: auto;
      border: none;
      background: none;
      color: var(--ah-text-faint);
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      padding: 0 8px;
      border-radius: var(--ah-radius-sm);
    }
    .close:hover {
      color: var(--ah-text);
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
      border-top: 1px solid var(--ah-border);
      flex: 0 0 auto;
    }
    /* footer 按钮：复用全应用统一 .btn 体系（与 ah-modal 一致），保证视觉统一。 */
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
      /* 窄屏下侧滑/上下抽屉尽量占满，避免内容被挤。 */
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

  /** 是否打开（reflect，供 :host([open]) 与外部状态绑定）。 */
  @property({ type: Boolean, reflect: true })
  open = false;

  /** 滑入方向：left / right（默认）/ top / bottom。 */
  @property({ type: String })
  placement: DrawerPlacement = 'right';

  /** 标题；为空且 showClose=false 时不渲染头部。 */
  @property({ type: String })
  title = '';

  /** 尺寸：左右方向为宽度、上下方向为高度（CSS 值，如 "320px" / "40vh"）。 */
  @property({ type: String })
  size = '320px';

  /** 是否显示遮罩（false 时为非模态抽屉，外部点击穿透）。 */
  @property({ type: Boolean })
  mask = true;

  /** 点击遮罩是否关闭（需 mask=true 才有遮罩可点）。 */
  @property({ type: Boolean, attribute: 'mask-closable' })
  maskClosable = true;

  /** 按下 Esc 是否关闭。 */
  @property({ type: Boolean, attribute: 'esc-closable' })
  escClosable = true;

  /** 是否显示右上角 × 按钮。 */
  @property({ type: Boolean, attribute: 'show-close' })
  showClose = true;

  /** 是否显示底部。 */
  @property({ type: Boolean, attribute: 'show-footer' })
  showFooter = true;

  /** 默认 footer 的确认按钮文案（调用方未通过 footer 插槽自定义时生效）。 */
  @property({ type: String, attribute: 'confirm-text' })
  confirmText = '确定';

  /** 默认 footer 的取消按钮文案。 */
  @property({ type: String, attribute: 'cancel-text' })
  cancelText = '取消';

  /** 离场动画进行中标记。 */
  @state()
  private leaving = false;

  /** 打开前聚焦的元素，关闭后归还焦点。 */
  private lastFocus: HTMLElement | null = null;

  updated(changed: PropertyValues) {
    if (!changed.has('open')) return;
    if (this.open) {
      this.lastFocus = document.activeElement as HTMLElement | null;
      if (this.mask) document.body.style.overflow = 'hidden';
      // 等一帧让面板渲染完成后再移焦（有标题优先聚焦关闭按钮，否则聚焦面板）。
      requestAnimationFrame(() => {
        const target =
          (this.shadowRoot?.querySelector<HTMLElement>('.close') ?? null) ||
          this.shadowRoot?.querySelector<HTMLElement>('.panel');
        target?.focus();
      });
      this.dispatchEvent(
        new CustomEvent('ah-open', { bubbles: true, composed: true })
      );
    } else if (this.lastFocus) {
      try {
        this.lastFocus.focus();
      } catch {
        /* 触发元素已被移除等场景忽略 */
      }
      this.lastFocus = null;
      if (this.mask) document.body.style.overflow = '';
    }
  }

  /** 发起关闭：播放离场动画 → open=false + 派发 close（detail 为关闭方式）。 */
  private finish(reason: DrawerCloseReason) {
    if (!this.open || this.leaving) return;
    this.leaving = true;
    window.setTimeout(() => {
      this.leaving = false;
      this.open = false;
      this.dispatchEvent(
        new CustomEvent('close', {
          detail: reason,
          bubbles: true,
          composed: true
        })
      );
    }, LEAVE_MS);
  }

  /**
   * 默认 footer 的「确定」按钮：仅派发 ah-confirm 事件，不直接关闭抽屉，
   * 由调用方在 @ah-confirm 里执行确认逻辑（保存 / 提交等），需要关闭时
   * 自行置 open=false（或复用 close 事件复位）。取消按钮则直接 finish('button') 关闭。
   */
  private onConfirm() {
    this.dispatchEvent(
      new CustomEvent('ah-confirm', { bubbles: true, composed: true })
    );
  }

  private onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (!this.escClosable) return;
      e.stopPropagation();
      this.finish('esc');
      return;
    }
    if (e.key !== 'Tab') return;
    // 焦点圈闭环：Tab 循环限制在面板内（shadow 控件 + 插槽内容里的可聚焦元素）。
    const focusables: HTMLElement[] = [
      ...(this.shadowRoot?.querySelectorAll<HTMLElement>(
        '.panel button, .panel input, .panel select, .panel textarea, .panel [tabindex]'
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
                  ? html`<div class="title" id="ahd-title">${this.title}</div>`
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
          ${this.showFooter
            ? html`<div class="foot">
                ${this.querySelector('[slot="footer"]')
                  ? html`<slot name="footer"></slot>`
                  : html`<button
                        type="button"
                        class="btn ghost"
                        @click=${() => this.finish('button')}
                      >
                        ${this.cancelText}
                      </button>
                      <button
                        type="button"
                        class="btn primary"
                        @click=${this.onConfirm}
                      >
                        ${this.confirmText}
                      </button>`}
              </div>`
            : nothing}
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
