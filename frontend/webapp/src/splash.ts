/**
 * 首屏占位（ah-splash）
 * ----------------------------------------------------------------
 * 消灭「打开 App → 黑屏 → 才显示登录/控制台」的卡顿感：
 * - 原生侧：@capacitor/splash-screen 启动图（assets/splash_*.png）覆盖冷启动；
 * - Web 侧：本组件在 main.ts bootstrap() 之前即挂载到 <body>，
 *   让 HTML 首帧解析完（甚至 JS 还未执行完）时就有品牌占位，
 *   之后由 main.ts 的 mountApp()/mountLogin() 把 ah-splash 摘除。
 *
 * 视觉：与暗色主题画布（--ah-canvas）一致的底色 + 居中的三层菱形 logo
 * + 品牌名。只引用主题令牌（--ah-*），不写死颜色，亮色主题下自动跟随。
 * 组件自身即注册自身（side-effect import 后自动 available），不依赖 Lit
 * 之外的额外包，保持零依赖。
 */
import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';

/** 与 logo.svg 一致的三层菱形（viewBox 0 0 100 100）。 */
function logoSvg() {
  return html`
    <svg viewBox="0 0 100 100" class="logo" role="img" aria-label="Agent Harness">
      <path d="M50 6 L84 20 L50 34 L16 20 Z"></path>
      <path d="M50 36 L84 50 L50 64 L16 50 Z"></path>
      <path d="M50 66 L84 80 L50 94 L16 80 Z"></path>
    </svg>
  `;
}

@customElement('ah-splash')
export class AhSplash extends LitElement {
  static styles = css`
    :host {
      display: grid;
      place-items: center;
      min-height: 100vh;
      min-height: 100dvh;
      width: 100%;
      background: var(--ah-canvas, #0b0e14);
      color: var(--ah-text, #e6edf3);
      position: fixed;
      inset: 0;
      z-index: 9999;
      /* 让原生 splash 的 fade-out 与 web 占位无缝衔接：
         摘除时由 main.ts 触发淡出过渡。 */
      transition: opacity 200ms ease;
    }
    :host([hiding]) {
      opacity: 0;
      pointer-events: none;
    }
    .wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 18px;
      padding: 24px;
    }
    .logo {
      width: 72px;
      height: 72px;
      fill: var(--ah-accent, #2997ff);
      filter: drop-shadow(
          0 0 10px color-mix(in srgb, var(--ah-accent, #2997ff) 60%, transparent)
        )
        drop-shadow(
          0 0 22px color-mix(in srgb, var(--ah-accent, #2997ff) 35%, transparent)
        );
      animation: ah-splash-pulse 1.8s ease-in-out infinite;
    }
    .name {
      font-family: var(
          --ah-font-display,
          'Inter Tight',
          'Inter',
          -apple-system,
          sans-serif
        );
      font-size: 20px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--ah-text, #e6edf3);
    }
    .hint {
      font-family: var(--ah-font-mono, ui-monospace, monospace);
      font-size: 11px;
      color: var(--ah-text-faint, #5d6675);
      letter-spacing: 0.06em;
    }
    @keyframes ah-splash-pulse {
      0%,
      100% {
        opacity: 0.85;
        transform: scale(1);
      }
      50% {
        opacity: 1;
        transform: scale(1.05);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .logo {
        animation: none;
      }
    }
  `;

  render() {
    return html`
      <div class="wrap">
        ${logoSvg()}
        <div class="name">Agent Harness</div>
        <div class="hint">正在启动…</div>
      </div>
    `;
  }
}
