/**
 * ah-settings-center：「设置」Tab 的综合设置中心。
 *
 * 由来：「我的 → 设置」原本直接承载 ah-provider-key-settings（仅 BYOK 密钥面板）。
 * 现升级为综合设置中心，分五组：账户 / 模型与密钥 / 系统与网络 / 外观 / 关于，
 * 密钥面板作为「模型与密钥」分区完整保留（直接复用 ah-provider-key-settings）。
 *
 * 版式：
 *  - 分组导航不使用侧栏 / 横滑胶囊，而是窗口顶部「一行等分平铺 Tab」，内容区整宽。
 *  - 桌面：flex 等分（图标在左、全名在右）；移动（≤760px）：grid 五等分（图标在上、短名在下），
 *    保证五个分组一屏可见、无横滑、无溢出菜单。
 *  - 选中态用 accent-soft 底 + accent 字（非实心强调色），全屏唯一强调点仍是密钥面板的「保存」。
 *
 * 分组定位：父级（app.ts）经 ah-goto 的 `{ tab:'settings', group }` 传 `group` + `groupSeq`
 * （自增序号，保证同一分组被重复请求时也能重新定位）。
 *
 * 内容真实性约定：仅保留「点了确实会发生什么」的行；不做无后端的装饰性开关。
 *  - 账户：账户资料（只读）+ 修改密码（复用 ah-password-dialog）+ 退出登录（真实登出）。
 *  - 系统与网络：服务状态（真实拉取 /api/v1/state）+ 接口地址 + 重新检测 + 清空通知未读。
 *  - 外观：主题（深色 / 浅色 / 跟随系统，真实写入 ah-theme）+ 侧边栏默认收起（父级持有偏好）。
 *
 * 视觉：仅引用 --ah-* 语义令牌，深色 / 浅色主题自适应；图标统一 Lucide 线型隐喻（stroke 1.7–1.8）。
 */
import {
  LitElement,
  html,
  css,
  nothing,
  svg,
  type PropertyValues,
  type TemplateResult
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  BRAND_DEFAULT,
  getTheme,
  setTheme,
  THEME_STORAGE_KEY,
  type BrandConfig,
  type Theme
} from '../theme/tokens';
import { client, logout } from '../api';
import { notify } from './ah-notification';
import { notifyError } from '../utils/errors';
import { getReminderUnread, clearReminderUnread } from '../plugin-notify';
import { avatarInitial, roleLabel } from '../utils/user-display';
import './provider-key-settings';
import './password-dialog';

/** 应用版本号，build-time 由 vite define（__APP_VERSION__）注入，取自 package.json。 */
// @ts-ignore - vite define 注入
const APP_VERSION = __APP_VERSION__;

type SettingsGroup = 'account' | 'keys' | 'system' | 'appearance' | 'about';

/** 主题偏好：dark / light 落 localStorage，system 表示清除偏好、跟随系统。 */
type ThemeMode = Theme | 'system';

/**
 * 统一包一层 Lucide 线型 SVG（同屏同库同风格：24 viewBox / currentColor / round）。
 *
 * ⚠️ body 必须用 lit 的 `svg` 标签构造，而不是 `html`：
 * `html` 模板在没有 &lt;svg&gt; 上下文的裸 <template> 里按 HTML 解析，此时
 *  - 自闭合（&lt;circle/&gt;）被忽略 → 图形元素互相嵌套（如 path 落进 circle）；
 *  - 元素落在 HTML 命名空间 → 放进 &lt;svg&gt; 后浏览器不绘制。
 * 结果就是「图标区留白但 DOM 里有 svg」。`svg` 标签在 SVG 上下文解析，两个问题都没有。
 */
