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
`;

const STORAGE_KEY = 'ah-theme';

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
  document.documentElement.setAttribute('data-theme', theme);
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, theme);
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
