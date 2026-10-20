/**
 * ah-modal：统一弹框（mac-ui 适配层）—— Svelte 迁移版
 * -------------------------------------------------------------------
 * 基于 @humuchen/mac-ui 的 MacConfirm 实现，保持原有 AhModal 公开 API 不变：
 *   - AhModal.confirm(opts) → Promise<boolean>
 *   - AhModal.alert(opts)  → Promise<void>
 *   - AhModal.prompt(opts) → Promise<string | null>
 *
 * 声明式 `<ah-modal ?open …>` 用法全库零使用（迁移前已核查），故不再提供
 * Svelte 组件包装；命令式 API 内部只操作 mac-confirm DOM，逻辑逐字保留。
 *
 * 主题：mac-ui 不读 `<html data-theme>`，故本适配层把应用主题显式下发给弹框宿主
 * （bindMacTheme），并订阅 ah:theme-changed 让已打开的弹框跟随切换。
 */
// 副作用导入：确保 mac-confirm / mac-button 已注册。
import '@humuchen/mac-ui';
import type { MacConfirm } from '@humuchen/mac-ui';
import { getTheme, type Theme } from '../theme/tokens';
import { APP_EVENTS } from '../app-events';

export type ModalVariant = 'info' | 'confirm' | 'warning';
export type ModalSize = 'sm' | 'md' | 'lg';

const SIZE_WIDTH: Record<ModalSize, string> = {
  sm: '360px',
  md: '480px',
  lg: '640px'
};

/**
 * ── mac-ui 的主题契约（@humuchen/mac-ui v0.0.3）──
 * 库内配色靠 `:host([data-theme='dark'])` 覆盖。也就是说：**组件只认自身 theme 属性 /
 * 宿主上的 data-theme 属性，或 mac-config-provider 祖先下发的值，不读 `<html data-theme>`**。
 *
 * 命令式弹框挂在 document.body 上，没有 config-provider 祖先，必须由这里显式喂入；
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
export function bindMacTheme(...els: Themeable[]): () => void {
  const sync = () => {
    const theme = getTheme();
    for (const el of els) el.theme = theme;
  };
  sync();
  window.addEventListener(APP_EVENTS.themeChanged, sync);
  return () => window.removeEventListener(APP_EVENTS.themeChanged, sync);
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

/* ------------------------- 命令式快捷 API ------------------------- */

/**
 * 确认框：resolve true=确认 / false=取消或关闭。
 */
function confirmModal(
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
      visible: false
    });
    // 弹框挂在 body，拿不到文档级主题，须显式喂入（见文件头「主题契约」）
    const stopTheme = bindMacTheme(el);
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      stopTheme();
      resolve(v);
      window.removeEventListener(APP_EVENTS.closeOverlays, onOverlayClose);
      el.remove();
    };
    // 注意：事件在 window 上派发，不会向下传播到 body 子元素，
    // 故必须监听 window 而不是弹框元素本身。
    const onOverlayClose = () => finish(false);
    window.addEventListener(APP_EVENTS.closeOverlays, onOverlayClose);
    el.addEventListener('mac-confirm-ok', () => finish(true));
    el.addEventListener('mac-confirm-cancel', () => finish(false));
    el.addEventListener('mac-confirm-close', () => finish(false));
    document.body.appendChild(el);
    el.open();
  });
}

/** 信息提示框：仅有确认按钮，resolve void。 */
function alertModal(opts: AhModalOptions): Promise<void> {
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
      visible: false
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
      window.removeEventListener(APP_EVENTS.closeOverlays, onOverlayClose);
      el.remove();
    };
    // 事件在 window 上派发，不会向下传播到 body 子元素 → 监听 window。
    const onOverlayClose = () => finish();
    window.addEventListener(APP_EVENTS.closeOverlays, onOverlayClose);
    // alert 只有一个确定按钮，点击确定或遮罩关闭都 resolve
    el.addEventListener('mac-confirm-ok', finish);
    el.addEventListener('mac-confirm-close', finish);
    document.body.appendChild(el);
    el.open();
  });
}

/** 输入框（prompt 形态）：resolve 输入值；取消/关闭返回 null。 */
function promptModal(
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
      visible: false
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
      window.removeEventListener(APP_EVENTS.closeOverlays, onOverlayClose);
      el.remove();
    };
    // 事件在 window 上派发，不会向下传播到 body 子元素 → 监听 window。
    const onOverlayClose = () => finish(null);
    window.addEventListener(APP_EVENTS.closeOverlays, onOverlayClose);
    el.addEventListener('mac-confirm-ok', () => finish(input.value));
    el.addEventListener('mac-confirm-cancel', () => finish(null));
    el.addEventListener('mac-confirm-close', () => finish(null));
    document.body.appendChild(el);
    el.open();
  });
}

/**
 * AhModal 公开 API（保持 `AhModal.confirm(...)` 调用形式不变）。
 */
export const AhModal = {
  confirm: confirmModal,
  alert: alertModal,
  prompt: promptModal
};

declare global {
  interface HTMLElementTagNameMap {
    'mac-confirm': MacConfirm;
  }
}
