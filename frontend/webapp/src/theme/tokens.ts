/**
 * 主题与令牌层（Theme & Design Tokens）
 * ---------------------------------------------------------------
 * - 语义化令牌（--ah-*）与具体色值解耦：组件只引用 --ah-*，绝不写死颜色。
 * - 通过 <html data-theme="dark|light"> 切换主题。CSS 自定义属性会沿 shadow DOM
 *   边界向上继承，因此单个注入 <head> 的全局样式表即可驱动所有 Lit 组件。
 * - 扩展新主题 = 新增一个 :root[data-theme="x"] 块，组件零改动。
 */

export type Theme = 'dark' | 'light';

const THEMES: Theme[] = ['dark', 'light'];

// dark：对齐 Ardot 设计稿（canvas #0B0E14 / accent #2997FF）
const darkTokens = `
  --ah-canvas: #0B0E14;
  --ah-surface-1: #121622;
  --ah-surface-2: #171C2B;
  --ah-surface-3: #1C2233;
  --ah-skeleton-base: #1E2536;
  --ah-skeleton-peak: #2A3348;
  --ah-border: #262D3D;
  --ah-text: #E6EDF3;
  --ah-text-muted: #9AA6B6;
  --ah-text-faint: #5D6675;
  --ah-accent: #2997FF;
  --ah-accent-strong: #0A84FF;
  --ah-accent-soft: rgba(41, 151, 255, 0.15);
  --ah-success: #30D158;
  --ah-success-soft: rgba(48, 209, 88, 0.15);
  --ah-warning: #FFD60A;
  --ah-warning-soft: rgba(255, 214, 10, 0.15);
  --ah-danger: #FF453A;
  --ah-danger-soft: rgba(255, 69, 58, 0.15);
  --ah-radius-sm: 8px;
  --ah-radius-md: 12px;
  --ah-radius-lg: 16px;
  --ah-radius-pill: 999px;
  --ah-h-sm: 22px;
  --ah-h-md: 26px;
  --ah-h-lg: 28px;
  --ah-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --ah-font-display: 'Inter Tight', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --ah-font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --ah-shadow: 0 1px 2px rgba(0, 0, 0, 0.40), 0 8px 24px rgba(0, 0, 0, 0.28);
  color-scheme: dark;
`;

// light：同一定义、浅色映射，便于后续多主题适配
const lightTokens = `
  --ah-canvas: #F4F6FA;
  --ah-surface-1: #FFFFFF;
  --ah-surface-2: #EEF1F6;
  --ah-surface-3: #E4E9F2;
  --ah-skeleton-base: #DCE2ED;
  --ah-skeleton-peak: #E9EDF5;
  --ah-border: #D8DEE9;
  --ah-text: #1B2330;
  --ah-text-muted: #5B6675;
  --ah-text-faint: #8A94A6;
  --ah-accent: #0066E6;
  --ah-accent-strong: #0052CC;
  --ah-accent-soft: rgba(0, 102, 230, 0.10);
  --ah-success: #1A9A3B;
  --ah-success-soft: rgba(26, 154, 59, 0.12);
  --ah-warning: #B07400;
  --ah-warning-soft: rgba(176, 116, 0, 0.12);
  --ah-danger: #D4261A;
  --ah-danger-soft: rgba(212, 38, 26, 0.12);
  --ah-radius-sm: 8px;
  --ah-radius-md: 12px;
  --ah-radius-lg: 16px;
  --ah-radius-pill: 999px;
  --ah-h-sm: 22px;
  --ah-h-md: 26px;
  --ah-h-lg: 28px;
  --ah-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --ah-font-display: 'Inter Tight', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --ah-font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --ah-shadow: 0 1px 2px rgba(16, 24, 40, 0.08), 0 8px 24px rgba(16, 24, 40, 0.10);
  color-scheme: light;
`;

