/**
 * ah-settings-center：「设置」Tab 的综合设置中心。
 *
 * 由来：「我的 → 设置」原本直接承载 ah-provider-key-settings（仅 BYOK 密钥面板）。
 * 现升级为综合设置中心，分四组：模型与密钥 / 系统与网络 / 外观 / 关于，
 * 密钥面板作为「模型与密钥」分区完整保留（直接复用 ah-provider-key-settings）。
 *
 * 不做「账户」分组：账户资料 / 修改密码 / 退出登录已由 ah-user-menu 承载
 * （移动端「我的」Tab 整页、桌面端顶栏头像下拉），此处再放一份即同一功能两处入口；
 * 且用户资料属「身份」而非「偏好」，归口在「我的」更合理。
 *
 * 版式：
 *  - 分组导航不使用侧栏 / 横滑胶囊，而是窗口顶部「一行等分平铺 Tab」，内容区整宽。
 *  - 桌面：flex 等分（图标在左、全名在右）；移动（≤760px）：grid 等分（图标在上、短名在下），
 *    列数由分组数推导（--set-groups，见 connectedCallback），保证分组一屏可见、无横滑、无溢出菜单。
 *  - 选中态用 accent-soft 底 + accent 字（非实心强调色），全屏唯一强调点仍是密钥面板的「保存」。
 *  - 移动端（≤760px）刻意**不用底色块与边框**表达选中：改为一条 18px 的滑动指示条
 *    （.tab-ink，宽度 = 一列，靠 translateX(下标 × 100%) 平移）+ 图标弹入 + 内容淡入上移。
 *    因此移动端 .tabs 必须 gap:0 —— 等分列无缝，位移距离才与列宽对齐。
 *    全部动效在 `prefers-reduced-motion: reduce` 下关闭。
 *  - 窗口宽度与内嵌密钥面板自身的 760px 约束对齐并水平居中：否则宽屏下密钥分区的卡片会比
 *    其它分组窄一截（内层面板自带 max-width），同一窗口出现两种卡片宽度。
 *
 * 分组定位：父级（app.ts）经 ah-goto 的 `{ tab:'settings', group }` 传 `group` + `groupSeq`
 * （自增序号，保证同一分组被重复请求时也能重新定位）。未知 / 已下线分组一律忽略并保持当前分组，
 * 避免切到不存在的分组后内容区空白。
 *
 * 内容真实性约定：仅保留「点了确实会发生什么」的行；不做无后端的装饰性开关。
 *  - 系统与网络：服务状态（真实拉取 /api/v1/state）+ 接口地址 + 重新检测 + 清空通知未读
 *    + 存储空间。存储按 **总计 / 应用 / 数据 / 缓存** 四项展示，口径与环境相关（原生壳走
 *    Capacitor Filesystem 量私有目录与缓存目录，与系统「应用信息」同源；纯 Web 走本地存储
 *    与 CacheStorage；「应用」为应用自身网页资源体积，见 utils/storage-usage.ts）。
 *    两个动作：「清除缓存」只清缓存、无需确认；**「清除数据」会抹掉登录状态与全部偏好，
 *    必须先经 AhModal 二次确认**，完成后广播 `ah-session-cleared` 由入口层切回登录页。
 *  - 外观：主题（深色 / 浅色 / 跟随系统，真实写入 ah-theme）+ 侧边栏默认收起（父级持有偏好）。
 *  - 关于：版本号 + 界面语言（只读）。品牌信息不出现在本页——品牌统一收敛到「我的」页，
 *    故此处不渲染品牌卡与版权脚（桌面侧栏品牌块亦已隐藏，见 styles/base.ts）。
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
  getTheme,
  setTheme,
  THEME_STORAGE_KEY,
  type Theme
} from '../theme/tokens';
import { client } from '../api';
import { AhModal } from './ah-modal';
import { notify } from './ah-notification';
import { notifyError } from '../utils/errors';
import {
  clearCache,
  clearData,
  measureStorage,
  type StorageBreakdown
} from '../utils/storage-usage';
import { getReminderUnread, clearReminderUnread } from '../plugin-notify';
import './provider-key-settings';
import { mobilePill } from '../styles/mobile-pill';

/** 应用版本号，build-time 由 vite define（__APP_VERSION__）注入，取自 package.json。 */
// @ts-ignore - vite define 注入
const APP_VERSION = __APP_VERSION__;

