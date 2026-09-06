/**
 * ah-user-menu：顶栏「登录用户」入口（头像 + 下拉菜单）。
 *
 * 位置：顶栏右上角，由 ah-login 登录成功后回填会话、或由
 * ah-app 挂载后调用 /api/account/me 拉取当前用户资料（username / role / email）。
 *
 * 交互：
 *  - 点击头像 → 切换下拉：头部展示「用户名 · 角色徽标」（含 email 可选），
 *    菜单含「修改密码」「退出登录」两项。
 *  - 「修改密码」→ 弹出模态（旧密码 / 新密码 / 确认新密码），复用 --ah-* 令牌与 ah-modal 视觉。
 *    校验前移到前端（规则同登录/注册，见 utils/auth-validation.ts），校验失败 / 后端报错 /
 *    网络异常一律走 ah-notification，模态内不再保留内联错误条。
 *  - 「退出登录」→ POST /api/account/logout（服务端清 cookie + 吊销 token），本地清会话回登录页。
 *  - 点击外部 / Esc 关闭下拉；模态下 Esc / 遮罩关闭。
 *
 * 视觉：仅引用 --ah-* 语义令牌，与全站（topbar / ah-modal / login）一致；深浅主题自适应。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { fetchMe, logout, changePassword, scryptDerive, bytesToHex } from '../api';
import { notify } from './ah-notification';
import { validateChangePassword } from '../utils/auth-validation';

/** 应用版本号，build-time 由 vite define（__APP_VERSION__）注入，取自 package.json。 */
// @ts-ignore - vite define 注入
const APP_VERSION = __APP_VERSION__;

// 角色 → 中文 + 徽标配色（延续 styles.ts 的 .role-badge 视觉）。
const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  operator: '操作员',
  viewer: '访客'
};

function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

/** 取用户名首字母（中文取首字，英文取首 1-2 字母）作头像占位。 */
function avatarInitial(name: string): string {
  const n = (name || '?').trim();
  if (!n) return '?';
  // 中文/日文等：取首字
  if (/[一-龥぀-ヿ]/.test(n[0]!)) return n[0]!;
  // 英文：首字母大写
  return n.slice(0, 2).toUpperCase();
}