function svgIcon(body: TemplateResult, strokeWidth = '1.8'): TemplateResult {
  return html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width=${strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${body}
  </svg>`;
}

// ── 分组图标（顶部 Tab）──
const ICON_ACCOUNT = svgIcon(
  svg`<circle cx="12" cy="8" r="4" /><path d="M5 20a7 7 0 0 1 14 0" />`
);
const ICON_KEYS = svgIcon(
  svg`<circle cx="8" cy="8" r="4" /><path d="M11 11l8 8M16 16l2-2M19 19l2-2" />`
);
const ICON_SYSTEM = svgIcon(
  svg`<path d="M4 7h11M18 7h2M4 17h2M9 17h11" /><circle cx="16" cy="7" r="2.2" /><circle
      cx="6"
      cy="17"
      r="2.2"
    />`
);
const ICON_APPEARANCE = svgIcon(
  svg`<path
      d="M12 3a9 9 0 1 0 0 18c1 0 1.6-1 1.3-1.9-.4-1 .3-2 1.3-2H17a3 3 0 0 0 3-3c0-5-4-9-8-9Z"
    /><circle cx="7.5" cy="10" r="1" /><circle cx="12" cy="7.5" r="1" /><circle
      cx="16.5"
      cy="10"
      r="1"
    />`
);
const ICON_ABOUT = svgIcon(
  svg`<circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />`
);

// ── 行图标（stroke 1.7，与分组图标同库但更细，形成「导航 > 内容」的层级感）──
const ICON_LOCK = svgIcon(
  svg`<rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />`,
  '1.7'
);
const ICON_LOGOUT = svgIcon(
  svg`<path d="M15 12H4M4 12l3-3M4 12l3 3" /><path d="M14 5h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3" />`,
  '1.7'
);
const ICON_ACTIVITY = svgIcon(
  svg`<path d="M22 12h-4l-3 9L9 3l-3 9H2" />`,
  '1.7'
);
const ICON_LINK = svgIcon(
  svg`<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />`,
  '1.7'
);
const ICON_REFRESH = svgIcon(
  svg`<path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" />`,
  '1.7'
);
const ICON_BELL = svgIcon(
  svg`<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M10.5 21a2 2 0 0 0 3 0" />`,
  '1.7'
);
const ICON_THEME = svgIcon(
  svg`<circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />`,
  '1.7'
);
const ICON_SIDEBAR = svgIcon(
  svg`<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />`,
  '1.7'
);
const ICON_TAG = svgIcon(
  svg`<path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7" /><path d="M9 12V4h6v8M9 12h6" />`,
  '1.7'
);
const ICON_LANG = svgIcon(
  svg`<circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />`,
  '1.7'
);

const GROUPS: Array<{
  id: SettingsGroup;
  /** 桌面 tab 全名 */
  label: string;
  /** 移动 tab 短名（五等分平铺时不易换行） */
  short: string;
  icon: TemplateResult;
}> = [
  { id: 'account', label: '账户', short: '账户', icon: ICON_ACCOUNT },
  { id: 'keys', label: '模型与密钥', short: '密钥', icon: ICON_KEYS },
  { id: 'system', label: '系统与网络', short: '系统', icon: ICON_SYSTEM },
  { id: 'appearance', label: '外观', short: '外观', icon: ICON_APPEARANCE },
  { id: 'about', label: '关于', short: '关于', icon: ICON_ABOUT }
];

@customElement('ah-settings-center')
export class AhSettingsCenter extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      max-width: 860px;
      font-family: var(--ah-font-sans);
      color: var(--ah-text);
    }
    /* 惰性挂载：非激活分组保留在 DOM（不丢已加载状态）但隐藏。
       :host 的 display:flex 会盖过浏览器默认 [hidden]，加 !important 保险。 */
    [hidden] {
      display: none !important;
    }

    /* 设置窗口：与 design/settings-center-mockup.html 方案 B 一致。
       桌面撑满内容区、内容区自身滚动；移动端高度自适应、由页面滚动。 */
    .setwin {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-lg);
      background: var(--ah-surface-1);
      overflow: hidden;
    }

    /* ── 顶部平铺 Tab ── */
    .head {
      border-bottom: 1px solid var(--ah-border);
      padding: 14px 14px 10px;
      flex: 0 0 auto;
    }
    .h-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--ah-font-display);
      font-size: 15px;
      font-weight: 700;
      padding: 0 4px 10px;
    }
    /* 移动端返回「我的」入口（桌面无此需求，隐藏） */
    .h-back {
      display: none;
      border: none;
      background: none;
      color: var(--ah-text-muted);
      font-size: 18px;
      line-height: 1;
      padding: 2px 6px;
      margin-left: -4px;
      border-radius: var(--ah-radius-sm);
      cursor: pointer;
    }
    .h-back:hover {
      color: var(--ah-text);
      background: var(--ah-surface-2);
    }
    .tabs {
      display: flex;
      gap: 6px;
    }
    .ttab {
      flex: 1 1 0;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      padding: 9px 8px;
      border-radius: 9px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--ah-text-muted);
      font-size: 13px;
      font-family: var(--ah-font-sans);
      cursor: pointer;
      white-space: nowrap;
      transition: background 120ms ease, color 120ms ease,
        border-color 120ms ease;
    }
    .ttab:hover {
      background: var(--ah-surface-2);
      color: var(--ah-text);
    }
    .ttab.on {
      background: var(--ah-accent-soft);
      color: var(--ah-accent);
      font-weight: 600;
      border-color: color-mix(in srgb, var(--ah-accent) 30%, transparent);
    }
    .ttab:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: 2px;
    }
    .ttab svg {
      width: 15px;
      height: 15px;
      flex: 0 0 auto;
    }
    .tl.short {
      display: none;
    }

    /* ── 内容区 ── */
    .pane {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: 18px 20px 24px;
    }

    .sec-title {
      font-size: 11px;
      color: var(--ah-text-faint);
      font-weight: 600;
      letter-spacing: 0.4px;
      padding: 4px 2px 8px;
      margin-top: 14px;
    }
    .sec-title:first-of-type {
      margin-top: 0;
    }
    .card {
      border: 1px solid var(--ah-border);
      background: var(--ah-surface-1);
      border-radius: var(--ah-radius-md);
      padding: 4px 14px;
      margin-bottom: 12px;
    }

    /* 账户资料：渐变头像 + 名称 / 角色 / 邮箱 */
    .profile {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 0;
    }
    .p-avatar {
      width: 48px;
      height: 48px;
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
      font-size: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .p-meta {
      min-width: 0;
      flex: 1 1 auto;
    }
    .p-name {
      font-size: 15px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .p-mail {
      font-size: 12px;
      color: var(--ah-text-faint);
      margin-top: 3px;
      word-break: break-all;
    }
    .role-badge {
      display: inline-block;
      padding: 1px 8px;
      border-radius: var(--ah-radius-pill);
      font-size: 10px;
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

    /* 通用设置行：图标盒 + 文案 + 右侧控件 */
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 12px 0;
      border-top: 1px solid var(--ah-border);
      background: none;
      border-left: none;
      border-right: none;
      border-bottom: none;
      color: inherit;
      font-family: var(--ah-font-sans);
      text-align: left;
    }
    .row:first-child {
      border-top: none;
    }
    button.row {
      cursor: pointer;
      border-radius: var(--ah-radius-sm);
    }
    button.row:hover {
      background: var(--ah-surface-2);
    }
    button.row:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: -2px;
    }
    .ri {
      width: 30px;
      height: 30px;
      border-radius: 9px;
      background: var(--ah-surface-3);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      color: var(--ah-text-muted);
    }
    .ri svg {
      width: 16px;
      height: 16px;
    }
    .ri.danger {
      background: var(--ah-danger);
      color: #fff;
    }
    .rc {
      flex: 1 1 auto;
      min-width: 0;
    }
    .rl {
      font-size: 13.5px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .rd {
      font-size: 11.5px;
      color: var(--ah-text-faint);
      margin-top: 2px;
      word-break: break-all;
    }
    .rd.mono {
      font-family: var(--ah-font-mono);
      font-size: 11px;
    }
    .chev {
      color: var(--ah-text-faint);
      font-size: 16px;
      line-height: 1;
      flex: 0 0 auto;
    }
    .row.danger .rl {
      color: var(--ah-danger);
    }
    .row.danger {
      color: var(--ah-danger);
    }

    /* 状态徽标 / 次要按钮 */
    .badge {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: var(--ah-radius-pill);
      flex: 0 0 auto;
    }
    .badge.ok {
      color: var(--ah-success);
      background: var(--ah-success-soft);
    }
    .badge.warn {
      color: var(--ah-warning);
      background: var(--ah-warning-soft);
    }
    .badge.muted {
      color: var(--ah-text-muted);
      background: var(--ah-surface-3);
    }
    .btn {
      flex: 0 0 auto;
      border: 1px solid var(--ah-border);
      background: transparent;
      color: var(--ah-text-muted);
      font-size: 12.5px;
      font-family: var(--ah-font-sans);
      padding: 6px 13px;
      border-radius: var(--ah-radius-md);
      cursor: pointer;
      transition: color 120ms ease, border-color 120ms ease;
    }
    .btn:hover:not(:disabled) {
      color: var(--ah-text);
      border-color: var(--ah-text-faint);
    }
    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .btn:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: 2px;
    }

    /* 开关 */
    .toggle {
      position: relative;
      width: 40px;
      height: 23px;
      flex: 0 0 auto;
      border-radius: var(--ah-radius-pill);
      background: var(--ah-surface-3);
      border: 1px solid var(--ah-border);
      cursor: pointer;
      padding: 0;
      transition: background 150ms ease, border-color 150ms ease;
    }
    .toggle::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 17px;
      height: 17px;
      border-radius: 50%;
      background: var(--ah-text-muted);
      transition: transform 150ms ease, background 150ms ease;
    }
    .toggle.on {
      background: var(--ah-accent);
      border-color: var(--ah-accent);
    }
    .toggle.on::after {
      transform: translateX(17px);
      background: #fff;
    }
    .toggle:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: 2px;
    }

    /* 分段控件 */
    .seg {
      display: inline-flex;
      gap: 4px;
      padding: 3px;
      background: var(--ah-surface-2);
      border: 1px solid var(--ah-border);
      border-radius: 10px;
      flex: 0 0 auto;
    }
    .seg button {
      border: none;
      background: none;
      color: var(--ah-text-muted);
      font-size: 12.5px;
      font-family: var(--ah-font-sans);
      padding: 6px 12px;
      border-radius: 7px;
      cursor: pointer;
      white-space: nowrap;
    }
    .seg button:hover {
      color: var(--ah-text);
    }
    .seg button.on {
      background: var(--ah-accent);
      color: #fff;
      font-weight: 600;
    }
    .seg button:focus-visible {
      outline: 2px solid var(--ah-accent);
      outline-offset: 2px;
    }

    /* 关于：品牌卡 + 版权脚 */
    .brand-card {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 18px 14px;
      border: 1px solid var(--ah-border);
      background: linear-gradient(
        160deg,
        var(--ah-surface-2),
        var(--ah-surface-1)
      );
      border-radius: var(--ah-radius-md);
      margin-bottom: 12px;
    }
    .b-logo {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      flex: 0 0 auto;
      background: linear-gradient(
        135deg,
        var(--ah-accent) 0%,
        var(--ah-accent-strong) 100%
      );
      color: #fff;
      font-family: var(--ah-font-display);
      font-weight: 700;
      font-size: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .b-logo img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .b-name {
      font-family: var(--ah-font-display);
      font-size: 15px;
      font-weight: 700;
    }
    .b-tag {
      font-size: 11.5px;
      color: var(--ah-text-faint);
      margin-top: 3px;
    }
    .about-foot {
      text-align: center;
      font-size: 11px;
      color: var(--ah-text-faint);
      font-family: var(--ah-font-mono);
      padding: 6px 0 2px;
    }

    /* ── 移动端（≤760px，与 app 断点一致）：五等分网格平铺 ── */
    @media (max-width: 760px) {
      .setwin {
        border-radius: 14px;
      }
      .head {
        padding: 10px 10px 8px;
      }
      .h-title {
        font-size: 14px;
        padding: 0 2px 8px;
      }
      .h-back {
        display: inline-flex;
        align-items: center;
      }
      .tabs {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 4px;
      }
      .ttab {
        flex-direction: column;
        gap: 3px;
        padding: 8px 2px;
        font-size: 10.5px;
        line-height: 1.15;
        border-radius: 10px;
        white-space: normal;
        text-align: center;
      }
      .ttab svg {
        width: 17px;
        height: 17px;
      }
      .tl.full {
        display: none;
      }
      .tl.short {
        display: inline;
      }
      .pane {
        padding: 14px 12px 18px;
      }
      .row {
        gap: 10px;
      }
    }
  `;

  /**
   * 目标分组（由父级经 ah-goto 传入）。配合 groupSeq 使用：
   * 仅当 groupSeq 变化时才重新定位，避免用户手动切 Tab 后被父级渲染覆盖。
   */
  @property({ type: String }) group: SettingsGroup = 'account';
  /** 定位序号：父级每次请求定位分组时自增，保证重复请求同一分组也能生效。 */
  @property({ type: Number }) groupSeq = 0;

  /** 当前登录用户名（账户资料展示）。 */
  @property({ type: String }) username = '';
  /** 当前登录用户角色（admin / operator / viewer）。 */
  @property({ type: String }) role = '';
  /** 当前登录用户邮箱（可选）。 */
  @property({ type: String }) email: string | null = null;
  /** 侧边栏收起偏好（由父级持有并持久化，本组件只负责 UI 与派发变更）。 */
  @property({ type: Boolean }) sidebarCollapsed = true;

  @state() private active: SettingsGroup = 'account';
  @state() private pwOpen = false;
  @state() private themeMode: ThemeMode = 'system';
  /** 系统与网络：服务端 LLM 连通状态（null = 尚未检测）。 */
  @state() private llmLive: boolean | null = null;
  @state() private checking = false;
  /** 系统与网络：本地未读提醒数。 */
  @state() private unread = 0;

  /** 已挂载过的分组：切换回来时保留组件状态（如密钥面板已加载的 Key），无需重新拉取。 */
  private mounted = new Set<SettingsGroup>(['account']);

  /** 品牌配置（关于分组展示，与「我的」页 / ah-brand-foot 同源）。 */
  @state() private brand: BrandConfig = BRAND_DEFAULT;

  connectedCallback() {
    super.connectedCallback();
    // 主题偏好：有显式存储值则为 dark / light，否则视为跟随系统。
    const stored =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(THEME_STORAGE_KEY)
        : null;
    this.themeMode =
      stored === 'dark' || stored === 'light' ? stored : 'system';
    this.unread = getReminderUnread().count;
    // 品牌配置：优先读取启动时注入的全局 BRAND，缺省回退令牌默认值。
    const g = (globalThis as unknown as { BRAND?: BrandConfig }).BRAND;
    if (g) this.brand = g;
  }

  protected willUpdate(changed: PropertyValues): void {
    // 父级每次经 ah-goto 请求定位分组都会自增 groupSeq：只有此时才覆盖用户手动选择。
    if (changed.has('groupSeq') && this.group) {
      this.active = this.group;
    }
    this.mounted.add(this.active);
    if (changed.has('active') && this.active === 'system') {
      void this.checkServer();
      this.unread = getReminderUnread().count;
    }
  }

  private selectGroup(id: SettingsGroup) {
    if (this.active === id) return;
    this.active = id;
  }

  /** 真实拉取 /api/v1/state，读取服务端 LLM 连通状态（live / mock）。 */
  private async checkServer() {
    if (this.checking) return;
    this.checking = true;
    try {
      const s = await client.getState();
      this.llmLive = !!s?.openrouter;
    } catch (e) {
      this.llmLive = null;
      notifyError(e, {
        title: '服务端状态',
        fallback: '无法连接服务端，请检查网络或稍后重试',
        key: 'settings-state'
      });
    } finally {
      this.checking = false;
    }
  }

  /** 重新检测：本地重取状态，并广播 ah-refresh 让顶栏 pill 等全局指示同步。 */
  private async recheck() {
    await this.checkServer();
    this.dispatchEvent(
      new CustomEvent('ah-refresh', { bubbles: true, composed: true })
    );
    if (this.llmLive !== null) {
      notify.success(
        this.llmLive ? '服务端状态：LLM live' : '服务端状态：LLM mock'
      );
    }
  }

  private setThemeMode(mode: ThemeMode) {
    this.themeMode = mode;
    if (mode === 'system') {
      // 清除显式偏好 → 回落到系统偏好（不写回存储，保持「跟随系统」语义）。
      localStorage.removeItem(THEME_STORAGE_KEY);
      const sys: Theme =
        typeof matchMedia !== 'undefined' &&
        matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark';
      document.documentElement.setAttribute('data-theme', sys);
    } else {
      setTheme(mode);
    }
    // 通知顶层同步 theme 状态（顶栏主题按钮的文案 / 图标由 app.ts 持有）。
    window.dispatchEvent(
      new CustomEvent('ah:theme-changed', { detail: { theme: getTheme() } })
    );
  }

  private toggleSidebar() {
    this.dispatchEvent(
      new CustomEvent('ah-sidebar-collapsed', {
        detail: { collapsed: !this.sidebarCollapsed },
        bubbles: true,
        composed: true
      })
    );
  }

  private clearUnread() {
    clearReminderUnread();
    this.unread = 0;
    // 同步顶层红点（app.ts 按 detail 回填提醒未读状态）。
    window.dispatchEvent(
      new CustomEvent('ah-reminder-unread', {
        detail: { tabId: '', count: 0 }
      })
    );
    notify.success('已清空通知未读');
  }

  private async onLogout() {
    await logout();
  }

  render(): TemplateResult {
    const initial = avatarInitial(this.username);
    return html`
      <div class="setwin">
        <div class="head">
          <div class="h-title">
            <button
              class="h-back"
              title="返回"
              aria-label="返回"
              @click=${() =>
                this.dispatchEvent(
                  new CustomEvent('ah-goto', {
                    detail: 'me',
                    bubbles: true,
                    composed: true
                  })
                )}
            >
              ‹
            </button>
            设置
          </div>
          <div class="tabs" role="tablist">
            ${GROUPS.map(
              (g) => html`
                <button
                  class="ttab ${this.active === g.id ? 'on' : ''}"
                  role="tab"
                  aria-selected=${this.active === g.id ? 'true' : 'false'}
                  title=${g.label}
                  @click=${() => this.selectGroup(g.id)}
                >
                  ${g.icon}
                  <span class="tl full">${g.label}</span>
                  <span class="tl short">${g.short}</span>
                </button>
              `
            )}
          </div>
        </div>

        <div class="pane">
          ${this.mounted.has('account')
            ? html`<section
                data-group="account"
                ?hidden=${this.active !== 'account'}
              >
                <div class="card">
                  <div class="profile">
                    <span class="p-avatar">${initial}</span>
                    <div class="p-meta">
                      <div class="p-name">
                        ${this.username || '未命名用户'}
                        ${this.role
                          ? html`<span class="role-badge ${this.role}"
                              >${roleLabel(this.role)}</span
                            >`
                          : nothing}
                      </div>
                      ${this.email
                        ? html`<div class="p-mail">${this.email}</div>`
                        : nothing}
                    </div>
                  </div>
                </div>

                <div class="sec-title">安全</div>
                <div class="card">
                  <button class="row" @click=${() => (this.pwOpen = true)}>
                    <span class="ri">${ICON_LOCK}</span>
                    <span class="rc">
                      <span class="rl">修改密码</span>
                      <span class="rd">定期更换以保障账户安全</span>
                    </span>
                    <span class="chev">›</span>
                  </button>
                </div>

                <div class="sec-title">会话</div>
                <div class="card">
                  <button class="row danger" @click=${() => this.onLogout()}>
                    <span class="ri danger">${ICON_LOGOUT}</span>
                    <span class="rc"><span class="rl">退出登录</span></span>
                    <span class="chev">›</span>
                  </button>
                </div>
              </section>`
            : nothing}
          ${this.mounted.has('keys')
            ? html`<section data-group="keys" ?hidden=${this.active !== 'keys'}>
                <ah-provider-key-settings></ah-provider-key-settings>
              </section>`
            : nothing}
          ${this.mounted.has('system')
            ? html`<section
                data-group="system"
                ?hidden=${this.active !== 'system'}
              >
                <div class="sec-title">服务与网络</div>
                <div class="card">
                  <div class="row">
                    <span class="ri">${ICON_ACTIVITY}</span>
                    <span class="rc">
                      <span class="rl">服务状态</span>
                      <span class="rd"
                        >模型调用当前使用真实模型或离线 Mock</span
                      >
                    </span>
                    <span
                      class="badge ${this.llmLive === null
                        ? 'muted'
                        : this.llmLive
                        ? 'ok'
                        : 'warn'}"
                      >${this.checking
                        ? '检测中…'
                        : this.llmLive === null
                        ? '未检测'
                        : this.llmLive
                        ? 'LLM live'
                        : 'LLM mock'}</span
                    >
                  </div>
                  <div class="row">
                    <span class="ri">${ICON_LINK}</span>
                    <span class="rc">
                      <span class="rl">接口地址</span>
                      <span class="rd mono"
                        >${typeof window !== 'undefined'
                          ? window.location.origin
                          : ''}</span
                      >
                    </span>
                  </div>
                  <div class="row">
                    <span class="ri">${ICON_REFRESH}</span>
                    <span class="rc">
                      <span class="rl">重新检测</span>
                      <span class="rd">重新拉取服务端状态并同步全局指示</span>
                    </span>
                    <button
                      class="btn"
                      ?disabled=${this.checking}
                      @click=${() => this.recheck()}
                    >
                      ${this.checking ? '检测中…' : '检测'}
                    </button>
                  </div>
                </div>

                <div class="sec-title">本地数据</div>
                <div class="card">
                  <div class="row">
                    <span class="ri">${ICON_BELL}</span>
                    <span class="rc">
                      <span class="rl">通知未读</span>
                      <span class="rd"
                        >本地累计 ${this.unread}
                        条未读提醒（底栏红点来源）</span
                      >
                    </span>
                    <button
                      class="btn"
                      ?disabled=${this.unread === 0}
                      @click=${() => this.clearUnread()}
                    >
                      清空
                    </button>
                  </div>
                </div>
              </section>`
            : nothing}
          ${this.mounted.has('appearance')
            ? html`<section
                data-group="appearance"
                ?hidden=${this.active !== 'appearance'}
              >
                <div class="sec-title">主题</div>
                <div class="card">
                  <div class="row">
                    <span class="ri">${ICON_THEME}</span>
                    <span class="rc">
                      <span class="rl">主题</span>
                      <span class="rd">深色 / 浅色 / 跟随系统偏好</span>
                    </span>
                    <span class="seg">
                      <button
                        class=${this.themeMode === 'dark' ? 'on' : ''}
                        @click=${() => this.setThemeMode('dark')}
                      >
                        深色
                      </button>
                      <button
                        class=${this.themeMode === 'light' ? 'on' : ''}
                        @click=${() => this.setThemeMode('light')}
                      >
                        浅色
                      </button>
                      <button
                        class=${this.themeMode === 'system' ? 'on' : ''}
                        @click=${() => this.setThemeMode('system')}
                      >
                        跟随系统
                      </button>
                    </span>
                  </div>
                  <div class="row">
                    <span class="ri">${ICON_SIDEBAR}</span>
                    <span class="rc">
                      <span class="rl">侧边栏默认收起</span>
                      <span class="rd">进入应用时折叠左侧导航（桌面端）</span>
                    </span>
                    <button
                      class="toggle ${this.sidebarCollapsed ? 'on' : ''}"
                      role="switch"
                      aria-checked=${this.sidebarCollapsed ? 'true' : 'false'}
                      aria-label="侧边栏默认收起"
                      @click=${() => this.toggleSidebar()}
                    ></button>
                  </div>
                </div>
              </section>`
            : nothing}
          ${this.mounted.has('about')
            ? html`<section
                data-group="about"
                ?hidden=${this.active !== 'about'}
              >
                <div class="brand-card">
                  <span class="b-logo"
                    >${this.brand.logoUrl
                      ? html`<img
                          src=${this.brand.logoUrl}
                          alt=${this.brand.productName}
                        />`
                      : (this.brand.productName[0] ?? 'A').toUpperCase()}</span
                  >
                  <div>
                    <div class="b-name">${this.brand.productName}</div>
                    <div class="b-tag">
                      ${this.brand.loginTagline ?? BRAND_DEFAULT.loginTagline}
                    </div>
                  </div>
                </div>
                <div class="card">
                  <div class="row">
                    <span class="ri">${ICON_TAG}</span>
                    <span class="rc">
                      <span class="rl">版本</span>
                      <span class="rd mono">v${APP_VERSION}</span>
                    </span>
                  </div>
                  <div class="row">
                    <span class="ri">${ICON_LANG}</span>
                    <span class="rc">
                      <span class="rl">界面语言</span>
                      <span class="rd">简体中文</span>
                    </span>
                  </div>
                </div>
                <div class="about-foot">
                  © ${new Date().getFullYear()} ·
                  ${this.brand.footer ?? BRAND_DEFAULT.footer}
                </div>
              </section>`
            : nothing}
        </div>
      </div>

      <ah-password-dialog
        ?open=${this.pwOpen}
        @ah-pw-close=${() => (this.pwOpen = false)}
      ></ah-password-dialog>
    `;
  }
}