/**
 * 设置中心的分组 id。
 * 注意：父级经 ah-goto 传来的 `group` 是运行时字符串，可能仍是历史值（如已下线的 account），
 * 故类型收敛不等于运行期可信，定位前仍必须走 GROUP_IDS 校验（见 willUpdate）。
 */
type SettingsGroup = 'keys' | 'system' | 'appearance' | 'about';

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

// ── 存储空间行图标 ──
const ICON_STORAGE = svgIcon(
  svg`<ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />`,
  '1.7'
);
const ICON_TRASH = svgIcon(
  svg`<path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 13.5A2.5 2.5 0 0 1 15.5 22h-7A2.5 2.5 0 0 1 6 19.5L5 6" />`,
  '1.7'
);
// ── 存储空间四行：应用 / 数据 / 缓存 / 危险动作 ──
const ICON_APP = svgIcon(
  svg`<path d="M12 3l8 4.4v9.2L12 21l-8-4.4V7.4L12 3Z" /><path d="M12 12l8-4.4M12 12v9M12 12L4 7.6" />`,
  '1.7'
);
const ICON_DATA = svgIcon(
  svg`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />`,
  '1.7'
);
const ICON_CACHE = svgIcon(
  svg`<rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 13h4" />`,
  '1.7'
);
const ICON_ALERT = svgIcon(
  svg`<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" />`,
  '1.7'
);

/**
 * 人读字节数；null / 不可用显示为破折号。
 * 存储四行（总计 / 应用 / 数据 / 缓存）与清理结果提示共用。
 */
function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const GROUPS: Array<{
  id: SettingsGroup;
  /** 桌面 tab 全名 */
  label: string;
  /** 移动 tab 短名（等分平铺时不易换行） */
  short: string;
  icon: TemplateResult;
}> = [
  { id: 'keys', label: '模型与密钥', short: '密钥', icon: ICON_KEYS },
  { id: 'system', label: '系统与网络', short: '系统', icon: ICON_SYSTEM },
  { id: 'appearance', label: '外观', short: '外观', icon: ICON_APPEARANCE },
  { id: 'about', label: '关于', short: '关于', icon: ICON_ABOUT }
];

/** 默认分组 = 首个分组（模型与密钥，设置里最常改的一项）。 */
const DEFAULT_GROUP: SettingsGroup = GROUPS[0]!.id;

/** 合法分组 id 集合：用于忽略父级传来的未知 / 已下线分组（如已移除的 account）。 */
const GROUP_IDS = new Set<SettingsGroup>(GROUPS.map((g) => g.id));