@customElement('ah-user-menu')
export class AhUserMenu extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      position: relative;
    }

    /* 头像按钮：圆形渐变 + 描边，hover 高亮，打开态加 accent 环。 */
    .avatar {
      width: 34px;
      height: 34px;
      flex: 0 0 auto;
      border-radius: 50%;
      border: 1px solid var(--ah-border);
      background: linear-gradient(
        135deg,
        var(--ah-accent) 0%,
        var(--ah-accent-strong) 100%
      );
      color: #fff;
      font-family: var(--ah-font-display);
      font-weight: 700;
      font-size: 13px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
      transition: border-color 120ms ease, transform 120ms ease,
        box-shadow 120ms ease;
    }
    .avatar:hover {
      border-color: var(--ah-accent);
      transform: translateY(-1px);
    }
    :host([data-open]) .avatar {
      border-color: var(--ah-accent);
      box-shadow: 0 0 0 3px var(--ah-accent-soft);
    }
    .avatar:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: 2px;
    }

    /* 下拉：锚定头像下方、右对齐，轻遮罩仅用于捕获外部点击（透明、不挡视觉）。 */
    .menu-scrim {
      position: fixed;
      inset: 0;
      z-index: 60;
    }
    .menu {
      position: absolute;
      top: calc(100% + 10px);
      right: 0;
      z-index: 61;
      width: 248px;
      background: var(--ah-surface-1);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-md);
      box-shadow: var(--ah-shadow);
      overflow: hidden;
      animation: aum-pop 0.14s ease;
      transform-origin: top right;
    }
    @keyframes aum-pop {
      from {
        opacity: 0;
        transform: scale(0.96) translateY(-4px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .menu {
        animation: none;
      }
    }

    .menu-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--ah-border);
    }
    .menu-head .ava {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: linear-gradient(
        135deg,
        var(--ah-accent) 0%,
        var(--ah-accent-strong) 100%
      );
      color: #fff;
      font-family: var(--ah-font-display);
      font-weight: 700;
      font-size: 15px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .menu-head .meta {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .menu-head .name {
      font-family: var(--ah-font-display);
      font-weight: 600;
      font-size: 14px;
      color: var(--ah-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .menu-head .sub {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .role-badge {
      display: inline-block;
      padding: 1px 8px;
      border-radius: var(--ah-radius-pill);
      font-size: 11px;
      font-family: var(--ah-font-mono);
      background: var(--ah-surface-3);
      border: 1px solid var(--ah-border);
      color: var(--ah-text-muted);
    }
    .role-badge.admin {
      color: var(--ah-accent);
      border-color: color-mix(in srgb, var(--ah-accent) 40%, transparent);
      background: var(--ah-accent-soft);
    }
    .email {
      font-size: 11px;
      color: var(--ah-text-faint);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 115px;
    }

    .items {
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 9px 10px;
      border: none;
      background: none;
      border-radius: var(--ah-radius-sm);
      color: var(--ah-text);
      font-size: 13px;
      font-family: var(--ah-font-sans);
      cursor: pointer;
      text-align: left;
    }
    .item svg {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      color: var(--ah-text-muted);
    }
    .item:hover {
      background: var(--ah-surface-2);
    }
    .item:hover svg {
      color: var(--ah-text);
    }
    .item.danger:hover {
      background: var(--ah-danger-soft);
    }
    .item.danger:hover svg,
    .item.danger:hover .label {
      color: var(--ah-danger);
    }
    .item:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: -2px;
    }

    /* 版本信息页脚 */
    .ver {
      padding: 7px 12px 9px;
      border-top: 1px solid var(--ah-border);
      font-size: 11px;
      font-family: var(--ah-font-mono);
      color: var(--ah-text-faint);
    }

    /* ── 改密模态（内联，复用 ah-modal 视觉，自行控制校验/关闭）── */
    .pw-scrim {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      animation: aum-fade 0.16s ease;
    }
    @keyframes aum-fade {
      from {
        opacity: 0;
      }
    }
    .pw-panel {
      width: min(calc(100vw - 32px), 420px);
      background: var(--ah-surface-1);
      color: var(--ah-text);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-lg);
      box-shadow: var(--ah-shadow);
      overflow: hidden;
      animation: aum-pop-in 0.16s cubic-bezier(0.2, 0.9, 0.3, 1.2);
    }
    @keyframes aum-pop-in {
      from {
        opacity: 0;
        transform: scale(0.96) translateY(6px);
      }
    }
    .pw-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 16px 18px 0;
    }
    .pw-title {
      font-family: var(--ah-font-display);
      font-weight: 600;
      font-size: 15px;
    }
    .pw-close {
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
    .pw-close:hover {
      color: var(--ah-text);
      background: var(--ah-surface-2);
    }
    .pw-body {
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
    .pw-foot {
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

  /** 用户名（本地 localStorage 已有，亦可由 setMe 覆盖）。 */
  @property({ type: String }) username = '';
  /** 角色（admin / operator / viewer）。 */
  @property({ type: String }) role = 'admin';
  /** 邮箱（可选，来自 /api/account/me）。 */
  @property({ type: String }) email: string | null = null;

  @state() private open = false;
  @state() private showPw = false;
  @state() private oldPw = '';
  @state() private newPw = '';
  @state() private confirmPw = '';
  @state() private pwBusy = false;

  connectedCallback() {
    super.connectedCallback();
    // 若未显式注入 username（如 ah-app 尚未 setMe），则尝试拉取一次 /me。
    if (!this.username) {
      void this.refreshMe();
    }
    document.addEventListener('click', this.onDocClick, true);
    window.addEventListener('keydown', this.onKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this.onDocClick, true);
    window.removeEventListener('keydown', this.onKeydown);
  }

  /** 外部（ah-app）在拿到 /me 后调用，回填头像所需资料。 */
  async refreshMe(): Promise<void> {
    const me = await fetchMe();
    if (me) {
      this.username = me.username;
      this.role = me.role;
      this.email = me.email;
    }
  }

  private onDocClick = (e: MouseEvent) => {
    // 下拉打开且点击落在组件外部（shadow 边界之外）→ 关闭。
    if (this.open && e.target instanceof Node && !this.contains(e.target)) {
      this.open = false;
    }
  };

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (this.showPw) this.closePw();
      else if (this.open) this.open = false;
    }
  };

  private toggle() {
    this.open = !this.open;
  }

  private openPw() {
    this.oldPw = '';
    this.newPw = '';
    this.confirmPw = '';
    this.pwBusy = false;
    this.open = false;
    this.showPw = true;
  }

  private closePw() {
    if (this.pwBusy) return;
    this.showPw = false;
  }

  private async submitPw() {
    if (this.pwBusy) return;
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
    this.pwBusy = true;
    // P1-14: 新密码客户端 scrypt 派生，不传输明文。旧密码仍以 plaintext 校验（服务端需验证）。
    const newSalt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const newDerivedHex = await scryptDerive(this.newPw, newSalt);
    const r = await changePassword(this.oldPw, '', { salt: newSalt, derivedHex: newDerivedHex });
    this.pwBusy = false;
    if (!r.ok) {
      // 后端业务错误（旧密码错误 / 新密码太弱 / OAuth 账户不支持…）统一走通知。
      notify.error(r.error ?? '修改失败。', { key: 'change-password' });
      return;
    }
    this.showPw = false;
    notify.success('密码已修改，下次登录请使用新密码');
  }

  private async onLogout() {
    this.open = false;
    await logout();
  }

  private keyIcon() {
    return html`<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="4" stroke="currentColor" stroke-width="1.6" />
      <path
        d="M11 11l8 8M16 16l2-2M19 19l2-2"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>`;
  }

  private logoutIcon() {
    return html`<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 12H4M4 12l3-3M4 12l3 3"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M14 5h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>`;
  }

  render() {
    const initial = avatarInitial(this.username);
    return html`
      <button
        class="avatar"
        title=${this.username || '用户'}
        aria-haspopup="menu"
        aria-expanded=${this.open ? 'true' : 'false'}
        @click=${(e: MouseEvent) => {
          e.stopPropagation();
          this.toggle();
        }}
      >
        ${initial}
      </button>

      ${this.open
        ? html`
            <div class="menu-scrim" @click=${() => (this.open = false)}></div>
            <div class="menu" role="menu">
              <div class="menu-head">
                <span class="ava">${initial}</span>
                <div class="meta">
                  <span class="name">${this.username || '未命名用户'}</span>
                  <span class="sub">
                    <span class="role-badge ${this.role}"
                      >${roleLabel(this.role)}</span
                    >
                    ${this.email
                      ? html`<span class="email">${this.email}</span>`
                      : ''}
                  </span>
                </div>
              </div>
              <div class="items">
                <button
                  class="item"
                  role="menuitem"
                  @click=${() => this.openPw()}
                >
                  ${this.keyIcon()}<span class="label">修改密码</span>
                </button>
                <button
                  class="item danger"
                  role="menuitem"
                  @click=${() => this.onLogout()}
                >
                  ${this.logoutIcon()}<span class="label">退出登录</span>
                </button>
              </div>
              <div class="ver">Agent Harness v${APP_VERSION}</div>
            </div>
          `
        : ''}
      ${this.showPw ? this.renderPwModal() : nothing}
    `;
  }

  private renderPwModal() {
    return html`
      <div
        class="pw-scrim"
        @click=${(e: MouseEvent) => {
          if (e.target === e.currentTarget) this.closePw();
        }}
      >
        <div
          class="pw-panel"
          role="dialog"
          aria-modal="true"
          aria-label="修改密码"
        >
          <div class="pw-head">
            <span class="pw-title">修改密码</span>
            <button
              class="pw-close"
              title="关闭"
              aria-label="关闭"
              @click=${() => this.closePw()}
            >
              ×
            </button>
          </div>
          <div class="pw-body">
            <div class="field">
              <label for="pw-old">当前密码</label>
              <input
                id="pw-old"
                type="password"
                autocomplete="current-password"
                placeholder="请输入当前密码"
                .value=${this.oldPw}
                @input=${(e: InputEvent) =>
                  (this.oldPw = (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label for="pw-new">新密码（至少 8 位）</label>
              <input
                id="pw-new"
                type="password"
                placeholder="请输入新密码"
                autocomplete="new-password"
                .value=${this.newPw}
                @input=${(e: InputEvent) =>
                  (this.newPw = (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label for="pw-confirm">确认新密码</label>
              <input
                id="pw-confirm"
                type="password"
                autocomplete="new-password"
                placeholder="请输入确认密码"
                .value=${this.confirmPw}
                @input=${(e: InputEvent) =>
                  (this.confirmPw = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void this.submitPw();
                  }
                }}
              />
            </div>
          </div>
          <div class="pw-foot">
            <button
              class="btn ghost"
              @click=${() => this.closePw()}
              ?disabled=${this.pwBusy}
            >
              取消
            </button>
            <button
              class="btn primary"
              @click=${() => this.submitPw()}
              ?disabled=${this.pwBusy}
            >
              ${this.pwBusy ? '提交中…' : '修改'}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
