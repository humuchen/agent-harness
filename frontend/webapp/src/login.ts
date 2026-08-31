/**
 * 登录 / 注册页（ah-login）
 * ----------------------------------------------------------------
 * 单幅沉浸式背景 + 悬浮认证卡片：
 *  - 整体锁定 1280×832 画幅并居中，避免大屏拉伸。
 *  - 整页统一为极光渐变背景 + 动画「智能体网络」mesh + 漂浮发光粒子，
 *    不再左右分栏；认证卡片以毛玻璃形态悬浮于画面中右（箭头指向区域）。
 *  - 科技感叠层（自下而上）：细网格底纹 → 透视地平线网格 → 光球 → 景深 mesh
 *    → 主 mesh → 扫描光带/雷达线 → 粒子 → 晕影 → CRT 扫描线 → HUD（四角括号、
 *    右侧刻度尺、右下角遥测读数）。品牌文案分列左上/左下。
 *  - 账号/密码/邮箱/确认密码框支持 Enter 直接提交；按钮下方给出 Enter 提示。
 *  - 完全区分 dark/light 主题，并遵循 prefers-reduced-motion 降级。
 *
 * 校验与提示（本迭代变更）：
 *  - 登录 / 注册的全部字段校验前移到前端（utils/auth-validation.ts，规则与后端
 *    accounts.ts 对齐）；校验不通过不发请求，直接用 ah-notification 提示并聚焦出错字段。
 *  - 所有提示（校验错误 / 后端业务错误 / 网络异常 / 成功）统一走 ah-notification，
 *    页内不再保留内联 `.notice` 提示条。
 *
 * 视觉只引用 --ah-* 语义令牌，局部渐变/发光用 color-mix 或硬编码主题覆盖，
 * 动画命名沿用项目 ah-* 约定（组件内作用域）。
 */
