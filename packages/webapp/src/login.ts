/**
 * 登录 / 注册页（ah-login）
 * ----------------------------------------------------------------
 * 设计还原自 Ardot 设计稿：
 *  - 左侧品牌面板：动画「智能体网络」mesh（节点呼吸 + 连线流动 + 数据脉冲沿线游走）
 *    + 极光渐变背景 + 漂浮粒子 + 「实时编排中」状态徽标。
 *  - 右侧认证卡片：登录 / 注册双视图（底部链接切换，无分段控件），
 *    统一 336×42 对齐输入框，密码框显隐（眼睛图标），GitHub SSO。
 *
 * 所有视觉只引用 --ah-* 语义令牌，随 dark/light 主题自动切换；
 * 动画命名沿用项目 ah-* 约定（组件内作用域，避免与 sharedStyles 冲突）。
 */
import { LitElement, html, nothing, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles } from './styles';
import { getTheme, type Theme } from './theme/tokens';

/* ------------------------------ 智能体网络 mesh 数据 ------------------------------ */

interface NetNode {
  x: number;
  y: number;
  r: number;
  delay: number;
}
interface NetEdge {
  a: number;
  b: number;
  dur: number;
  delay: number;
}

// viewBox 560 × 640，居中 hub + 6 个外围节点，构成星形 + 周界互联网络
const NODES: NetNode[] = [
  { x: 280, y: 300, r: 9, delay: 0 }, // 0 hub
  { x: 130, y: 150, r: 5, delay: 0.6 }, // 1
  { x: 430, y: 130, r: 6, delay: 1.1 }, // 2
  { x: 95, y: 430, r: 5, delay: 0.3 }, // 3
  { x: 460, y: 440, r: 6, delay: 1.4 }, // 4
  { x: 210, y: 560, r: 5, delay: 0.9 }, // 5
  { x: 370, y: 580, r: 5, delay: 1.8 }, // 6
];
const EDGES: NetEdge[] = [
  { a: 0, b: 1, dur: 4.2, delay: 0.0 },
  { a: 0, b: 2, dur: 3.8, delay: 0.7 },
  { a: 0, b: 3, dur: 4.6, delay: 0.3 },
  { a: 0, b: 4, dur: 4.0, delay: 1.0 },
  { a: 0, b: 5, dur: 5.0, delay: 0.5 },
  { a: 0, b: 6, dur: 4.4, delay: 1.3 },
  { a: 1, b: 2, dur: 5.4, delay: 0.2 },
  { a: 3, b: 5, dur: 5.8, delay: 0.9 },
  { a: 4, b: 6, dur: 5.2, delay: 0.4 },
  { a: 1, b: 3, dur: 6.0, delay: 1.2 },
  { a: 2, b: 4, dur: 5.6, delay: 0.6 },
  { a: 5, b: 6, dur: 6.2, delay: 1.5 },
];

