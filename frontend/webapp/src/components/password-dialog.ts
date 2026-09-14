/**
 * ah-password-dialog：修改密码模态（共享组件）。
 *
 * 由 `user-menu`（顶栏头像下拉 / 移动端「我的」页）承载的改密入口使用；
 * 抽为独立组件是为了把表单与校验从菜单组件里分出来，便于单测与复用。
 * （设置中心已移除「账户」分组，改密入口全站只有 user-menu 一处。）
 *
 * 交互与校验：
 *  - 受控打开：父组件绑定 `?open`，组件内部关闭时派发 `ah-pw-close` 让父级同步状态。
 *  - 校验前移到前端（规则同登录 / 注册，见 utils/auth-validation.ts）；校验失败 /
 *    后端报错 / 网络异常一律走 ah-notification，模态内不保留内联错误条。
 *  - 关闭途径：Esc / 遮罩点击 / 「取消」/ 右上角 ×；提交中禁止关闭（避免请求悬挂）。
 *  - 新密码客户端 PBKDF2 派生后提交（P1-14），明文新密码不出网；旧密码仍需服务端校验。
 *
 * 视觉：仅引用 --ah-* 语义令牌，与全站（topbar / ah-modal / 登录页）一致；深浅主题自适应。
 */
import {
  LitElement,
  html,
  css,
  type PropertyValues,
  type TemplateResult
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { changePassword, derivePassword, bytesToHex } from '../api';
import { notify } from './ah-notification';
import { validateChangePassword } from '../utils/auth-validation';

@customElement('ah-password-dialog')
export class AhPasswordDialog extends LitElement {
  static styles = css`
    :host {
      display: contents;
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
      animation: ahpd-fade 0.16s ease;
    }
    @keyframes ahpd-fade {
      from {
        opacity: 0;
      }
    }
    .panel {
      width: min(calc(100vw - 32px), 420px);
      background: var(--ah-surface-1);
      color: var(--ah-text);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-lg);
      box-shadow: var(--ah-shadow);
      overflow: hidden;
      animation: ahpd-pop 0.16s cubic-bezier(0.2, 0.9, 0.3, 1.2);
    }
    @keyframes ahpd-pop {
      from {
        opacity: 0;
        transform: scale(0.96) translateY(6px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .scrim,
      .panel {
        animation: none;
      }
    }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 16px 18px 0;
    }
    .title {
      font-family: var(--ah-font-display);
      font-weight: 600;
      font-size: 15px;
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
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .field label {
      font-size: 12px;
      color: var(--ah-text-muted);
    }
    .field input {
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
    }
    .field input:focus {
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
      transition: background 120ms ease, border-color 120ms ease,
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
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .btn:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: 2px;
    }
  `;

  /** 受控打开态：由父组件绑定（?open），内部关闭时派发 ah-pw-close。 */
  @property({ type: Boolean }) open = false;

  @state() private oldPw = '';
  @state() private newPw = '';
  @state() private confirmPw = '';
  @state() private busy = false;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKeydown);
  }

  /** 每次「打开」都重置草稿与忙碌态，避免上次输入残留。 */
  protected willUpdate(changed: PropertyValues): void {
    if (changed.has('open') && this.open && !changed.get('open')) {
      this.oldPw = '';
      this.newPw = '';
      this.confirmPw = '';
      this.busy = false;
    }
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.open) this.close();
  };

  /** 关闭并通知父级同步（提交中不响应，避免请求悬挂）。 */
  private close() {
    if (this.busy) return;
    this.open = false;
    this.dispatchEvent(
      new CustomEvent('ah-pw-close', { bubbles: true, composed: true })
    );
  }

  private async submit() {
    if (this.busy) return;
    // 前端校验（规则与后端一致，见 utils/auth-validation.ts）：不发请求即给出反馈。
    const invalid = validateChangePassword({
      oldPassword: this.oldPw,
      newPassword: this.newPw,
      confirm: this.confirmPw
    });
    if (invalid) {
      notify.warning(invalid, { key: 'change-password' });
      return;
    }
    this.busy = true;
    // P1-14: 新密码客户端 PBKDF2 派生，不传输明文。旧密码仍以 plaintext 校验（服务端需验证）。
    const newSalt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const newDerivedHex = await derivePassword(this.newPw, newSalt);
    const r = await changePassword(this.oldPw, '', {
      salt: newSalt,
      derivedHex: newDerivedHex
    });
    this.busy = false;
    if (!r.ok) {
      // 后端业务错误（旧密码错误 / 新密码太弱 / OAuth 账户不支持…）统一走通知。
      notify.error(r.error ?? '修改失败。', { key: 'change-password' });
      return;
    }
    this.open = false;
    this.dispatchEvent(
      new CustomEvent('ah-pw-close', { bubbles: true, composed: true })
    );
    notify.success('密码已修改，下次登录请使用新密码');
  }

  render(): TemplateResult {
    if (!this.open) return html``;
    return html`
      <div
        class="scrim"
        @click=${(e: MouseEvent) => {
          if (e.target === e.currentTarget) this.close();
        }}
      >
        <div class="panel" role="dialog" aria-modal="true" aria-label="修改密码">
          <div class="head">
            <span class="title">修改密码</span>
            <button
              class="close"
              title="关闭"
              aria-label="关闭"
              @click=${() => this.close()}
            >
              ×
            </button>
          </div>
          <div class="body">
            <div class="field">
              <label for="ah-pw-old">当前密码</label>
              <input
                id="ah-pw-old"
                type="password"
                autocomplete="current-password"
                placeholder="请输入当前密码"
                .value=${this.oldPw}
                @input=${(e: InputEvent) =>
                  (this.oldPw = (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label for="ah-pw-new">新密码（至少 8 位）</label>
              <input
                id="ah-pw-new"
                type="password"
                autocomplete="new-password"
                placeholder="请输入新密码"
                .value=${this.newPw}
                @input=${(e: InputEvent) =>
                  (this.newPw = (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label for="ah-pw-confirm">确认新密码</label>
              <input
                id="ah-pw-confirm"
                type="password"
                autocomplete="new-password"
                placeholder="请输入确认密码"
                .value=${this.confirmPw}
                @input=${(e: InputEvent) =>
                  (this.confirmPw = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void this.submit();
                  }
                }}
              />
            </div>
          </div>
          <div class="foot">
            <button
              class="btn ghost"
              @click=${() => this.close()}
              ?disabled=${this.busy}
            >
              取消
            </button>
            <button
              class="btn primary"
              @click=${() => this.submit()}
              ?disabled=${this.busy}
            >
              ${this.busy ? '提交中…' : '修改'}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
