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
 *
 * 主题：mac-ui 不读 `<html data-theme>`，故本适配层把应用主题显式下发给弹框宿主
 * （声明式走 `theme` 绑定、命令式走 bindMacTheme），并订阅 ah:theme-changed 让
 * 已打开的弹框跟随切换 —— 否则暗色主题下弹框会是浅色（详见下方「主题契约」）。
 */
import { LitElement, html, css, nothing } from 'lit';
import { mobilePill } from '../styles/mobile-pill';
import { customElement, property, state } from 'lit/decorators.js';
// 副作用导入：确保 mac-confirm / mac-button 已注册。
// （上面那种只用作类型的具名导入会被 esbuild 整体擦除，不触发库的注册副作用；
//   若只依赖 components/index.ts 的全局注册，单独引用本文件的页面/探针会拿到未升级元素。）
import '@humuchen/mac-ui';
import { MacConfirm } from '@humuchen/mac-ui';
import type { ConfirmOptions } from '@humuchen/mac-ui';
import { getTheme, type Theme } from '../theme/tokens';

export type ModalVariant = 'info' | 'confirm' | 'warning';
export type ModalSize = 'sm' | 'md' | 'lg';

const SIZE_WIDTH: Record<ModalSize, string> = {
  sm: '360px',
  md: '480px',
  lg: '640px'
};

/**
 * ── mac-ui 的主题契约（@humuchen/mac-ui v0.0.3）──
 * 库内配色靠 `:host([data-theme='dark'])` 覆盖（全库 92 处；仅菜单 portal 读过一次
 * 文档级属性）。也就是说：**组件只认自身 `theme` 属性 / 宿主上的 data-theme 属性，
 * 或 `mac-config-provider` 祖先下发的值，不读 `<html data-theme>`**。
 *
 * 本适配层的两种用法都拿不到主题，必须由这里显式喂入：
 *   1) 命令式弹框（confirm/alert/prompt）挂在 `document.body` 上，没有 config-provider 祖先；
 *   2) 声明式弹框在 `ah-modal` 的 shadow root 内，`parentElement` 链到 shadow 边界即中断，
 *      同样找不到文档级 provider。
 * 若不喂，弹框会一直用库内默认的浅色令牌 —— 即暗色主题下出现「白底深字」的突兀弹框。
 *
 * 注：库基类会在 update 时用 `theme ?? 父 provider 的 data-theme` 回写自身 data-theme，
 * 值为空时**移除**该属性；所以不能只手工 `setAttribute('data-theme')`（会被抹掉），
 * 必须走 `theme` 属性。
 */

/** 可被 mac-ui 主题化的元素（库的 BaseElement 均带 `theme?: 'light' | 'dark'`）。 */
type Themeable = { theme?: Theme };

/**
 * 把当前应用主题写给一个或多个 mac-ui 元素，并订阅主题变更（切主题时已打开的弹框跟随）。
 * @returns 解绑函数；弹框销毁时务必调用，避免 window 监听泄漏。
 */
function bindMacTheme(...els: Themeable[]): () => void {
  const sync = () => {
    const theme = getTheme();
    for (const el of els) el.theme = theme;
  };
  sync();
  window.addEventListener('ah:theme-changed', sync);
  return () => window.removeEventListener('ah:theme-changed', sync);
}

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
  static styles = [css`
    :host {
      display: none;
    }
    :host([open]) {
      display: block;
    }
  `, mobilePill];

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

  /** 当前应用主题：mac-ui 不读文档级属性，须显式下发给弹框宿主（见文件头「主题契约」）。 */
  @state() private macTheme: Theme = getTheme();

  private onThemeChanged = () => {
    this.macTheme = getTheme();
  };

  connectedCallback() {
    super.connectedCallback();
    this.macTheme = getTheme();
    window.addEventListener('ah:theme-changed', this.onThemeChanged);
    window.addEventListener('ah:close-overlays', this.onCloseOverlays);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('ah:theme-changed', this.onThemeChanged);
    window.removeEventListener('ah:close-overlays', this.onCloseOverlays);
  }

  /** 路由切换或浏览器后退/前进时关闭声明式弹窗。 */
  private onCloseOverlays = () => {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(
      new CustomEvent('close', { bubbles: true, composed: true })
    );
  };

  render() {
    if (!this.open) return nothing;
    const width = this.width || SIZE_WIDTH[this.size];
    return html`
      <mac-confirm
        ?visible=${this.open}
        theme=${this.macTheme}
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
      // 弹框挂在 body，拿不到文档级主题，须显式喂入（见文件头「主题契约」）
      const stopTheme = bindMacTheme(el);
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        stopTheme();
        resolve(v);
        window.removeEventListener('ah:close-overlays', onOverlayClose);
        el.remove();
      };
      // 注意：事件在 window 上派发，不会向下传播到 body 子元素，
      // 故必须监听 window 而不是弹框元素本身。
      const onOverlayClose = () => finish(false);
      window.addEventListener('ah:close-overlays', onOverlayClose);
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

      // 自定义 footer 里的 mac-button 是 el 的 light DOM 子节点，同样拿不到文档级主题
      const okBtn = footerSlot.querySelector('mac-button') as Themeable | null;
      const stopTheme = okBtn ? bindMacTheme(el, okBtn) : bindMacTheme(el);

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        stopTheme();
        resolve();
        window.removeEventListener('ah:close-overlays', onOverlayClose);
        el.remove();
      };
      // 事件在 window 上派发，不会向下传播到 body 子元素 → 监听 window。
      const onOverlayClose = () => finish();
      window.addEventListener('ah:close-overlays', onOverlayClose);
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

      // 弹框挂在 body，拿不到文档级主题，须显式喂入（见文件头「主题契约」）
      const stopTheme = bindMacTheme(el);

      let done = false;
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        stopTheme();
        resolve(v);
        window.removeEventListener('ah:close-overlays', onOverlayClose);
        el.remove();
      };
      // 事件在 window 上派发，不会向下传播到 body 子元素 → 监听 window。
      const onOverlayClose = () => finish(null);
      window.addEventListener('ah:close-overlays', onOverlayClose);
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