function edgePath(e: NetEdge): string {
  const a = NODES[e.a];
  const b = NODES[e.b];
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

/** 渲染整张 mesh：连线(流动) + 沿线游走的脉冲 + 节点(呼吸光晕 + 实心点)。 */
function meshSvg() {
  return html`
    <svg class="mesh" viewBox="0 0 560 640" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      ${EDGES.map(
        (e, k) => html`
          <path id=${`edge-${k}`} class="edge" d=${edgePath(e)} style=${`animation-delay:${e.delay}s`}></path>
          <circle class="packet" r="3">
            <animateMotion dur=${`${e.dur}s`} begin=${`${e.delay}s`} repeatCount="indefinite">
              <mpath href=${`#edge-${k}`}></mpath>
            </animateMotion>
          </circle>
        `
      )}
      ${NODES.map(
        (n) => html`
          <circle class="node-glow" cx=${n.x} cy=${n.y} r=${n.r * 2.4} style=${`animation-delay:${n.delay}s`}></circle>
          <circle class="node" cx=${n.x} cy=${n.y} r=${n.r}></circle>
        `
      )}
    </svg>
  `;
}

/** 眼睛图标：open=true 睁眼，false 闭眼（带斜杠）。 */
function eyeIcon(open: boolean) {
  return open
    ? html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" stroke="currentColor" stroke-width="1.6" />
        <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" />
      </svg>`
    : html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7c2 0 3.7.8 5.2 1.9M22 12s-3.5 7-10 7c-2 0-3.7-.8-5.2-1.9" stroke="currentColor" stroke-width="1.6" />
        <path d="M4 4l16 16" stroke="currentColor" stroke-width="1.6" />
      </svg>`;
}

@customElement('ah-login')
export class AhLogin extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: grid;
        grid-template-columns: 1.05fr 1fr;
        height: 100vh;
        height: 100dvh;
        overflow: hidden;
        color: var(--ah-text);
      }

      /* ---------------------- 左：品牌 / 动画面板 ---------------------- */
      .brand-panel {
        position: relative;
        overflow: hidden;
        background: var(--ah-surface-1);
        border-right: 1px solid var(--ah-border);
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 40px 44px;
        isolation: isolate;
      }
      /* 极光渐变层：多块缓慢漂移的彩色光斑，营造科技氛围 */
      .aurora {
        position: absolute;
        inset: -25%;
        z-index: 0;
        filter: blur(56px);
        opacity: 0.5;
        pointer-events: none;
      }
      .aurora.a1 {
        background: radial-gradient(40% 40% at 30% 30%, var(--ah-accent) 0%, transparent 70%);
        animation: ah-login-aurora 19s ease-in-out infinite;
      }
      .aurora.a2 {
        background: radial-gradient(38% 38% at 72% 64%, var(--ah-accent-strong) 0%, transparent 70%);
        opacity: 0.38;
        animation: ah-login-aurora 24s ease-in-out infinite reverse;
      }
      .aurora.a3 {
        background: radial-gradient(34% 34% at 55% 88%, var(--ah-success) 0%, transparent 72%);
        opacity: 0.22;
        animation: ah-login-aurora 28s ease-in-out infinite;
      }
      @keyframes ah-login-aurora {
        0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
        50% { transform: translate3d(5%, -4%, 0) scale(1.12); }
      }

      /* mesh 铺满面板，垫在文字之下 */
      .mesh {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        z-index: 1;
        opacity: 0.92;
        pointer-events: none;
      }
      .edge {
        fill: none;
        stroke: var(--ah-accent);
        stroke-width: 1.2;
        opacity: 0.45;
        stroke-dasharray: 5 9;
        animation: ah-login-flow 4s linear infinite;
      }
      @keyframes ah-login-flow {
        to { stroke-dashoffset: -140; }
      }
      .packet {
        fill: var(--ah-accent-strong);
        filter: drop-shadow(0 0 4px var(--ah-accent));
      }
      .node-glow {
        fill: var(--ah-accent);
        transform-box: fill-box;
        transform-origin: center;
        animation: ah-login-node 3.2s ease-in-out infinite;
      }
      .node {
        fill: var(--ah-text);
        stroke: var(--ah-accent);
        stroke-width: 1.5;
      }
      @keyframes ah-login-node {
        0%, 100% { opacity: 0.28; transform: scale(0.82); }
        50% { opacity: 0.6; transform: scale(1.28); }
      }

      /* 漂浮粒子 */
      .particles {
        position: absolute;
        inset: 0;
        z-index: 1;
        pointer-events: none;
        overflow: hidden;
      }
      .particle {
        position: absolute;
        bottom: -10px;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--ah-accent);
        opacity: 0;
        animation: ah-login-float linear infinite;
      }
      @keyframes ah-login-float {
        0% { transform: translateY(0); opacity: 0; }
        12% { opacity: 0.7; }
        88% { opacity: 0.7; }
        100% { transform: translateY(-130px); opacity: 0; }
      }

      /* 底部暗化，保证品牌文字可读 */
      .brand-panel::after {
        content: '';
        position: absolute;
        inset: 0;
        z-index: 2;
        background: radial-gradient(120% 80% at 20% 90%, rgba(0, 0, 0, 0.45), transparent 60%),
          linear-gradient(180deg, rgba(0, 0, 0, 0.15), transparent 30%);
        pointer-events: none;
      }

      .brand-top,
      .brand-bottom {
        position: relative;
        z-index: 3;
      }
      .brand-mark {
        display: flex;
        align-items: center;
        gap: 10px;
        font-family: var(--ah-font-display);
        font-weight: 700;
        font-size: 18px;
      }
      .brand-mark .logo {
        width: 26px;
        height: 26px;
        object-fit: contain;
        display: block;
      }
      .brand-ver {
        margin-left: auto;
        font-family: var(--ah-font-mono);
        font-size: 11px;
        color: var(--ah-text-faint);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-pill);
        padding: 2px 10px;
      }
      .brand-title {
        font-family: var(--ah-font-display);
        font-size: 30px;
        font-weight: 700;
        line-height: 1.25;
        margin: 26px 0 10px;
        max-width: 12ch;
      }
      .brand-sub {
        color: var(--ah-text-muted);
        font-size: 14px;
        max-width: 30ch;
        line-height: 1.6;
      }
      .feature-list {
        list-style: none;
        margin: 22px 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .feature-list li {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        color: var(--ah-text-muted);
      }
      .feature-list .tick {
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--ah-accent-soft);
        color: var(--ah-accent);
        font-size: 11px;
      }
      .brand-foot {
        font-size: 12px;
        color: var(--ah-text-faint);
        font-family: var(--ah-font-mono);
      }
      /* 「实时编排中」状态徽标 */
      .status-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: var(--ah-radius-pill);
        background: var(--ah-surface-2);
        border: 1px solid var(--ah-border);
        font-size: 12px;
        color: var(--ah-text-muted);
        margin-bottom: 26px;
      }
      .chip-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--ah-success);
        animation: ah-login-chip 1.6s ease-in-out infinite;
      }
      @keyframes ah-login-chip {
        0%, 100% { opacity: 1; box-shadow: 0 0 0 3px var(--ah-success-soft); }
        50% { opacity: 0.5; box-shadow: 0 0 0 0 var(--ah-success-soft); }
      }

      /* ---------------------- 右：认证卡片 ---------------------- */
      .auth-panel {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px;
        background: var(--ah-canvas);
        overflow: auto;
      }
      .auth-card {
        width: 400px;
        max-width: 100%;
        background: var(--ah-surface-1);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-lg);
        padding: 32px 30px;
        box-shadow: var(--ah-shadow);
      }
      .auth-card h1 {
        font-family: var(--ah-font-display);
        font-size: 24px;
        margin: 0 0 6px;
      }
      .auth-sub {
        color: var(--ah-text-muted);
        font-size: 13px;
        margin: 0 0 24px;
      }
      .field {
        position: relative;
        margin-bottom: 14px;
      }
      .field label {
        display: block;
        font-size: 12px;
        color: var(--ah-text-muted);
        margin-bottom: 6px;
      }
      .field input {
        width: 100%;
        box-sizing: border-box;
        height: 42px;
        padding: 0 14px;
        background: var(--ah-surface-2);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-md);
        color: var(--ah-text);
        font-size: 14px;
        font-family: inherit;
        transition: border-color 140ms ease, box-shadow 140ms ease;
      }
      .field input::placeholder {
        color: var(--ah-text-faint);
      }
      .field input:focus {
        outline: none;
        border-color: var(--ah-accent);
        box-shadow: 0 0 0 3px var(--ah-accent-soft);
      }
      /* 密码框右侧留出眼睛按钮空间 */
      .field.has-eye input {
        padding-right: 42px;
      }
      .eye-btn {
        position: absolute;
        right: 6px;
        bottom: 6px;
        width: 30px;
        height: 30px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        color: var(--ah-text-faint);
        cursor: pointer;
        border-radius: var(--ah-radius-sm);
      }
      .eye-btn:hover {
        color: var(--ah-text);
        background: var(--ah-surface-3);
      }
      .row-between {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 4px 0 18px;
        font-size: 13px;
      }
      .remember {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        color: var(--ah-text-muted);
        cursor: pointer;
      }
      .remember input {
        accent-color: var(--ah-accent);
      }
      .btn-primary {
        width: 100%;
        height: 44px;
        background: var(--ah-accent);
        color: #fff;
        border: none;
        border-radius: var(--ah-radius-md);
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        transition: filter 140ms ease, transform 80ms ease;
      }
      .btn-primary:hover {
        filter: brightness(1.06);
      }
      .btn-primary:active {
        transform: translateY(1px);
      }
      .divider {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 20px 0;
        color: var(--ah-text-faint);
        font-size: 12px;
      }
      .divider::before,
      .divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--ah-border);
      }
      .btn-sso {
        width: 100%;
        height: 44px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        background: var(--ah-surface-2);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-md);
        color: var(--ah-text);
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
        transition: border-color 140ms ease;
      }
      .btn-sso:hover {
        border-color: var(--ah-accent);
      }
      .btn-sso svg {
        width: 18px;
        height: 18px;
      }
      .terms {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: 12px;
        color: var(--ah-text-muted);
        margin-bottom: 18px;
        line-height: 1.5;
      }
      .terms input {
        margin-top: 2px;
        accent-color: var(--ah-accent);
      }
      .terms a {
        color: var(--ah-accent);
        text-decoration: none;
      }
      .auth-foot {
        margin-top: 22px;
        text-align: center;
        font-size: 13px;
        color: var(--ah-text-muted);
      }
      .auth-foot .link {
        background: none;
        border: none;
        color: var(--ah-accent);
        cursor: pointer;
        font-size: 13px;
        padding: 0 2px;
        font-family: inherit;
      }
      .notice {
        margin-top: 14px;
        padding: 8px 12px;
        border-radius: var(--ah-radius-sm);
        background: var(--ah-accent-soft);
        color: var(--ah-accent);
        font-size: 12.5px;
        text-align: center;
      }

      /* ---------------------- 移动端：上下堆叠 ---------------------- */
      @media (max-width: 860px) {
        :host {
          grid-template-columns: 1fr;
          grid-template-rows: auto 1fr;
          height: auto;
          min-height: 100dvh;
          overflow: visible;
        }
        .brand-panel {
          border-right: none;
          border-bottom: 1px solid var(--ah-border);
          min-height: 320px;
          padding: 28px 24px;
        }
        .brand-title {
          font-size: 24px;
        }
        .feature-list {
          display: none;
        }
        .auth-panel {
          overflow: visible;
        }
      }
    `,
  ];

  @state() mode: 'login' | 'register' = 'login';
  @state() showPassword = false;
  @state() showConfirm = false;
  @state() remember = false;
  @state() agree = false;
  @state() notice: string | null = null;
  @state() theme: Theme = getTheme();

  private themeObs?: MutationObserver;

  private toggleMode() {
    this.mode = this.mode === 'login' ? 'register' : 'login';
    this.notice = null;
  }

  connectedCallback() {
    super.connectedCallback();
    // 跟随全局主题切换 logo 资源：浅色面板用 logo.svg（近黑），深色面板用 logo-white.svg（白）。
    this.themeObs = new MutationObserver(() => {
      this.theme = getTheme();
    });
    this.themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.themeObs?.disconnect();
  }

  private onSubmit(e: Event) {
    e.preventDefault();
    this.notice = '演示页面：未接入鉴权后端，提交逻辑待对接。';
  }

  private field(
    label: string,
    type: string,
    placeholder: string,
    valueKey: 'email' | 'username' | 'password' | 'confirm',
    hasEye = false
  ) {
    const isPw = hasEye;
    const inputType = isPw ? (valueKey === 'password' ? (this.showPassword ? 'text' : 'password') : this.showConfirm ? 'text' : 'password') : type;
    return html`
      <div class="field ${hasEye ? 'has-eye' : ''}">
        <label>${label}</label>
        <input type=${inputType} placeholder=${placeholder} autocomplete=${valueKey} />
        ${hasEye
          ? html`<button
              class="eye-btn"
              type="button"
              title=${valueKey === 'password' ? (this.showPassword ? '隐藏密码' : '显示密码') : this.showConfirm ? '隐藏密码' : '显示密码'}
              @click=${() => (valueKey === 'password' ? (this.showPassword = !this.showPassword) : (this.showConfirm = !this.showConfirm))}
            >
              ${eyeIcon(valueKey === 'password' ? this.showPassword : this.showConfirm)}
            </button>`
          : nothing}
      </div>
    `;
  }

  render() {
    const particles = [12, 26, 41, 58, 70, 83, 92].map(
      (left, i) => html`<span class="particle" style=${`left:${left}%;animation-duration:${5 + (i % 4)}s;animation-delay:${i * 0.7}s`}></span>`
    );

    return html`
      <section class="brand-panel">
        <div class="aurora a1"></div>
        <div class="aurora a2"></div>
        <div class="aurora a3"></div>
        ${meshSvg()}
        <div class="particles">${particles}</div>

        <div class="brand-top">
          <div class="brand-mark">
            <img
              class="logo"
              src=${this.theme === 'light' ? '/logo.svg' : '/logo-white.svg'}
              alt="Agent Harness"
            />
            <span>Agent Harness</span>
            <span class="brand-ver">v1.0 · 控制台</span>
          </div>
          <h2 class="brand-title">编排你的智能体网络</h2>
          <p class="brand-sub">统一接入 LLM · MCP · 工具与记忆，让多智能体协同运行、实时可观测。</p>
          <ul class="feature-list">
            <li><span class="tick">✓</span> 实时编排引擎，低延迟调度</li>
            <li><span class="tick">✓</span> 多智能体协同与护栏校验</li>
            <li><span class="tick">✓</span> 全链路可观测 · 可审计</li>
          </ul>
        </div>

        <div class="brand-bottom">
          <div class="status-chip"><span class="chip-dot"></span>实时编排中</div>
          <div class="brand-foot">© 2026 Agent Harness · 隐私优先</div>
        </div>
      </section>

      <section class="auth-panel">
        <div class="auth-card">
          ${this.mode === 'login'
            ? html`
                <h1>欢迎回来</h1>
                <p class="auth-sub">登录以继续管理你的智能体运行时。</p>
                <form @submit=${this.onSubmit}>
                  ${this.field('邮箱', 'email', 'you@example.com', 'email')}
                  ${this.field('密码', 'password', '请输入密码', 'password', true)}
                  <div class="row-between">
                    <label class="remember"><input type="checkbox" ?checked=${this.remember} @change=${(e: Event) => (this.remember = (e.target as HTMLInputElement).checked)} /> 记住我</label>
                    <button class="link" type="button" @click=${() => (this.notice = '演示页面：找回密码流程待接入。')}>忘记密码？</button>
                  </div>
                  <button class="btn-primary" type="submit">登录</button>
                </form>
                <div class="divider">或使用</div>
                <button class="btn-sso" type="button" @click=${() => (this.notice = '演示页面：GitHub OAuth 待接入。')}>
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 5 18.3 5.3 18.3 5.3c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5Z" />
                  </svg>
                  GitHub 继续
                </button>
                ${this.notice ? html`<div class="notice">${this.notice}</div>` : nothing}
                <div class="auth-foot">还没有账号？<button class="link" type="button" @click=${this.toggleMode}>去注册</button></div>
              `
            : html`
                <h1>创建账号</h1>
                <p class="auth-sub">注册以解锁完整的智能体编排能力。</p>
                <form @submit=${this.onSubmit}>
                  ${this.field('邮箱', 'email', 'you@example.com', 'email')}
                  ${this.field('用户名', 'text', '设置用户名', 'username')}
                  ${this.field('密码', 'password', '至少 8 位', 'password', true)}
                  ${this.field('确认密码', 'password', '再次输入密码', 'confirm', true)}
                  <label class="terms">
                    <input type="checkbox" ?checked=${this.agree} @change=${(e: Event) => (this.agree = (e.target as HTMLInputElement).checked)} />
                    <span>我已阅读并同意 <a href="#" @click=${(e: Event) => e.preventDefault()}>服务条款</a> 与 <a href="#" @click=${(e: Event) => e.preventDefault()}>隐私政策</a>。</span>
                  </label>
                  <button class="btn-primary" type="submit">创建账号</button>
                </form>
                ${this.notice ? html`<div class="notice">${this.notice}</div>` : nothing}
                <div class="auth-foot">已有账号？<button class="link" type="button" @click=${this.toggleMode}>去登录</button></div>
              `}
        </div>
      </section>
    `;
  }
}
