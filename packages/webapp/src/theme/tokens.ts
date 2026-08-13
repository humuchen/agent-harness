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