@customElement('ah-settings-center')
export class AhSettingsCenter extends LitElement {
  static styles = [css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      /* 与内嵌 ah-provider-key-settings 的 max-width 对齐：否则密钥分区的卡片
         会比其它分组窄（内层面板自带 760px 上限），同一窗口出现两种卡片宽度。
         桌面宽屏下水平居中，避免窗口贴左、右侧留大片空白。 */
      max-width: 760px;
      margin-inline: auto;
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
    /* 移动端激活指示条：桌面端沿用 accent-soft 底色块，故默认不渲染。 */
    .tab-ink {
      display: none;
    }
    /* 移动端切页动画（关键帧全局定义，仅 ≤760px 使用）。 */
    @keyframes set-tab-pop {
      from {
        transform: scale(0.86);
        opacity: 0.55;
      }
      to {
        transform: none;
        opacity: 1;
      }
    }
    @keyframes set-pane-in {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: none;
      }
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

    /* 存储空间：右侧数值列（等宽字体、右对齐，便于纵向比对四项大小） */
    .sv {
      flex: 0 0 auto;
      font-family: var(--ah-font-mono);
      font-size: 12px;
      color: var(--ah-text-muted);
      white-space: nowrap;
    }
    /* 破坏性操作（清除数据）：danger 着色但不做实心色块，避免与唯一强调点「保存」抢视觉 */
    .ri.danger {
      color: var(--ah-danger);
      background: color-mix(in srgb, var(--ah-danger) 14%, transparent);
    }
    .btn.danger {
      color: var(--ah-danger);
      border-color: color-mix(in srgb, var(--ah-danger) 45%, transparent);
    }
    .btn.danger:hover:not(:disabled) {
      color: var(--ah-danger);
      border-color: var(--ah-danger);
      background: color-mix(in srgb, var(--ah-danger) 10%, transparent);
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

    /* ── 移动端（≤760px，与 app 断点一致）：等分网格平铺 ──
       列数取 --set-groups（= 分组数，由 connectedCallback 写入），
       避免「分组增删、这里的列数忘了同步」把网格空出一格或挤出第二行。 */
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
        grid-template-columns: repeat(var(--set-groups, 4), minmax(0, 1fr));
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
      /* ── 顶部 Tab：移动端去掉底色与边框，改用滑动指示条 + 切换动画 ──
         等分列宽必须无缝（gap:0），否则指示条的位移距离与列宽对不上。 */
      .tabs {
        position: relative;
        gap: 0;
      }
      .ttab {
        position: relative;
        z-index: 1;
        background: transparent;
        border-color: transparent;
        border-radius: 0;
        transition: color 180ms ease, transform 140ms ease;
      }
      .ttab:hover {
        background: transparent;
        color: var(--ah-text-muted);
      }
      .ttab.on {
        background: transparent;
        border-color: transparent;
        color: var(--ah-accent);
      }
      .ttab:active {
        transform: scale(0.94);
      }
      /* 选中项图标轻微弹入（class 切换即重放） */
      .ttab.on svg {
        animation: set-tab-pop 260ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      /* 滑动指示条：宽度 = 一列，靠 translateX(下标 × 100%) 平移到当前列 */
      .tab-ink {
        display: block;
        position: absolute;
        left: 0;
        top: 0;
        z-index: 0;
        width: calc(100% / var(--set-groups, 4));
        height: 100%;
        pointer-events: none;
        transform: translateX(calc(var(--tab-i, 0) * 100%));
        transition: transform 280ms cubic-bezier(0.22, 0.61, 0.36, 1);
      }
      .tab-ink::after {
        content: '';
        position: absolute;
        left: 50%;
        bottom: 0;
        width: 18px;
        height: 2px;
        margin-left: -9px;
        border-radius: 2px;
        background: var(--ah-accent);
      }
      /* 内容切页：section 由 hidden 变可见时会重放该动画 */
      section[data-group] {
        animation: set-pane-in 220ms ease-out both;
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
      /* 触控目标：行与图标盒略放大，便于手指命中（≥44px 行高） */
      .row {
        gap: 10px;
        padding: 13px 0;
        flex-wrap: wrap;
      }
      .ri {
        width: 32px;
        height: 32px;
      }
      .btn {
        padding: 8px 14px;
      }
      /* 分段控件独占一行：三段（深色/浅色/跟随系统）在 320px 屏上约占 190px，
         与说明文字同行会把文案挤成竖排（每行 2–3 字的窄柱）。
         换行后左缩进对齐文案起点（图标盒 32px + gap 10px），三段时间等分整行。 */
      .seg {
        flex: 1 1 100%;
        margin-left: 42px;
        margin-top: 2px;
      }
      .seg button {
        flex: 1 1 0;
        padding: 8px 6px;
        text-align: center;
      }
    }

    /* 降低动效偏好：关掉移动端的滑条位移、图标弹入与切页动画（无障碍） */
    @media (max-width: 760px) and (prefers-reduced-motion: reduce) {
      .tab-ink,
      .ttab,
      .ttab.on svg,
      section[data-group] {
        transition: none;
        animation: none;
      }
    }
  `, mobilePill];

  /**
   * 目标分组（由父级经 ah-goto 传入）。配合 groupSeq 使用：
   * 仅当 groupSeq 变化时才重新定位，避免用户手动切 Tab 后被父级渲染覆盖。
   * 未知 / 已下线分组（如已移除的 account）一律忽略，保持当前分组不出现空白内容区。
   */
  @property({ type: String }) group: SettingsGroup = DEFAULT_GROUP;
  /** 定位序号：父级每次请求定位分组时自增，保证重复请求同一分组也能生效。 */
  @property({ type: Number }) groupSeq = 0;

  /** 侧边栏收起偏好（由父级持有并持久化，本组件只负责 UI 与派发变更）。 */
  @property({ type: Boolean }) sidebarCollapsed = true;

  @state() private active: SettingsGroup = DEFAULT_GROUP;
  @state() private themeMode: ThemeMode = 'system';
  /** 系统与网络：服务端 LLM 连通状态（null = 尚未检测）。 */
  @state() private llmLive: boolean | null = null;
  @state() private checking = false;
  /** 系统与网络：本地未读提醒数。 */
  @state() private unread = 0;
  /** 存储空间：总计 / 应用 / 数据 / 缓存 四项占用（null = 尚未测量）。 */
  @state() private storage: StorageBreakdown | null = null;
  @state() private clearingCache = false;
  @state() private clearingData = false;

  /** 已挂载过的分组：切换回来时保留组件状态（如密钥面板已加载的 Key），无需重新拉取。 */
  private mounted = new Set<SettingsGroup>([DEFAULT_GROUP]);

  connectedCallback() {
    super.connectedCallback();
    // 移动端 Tab 网格列数 = 分组数：由 JS 下发，避免「分组增删但媒体查询里列数忘了改」
    // （本组件曾因此把 5 列写死，移除一个分组后网格右侧空出一格）。
    this.style.setProperty('--set-groups', String(GROUPS.length));
    // 主题偏好：有显式存储值则为 dark / light，否则视为跟随系统。
    const stored =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(THEME_STORAGE_KEY)
        : null;
    this.themeMode =
      stored === 'dark' || stored === 'light' ? stored : 'system';
    this.unread = getReminderUnread().count;
  }

  protected willUpdate(changed: PropertyValues): void {
    // 父级每次经 ah-goto 请求定位分组都会自增 groupSeq：只有此时才覆盖用户手动选择。
    if (changed.has('groupSeq') && GROUP_IDS.has(this.group)) {
      this.active = this.group;
    }
    this.mounted.add(this.active);
    if (changed.has('active') && this.active === 'system') {
      void this.checkServer();
      // 存储占用随使用变化，每次进入「系统与网络」都重新测量一次。
      void this.refreshStorage();
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

  /** 重新测量存储四项占用（进入「系统与网络」时、以及每次清理后调用）。 */
  private async refreshStorage() {
    this.storage = await measureStorage();
  }

  /** 「清除缓存」：只清缓存（原生缓存目录 + CacheStorage），不动登录状态与偏好，无需二次确认。 */
  private async onClearCache() {
    if (this.clearingCache) return;
    this.clearingCache = true;
    try {
      const r = await clearCache();
      await this.refreshStorage();
      if (!r.ran) {
        notify.info('当前环境没有可清除的缓存');
        return;
      }
      notify.success(
        r.bytes ? `已清除缓存（约 ${formatBytes(r.bytes)}）` : '已清除缓存'
      );
    } catch (e) {
      notifyError(e, {
        title: '存储空间',
        fallback: '清除缓存失败',
        key: 'settings-cache'
      });
    } finally {
      this.clearingCache = false;
    }
  }

  /**
   * 「清除数据」：二次确认后清空本地数据 + 缓存，随后重载回登录页。
   *
   * 该动作会抹掉登录凭据与全部偏好（对齐 Android「清除存储」语义），
   * 故用带破坏性红色按钮的确认弹框拦截误触；确认文案明确写出「需要重新登录」。
   */
  private async onClearData() {
    if (this.clearingData) return;
    const ok = await AhModal.confirm({
      variant: 'warning',
      danger: true,
      title: '清除数据',
      message:
        '将删除本地全部数据与缓存（登录状态、主题偏好、会话与模型选择等），清除后需要重新登录。此操作不可恢复。',
      confirmText: '清除数据',
      cancelText: '取消',
      maskClosable: false
    });
    if (!ok) return;

    this.clearingData = true;
    try {
      const r = await clearData();
      notify.success(
        r.bytes
          ? `已清除本地数据（约 ${formatBytes(r.bytes)}），即将返回登录页`
          : '已清除本地数据，即将返回登录页'
      );
      // 本地凭据已清空：广播给入口层（main.ts）切回登录页，而不是整页 reload
      // —— 更快，也不会把刚弹出的结果提示一起刷掉。
      window.dispatchEvent(new CustomEvent('ah-session-cleared'));
    } catch (e) {
      notifyError(e, {
        title: '存储空间',
        fallback: '清除数据失败',
        key: 'settings-data'
      });
      this.clearingData = false;
    }
  }

  /** 当前分组的列下标：驱动移动端滑动指示条的位移（找不到时退回 0）。 */
  private get activeIndex(): number {
    const i = GROUPS.findIndex((g) => g.id === this.active);
    return i < 0 ? 0 : i;
  }

  render(): TemplateResult {
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
          <div
            class="tabs"
            role="tablist"
            style="--tab-i: ${this.activeIndex}"
          >
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
            <!-- 移动端滑动指示条：装饰性，故 aria-hidden；位移由 --tab-i 驱动 -->
            <span class="tab-ink" aria-hidden="true"></span>
          </div>
        </div>

        <div class="pane">
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

                <div class="sec-title">存储空间</div>
                <div class="card">
                  <div class="row">
                    <span class="ri">${ICON_STORAGE}</span>
                    <span class="rc">
                      <span class="rl">总计</span>
                      <span class="rd">应用 + 数据 + 缓存</span>
                    </span>
                    <span class="sv">${formatBytes(this.storage?.total)}</span>
                  </div>
                  <div class="row">
                    <span class="ri">${ICON_APP}</span>
                    <span class="rc">
                      <span class="rl">应用</span>
                      <span class="rd">应用自身加载的网页资源（JS / CSS）</span>
                    </span>
                    <span class="sv">${formatBytes(this.storage?.app)}</span>
                  </div>
                  <div class="row">
                    <span class="ri">${ICON_DATA}</span>
                    <span class="rc">
                      <span class="rl">数据</span>
                      <span class="rd"
                        >${this.storage?.native
                          ? '应用私有文件与网页层本地存储'
                          : '浏览器本地存储'}</span
                      >
                    </span>
                    <span class="sv">${formatBytes(this.storage?.data)}</span>
                  </div>
                  <div class="row">
                    <span class="ri danger">${ICON_ALERT}</span>
                    <span class="rc">
                      <span class="rl">清除数据</span>
                      <span class="rd"
                        >删除全部本地数据与缓存，清除后需重新登录</span
                      >
                    </span>
                    <button
                      class="btn danger"
                      ?disabled=${this.clearingData}
                      @click=${() => this.onClearData()}
                    >
                      ${this.clearingData ? '清除中…' : '清除'}
                    </button>
                  </div>
                  <div class="row">
                    <span class="ri">${ICON_CACHE}</span>
                    <span class="rc">
                      <span class="rl">缓存</span>
                      <span class="rd"
                        >${this.storage?.native
                          ? '应用缓存目录，可安全清理'
                          : '浏览器资源缓存'}</span
                      >
                    </span>
                    <span class="sv">${formatBytes(this.storage?.cache)}</span>
                  </div>
                  <div class="row">
                    <span class="ri">${ICON_TRASH}</span>
                    <span class="rc">
                      <span class="rl">清除缓存</span>
                      <span class="rd">只清缓存，不影响登录状态与偏好</span>
                    </span>
                    <button
                      class="btn"
                      ?disabled=${this.clearingCache}
                      @click=${() => this.onClearCache()}
                    >
                      ${this.clearingCache ? '清除中…' : '清除'}
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
              </section>`
            : nothing}
        </div>
      </div>
    `;
  }
}