/** 注入 <head> 的全局主题样式：默认兜底 dark，dark/light 显式可切换。 */
export const THEME_CSS = `
/* ── 主题切换颜色过渡 ────────────────────────────────────────────────
   把所有「深色/浅色取值不同」的颜色令牌注册为 @property（带 <color> 语法），
   使其计算值可被浏览器插值；切换 data-theme 时在 <html> 上临时挂
   .ah-theme-anim 类（见 withThemeAnimation），对这批自定义属性做 0.45s 过渡。
   自定义属性沿继承向下传递 —— 过渡期间每一帧 html 上的插值都会重新解析
   所有消费方的 var(--ah-*)（含 shadow DOM 内部），因此整页颜色平滑渐变，
   而不是瞬间跳变。
   - initial-value 取 dark 值（与 :root 默认块一致）。
   - 不支持 @property 的旧引擎静默降级为即时切换，无副作用。
   - 取值在两个主题间完全相同的令牌（radius / 字号 / 字体 / 高度）无需注册。 */
@property --ah-canvas        { syntax: '<color>';  inherits: true; initial-value: #0B0E14; }
@property --ah-surface-1     { syntax: '<color>';  inherits: true; initial-value: #121622; }
@property --ah-surface-2     { syntax: '<color>';  inherits: true; initial-value: #171C2B; }
@property --ah-surface-3     { syntax: '<color>';  inherits: true; initial-value: #1C2233; }
@property --ah-skeleton-base { syntax: '<color>';  inherits: true; initial-value: #1E2536; }
@property --ah-skeleton-peak { syntax: '<color>';  inherits: true; initial-value: #2A3348; }
@property --ah-border        { syntax: '<color>';  inherits: true; initial-value: #262D3D; }
@property --ah-text          { syntax: '<color>';  inherits: true; initial-value: #E6EDF3; }
@property --ah-text-muted    { syntax: '<color>';  inherits: true; initial-value: #9AA6B6; }
@property --ah-text-faint    { syntax: '<color>';  inherits: true; initial-value: #5D6675; }
@property --ah-accent        { syntax: '<color>';  inherits: true; initial-value: #2997FF; }
@property --ah-accent-strong { syntax: '<color>';  inherits: true; initial-value: #0A84FF; }
@property --ah-accent-soft   { syntax: '<color>';  inherits: true; initial-value: rgba(41,151,255,0.15); }
@property --ah-success       { syntax: '<color>';  inherits: true; initial-value: #30D158; }
@property --ah-success-soft  { syntax: '<color>';  inherits: true; initial-value: rgba(48,209,88,0.15); }
@property --ah-warning       { syntax: '<color>';  inherits: true; initial-value: #FFD60A; }
@property --ah-warning-soft  { syntax: '<color>';  inherits: true; initial-value: rgba(255,214,10,0.15); }
@property --ah-danger        { syntax: '<color>';  inherits: true; initial-value: #FF453A; }
@property --ah-danger-soft   { syntax: '<color>';  inherits: true; initial-value: rgba(255,69,58,0.15); }
/* 门控过渡：仅 .ah-theme-anim 挂类期间（withThemeAnimation 的 600ms 窗口内）
   才启用颜色插值，避免首屏加载 / 无主题变更时产生多余过渡。
   过渡声明在 <html>（= 令牌实际变更的元素）上，消费方 var() 随帧重解析。 */
html.ah-theme-anim {
  transition:
    --ah-canvas        0.45s ease,
    --ah-surface-1     0.45s ease,
    --ah-surface-2     0.45s ease,
    --ah-surface-3     0.45s ease,
    --ah-skeleton-base 0.45s ease,
    --ah-skeleton-peak 0.45s ease,
    --ah-border        0.45s ease,
    --ah-text          0.45s ease,
    --ah-text-muted    0.45s ease,
    --ah-text-faint    0.45s ease,
    --ah-accent        0.45s ease,
    --ah-accent-strong 0.45s ease,
    --ah-accent-soft   0.45s ease,
    --ah-success       0.45s ease,
    --ah-success-soft  0.45s ease,
    --ah-warning       0.45s ease,
    --ah-warning-soft  0.45s ease,
    --ah-danger        0.45s ease,
    --ah-danger-soft   0.45s ease;
}
:root {
${darkTokens}
}
:root[data-theme="dark"] {
${darkTokens}
}
:root[data-theme="light"] {
${lightTokens}
}
html, body {
  margin: 0;
  padding: 0;
  min-height: 100%;
  background: var(--ah-canvas);
  color: var(--ah-text);
}
/* 移动端（窄屏或触屏）：全局隐藏滚动条 + 去除点击蓝色高亮（WebView 默认 :active）。
   - 滚动条：html/body（文档根，非 shadow）+ 任意滚动容器，三套语法并写。
   - 点击高亮：-webkit-tap-highlight-color: transparent 吃掉 Android WebView 默认蓝色圆。 */
@media (max-width: 900px), (pointer: coarse) {
  html, body, * {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  ::-webkit-scrollbar,
  *::-webkit-scrollbar {
    display: none;
    width: 0;
    height: 0;
    background: transparent;
  }
  * {
    -webkit-tap-highlight-color: transparent;
  }
}
/* 移动端按钮胶囊化：外部组件库 @humuchen/mac-ui 的按钮圆角覆盖。
   为什么必须写在文档级（此处）而不是业务组件的 shadow 样式里：
   mac-ui 的按钮有两个来源，二者都不在业务组件的 shadow root 内 ——
   1) mac-confirm / mac-dialog 自带 footer 里的 mac-button（在库自身 shadow root 内）；
   2) ah-modal 通过 <div slot="footer"> 注入的 mac-button（被 slot 投影到 light DOM，
      最终作为 mac-confirm 的 light 子节点挂在 document 上）。
   故只能由文档级样式表命中其宿主元素。
   mac-ui 把 --{size}-button-radius 声明在自身 :host 内，外层普通声明无法覆盖，
   必须 !important（对影子宿主，外层 important 优先于影子树普通声明）。
   需要覆盖的是「按钮相关」令牌，而非底层的 --md-radius-md ——
   后者同时驱动输入框 / 菜单 / 卡片圆角，改它会连带圆掉非按钮元素：
   - --{sm|md|lg}-button-radius：mac-button（三个尺寸类会互相重指向，须全给）；
   - --md-confirm-btn-radius   ：mac-confirm 自带 footer 的 <button class="footer-btn">；
   - --md-modal-footer-btn-radius：mac-modal footer 同理（同一套库令牌，一并给上）；
   - --md-confirm/modal-footer-cancel-border：取消按钮的 0.5px 描边色 → 透明（去边框）。
   注：用 * 而非罗列 mac-* 标签名 —— 后者需逐一猜测库内组件名，漏一个即失效；
   自定义属性本就靠继承向下传递，写在通配选择器上最稳妥。 */
@media (max-width: 760px), (pointer: coarse) {
  * {
    --md-button-radius: 999px !important;
    --sm-button-radius: 999px !important;
    --lg-button-radius: 999px !important;
    --md-confirm-btn-radius: 999px !important;
    --md-modal-footer-btn-radius: 999px !important;
    --md-confirm-cancel-border: transparent !important;
    --md-modal-footer-cancel-border: transparent !important;
  }
}
`;