import { LitElement, html, nothing, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles } from './styles';
import { getTheme, type Theme } from './theme/tokens';
import { setSession, requestPasswordReset, resetPassword } from './api';
import { notify } from './components/ah-notification';
import { notifyError } from './utils/errors';
import {
  validateLogin,
  validateRegister,
  validateForgot,
  validateResetPassword,
  type LoginForm,
  type RegisterForm
} from './utils/auth-validation';

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

      /* ---------------------- 科技感图层：网格 / 扫描光带 / HUD ---------------------- */
      /* 细网格底纹：整幅 64px 网格，中心亮、四周径向淡出，并极缓慢平移。 */
      .tech-grid {
        position: absolute;
        inset: -1px;
        z-index: 0;
        pointer-events: none;
        background-image: linear-gradient(
            to right,
            color-mix(in srgb, var(--ah-accent) 26%, transparent) 1px,
            transparent 1px
          ),
          linear-gradient(
            to bottom,
            color-mix(in srgb, var(--ah-accent) 26%, transparent) 1px,
            transparent 1px
          );
        background-size: 64px 64px;
        mask-image: radial-gradient(
          ellipse 78% 70% at 48% 46%,
          #000 24%,
          transparent 92%
        );
        -webkit-mask-image: radial-gradient(
          ellipse 78% 70% at 48% 46%,
          #000 24%,
          transparent 92%
        );
        opacity: 0.42;
        animation: ah-login-grid-pan 26s linear infinite;
      }
      :host([data-theme='light']) .tech-grid {
        background-image: linear-gradient(
            to right,
            rgba(0, 102, 230, 0.16) 1px,
            transparent 1px
          ),
          linear-gradient(
            to bottom,
            rgba(0, 102, 230, 0.16) 1px,
            transparent 1px
          );
        opacity: 0.55;
      }
      @keyframes ah-login-grid-pan {
        to {
          background-position: 64px 64px, 64px 64px;
        }
      }

      /* 透视地平线网格：底部 3D 网格向后退去，制造纵深空间。 */
      .grid-floor {
        position: absolute;
        left: -20%;
        right: -20%;
        bottom: -8%;
        height: 42%;
        z-index: 0;
        pointer-events: none;
        overflow: hidden;
        perspective: 300px;
        perspective-origin: 50% 0%;
      }
      .grid-floor::before {
        content: '';
        position: absolute;
        inset: 0 -20% -180% -20%;
        transform-origin: 50% 0%;
        transform: rotateX(74deg);
        background-image: linear-gradient(
            to right,
            color-mix(in srgb, var(--ah-accent) 42%, transparent) 1px,
            transparent 1px
          ),
          linear-gradient(
            to bottom,
            color-mix(in srgb, var(--ah-accent) 42%, transparent) 1px,
            transparent 1px
          );
        background-size: 72px 72px;
        mask-image: linear-gradient(
          to bottom,
          transparent 0%,
          #000 36%,
          transparent 86%
        );
        -webkit-mask-image: linear-gradient(
          to bottom,
          transparent 0%,
          #000 36%,
          transparent 86%
        );
        animation: ah-login-floor 5.5s linear infinite;
      }
      :host([data-theme='light']) .grid-floor::before {
        background-image: linear-gradient(
            to right,
            rgba(0, 102, 230, 0.26) 1px,
            transparent 1px
          ),
          linear-gradient(
            to bottom,
            rgba(0, 102, 230, 0.26) 1px,
            transparent 1px
          );
      }
      @keyframes ah-login-floor {
        to {
          background-position: 0 72px;
        }
      }

      /* 扫描层：竖向柔光带 + 横向雷达线，交替扫过全幅。 */
      .scan-track {
        position: absolute;
        inset: 0;
        z-index: 1;
        pointer-events: none;
        overflow: hidden;
      }
      .scan-beam {
        position: absolute;
        top: -8%;
        bottom: -8%;
        left: 0;
        width: 16%;
        background: linear-gradient(
          90deg,
          transparent 0%,
          color-mix(in srgb, var(--ah-accent) 8%, transparent) 36%,
          color-mix(in srgb, var(--ah-accent) 32%, transparent) 50%,
          color-mix(in srgb, var(--ah-accent) 8%, transparent) 64%,
          transparent 100%
        );
        filter: blur(8px);
        opacity: 0;
        animation: ah-login-sweep 11s cubic-bezier(0.5, 0, 0.5, 1) infinite;
      }
      :host([data-theme='light']) .scan-beam {
        background: linear-gradient(
          90deg,
          transparent 0%,
          rgba(0, 102, 230, 0.06) 36%,
          rgba(0, 102, 230, 0.2) 50%,
          rgba(0, 102, 230, 0.06) 64%,
          transparent 100%
        );
      }
      /* translateX 走自身宽度的倍数：宽度 16% ⇒ -130% → 660% 正好扫过整个容器。 */
      @keyframes ah-login-sweep {
        0% {
          transform: translateX(-130%);
          opacity: 0;
        }
        12% {
          opacity: 0.9;
        }
        88% {
          opacity: 0.9;
        }
        100% {
          transform: translateX(660%);
          opacity: 0;
        }
      }
      .scan-line {
        position: absolute;
        left: 0;
        right: 0;
        top: -1%;
        height: 1px;
        background: linear-gradient(
          90deg,
          transparent 0%,
          color-mix(in srgb, var(--ah-accent) 60%, transparent) 18%,
          color-mix(in srgb, var(--ah-accent) 90%, transparent) 50%,
          color-mix(in srgb, var(--ah-accent) 60%, transparent) 82%,
          transparent 100%
        );
        box-shadow: 0 0 20px 2px
          color-mix(in srgb, var(--ah-accent) 40%, transparent);
        opacity: 0;
        animation: ah-login-scanline 7.5s ease-in-out infinite;
      }
      @keyframes ah-login-scanline {
        0% {
          top: -1%;
          opacity: 0;
        }
        10% {
          opacity: 0.5;
        }
        90% {
          opacity: 0.5;
        }
        100% {
          top: 101%;
          opacity: 0;
        }
      }

      /* CRT 扫描线：极淡横向条纹，压一层数字屏幕质感。 */
      .scanlines {
        position: absolute;
        inset: 0;
        z-index: 2;
        pointer-events: none;
        background: repeating-linear-gradient(
          to bottom,
          rgba(190, 225, 255, 0.05) 0 1px,
          transparent 1px 4px
        );
        opacity: 0.45;
      }
      :host([data-theme='light']) .scanlines {
        background: repeating-linear-gradient(
          to bottom,
          rgba(10, 32, 68, 0.04) 0 1px,
          transparent 1px 4px
        );
        opacity: 0.5;
      }

      /* HUD 四角括号：给画幅加一层「取景框 / 控制台」感。 */
      .hud {
        position: absolute;
        inset: 0;
        z-index: 3;
        pointer-events: none;
      }
      .hud-corner {
        position: absolute;
        width: 28px;
        height: 28px;
        border: 1px solid color-mix(in srgb, var(--ah-accent) 62%, transparent);
      }
      .hud-corner.tl {
        top: 20px;
        left: 24px;
        border-right: 0;
        border-bottom: 0;
      }
      .hud-corner.tr {
        top: 20px;
        right: 24px;
        border-left: 0;
        border-bottom: 0;
      }
      .hud-corner.bl {
        bottom: 20px;
        left: 24px;
        border-right: 0;
        border-top: 0;
      }
      .hud-corner.br {
        bottom: 20px;
        right: 24px;
        border-left: 0;
        border-top: 0;
      }

      /* HUD 右侧刻度尺：等距刻度 + 等宽数字，模拟遥测标尺。 */
      .hud-ruler {
        position: absolute;
        right: 28px;
        top: 50%;
        transform: translateY(-50%);
        z-index: 3;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 15px;
        font-family: var(--ah-font-mono);
        font-size: 10px;
        letter-spacing: 0.06em;
        color: var(--ah-text-faint);
      }
      .hud-ruler span {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .hud-ruler i {
        display: block;
        width: 12px;
        height: 1px;
        background: color-mix(in srgb, var(--ah-accent) 50%, transparent);
      }

      /* HUD 遥测读数：右下角实时 uptime / 链路延迟，带闪烁光标。 */
      .hud-tel {
        position: absolute;
        right: 28px;
        bottom: 26px;
        z-index: 3;
        pointer-events: none;
        text-align: right;
        font-family: var(--ah-font-mono);
        font-size: 10.5px;
        line-height: 1.95;
        letter-spacing: 0.04em;
        color: var(--ah-text-faint);
      }
      .hud-tel b {
        font-weight: 600;
        color: color-mix(in srgb, var(--ah-accent) 82%, var(--ah-text));
      }
      .hud-tel .cursor {
        display: inline-block;
        width: 6px;
        height: 10px;
        margin-left: 4px;
        vertical-align: -1px;
        background: var(--ah-accent);
        animation: ah-login-caret 1.05s steps(1) infinite;
      }
      @keyframes ah-login-caret {
        0%,
        50% {
          opacity: 1;
        }
        50.01%,
        100% {
          opacity: 0;
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
        display: block;
        fill: currentColor;
        color: var(--ah-text);
        filter: drop-shadow(
            0 0 10px color-mix(in srgb, var(--ah-accent) 60%, transparent)
          )
          drop-shadow(
            0 0 22px color-mix(in srgb, var(--ah-accent) 35%, transparent)
          );
      }
      :host([data-theme='light']) .brand-mark .logo {
        color: var(--ah-accent);
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
        left: clamp(420px, 46%, calc(100% - 700px));
        top: 52%;
        transform: translate(-50%, -50%);
        /* PC 端卡片宽度 680px（可用 --ahd-size 覆盖）；移动端媒体查询强制 100% 满宽。 */
        width: var(--ahd-size, 680px);
        max-width: calc(100% - 96px);
        z-index: 5;
      }
      .auth-card {
        width: 100%;
        box-sizing: border-box;
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
        position: relative;
        overflow: hidden;
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
      /* 按钮表面掠过的高光，弱化纯色块、增加「可点击」的电流感。 */
      .btn-primary::after {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: -40%;
        width: 38%;
        background: linear-gradient(
          90deg,
          transparent,
          rgba(255, 255, 255, 0.3),
          transparent
        );
        animation: ah-login-shimmer 3.8s ease-in-out infinite;
      }
      @keyframes ah-login-shimmer {
        0%,
        62% {
          left: -40%;
        }
        100% {
          left: 122%;
        }
      }
      .btn-primary:hover {
        filter: brightness(1.06);
      }
      .btn-primary:active {
        transform: translateY(1px);
      }

      /* Enter 提示：明确告诉用户回车即可提交。 */
      .enter-hint {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        margin-top: 10px;
        font-family: var(--ah-font-mono);
        font-size: 11px;
        color: var(--ah-text-faint);
      }
      .enter-hint kbd {
        font-family: var(--ah-font-mono);
        font-size: 10px;
        line-height: 1;
        padding: 3px 6px;
        border-radius: 5px;
        border: 1px solid var(--ah-border);
        background: var(--ah-surface-2);
        color: var(--ah-text-muted);
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
        /* 图标按钮：仅展示各自 logo，方形成组并排。 */
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: var(--ah-text);
        cursor: pointer;
        font-family: inherit;
        transition: border-color 140ms ease, background 140ms ease;
        padding: 0;
      }
      .btn-sso:hover {
        border-color: var(--ah-accent);
        background: var(--ah-surface-2);
      }
      .btn-sso svg {
        width: 20px;
        height: 20px;
      }
      .sso-row {
        display: flex;
        gap: 12px;
        justify-content: center;
      }
      .sso-row .btn-sso {
        flex: 0 0 auto;
      }
      .terms {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: 12px;
        color: var(--ah-text-muted);
        margin-bottom: 18px;
        line-height: 1.5;
        flex-direction: row;
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
      /* ---------------------- 降级：尊重系统「减少动态效果」 ---------------------- */
      @media (prefers-reduced-motion: reduce) {
        .tech-grid,
        .grid-floor::before,
        .scan-beam,
        .scan-line,
        .orb,
        .particle,
        .depth-mesh,
        .chip-dot,
        .hud-tel .cursor,
        .btn-primary::after,
        .edge,
        .node-glow {
          animation: none !important;
        }
        .scan-track,
        .scanlines {
          display: none;
        }
      }

      /* ---------------------- 移动端：上下堆叠 ---------------------- */
      @media (max-width: 900px) {
        :host {
          place-items: start center;
          /* 横向裁掉：装饰层 .depth-mesh（inset:-12% / width:124%）
             在移动端 .login-wrap 放开后本体会向右溢出约 12%。 */
          overflow-x: hidden;
          /* 移动端允许整页滚动，避免内容超高被裁切 */
          overflow-y: auto;
          -webkit-text-size-adjust: 100%;
          text-size-adjust: 100%;
        }
        .login-wrap {
          display: flex;
          flex-direction: column;
          box-sizing: border-box;
          aspect-ratio: auto;
          max-height: none;
          min-height: 100dvh;
          /* border-box：padding 计入宽度，避免 100% 宽 + 内边距撑出横向溢出；
             overflow-x:hidden 裁掉装饰层右溢，overflow-y:auto 让内容超高时纵向滚动，
             同时裁掉 .depth-mesh 上下 -12% 的幻影溢出（它原本会把 scrollHeight 撑大、
             凭空触发竖向滚动条）。 */
          box-sizing: border-box;
          overflow-x: hidden;
          overflow-y: auto;
          padding: 24px 18px;
          gap: 4px;
        }
        .brand-top,
        .brand-head,
        .brand-bottom {
          position: static;
          width: auto;
        }
        .brand-top {
          padding: 0;
        }
        .brand-head {
          margin-top: 18px;
        }
        .brand-bottom {
          margin-top: 6px;
        }
        .brand-sub {
          margin-top: 10px;
        }
        .feature-list {
          display: none;
        }
        .vignette,
        .card-halo,
        /* 移动端为滚动布局，关闭 3D 地面、扫描线与 HUD 等纯装饰层，
           只保留细网格 + 主 mesh + 粒子，保证性能与可读性。 */
        .grid-floor,
        .scan-track,
        .scanlines,
        .hud,
        .hud-ruler,
        .hud-tel {
          display: none;
        }
        /* depth-mesh 是 inset:-12% / width:124% 的装饰景深层，无 overflow 裁切，
           会在移动端向下/右溢出、凭空撑出滚动条；移动端隐藏，保留主 mesh + 粒子即可。 */
        .depth-mesh {
          display: none;
        }
        /* 极矮屏（如 640 高的小手机）：隐藏冗余品牌文案，只留卡片。 */
        @media (max-height: 680px) {
          .brand-head,
          .brand-bottom {
            display: none;
          }
          .auth-float {
            margin-top: 12px;
          }
        }
        .auth-float {
          position: relative;
          left: auto;
          top: auto;
          transform: none;
          width: 100%;
          max-width: 460px;
          margin: 18px auto 0;
        }
        .auth-card {
          background: var(--ah-surface-1);
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
        }
        /* iOS 聚焦输入框自动放大问题：移动端字号不小于 16px */
        .field input,
        .btn-primary,
        .forge {
          font-size: 16px;
        }
        :host([data-theme='light']) .auth-card {
          background: #fff;
        }
      }

      /* ---------------------- 窄屏手机（≤480px）细化 ---------------------- */
      @media (max-width: 480px) {
        .login-wrap {
          padding: 22px 16px;
          gap: 4px;
        }
        .brand-top {
          top: 0;
          left: 0;
          right: 0;
          padding: 0;
        }
        .brand-mark {
          font-size: 16px;
          gap: 9px;
        }
        .brand-mark .logo {
          width: 28px;
          height: 28px;
        }
        .brand-head {
          margin-top: 16px;
        }
        .brand-title {
          font-size: 22px;
        }
        .brand-sub {
          font-size: 14px;
          margin-top: 10px;
        }
        .brand-bottom {
          margin-top: 4px;
        }
        .auth-float {
          margin: 18px 0 0;
        }
        .auth-card {
          padding: 22px 18px;
          border-radius: 16px;
        }
        .auth-card h1 {
          font-size: 20px;
        }
        .auth-sub {
          font-size: 12px;
          margin-bottom: 18px;
        }
        .field {
          margin-bottom: 12px;
        }
        .field label {
          font-size: 12px;
          margin-bottom: 5px;
        }
        .field input {
          height: 44px;
          padding: 0 12px;
        }
        .field.has-eye input {
          padding-right: 40px;
        }
        .eye-btn {
          width: 32px;
          height: 32px;
          right: 5px;
          bottom: 6px;
        }
        .row-between {
          margin: 2px 0 14px;
          font-size: 13px;
        }
        .btn-primary {
          height: 48px;
        }
      }
    `
  ];

  @state() mode: 'login' | 'register' | 'forgot' = 'login';
  @state() showPassword = false;
  @state() showConfirm = false;
  @state() agree = false;
  @state() submitting = false;
  /** 忘记密码流程的子步骤：request（申请凭证）→ reset（设置新密码）。 */
  @state() private forgotStep: 'request' | 'reset' = 'request';
  /** 后端返回的一次性重置凭证（演示环境直接注入，生产应来自邮件链接）。 */
  @state() private resetToken: string | null = null;
  @state() theme: Theme = getTheme();
  // GitHub OAuth 是否可用（后端配置了 GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET 时为 true）。
  @state() githubEnabled = false;
  // Google OAuth 是否可用（后端配置了 GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET 时为 true）。
  @state() googleEnabled = false;
  // HUD 遥测读数：会话秒数 + 抖动后的链路延迟，仅用于背景氛围。
  @state() private uptimeSec = 0;
  @state() private latencyMs = 24;

  private themeObs?: MutationObserver;
  private telTimer?: number;

  private switchMode(m: 'login' | 'register') {
    this.mode = m;
    this.agree = false;
    this.forgotStep = 'request';
    this.resetToken = null;
  }

  /** 进入「忘记密码」流程（重置 forgotStep / resetToken，避免残留上一轮凭证）。 */
  private enterForgot() {
    this.mode = 'forgot';
    this.forgotStep = 'request';
    this.resetToken = null;
  }

  /** 从忘记密码流程回到登录。 */
  private backToLogin() {
    this.mode = 'login';
    this.forgotStep = 'request';
    this.resetToken = null;
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
    // 拉取鉴权元信息，决定是否展示 GitHub / Google 登录按钮。
    fetch('/api/auth/config', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg?.github?.enabled) this.githubEnabled = true;
        if (cfg?.google?.enabled) this.googleEnabled = true;
      })
      .catch(() => {
        /* 拉取失败不展示按钮，不影响账号密码登录 */
      });
    // HUD 遥测读数自走：每秒 tick 一次，延迟在 18~38ms 间抖动。
    this.telTimer = window.setInterval(() => {
      this.uptimeSec += 1;
      this.latencyMs = 18 + Math.floor(Math.random() * 21);
    }, 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.themeObs?.disconnect();
    if (this.telTimer !== undefined) window.clearInterval(this.telTimer);
    this.telTimer = undefined;
  }

  /** HUD 遥测：把会话秒数格式化为 HH:MM:SS。 */
  private fmtUptime(): string {
    const s = this.uptimeSec;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(
      Math.floor((s % 3600) / 60)
    )}:${pad(s % 60)}`;
  }

  /**
   * 发起 GitHub OAuth 授权码流：跳转后端 /api/account/oauth/github，
   * 后端 302 到 GitHub 授权页；用户授权后由后端回调换 token、签发 ah_auth cookie、
   * 再 302 回首页 ?oauth=success，由 main.ts 用 /api/account/me 回填会话并进入控制台。
   */
  private startGithubOAuth() {
    window.location.href = '/api/account/oauth/github';
  }

  /**
   * 发起 Google OAuth 授权码流（PKCE）：跳转后端 /api/account/oauth/google，
   * 后端 302 到 Google 授权页；用户授权后由后端回调换 token、签发 ah_auth cookie、
   * 再 302 回首页 ?oauth=success，由 main.ts 用 /api/account/me 回填会话并进入控制台。
   */
  private startGoogleOAuth() {
    window.location.href = '/api/account/oauth/google';
  }

  /**
   * 表单内按 Enter 直接提交（账号 / 密码 / 邮箱 / 确认密码均生效）。
   * 浏览器原生隐式提交在部分场景（输入法回车、自定义组件、无 submit 按钮）不可靠，
   * 这里显式兜底：preventDefault 掉原生提交，统一走 submitForm，避免一次回车提交两次。
   * 注意 isComposing：中文输入法组字期间的回车用于「确认候选词」，不能触发登录。
   */
  private onFormKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.isComposing || e.repeat) return;
    const el = e.target as HTMLElement | null;
    if (!el || el.tagName !== 'INPUT') return;
    const input = el as HTMLInputElement;
    // 复选框 / 按钮类控件保留原生 Enter 行为。
    if (['checkbox', 'radio', 'button', 'submit', 'reset'].includes(input.type))
      return;
    e.preventDefault();
    const form =
      input.form ?? (this.renderRoot?.querySelector('form') as HTMLFormElement);
    void this.submitForm(form);
  }

  /** 表单 submit 事件：点击提交按钮、移动端软键盘 Go 键都汇聚到这里。 */
  private onSubmit(e: Event) {
    e.preventDefault();
    void this.submitForm(e.target as HTMLFormElement);
  }

  /* ----------------------- 忘记密码：申请凭证 ----------------------- */

  private onForgotRequest(e: Event) {
    e.preventDefault();
    void this.submitForgotRequest(e.target as HTMLFormElement);
  }

  private onForgotKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.isComposing || e.repeat) return;
    const el = e.target as HTMLElement | null;
    if (!el || el.tagName !== 'INPUT') return;
    const input = el as HTMLInputElement;
    if (['checkbox', 'radio', 'button', 'submit', 'reset'].includes(input.type))
      return;
    e.preventDefault();
    const form =
      input.form ?? (this.renderRoot?.querySelector('form') as HTMLFormElement);
    void this.submitForgotRequest(form);
  }

  /** 申请重置凭证：前端校验 identifier → POST /api/account/forgot-password。 */
  private async submitForgotRequest(form: HTMLFormElement | null) {
    if (this.submitting || !form) return;
    const identifier =
      (
        form.elements.namedItem('username') as HTMLInputElement | null
      )?.value?.trim() ?? '';
    const err = validateForgot({ identifier });
    if (err) {
      notify.warning(err, { key: 'forgot-form' });
      (form.elements.namedItem('username') as HTMLInputElement | null)?.focus();
      return;
    }
    this.submitting = true;
    try {
      const r = await requestPasswordReset(identifier);
      if (!r.ok || !r.resetToken) {
        notify.error(r.error || '申请失败。', { key: 'forgot-form' });
        return;
      }
      // 演示环境：token 直接注入，跳到第二步设置新密码（生产应改为来自邮件链接）。
      this.resetToken = r.resetToken;
      this.forgotStep = 'reset';
      notify.success('验证通过，请设置新密码');
    } catch (err) {
      notifyError(err, { fallback: '申请失败。', key: 'forgot-form' });
    } finally {
      this.submitting = false;
    }
  }

  /* ----------------------- 忘记密码：设置新密码 ----------------------- */

  private onResetSubmit(e: Event) {
    e.preventDefault();
    void this.submitReset(e.target as HTMLFormElement);
  }

  private onResetKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.isComposing || e.repeat) return;
    const el = e.target as HTMLElement | null;
    if (!el || el.tagName !== 'INPUT') return;
    const input = el as HTMLInputElement;
    if (['checkbox', 'radio', 'button', 'submit', 'reset'].includes(input.type))
      return;
    e.preventDefault();
    const form =
      input.form ?? (this.renderRoot?.querySelector('form') as HTMLFormElement);
    void this.submitReset(form);
  }

  /** 用凭证重设密码：前端校验 → POST /api/account/reset-password → 回登录页。 */
  private async submitReset(form: HTMLFormElement | null) {
    if (this.submitting || !form) return;
    if (!this.resetToken) {
      notify.error('重置凭证已失效，请重新申请。', { key: 'forgot-form' });
      this.forgotStep = 'request';
      return;
    }
    const password =
      (form.elements.namedItem('password') as HTMLInputElement | null)?.value ??
      '';
    const confirm =
      (form.elements.namedItem('confirm') as HTMLInputElement | null)?.value ??
      '';
    const err = validateResetPassword({ newPassword: password, confirm });
    if (err) {
      notify.warning(err, { key: 'forgot-form' });
      (form.elements.namedItem('password') as HTMLInputElement | null)?.focus();
      return;
    }
    this.submitting = true;
    try {
      const r = await resetPassword(this.resetToken, password);
      if (!r.ok) {
        notify.error(r.error || '重置失败。', { key: 'forgot-form' });
        return;
      }
      notify.success('密码已重置，请使用新密码登录');
      this.mode = 'login';
      this.forgotStep = 'request';
      this.resetToken = null;
    } catch (err) {
      notifyError(err, { fallback: '重置失败。', key: 'forgot-form' });
    } finally {
      this.submitting = false;
    }
  }

  /**
   * 提交：真实接入账户密码后端。
   *  - 注册：POST /api/account/register（服务端落库 + 顺带签发登录 cookie）。
   *  - 登录：POST /api/account/login（校验凭据 + 下发 cookie）。
   * 成功后服务端已下发现有 HttpOnly cookie，前端只需记录用户名（setSession）并派发
   * ah-login-success 通知 main.ts 进入控制台；失败则展示后端返回的错误文案。
   * 注意：cookie 由浏览器托管、前端不读取其值；用户名仅用于 x-ah-username 双因子。
   *
   * 校验前移：用户名格式 / 密码长度 / 邮箱格式 / 两次一致 / 同意条款全部在前端完成
   * （规则见 utils/auth-validation.ts，与后端 accounts.ts 逐条对齐）。校验不通过直接
   * 用 notification 提示并聚焦到出错字段，不发请求；后端侧仍保留同规则校验作为纵深
   * 防御，其返回的「用户名已被占用」等业务错误也统一走 notification。
   */
  private async submitForm(form: HTMLFormElement | null) {
    if (this.submitting) return;
    // 从表单读取字段（输入项受控在 DOM，按 name 取）。
    if (!form) return;
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

    // ── 前端校验：不通过则提示 + 聚焦出错字段，不发请求 ──
    if (this.mode === 'register') {
      const payload: RegisterForm = {
        email,
        username,
        password,
        confirm,
        agree: this.agree
      };
      const err = validateRegister(payload);
      if (err) {
        notify.warning(err, { key: 'auth-form' });
        this.focusField(form, err, payload);
        return;
      }
    } else {
      const payload: LoginForm = { username, password };
      const err = validateLogin(payload);
      if (err) {
        notify.warning(err, { key: 'auth-form' });
        this.focusField(form, err, payload);
        return;
      }
    }

    this.submitting = true;
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
        // 服务端业务错误（用户名已被占用 / 用户名或密码错误…）统一走通知组件。
        notify.error(
          data.error ||
            (this.mode === 'register' ? '注册失败。' : '登录失败。'),
          { key: 'auth-form' }
        );
        return;
      }
      // 服务端已下发 ah_auth cookie；前端仅记录用户名用于双因子 header。
      setSession(data.username || email);
      notify.success(
        this.mode === 'register' ? '注册成功，已自动登录' : '登录成功'
      );
      this.dispatchEvent(
        new CustomEvent('ah-login-success', { bubbles: true, composed: true })
      );
    } catch (err) {
      notifyError(err, {
        fallback: this.mode === 'register' ? '注册失败。' : '登录失败。',
        key: 'auth-form'
      });
    } finally {
      this.submitting = false;
    }
  }

  /**
   * 校验失败后把焦点送到出错字段：由校验文案反查字段名，省去在校验器里
   * 额外返回字段标识（文案与字段一一对应，见 auth-validation.ts）。
   */
  private focusField(
    form: HTMLFormElement,
    err: string,
    _payload: Partial<LoginForm & RegisterForm>
  ): void {
    let name: 'email' | 'username' | 'password' | 'confirm' | null = null;
    if (err.includes('邮箱')) name = 'email';
    else if (err.includes('用户名')) name = 'username';
    else if (err.includes('不一致')) name = 'confirm';
    else if (err.includes('密码')) name = 'password';
    if (!name) return;
    const el = form.elements.namedItem(name) as HTMLInputElement | null;
    el?.focus?.();
  }

  private field(
    label: string,
    type: string,
    placeholder: string,
    valueKey: 'email' | 'username' | 'password' | 'confirm',
    hasEye = false
  ) {
    const isPw = hasEye;
    // 登录用 current-password、注册用 new-password，让密码管理器正确归类。
    const autocomplete =
      valueKey === 'password'
        ? this.mode === 'login'
          ? 'current-password'
          : 'new-password'
        : valueKey === 'confirm'
        ? 'new-password'
        : valueKey;
    // 移动端软键盘回车键文案：账号类「下一项」，最后一个密码框「前往 / 提交」。
    const enterkeyhint =
      valueKey === 'password' || valueKey === 'confirm' ? 'go' : 'next';
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
          autocomplete=${autocomplete}
          enterkeyhint=${enterkeyhint}
          ?disabled=${this.submitting}
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

    // HUD 右侧刻度尺读数（等宽数字 + 短刻度线），纯装饰。
    const ruler = ['08', '16', '24', '32', '40', '48', '56'].map(
      (v) => html`<span>${v}<i></i></span>`
    );

    return html`
      <div class="login-wrap">
        <div class="tech-grid"></div>
        <div class="grid-floor"></div>
        <div class="orbs">${orbs}</div>
        <div class="depth-mesh">${meshSvg('depth-mesh')}</div>
        ${meshSvg()}
        <div class="scan-track">
          <i class="scan-beam"></i><i class="scan-line"></i>
        </div>
        <div class="particles">${particles}</div>
        <div class="vignette"></div>
        <div class="card-halo"></div>
        <div class="scanlines"></div>
        <div class="hud">
          <i class="hud-corner tl"></i><i class="hud-corner tr"></i
          ><i class="hud-corner bl"></i><i class="hud-corner br"></i>
        </div>
        <div class="hud-ruler">${ruler}</div>
        <div class="hud-tel">
          <div>
            MESH <b>${NODES.length}</b> NODES · <b>${EDGES.length}</b> LINKS
          </div>
          <div>UPLINK <b>STABLE</b></div>
          <div>RTT <b>${this.latencyMs}ms</b></div>
          <div>UP ${this.fmtUptime()}<i class="cursor"></i></div>
        </div>

        <div class="brand-top">
          <div class="brand-mark">
            <svg
              class="logo"
              viewBox="0 0 100 100"
              role="img"
              aria-label="Agent Harness"
            >
              <path d="M50 6 L84 20 L50 34 L16 20 Z" />
              <path d="M50 36 L84 50 L50 64 L16 50 Z" />
              <path d="M50 66 L84 80 L50 94 L16 80 Z" />
            </svg>
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
                  <form @submit=${this.onSubmit} @keydown=${this.onFormKeydown}>
                    ${this.field('用户名', 'username', '用户名', 'username')}
                    ${this.field(
                      '密码',
                      'password',
                      '请输入密码',
                      'password',
                      true
                    )}
                    <div class="row-between">
                      <button
                        class="forge"
                        type="button"
                        @click=${this.enterForgot}
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
                    <div class="enter-hint">按 <kbd>Enter</kbd> 登录</div>
                  </form>
                  <div class="divider">或</div>
                  ${this.githubEnabled || this.googleEnabled
                    ? html`<div class="sso-row">
                        ${this.githubEnabled
                          ? html`<button
                              class="btn-sso"
                              type="button"
                              aria-label="使用 GitHub 登录"
                              title="使用 GitHub 登录"
                              @click=${() => this.startGithubOAuth()}
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
                            </button>`
                          : nothing}
                        ${this.googleEnabled
                          ? html`<button
                              class="btn-sso"
                              type="button"
                              aria-label="使用 Google 登录"
                              title="使用 Google 登录"
                              @click=${() => this.startGoogleOAuth()}
                            >
                              <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path
                                  fill="#4285F4"
                                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                                />
                                <path
                                  fill="#34A853"
                                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                                />
                                <path
                                  fill="#FBBC05"
                                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                                />
                                <path
                                  fill="#EA4335"
                                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                                />
                              </svg>
                            </button>`
                          : nothing}
                      </div>`
                    : nothing}
                  <div class="auth-foot">
                    还没有账号？<button
                      class="link"
                      type="button"
                      @click=${() => this.switchMode('register')}
                    >
                      立即注册
                    </button>
                  </div>
                `
              : this.mode === 'register'
              ? html`
                  <h1>创建账号</h1>
                  <p class="auth-sub">注册以解锁完整的智能体编排能力</p>
                  <form @submit=${this.onSubmit} @keydown=${this.onFormKeydown}>
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
                    <div class="enter-hint">按 <kbd>Enter</kbd> 提交注册</div>
                  </form>
                  <div class="auth-foot">
                    已有账号？<button
                      class="link"
                      type="button"
                      @click=${() => this.switchMode('login')}
                    >
                      去登录
                    </button>
                  </div>
                `
              : html`
                  <h1>找回密码</h1>
                  <p class="auth-sub">
                    ${this.forgotStep === 'request'
                      ? '输入你的用户名或注册邮箱，验证通过后将引导你设置新密码。'
                      : '为该账号设置一个新密码，重置成功后需使用新密码重新登录。'}
                  </p>
                  ${this.forgotStep === 'request'
                    ? html`
                        <form
                          @submit=${this.onForgotRequest}
                          @keydown=${this.onForgotKeydown}
                        >
                          ${this.field(
                            '用户名或邮箱',
                            'text',
                            '用户名 / you@company.com',
                            'username'
                          )}
                          <button
                            class="btn-primary"
                            type="submit"
                            ?disabled=${this.submitting}
                          >
                            ${this.submitting ? '验证中…' : '发送重置凭证'}
                          </button>
                          <div class="enter-hint">按 <kbd>Enter</kbd> 提交</div>
                        </form>
                      `
                    : html`
                        <form
                          @submit=${this.onResetSubmit}
                          @keydown=${this.onResetKeydown}
                        >
                          ${this.field(
                            '新密码',
                            'password',
                            '至少 8 位',
                            'password',
                            true
                          )}
                          ${this.field(
                            '确认新密码',
                            'password',
                            '再次输入密码',
                            'confirm',
                            true
                          )}
                          <button
                            class="btn-primary"
                            type="submit"
                            ?disabled=${this.submitting}
                          >
                            ${this.submitting ? '重置中…' : '重置密码'}
                          </button>
                          <div class="enter-hint">按 <kbd>Enter</kbd> 提交</div>
                        </form>
                      `}
                  <div class="auth-foot">
                    想起来了？<button
                      class="link"
                      type="button"
                      @click=${this.backToLogin}
                    >
                      返回登录
                    </button>
                  </div>
                `}
          </div>
        </div>
      </div>
    `;
  }
}
