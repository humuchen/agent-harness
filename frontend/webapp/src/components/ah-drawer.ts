/**
 * ah-drawer：通用抽屉组件（mac-ui 适配层）
 * ---------------------------------------------------------------
 * 基于 @humuchen/mac-ui 的 MacDrawer 实现，保持原有 AhDrawer 公开 API 不变：
 *   - 四个滑入方向：left / right（默认）/ top / bottom
 *   - 声明式 API：<ah-drawer ?open placement title size mask mask-closable esc-closable show-close>
 *   - 事件：@close(detail: "esc"|"mask"|"button"), @ah-open, @ah-confirm
 *
 * 与 mac-ui MacDrawer 的映射：
 *   size → width/height（根据 placement 自动判断方向）
 *   mask → showMask（false 时为 'transparent' 穿透）
 *   esc-closable → closeOnEsc
 *   show-close → closable
 *
 * 实现方式：由于 MacDrawer 使用 portal 机制移动子元素，AhDrawer 采用命令式创建
 * mac-drawer 节点并挂载到 document.body，同时把 light DOM 子节点转移过去。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';

export type DrawerPlacement = 'left' | 'right' | 'top' | 'bottom';
export type DrawerCloseReason = 'esc' | 'mask' | 'button';

@customElement('ah-drawer')
export class AhDrawer extends LitElement {
  static styles = css`
    :host {
      display: none;
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
  private _drawer: any = null;

  private _pendingReason: DrawerCloseReason = 'button';
  private _movedChildren: Element[] = [];

  updated(changed: PropertyValues) {
    if (changed.has('open')) {
      if (this.open) {
        this._show();
      } else {
        this._hide();
      }
    }
    if (this.open && this._drawer) {
      this._syncProps();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._hide();
  }

  private _syncProps() {
    if (!this._drawer) return;
    const d = this._drawer;
    d.title = this.title;
    d.placement = this.placement;
    d.width = this.size;
    d.height = this.size;
    d.closable = this.showClose;
    d.maskClosable = this.maskClosable;
    d.showMask = this.mask ? true : 'transparent';
    d.closeOnEsc = this.escClosable;
  }

  private _show() {
    this._hide(); // 清理旧的

    const drawer = document.createElement('mac-drawer') as any;
    this._drawer = drawer;
    this._syncProps();

    // 转移 light DOM 子节点到 drawer（mac-ui portal 会接管它们）
    this._movedChildren = [];
    const footerSlot = this.querySelector('[slot="footer"]');
    const defaultChildren = Array.from(this.children).filter(
      (c) => c !== footerSlot && !c.hasAttribute('slot')
    );

    for (const child of defaultChildren) {
      drawer.appendChild(child);
      this._movedChildren.push(child);
    }

    // 处理 footer 插槽
    if (this.showFooter) {
      if (footerSlot) {
        drawer.appendChild(footerSlot);
        this._movedChildren.push(footerSlot);
      } else {
        const footer = document.createElement('div');
        footer.setAttribute('slot', 'footer');
        footer.innerHTML = `
          <button type="button" class="btn ghost" data-role="cancel">${this.cancelText}</button>
          <button type="button" class="btn primary" data-role="confirm">${this.confirmText}</button>
        `;
        footer.style.cssText = `
          display: flex; justify-content: flex-end; gap: 10px;
          padding: 12px 16px; border-top: 1px solid var(--ah-border);
        `;
        // 绑定按钮事件
        const cancelBtn = footer.querySelector('[data-role="cancel"]');
        const confirmBtn = footer.querySelector('[data-role="confirm"]');
        cancelBtn?.addEventListener('click', () => {
          this._pendingReason = 'button';
          drawer.open = false;
        });
        confirmBtn?.addEventListener('click', () => {
          this.dispatchEvent(new CustomEvent('ah-confirm', { bubbles: true, composed: true }));
        });
        drawer.appendChild(footer);
        this._movedChildren.push(footer);
      }
    }

    // 关闭事件
    drawer.addEventListener('mac-drawer-close', () => {
      this.dispatchEvent(new CustomEvent('close', {
        detail: this._getCloseReason(),
        bubbles: true,
        composed: true
      }));
      this._restoreChildren();
      this._drawer = null;
    });

    drawer.addEventListener('mac-drawer-open', () => {
      this.dispatchEvent(new CustomEvent('ah-open', { bubbles: true, composed: true }));
    });

    document.body.appendChild(drawer);
    drawer.open = true;
  }

  private _hide() {
    if (this._drawer) {
      this._drawer.open = false;
      // 等动画结束再清理（mac-ui 会自动派发 close 事件）
    }
  }

  private _restoreChildren() {
    // 将转移的子节点还原到 ah-drawer 中（为下次打开准备）
    for (const child of this._movedChildren) {
      if (child.parentElement !== this) {
        try {
          this.appendChild(child);
        } catch {
          // 节点可能已被销毁
        }
      }
    }
    this._movedChildren = [];
  }

  private _getCloseReason(): DrawerCloseReason {
    const r = this._pendingReason;
    this._pendingReason = 'button';
    return r;
  }

  private _onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.open) {
      this._pendingReason = 'esc';
    }
  };

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKeyDown);
  }

  render() {
    return nothing;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ah-drawer': AhDrawer;
  }
}