/**
 * 主题偏好的 localStorage 键。
 * 导出原因：设置中心的「跟随系统」需要清除该键以回落到系统偏好（见 settings-center.ts）。
 */
export const THEME_STORAGE_KEY = 'ah-theme';

const STORAGE_KEY = THEME_STORAGE_KEY;

export function installThemeStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('ah-theme')) return;
  const style = document.createElement('style');
  style.id = 'ah-theme';
  style.textContent = THEME_CSS;
  document.head.appendChild(style);
}

export function getTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  const stored = typeof localStorage !== 'undefined' ? (localStorage.getItem(STORAGE_KEY) as Theme | null) : null;
  if (stored === 'dark' || stored === 'light') return stored;
  if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

export function setTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  // 切换主题前挂过渡类、切换后 600ms 移除：整页颜色在 withThemeAnimation 窗口内平滑渐变。
  withThemeAnimation(() => {
    document.documentElement.setAttribute('data-theme', theme);
  });
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, theme);
  syncNativeStatusBar(theme);
}

/**
 * 主题切换颜色过渡包装器：把「改 data-theme」这件事包在一个带过渡类的窗口里执行。
 *
 * 原理（配合 THEME_CSS）：
 *  - 进入时给 <html> 加 `.ah-theme-anim`（启用 `html.ah-theme-anim` 上的
 *    自定义属性 transition），再改 `data-theme`；
 *  - 浏览器对已注册（@property）的 `--ah-*` 自定义属性做 0.45s 插值，
 *    沿继承传到所有消费方（含 shadow DOM），实现整页平滑变色而非跳变；
 *  - 600ms 后移除过渡类，避免过渡状态常驻影响后续布局 / 动画。
 *
 * 旧引擎（不支持 @property / 自定义属性 transition）：类与规则均静默失效，
 * 退化为即时切换，无副作用。
 *
 * 供 setTheme 与 settings-center「跟随系统」分支共用 —— 后者绕过 setTheme
 * 直接写 data-theme，需单独调用本函数保持一致的过渡体验。
 */
