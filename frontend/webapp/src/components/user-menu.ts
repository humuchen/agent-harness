/**
 * ah-user-menu：顶栏「登录用户」入口（头像 + 下拉菜单）。
 *
 * 位置：顶栏右上角，由 ah-login 登录成功后回填会话、或由
 * ah-app 挂载后调用 /api/account/me 拉取当前用户资料（username / role / email）。
 *
 * 交互：
 *  - 点击头像 → 切换下拉：头部展示「用户名 · 角色徽标」（含 email 可选），
 *    菜单含「修改密码」「退出登录」两项。
 *  - 「修改密码」→ 打开共享的 ah-password-dialog（旧密码 / 新密码 / 确认新密码）。
 *    校验前移到前端（规则同登录/注册，见 utils/auth-validation.ts），校验失败 / 后端报错 /
 *    网络异常一律走 ah-notification，模态内不再保留内联错误条。
 *    （改密入口全站只有此处：设置中心已移除「账户」分组，不与本页重复。）
 *  - 「退出登录」→ POST /api/account/logout（服务端清 cookie + 吊销 token），本地清会话回登录页。
 *  - 点击外部 / Esc 关闭下拉；模态下 Esc / 遮罩关闭（由 ah-password-dialog 自行处理）。
 *  - standalone 模式（「我的」Tab，桌面与移动共用）：整页渲染账户面板 + 品牌块。
 *    品牌信息在本页统一呈现——桌面侧栏品牌块已隐藏（styles/base.ts）、内容区品牌脚已移除，
 *    登录页除外；版本号收敛到设置中心的「关于」分组。
 *
 * 视觉：仅引用 --ah-* 语义令牌，与全站（topbar / ah-modal / login）一致；深浅主题自适应。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { fetchMe, logout } from '../api';
import { BRAND_DEFAULT, type BrandConfig } from '../theme/tokens';
import { avatarInitial, roleLabel } from '../utils/user-display';
// 改密模态：账户相关操作（资料 / 改密 / 退出）全部收在「我的」，故由本组件独占。
import './password-dialog';

@customElement('ah-user-menu')
export class AhUserMenu extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      position: relative;
    }
    /* standalone 模式：作为移动端「我的」Tab 的根容器，撑满父级宽度 */
    :host([standalone]) {
      display: block;
      width: 100%;
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

    /* 改密模态的视觉与逻辑由 ah-password-dialog 承载（见 password-dialog.ts），
       本组件只负责受控开关，不重复样式，避免两处各写一份。 */

    /* ── standalone 模式（「我的」Tab 整页渲染，桌面与移动共用）──
       对齐设计稿 design/mobile-menu-mockups.html 方案 A：
       渐变用户卡片 + 分组标题（账户/系统/退出）+ 带图标盒与箭头的圆角条目。 */
    .standalone {
      display: flex;
      flex-direction: column;
      padding: 4px 4px 24px;
    }
    /* 用户卡片：渐变背景 + 描边圆角，头像 54px 渐变投影 */
    .s-card {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 18px 16px;
      border-radius: 16px;
      background: linear-gradient(
        160deg,
        var(--ah-surface-2),
        var(--ah-surface-1)
      );
      border: 1px solid var(--ah-border);
      margin: 2px 0 16px;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.02) inset;
    }
    .s-card .ava.big {
      width: 54px;
      height: 54px;
      font-size: 22px;
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
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--ah-border);
      box-shadow: 0 4px 14px rgba(10, 132, 255, 0.35);
    }
    .s-card .meta {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .s-card .name {
      font-size: 17px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .s-card .email {
      font-size: 11.5px;
      max-width: 200px;
      color: var(--ah-text-faint);
    }

    /* 分组标题：账户 / 系统 / 退出 */
    .s-sec {
      font-size: 11px;
      color: var(--ah-text-faint);
      font-weight: 600;
      letter-spacing: 0.4px;
      padding: 4px 2px 8px;
      margin-top: 4px;
    }
    .s-sec:first-of-type {
      margin-top: 0;
    }

    /* 条目：带图标盒 + 文案 + 右箭头的圆角卡片 */
    .s-items {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .s-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 11px;
      background: var(--ah-surface-1);
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      font-family: var(--ah-font-sans);
      color: var(--ah-text);
      text-align: left;
      width: 100%;
    }
    .s-item .s-lbl {
      min-width: 0;
    }
    .s-item .s-lbl small {
      display: block;
      font-weight: 400;
      color: var(--ah-text-faint);
      font-size: 10.5px;
      margin-top: 1px;
    }
    .s-item .s-chev {
      margin-left: auto;
      color: var(--ah-text-faint);
      font-size: 18px;
      flex: 0 0 auto;
    }
    /* 退出条目：danger 配色 */
    .s-item.danger {
      color: var(--ah-danger);
    }
    .s-item.danger svg {
      background: var(--ah-danger);
      color: #fff;
    }
    .s-item.danger:hover svg {
      color: #fff;
    }
    .s-item:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: 2px;
    }
    /* 品牌脚（移动端「我的」页呈现，替换原版本号脚） */
    .s-brand {
      margin-top: 18px;
      padding: 16px 0 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      text-align: center;
    }
    .s-logo {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      object-fit: contain;
      margin-bottom: 2px;
    }
    .s-brand-name {
      font-family: var(--ah-font-display);
      font-weight: 600;
      font-size: 13px;
      color: var(--ah-text-muted);
    }
    .s-brand-foot {
      font-size: 10.5px;
      color: var(--ah-text-faint);
      font-family: var(--ah-font-mono);
    }
  `;

  /** 用户名（本地 localStorage 已有，亦可由 setMe 覆盖）。 */
  @property({ type: String }) username = '';
  /** 角色（admin / operator / viewer）。 */
  @property({ type: String }) role = 'admin';
  /** 邮箱（可选，来自 /api/account/me）。 */
  @property({ type: String }) email: string | null = null;
  /**
   * standalone：移动端「我的」Tab 使用 —— 直接渲染完整账户面板（用户卡片 + 菜单 + 版本脚），
   * 不带弹出/外部点击收起逻辑。默认 false（顶栏头像按钮 + 下拉）。
   */
  @property({ type: Boolean }) standalone = false;

  /** 品牌配置（standalone「我的」页呈现；桌面其它页面已不展示品牌）。 */
  @state() private brand: BrandConfig = BRAND_DEFAULT;

  @state() private open = false;
  /** 改密模态开关（模态本体为 ah-password-dialog，受控 open）。 */
  @state() private showPw = false;

  connectedCallback() {
    super.connectedCallback();
    // 若未显式注入 username（如 ah-app 尚未 setMe），则尝试拉取一次 /me。
    if (!this.username) {
      void this.refreshMe();
    }
    // 品牌配置：「我的」页呈现（桌面其它页面已不展示品牌），
    // 优先读取启动时注入的全局 BRAND，缺省回退到令牌默认值。
    const g = (globalThis as unknown as { BRAND?: BrandConfig }).BRAND;
    if (g) this.brand = g;
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
    // 改密模态的 Esc 由 ah-password-dialog 自行处理（其 busy 态需拦截关闭），此处只管下拉。
    if (e.key === 'Escape' && !this.showPw && this.open) {
      this.open = false;
    }
  };

  private toggle() {
    this.open = !this.open;
  }

  private openPw() {
    this.open = false;
    this.showPw = true;
  }

  private async onLogout() {
    this.open = false;
    await logout();
  }

  render() {
    const initial = avatarInitial(this.username);
    // standalone：移动端「我的」Tab —— 对齐设计稿方案
    // 渐变用户卡片 + 分组（账户/系统/退出）条目 + 版本脚。无弹出行为。
    if (this.standalone) {
      return html`<div class="standalone">
          <div class="s-card">
            <span class="ava big">${initial}</span>
            <div class="meta">
              <span class="name"
                >${this.username || '未命名用户'}
                <span class="role-badge ${this.role}"
                  >${roleLabel(this.role)}</span
                >
              </span>
              ${this.email
                ? html`<span class="email">${this.email}</span>`
                : ''}
            </div>
          </div>

          <div class="s-sec">账户</div>
          <div class="s-items">
            <button
              class="s-item"
              role="menuitem"
              @click=${() => this.openPw()}
            >
              <span class="s-lbl">修改密码</span>
              <span class="s-chev">›</span>
            </button>
          </div>

          <div class="s-sec">系统</div>
          <div class="s-items">
            <button
              class="s-item"
              role="menuitem"
              @click=${() => this.dispatchSettings()}
            >
              <span class="s-lbl">设置</span>
              <span class="s-chev">›</span>
            </button>
          </div>

          <div class="s-sec">退出</div>
          <div class="s-items">
            <button
              class="s-item danger"
              role="menuitem"
              @click=${() => this.onLogout()}
            >
              <span class="s-lbl">退出登录</span>
              <span class="s-chev">›</span>
            </button>
          </div>

          <div class="s-brand">
            ${this.brand.logoUrl
              ? html`<img
                  class="s-logo"
                  src=${this.brand.logoUrl}
                  alt=${this.brand.productName}
                />`
              : nothing}
            <span class="s-brand-name">${this.brand.productName}</span>
            <span class="s-brand-foot"
              >© ${new Date().getFullYear()} ·
              ${this.brand.footer ?? BRAND_DEFAULT.footer}</span
            >
          </div>
        </div>
        <ah-password-dialog
          ?open=${this.showPw}
          @ah-pw-close=${() => (this.showPw = false)}
        ></ah-password-dialog> `;
    }
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
                  <span class="label">修改密码</span>
                  <span class="s-chev">›</span>
                </button>
                <button
                  class="item danger"
                  role="menuitem"
                  @click=${() => this.onLogout()}
                >
                  <span class="label">退出登录</span>
                  <span class="s-chev">›</span>
                </button>
              </div>
            </div>
          `
        : ''}
      <ah-password-dialog
        ?open=${this.showPw}
        @ah-pw-close=${() => (this.showPw = false)}
      ></ah-password-dialog>
    `;
  }

  /** 「我的 → 设置」：定位到综合设置中心的「系统与网络」分组，与条目所在分组一致。 */
  private dispatchSettings() {
    this.dispatchEvent(
      new CustomEvent('ah-goto', {
        detail: { tab: 'settings', group: 'system' },
        bubbles: true,
        composed: true
      })
    );
  }
}
