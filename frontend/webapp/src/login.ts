/**
 * 登录 / 注册页（ah-login）
 * ----------------------------------------------------------------
 * 单幅沉浸式背景 + 悬浮认证卡片：
 *  - 整体锁定 1280×832 画幅并居中，避免大屏拉伸。
 *  - 整页统一为极光渐变背景 + 动画「智能体网络」mesh + 漂浮发光粒子，
 *    不再左右分栏；认证卡片以毛玻璃形态悬浮于画面中右（箭头指向区域）。
 *  - 品牌文案分列左上/左下，与悬浮卡片形成图层感。
 *  - 完全区分 dark/light 主题。
 *
 * 视觉只引用 --ah-* 语义令牌，局部渐变/发光用 color-mix 或硬编码主题覆盖，
 * 动画命名沿用项目 ah-* 约定（组件内作用域）。
 */
import { LitElement, html, nothing, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles } from './styles';
import { getTheme, type Theme } from './theme/tokens';
import { setSession } from './api';

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
  { x: 370, y: 580, r: 5, delay: 1.8 } // 6
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
  { a: 5, b: 6, dur: 6.2, delay: 1.5 }
];

function edgePath(e: NetEdge): string {
  const a = NODES[e.a];
  const b = NODES[e.b];
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

/** 渲染整张 mesh：连线(流动) + 沿线游走的脉冲 + 节点(呼吸光晕 + 实心点)。 */
function meshSvg(className = 'mesh') {
  return html`
    <svg
      class=${className}
      viewBox="0 0 560 640"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      ${EDGES.map(
        (e, k) => html`
          <path
            id=${`edge-${k}`}
            class="edge"
            d=${edgePath(e)}
            style=${`animation-delay:${e.delay}s`}
          ></path>
          <circle class="packet" r="3">
            <animateMotion
              dur=${`${e.dur}s`}
              begin=${`${e.delay}s`}
              repeatCount="indefinite"
            >
              <mpath href=${`#edge-${k}`}></mpath>
            </animateMotion>
          </circle>
        `
      )}
      ${NODES.map(
        (n) => html`
          <circle
            class="node-glow"
            cx=${n.x}
            cy=${n.y}
            r=${n.r * 2.4}
            style=${`animation-delay:${n.delay}s`}
          ></circle>
          <circle class="node" cx=${n.x} cy=${n.y} r=${n.r}></circle>
        `
      )}
    </svg>
  `;
}

/** 眼睛图标：open=true 睁眼，false 闭眼（带斜杠）。 */
function eyeIcon(open: boolean) {
  return open
    ? html`<svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"
          stroke="currentColor"
          stroke-width="1.6"
        />
        <circle
          cx="12"
          cy="12"
          r="3"
          stroke="currentColor"
          stroke-width="1.6"
        />
      </svg>`
    : html`<svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M2 12s3.5-7 10-7c2 0 3.7.8 5.2 1.9M22 12s-3.5 7-10 7c-2 0-3.7-.8-5.2-1.9"
          stroke="currentColor"
          stroke-width="1.6"
        />
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
        place-items: center;
        min-height: 100vh;
        min-height: 100dvh;
        overflow: auto;
        background: var(--ah-canvas);
      }
      /* 锁定 1280×832 画幅并居中；单幅沉浸式背景。 */
      .login-wrap {
        position: relative;
        width: 100%;
        aspect-ratio: 1280 / 832;
        max-height: 100vh;
        max-height: 100dvh;
        overflow: hidden;
        /* 统一极光背景：accent → surface-3 → surface-1 */
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--ah-accent) 30%, transparent) 0%,
          color-mix(in srgb, var(--ah-surface-3) 55%, transparent) 50%,
          var(--ah-surface-1) 100%
        );
      }
      :host([data-theme='light']) .login-wrap {
        background: linear-gradient(
          135deg,
          rgba(0, 102, 230, 0.16) 0%,
          rgba(217, 235, 255, 0.55) 55%,
          #fff 100%
        );
      }

      /* ---------------------- 背景氛围层 ---------------------- */
      .mesh {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        z-index: 1;
        opacity: 0.95;
        pointer-events: none;
      }
      .edge {
        fill: none;
        stroke: var(--ah-accent);
        stroke-width: 1.2;
        opacity: 0.5;
        stroke-dasharray: 5 9;
        animation: ah-login-flow 4s linear infinite;
      }
      :host([data-theme='light']) .edge {
        opacity: 0.78;
      }
      @keyframes ah-login-flow {
        to {
          stroke-dashoffset: -140;
        }
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
        0%,
        100% {
          opacity: 0.32;
          transform: scale(0.82);
        }
        50% {
          opacity: 0.65;
          transform: scale(1.28);
        }
      }

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
        border-radius: 50%;
        background: var(--ah-accent);
        box-shadow: 0 0 9px 1px var(--ah-accent);
        opacity: 0;
        animation: ah-login-float linear infinite;
      }
      @keyframes ah-login-float {
        0% {
          transform: translateY(0);
          opacity: 0;
        }
        12% {
          opacity: 0.85;
        }
        88% {
          opacity: 0.85;
        }
        100% {
          transform: translateY(-150px);
          opacity: 0;
        }
      }

      /* 景深 mesh：比主 mesh 更大、更淡、更慢，营造空间纵深感。 */
      .depth-mesh {
        position: absolute;
        inset: -12%;
        width: 124%;
        height: 124%;
        z-index: 0;
        opacity: 0.18;
        filter: blur(1.5px);
        pointer-events: none;
        animation: ah-login-drift 24s ease-in-out infinite alternate;
      }
      :host([data-theme='light']) .depth-mesh {
        opacity: 0.28;
      }
      .depth-mesh .edge {
        opacity: 0.35;
        stroke-width: 0.9;
      }
      .depth-mesh .node,
      .depth-mesh .node-glow,
      .depth-mesh .packet {
        opacity: 0.45;
      }
      @keyframes ah-login-drift {
        0% {
          transform: translate(-2%, -2%) scale(1.02);
        }
        100% {
          transform: translate(2%, 2%) scale(1.08);
        }
      }

      /* 漂浮光球：大尺度 accent 柔光，增加背景层次。 */
      .orbs {
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        overflow: hidden;
      }
      .orb {
        position: absolute;
        border-radius: 50%;
        filter: blur(60px);
        opacity: 0.32;
        animation: ah-login-orb 18s ease-in-out infinite alternate;
      }
      :host([data-theme='light']) .orb {
        opacity: 0.22;
      }
      @keyframes ah-login-orb {
        0% {
          transform: translate(0, 0) scale(1);
        }
        100% {
          transform: translate(20px, -30px) scale(1.12);
        }
      }

      /* 全幅晕影：中心透亮、四周渐隐，让悬浮卡片更聚焦。 */
      .vignette {
        position: absolute;
        inset: 0;
        z-index: 2;
        pointer-events: none;
        background: radial-gradient(
          circle at 50% 60%,
          transparent 35%,
          color-mix(in srgb, var(--ah-surface-1) 60%, transparent) 100%
        );
      }
      :host([data-theme='light']) .vignette {
        background: radial-gradient(
          circle at 50% 60%,
          transparent 35%,
          rgba(255, 255, 255, 0.45) 100%
        );
      }
      /* 卡片背后 accent 光晕 */
      .card-halo {
        position: absolute;
        left: 46%;
        top: 52%;
        transform: translate(-50%, -50%);
        width: 480px;
        height: 620px;
        z-index: 2;
        pointer-events: none;
        background: radial-gradient(
          circle,
          color-mix(in srgb, var(--ah-accent) 22%, transparent) 0%,
          transparent 70%
        );
        filter: blur(50px);
        opacity: 0.8;
      }
      :host([data-theme='light']) .card-halo {
        background: radial-gradient(
          circle,
          rgba(0, 102, 230, 0.14) 0%,
          transparent 70%
        );
      }

      /* ---------------------- 品牌文案（左上 + 左下） ---------------------- */
      .brand-top {
        position: absolute;
        top: 42px;
        left: 48px;
        right: 48px;
        z-index: 4;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .brand-mark {
        display: flex;
        align-items: center;
        gap: 12px;
        font-family: var(--ah-font-display);
        font-weight: 600;
        font-size: 18px;
        color: var(--ah-text);
      }
      .brand-mark .logo {
        width: 34px;
        height: 34px;
        object-fit: contain;
        display: block;
        filter: drop-shadow(
            0 0 10px color-mix(in srgb, var(--ah-accent) 60%, transparent)
          )
          drop-shadow(
            0 0 22px color-mix(in srgb, var(--ah-accent) 35%, transparent)
          );
      }
      :host([data-theme='light']) .brand-mark .logo {
        filter: drop-shadow(0 0 8px rgba(0, 102, 230, 0.35))
          drop-shadow(0 0 16px rgba(0, 102, 230, 0.22));
      }
      .brand-ver {
        font-family: var(--ah-font-mono);
        font-size: 11px;
        font-weight: 500;
        color: var(--ah-text-muted);
        background: var(--ah-surface-3);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-pill);
        padding: 4px 10px;
      }
      .status-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-family: var(--ah-font-mono);
        font-size: 11px;
        color: var(--ah-text-muted);
        white-space: nowrap;
      }
      .chip-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--ah-accent);
        box-shadow: 0 0 8px 1px var(--ah-accent);
        animation: ah-login-chip 1.6s ease-in-out infinite;
      }
      @keyframes ah-login-chip {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.45;
        }
      }

      .brand-head {
        position: absolute;
        top: 110px;
        left: 48px;
        width: min(300px, 26%);
        z-index: 4;
      }
      .brand-title {
        font-family: var(--ah-font-display);
        font-size: 26px;
        font-weight: 600;
        line-height: 1.25;
        margin: 0;
        color: var(--ah-text);
        text-shadow: 0 0 6px
            color-mix(in srgb, var(--ah-accent) 55%, transparent),
          0 0 16px color-mix(in srgb, var(--ah-accent) 35%, transparent),
          0 0 32px color-mix(in srgb, var(--ah-accent) 20%, transparent);
      }
      :host([data-theme='light']) .brand-title {
        text-shadow: 0 0 4px rgba(0, 102, 230, 0.35),
          0 0 12px rgba(0, 102, 230, 0.22), 0 0 24px rgba(0, 102, 230, 0.12);
      }
      .brand-sub {
        color: var(--ah-text-muted);
        font-size: 15px;
        line-height: 1.6;
        margin: 14px 0 0;
        max-width: 30ch;
      }

      .brand-bottom {
        position: absolute;
        bottom: 42px;
        left: 48px;
        width: min(300px, 26%);
        z-index: 4;
      }
      .feature-list {
        list-style: none;
        margin: 0 0 24px;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .feature-list li {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 14px;
        color: var(--ah-text);
      }
      .feature-list .tick {
        width: 20px;
        height: 20px;
        flex: 0 0 auto;
        color: var(--ah-accent);
      }
      .brand-foot {
        font-size: 12px;
        color: var(--ah-text-faint);
        font-family: var(--ah-font-mono);
      }

      /* ---------------------- 悬浮认证卡片 ---------------------- */
      .auth-float {
        position: absolute;
        /* 悬浮于画面中右，与左上标题、左下特性形成对角构图；
           clamp 保证在任何画幅下都不覆盖左侧文案、不溢出右边界。 */
        left: clamp(420px, 46%, calc(100% - 380px));
        top: 52%;
        transform: translate(-50%, -50%);
        width: 360px;
        max-width: calc(100% - 96px);
        z-index: 5;
      }
      .auth-card {
        width: 100%;
        background: color-mix(in srgb, var(--ah-surface-1) 88%, transparent);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        border: 1px solid var(--ah-border);
        border-radius: 20px;
        padding: 34px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35),
          0 24px 60px rgba(0, 0, 0, 0.32),
          inset 0 0 0 1px color-mix(in srgb, var(--ah-accent) 50%, transparent),
          0 0 30px color-mix(in srgb, var(--ah-accent) 30%, transparent);
      }
      :host([data-theme='light']) .auth-card {
        background: rgba(255, 255, 255, 0.78);
        border-color: rgba(0, 102, 230, 0.22);
        box-shadow: 0 1px 2px rgba(10, 16, 26, 0.06),
          0 24px 60px rgba(10, 16, 26, 0.1),
          inset 0 0 0 1px rgba(0, 102, 230, 0.32),
          0 0 30px rgba(0, 102, 230, 0.16);
      }
      .auth-card h1 {
        font-family: var(--ah-font-display);
        font-size: 24px;
        font-weight: 600;
        margin: 0 0 6px;
        color: var(--ah-text);
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
        border-radius: 8px;
        color: var(--ah-text);
        font-size: 13px;
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
        border-radius: 8px;
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
      .forge {
        background: none;
        border: none;
        color: var(--ah-accent);
        cursor: pointer;
        font-size: 13px;
        padding: 0;
        font-family: inherit;
      }
      .btn-primary {
        width: 100%;
        height: 46px;
        background: var(--ah-accent);
        color: #fff;
        border: none;
        border-radius: var(--ah-radius-pill);
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        box-shadow: 0 4px 16px
          color-mix(in srgb, var(--ah-accent) 55%, transparent);
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
        margin: 16px 0;
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
        height: 46px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        background: var(--ah-surface-2);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-pill);
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
        font-weight: 600;
      }
      .notice {
        margin-top: 14px;
        padding: 8px 12px;
        border-radius: 8px;
        background: var(--ah-accent-soft);
        color: var(--ah-accent);
        font-size: 12px;
        text-align: center;
      }

      .notice .error {
        background: var(--ah-danger-soft);
        color: var(--ah-danger);
      }

      /* ---------------------- 移动端：上下堆叠 ---------------------- */
      @media (max-width: 900px) {
        :host {
          place-items: start center;
        }
        .login-wrap {
          display: flex;
          flex-direction: column;
          aspect-ratio: auto;
          max-height: none;
          min-height: 100dvh;
          overflow: visible;
          padding: 32px 24px;
          gap: 8px;
        }
        .brand-top,
        .brand-head,
        .brand-bottom {
          position: static;
          width: auto;
        }
        .brand-head {
          margin-top: 28px;
        }
        .brand-bottom {
          margin-top: 8px;
        }
        .feature-list {
          display: none;
        }
        .vignette,
        .card-halo {
          display: none;
        }
        .auth-float {
          position: relative;
          left: auto;
          top: auto;
          transform: none;
          width: 100%;
          max-width: 100%;
          margin: 24px 0 0;
        }
        .auth-card {
          background: var(--ah-surface-1);
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
        }
        :host([data-theme='light']) .auth-card {
          background: #fff;
        }
      }
    `
  ];

  @state() mode: 'login' | 'register' = 'login';
  @state() showPassword = false;
  @state() showConfirm = false;
  @state() remember = false;
  @state() agree = false;
  @state() notice: string | null = null;
  @state() submitting = false;
  @state() theme: Theme = getTheme();

  private themeObs?: MutationObserver;

  private toggleMode() {
    this.mode = this.mode === 'login' ? 'register' : 'login';
    this.notice = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('data-theme', this.theme);
    this.themeObs = new MutationObserver(() => {
      this.theme = getTheme();
      this.setAttribute('data-theme', this.theme);
    });
    this.themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.themeObs?.disconnect();
  }

  /**
   * 提交：真实接入账户密码后端。
   *  - 注册：POST /api/account/register（服务端落库 + 顺带签发登录 cookie）。
   *  - 登录：POST /api/account/login（校验凭据 + 下发 cookie）。
   * 成功后服务端已下发现有 HttpOnly cookie，前端只需记录用户名（setSession）并派发
   * ah-login-success 通知 main.ts 进入控制台；失败则展示后端返回的错误文案。
   * 注意：cookie 由浏览器托管、前端不读取其值；用户名仅用于 x-ah-username 双因子。
   */
  private async onSubmit(e: Event) {
    e.preventDefault();
    if (this.submitting) return;
    if (this.mode === 'register' && !this.agree) {
      this.notice = '请先阅读并同意服务条款与隐私政策。';
      return;
    }
    // 从表单读取字段（输入项受控在 DOM，按 name 取）。
    const form = e.target as HTMLFormElement;
    const email =
      (
        form.elements.namedItem('email') as HTMLInputElement | null
      )?.value?.trim() ?? '';
    const password =
      (form.elements.namedItem('password') as HTMLInputElement | null)?.value ??
      '';
    const confirm =
      (form.elements.namedItem('confirm') as HTMLInputElement | null)?.value ??
      '';
    const username =
      (
        form.elements.namedItem('username') as HTMLInputElement | null
      )?.value?.trim() ?? '';

    if (this.mode === 'register') {
      if (!email) {
        this.notice = '请填写邮箱。';
        return;
      }
      if (password.length < 8) {
        this.notice = '密码至少 8 位。';
        return;
      }
      if (password !== confirm) {
        this.notice = '两次输入的密码不一致。';
        return;
      }
    } else {
      if (!email) {
        this.notice = '请填写邮箱 / 用户名。';
        return;
      }
      if (!password) {
        this.notice = '请填写密码。';
        return;
      }
    }

    this.submitting = true;
    this.notice = null;
    try {
      const endpoint =
        this.mode === 'register'
          ? '/api/account/register'
          : '/api/account/login';
      // 登录支持邮箱或用户名；注册用邮箱作为登录名（后端 username 即登录标识）。
      const body = JSON.stringify({ username, email, password });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        credentials: 'same-origin'
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        username?: string;
      };
      if (!res.ok || !data.ok) {
        this.notice =
          data.error ||
          (this.mode === 'register' ? '注册失败。' : '登录失败。');
        return;
      }
      // 服务端已下发 ah_auth cookie；前端仅记录用户名用于双因子 header。
      setSession(data.username || email);
      this.dispatchEvent(
        new CustomEvent('ah-login-success', { bubbles: true, composed: true })
      );
    } catch (err) {
      this.notice =
        '网络异常，请稍后重试。' +
        (err instanceof Error ? `（${err.message}）` : '');
    } finally {
      this.submitting = false;
    }
  }

  private field(
    label: string,
    type: string,
    placeholder: string,
    valueKey: 'email' | 'username' | 'password' | 'confirm',
    hasEye = false
  ) {
    const isPw = hasEye;
    const inputType = isPw
      ? valueKey === 'password'
        ? this.showPassword
          ? 'text'
          : 'password'
        : this.showConfirm
        ? 'text'
        : 'password'
      : type;
    return html`
      <div class="field ${hasEye ? 'has-eye' : ''}">
        <label>${label}</label>
        <input
          name=${valueKey}
          type=${inputType}
          placeholder=${placeholder}
          autocomplete=${valueKey}
        />
        ${hasEye
          ? html`<button
              class="eye-btn"
              type="button"
              title=${valueKey === 'password'
                ? this.showPassword
                  ? '隐藏密码'
                  : '显示密码'
                : this.showConfirm
                ? '隐藏密码'
                : '显示密码'}
              @click=${() =>
                valueKey === 'password'
                  ? (this.showPassword = !this.showPassword)
                  : (this.showConfirm = !this.showConfirm)}
            >
              ${eyeIcon(
                valueKey === 'password' ? this.showPassword : this.showConfirm
              )}
            </button>`
          : nothing}
      </div>
    `;
  }

  render() {
    const particles = [10, 24, 39, 55, 70, 84, 93].map(
      (left, i) =>
        html`<span
          class="particle"
          style=${`left:${left}%;width:${4 + (i % 2)}px;height:${
            4 + (i % 2)
          }px;animation-duration:${5 + (i % 4)}s;animation-delay:${i * 0.7}s`}
        ></span>`
    );

    const orbs = [
      { w: 420, h: 420, l: 6, t: 8, d: 0 },
      { w: 320, h: 320, l: 62, t: 46, d: 6 },
      { w: 260, h: 260, l: 34, t: 72, d: 12 }
    ].map(
      (o) =>
        html`<span
          class="orb"
          style=${`left:${o.l}%;top:${o.t}%;width:${o.w}px;height:${o.h}px;background:radial-gradient(circle, color-mix(in srgb, var(--ah-accent) 55%, transparent) 0%, transparent 70%);animation-delay:${o.d}s`}
        ></span>`
    );

    return html`
      <div class="login-wrap">
        <div class="depth-mesh">${meshSvg('depth-mesh')}</div>
        <div class="orbs">${orbs}</div>
        ${meshSvg()}
        <div class="particles">${particles}</div>
        <div class="vignette"></div>
        <div class="card-halo"></div>

        <div class="brand-top">
          <div class="brand-mark">
            <img
              class="logo"
              src=${this.theme === 'light' ? './logo.svg' : './logo-white.svg'}
              alt="Agent Harness"
            />
            <span>Agent Harness</span>
            <span class="brand-ver">v2.0</span>
          </div>
          <div class="status-chip">
            <span class="chip-dot"></span>实时编排中
          </div>
        </div>

        <div class="brand-head">
          <h2 class="brand-title">编排、运行、观测<br />你的每一个 AI Agent</h2>
          <p class="brand-sub">
            统一接入 MCP 工具生态，实时追踪思考链路，把精力留给真正的业务价值。
          </p>
        </div>

        <div class="brand-bottom">
          <ul class="feature-list">
            <li>
              <svg
                class="tick"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4 10.5l4 4 8-9"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              多 Agent 编排与并行调度
            </li>
            <li>
              <svg
                class="tick"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4 10.5l4 4 8-9"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              一键接入 40+ MCP 服务
            </li>
            <li>
              <svg
                class="tick"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4 10.5l4 4 8-9"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              全链路可观测与事件回放
            </li>
          </ul>
          <div class="brand-foot">Agent Harness 2026 · 私有化部署就绪</div>
        </div>

        <div class="auth-float">
          <div class="auth-card">
            ${this.mode === 'login'
              ? html`
                  <h1>欢迎回来</h1>
                  <p class="auth-sub">登录以进入你的 Agent 工作台</p>
                  <form @submit=${this.onSubmit}>
                    ${this.field('用户名', 'username', '用户名', 'username')}
                    ${this.field(
                      '密码',
                      'password',
                      '请输入密码',
                      'password',
                      true
                    )}
                    <div class="row-between">
                      <label class="remember"
                        ><input
                          type="checkbox"
                          ?checked=${this.remember}
                          @change=${(e: Event) =>
                            (this.remember = (
                              e.target as HTMLInputElement
                            ).checked)}
                        />
                        记住我</label
                      >
                      <button
                        class="forge"
                        type="button"
                        @click=${() =>
                          (this.notice = '演示页面：找回密码流程待接入。')}
                      >
                        忘记密码？
                      </button>
                    </div>
                    <button
                      class="btn-primary"
                      type="submit"
                      ?disabled=${this.submitting}
                    >
                      ${this.submitting ? '登录中…' : '登录'}
                    </button>
                  </form>
                  <div class="divider">或</div>
                  <button
                    class="btn-sso"
                    type="button"
                    @click=${() =>
                      (this.notice = '演示页面：GitHub OAuth 待接入。')}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 5 18.3 5.3 18.3 5.3c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5Z"
                      />
                    </svg>
                    使用 GitHub 继续
                  </button>
                  ${this.notice
                    ? html`<div class="notice error">${this.notice}</div>`
                    : nothing}
                  <div class="auth-foot">
                    还没有账号？<button
                      class="link"
                      type="button"
                      @click=${this.toggleMode}
                    >
                      立即注册
                    </button>
                  </div>
                `
              : html`
                  <h1>创建账号</h1>
                  <p class="auth-sub">注册以解锁完整的智能体编排能力</p>
                  <form @submit=${this.onSubmit}>
                    ${this.field('邮箱', 'email', 'you@company.com', 'email')}
                    ${this.field('用户名', 'text', '设置用户名', 'username')}
                    ${this.field(
                      '密码',
                      'password',
                      '至少 8 位',
                      'password',
                      true
                    )}
                    ${this.field(
                      '确认密码',
                      'password',
                      '再次输入密码',
                      'confirm',
                      true
                    )}
                    <label class="terms">
                      <input
                        type="checkbox"
                        ?checked=${this.agree}
                        @change=${(e: Event) =>
                          (this.agree = (e.target as HTMLInputElement).checked)}
                      />
                      <span
                        >我已阅读并同意
                        <a href="#" @click=${(e: Event) => e.preventDefault()}
                          >服务条款</a
                        >
                        与
                        <a href="#" @click=${(e: Event) => e.preventDefault()}
                          >隐私政策</a
                        >。</span
                      >
                    </label>
                    <button
                      class="btn-primary"
                      type="submit"
                      ?disabled=${this.submitting}
                    >
                      ${this.submitting ? '创建中…' : '创建账号'}
                    </button>
                  </form>
                  ${this.notice
                    ? html`<div class="notice">${this.notice}</div>`
                    : nothing}
                  <div class="auth-foot">
                    已有账号？<button
                      class="link"
                      type="button"
                      @click=${this.toggleMode}
                    >
                      去登录
                    </button>
                  </div>
                `}
          </div>
        </div>
      </div>
    `;
  }
}