export function withThemeAnimation(mutate: () => void): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.add('ah-theme-anim');
  mutate();
  window.setTimeout(() => root.classList.remove('ah-theme-anim'), 600);
}

/**
 * 原生壳（Capacitor）下让系统状态栏图标跟随主题：
 *  - 深色主题 → `Style.Light`（浅色图标，配深色背景）；
 *  - 浅色主题 → `Style.Dark`（深色图标，配浅色背景）。
 * 背景：capacitor.config.ts 里 StatusBar 只能写一份**启动默认值**（写的是深色主题的
 * `style: 'LIGHT'`）；切到白色主题后 WebView 背景变浅而状态栏图标仍是白色，
 * 在 `overlaysWebView: true`（Android 16+ 强制 edge-to-edge）下就是「白字白底」，
 * 时间 / 电量等原生头部信息全部看不见 —— 用户实测反馈。故主题写入路径统一在此同步。
 * 约定：走全局 `window.Capacitor.Plugins`（webapp 不依赖 @capacitor/*），纯 Web 安全降级。
 *
 * 导出原因：settings-center 的「跟随系统」分支绕过 setTheme 直接写 data-theme（不落存储），
 * 需单独调用本函数保持状态栏同步；其余主题写入路径（initTheme / setTheme / toggleTheme）
 * 已在 setTheme 内统一覆盖，无需重复调用。
 */
export function syncNativeStatusBar(theme: Theme): void {
  try {
    type StatusBarLike = { setStyle(opts: { style: string }): Promise<void> };
    const cap = (
      globalThis as unknown as {
        Capacitor?: {
          isNativePlatform?: () => boolean;
          Plugins?: { StatusBar?: StatusBarLike };
        };
      }
    ).Capacitor;
    if (!cap?.isNativePlatform?.()) return;
    // native 端 StatusBar.setStyle(style) 实际语义（StatusBar.java:51）：
    //   style='DARK'  → setAppearanceLightStatusBars(false) → 深色背景 + 浅色图标（白字）→ 配深色主题
    //   style='LIGHT' → setAppearanceLightStatusBars(true)  → 浅色背景 + 深色图标（黑字）→ 配浅色主题
    // 因此 web 端映射：深色主题传 'DARK'，浅色主题传 'LIGHT'。
    const nativeStyle = theme === 'dark' ? 'DARK' : 'LIGHT';
    if (!cap.Plugins?.StatusBar) {
      // 首屏：initTheme 可能先于 Capacitor 桥注册完成而执行（isNativePlatform
      // 已为 true 但 Plugins.StatusBar 尚未注入）。短延迟重试 3 次（200ms 间隔），
      // 避免首次同步被静默吞掉 → 黑主题状态栏停在系统默认黑图标。
      let tries = 0;
      const retry = (): void => {
        if (tries++ >= 3) return;
        const bar = (globalThis as unknown as { Capacitor?: { Plugins?: { StatusBar?: StatusBarLike } } }).Capacitor?.Plugins?.StatusBar;
        if (!bar) {
          window.setTimeout(retry, 200);
          return;
        }
        void bar.setStyle({ style: nativeStyle });
      };
      window.setTimeout(retry, 200);
      return;
    }
    void cap.Plugins.StatusBar.setStyle({ style: nativeStyle });
  } catch {
    /* 插件桥不可用 / 桥调用失败：状态栏保持启动配置，不影响页面功能 */
  }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

/** 应用启动时调用：装好主题样式并依据存储 / 系统偏好落到 <html data-theme>。 */
export function initTheme(): void {
  installThemeStyles();
  setTheme(getTheme());
}

// ─── P3-1 品牌位应用 ──────────────────────────────────────────────────────────

export interface BrandConfig {
  productName: string;
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  loginTagline?: string;
  footer?: string;
}

export const BRAND_DEFAULT: BrandConfig = {
  productName: 'Agent Harness',
  primaryColor: '#2997FF',
  loginTagline: '编排、运行、观测 — 你的每一个 AI Agent',
  footer: 'Agent Harness 2026 · 私有化部署就绪'
};

/** 把品牌 primaryColor 写入 CSS 变量 --ah-accent，替换当前主题色。 */
export function applyBrand(cfg: BrandConfig): void {
  if (!cfg.primaryColor) return;
  const root = document.documentElement;
  // 写入 --ah-accent 及其强弱变体，覆盖主题默认
  root.style.setProperty('--ah-accent', cfg.primaryColor);
  // 推导 --ah-accent-strong（+20% 亮度）
  const strong = lightenHex(cfg.primaryColor, 0.2);
  if (strong) root.style.setProperty('--ah-accent-strong', strong);
  // 推导 --ah-accent-soft（透明版本）
  root.style.setProperty('--ah-accent-soft', hexToRgba(cfg.primaryColor, 0.15));
}

/** 简单 Hex 亮度调整（用于推导 accent-strong）。 */
function lightenHex(hex: string, pct: number): string | null {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return null;
  const num = parseInt(clean, 16);
  const r = Math.min(255, ((num >> 16) + Math.floor(255 * pct)) | 0);
  const g = Math.min(255, ((num >> 8 & 0xff) + Math.floor(255 * pct)) | 0);
  const b = Math.min(255, ((num & 0xff) + Math.floor(255 * pct)) | 0);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Hex 转 rgba() 字符串。 */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return `rgba(41, 151, 255, ${alpha})`; // 默认蓝
}

/** 启动时加载品牌配置并应用。 */
export async function initBrand(): Promise<BrandConfig> {
  try {
    const res = await fetch('/api/brand', { credentials: 'same-origin' });
    if (res.ok) {
      const cfg = (await res.json()) as BrandConfig;
      applyBrand(cfg);
      // 设置 favicon
      if (cfg.faviconUrl) {
        const link = document.querySelector('link[rel="icon"]') || document.createElement('link');
        link.setAttribute('rel', 'icon');
        link.setAttribute('href', cfg.faviconUrl);
        document.head.appendChild(link);
      }
      return cfg;
    }
  } catch {
    // 网络错误或脱机 → 使用默认品牌
  }
  applyBrand(BRAND_DEFAULT);
  return BRAND_DEFAULT;
}
