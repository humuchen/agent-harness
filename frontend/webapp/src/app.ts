import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { client, authedFetch, fetchMe } from './api';
import type { ServerState } from '@agent-harness/client';
import { sharedStyles } from './styles';
import { getTheme, toggleTheme, type Theme } from './theme/tokens';
import { pluginUIRegistry } from './plugin-ui-registry';
import { notifyError } from './utils/errors';
import {
  startPluginNotify,
  stopPluginNotify,
  getReminderUnread,
  clearReminderUnread,
  type ReminderUnread
} from './plugin-notify';
import './plugins-console';
import './components/provider-key-settings';
import { TopProgressBar } from './top-progress-bar';

type Tab =
  | 'dashboard'
  | 'run'
  | 'verify'
  | 'env'
  | 'mcp'
  | 'approvals'
  | 'observability'
  | 'chat'
  | 'plugins'
  | 'settings';

const SIDEBAR_COLLAPSED_KEY = 'ah:sidebar-collapsed';

/**
 * 侧边栏收起态只显示「短标签」(data-short)。不同 Tab 的首字可能相同
 * （如「客资看板」与「客服后台」首字都是「客」），若直接取首字会在收起态
 * 出现两个一模一样的字。这里做全局去重：优先 1 字，冲突则逐步加长到
 * 2 字 / 3 字，极端情况用完整 label 兜底，保证收起态每个 Tab 的短标签唯一可辨。
 */
function uniqueShort(label: string, used: Set<string>): string {
  for (let n = 1; n <= label.length; n++) {
    const cand = label.slice(0, n);
    if (!used.has(cand)) {
      used.add(cand);
      return cand;
    }
  }
  let i = 1;
  let cand = `${label}(${i})`;
  while (used.has(cand)) cand = `${label}(${++i})`;
  used.add(cand);
  return cand;
}

const TABS: Array<{ id: Tab; label: string; short: string }> = [
  { id: 'dashboard', label: '总览', short: '览' },
  { id: 'chat', label: '对话', short: '话' },
  { id: 'mcp', label: 'MCP', short: 'M' },
  { id: 'observability', label: '可观测', short: '观' },
  { id: 'plugins', label: '插件', short: '插' }
];

/** History 路由：从 location.pathname 解析初始 Tab（如 /chat → chat）。 */
function initialTabFromPath(): string {
  const seg = window.location.pathname.replace(/^\/+|\/+$/g, '');
  return seg || 'dashboard';
}

/**
 * 移动端「对话」Tab 专用外壳锁定样式：把应用壳钉成整屏（fixed + inset:0），
 * 聊天区填满剩余空间、输入框固定在底部，无需滚动外层页面即可输入。
 * 仅 chat Tab 生效（.shell.chat-mode），其它 Tab 仍走 sharedStyles 的自然滚动，
 * 不影响 ah-run / ah-dashboard 等面板在移动端的内容滚动需求。
 */
/**
 * 插件 Tab 的未读提醒红点徽标。
 * 用 danger 色契合「待处理」语义；收起态（data-short 可见、nav-text 隐藏）也要能看到，
 * 所以不依赖 .nav-text 的布局，独立用 margin-left:auto 贴到按钮右侧。
 */
const navDotCss = css`
  /* 展开态：带数字的胶囊徽标，贴在标签右侧。 */
  .nav-dot {
    flex: none;
    margin-left: auto;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    box-sizing: border-box;
    border-radius: 999px;
    background: var(--ah-danger, #e5484d);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  /* 收起态：只剩短标签、宽度紧张，退化为右上角的小圆点（隐去数字，只表「有未读」）。 */
  .sidebar.collapsed .nav-dot {
    position: absolute;
    top: 4px;
    right: 4px;
    margin-left: 0;
    width: 8px;
    min-width: 8px;
    height: 8px;
    padding: 0;
    font-size: 0;
    line-height: 0;
  }
`;

const chatShellCss = css`
  /* ?hidden 绑定用于 Tab 切换时隐藏非激活面板。:host 的 display:block 会盖过
     浏览器默认的 [hidden] 样式，必须加 !important 保险。 */
  [hidden] {
    display: none !important;
  }
  @media (max-width: 900px) {
    .shell.chat-mode {
      position: fixed;
      inset: 0;
      z-index: 1;
      display: flex;
      flex-direction: row;
      overflow: hidden;
    }
    .shell.chat-mode .main {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .shell.chat-mode .topbar {
      flex: 0 0 auto;
      padding: 8px 10px;
      gap: 8px;
    }
    /* 移动端对话页：隐藏刷新按钮，仅留状态与菜单，节省竖向空间 */
    .shell.chat-mode .topbar .ghost {
      display: none;
    }
    .shell.chat-mode .content {
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    }
  }
`;

/**
 * 顶层应用壳：顶栏（连接状态 + 令牌）、Tab 导航、各面板容器。
 * 面板通过 dispatchEvent(new CustomEvent('ah-refresh')) 。
 */
@customElement('ah-app')
export class AhApp extends LitElement {
  static styles = [sharedStyles, navDotCss, chatShellCss];

  @state() private tab: string = initialTabFromPath();
  @state() private state: ServerState | null = null;
  @state() private err: string | null = null;
  @state() private theme: Theme = getTheme();
  @state() private me: {
    username: string;
    role: string;
    email: string | null;
  } | null = null;
  @state() private sidebarCollapsed =
    localStorage.getItem(SIDEBAR_COLLAPSED_KEY) !== 'false';
  /** 全局运行中指示器：任意面板（chat / run）发起运行即亮起，全部结束后熄灭。 */
  @state() private globalRunning = false;
  /** 顶部进度条实例。 */
  private progressBar = TopProgressBar.getInstance();
  @state() private drawerOpen = false;
  /** 插件动态 Tab（来自服务端 /api/plugins，无业务词）。short 为去重后的收起态短标签。 */
  @state() private pluginTabs: Array<{
    id: string;
    label: string;
    short: string;
  }> = [];
  /** 正在加载（服务端实时渲染）的插件 Tab id；非空时内容区显示骨架屏。 */
  @state() private pluginLoading: string | null = null;
  /**
   * 未读提醒状态（桌面通知不可用时由 plugin-notify 累加并持久化）。
   * tabId 由事件 detail 带出，本壳只做匹配、不认识具体是哪个业务插件。
   */
  @state() private reminderUnread: ReminderUnread = { tabId: '', count: 0 };

  connectedCallback() {
    super.connectedCallback();
    this.refreshState();
    this.theme = getTheme();
    // 拉取当前登录用户资料（顶栏头像 / 角色展示）。
    void this.loadMe();
    // 拉取插件视图（动态 Tab），失败不阻断主面板。
    void this.loadPluginViews();
    // 监听子面板发来的刷新请求（如创建/销毁环境后）；同时重拉插件视图，
    // 使正在查看的插件 Tab（如客资看板）也能拿到最新服务端渲染数据。
    this.addEventListener('ah-refresh', () => {
      this.refreshState();
      void this.loadPluginViews();
    });
    // 监听插件集合变化（启用/停用/升级）：重拉动态 Tab，使已禁用插件的 Tab 即时消失。
    window.addEventListener(
      'ah-plugins-changed',
      this.onPluginsChanged as EventListener
    );
    // 监听未读提醒数变化（plugin-notify 在桌面通知不可用时累加）。
    this.reminderUnread = getReminderUnread();
    window.addEventListener(
      'ah-reminder-unread',
      this.onReminderUnread as EventListener
    );
    // 启动插件主动提醒轮询（备忘到点后应用内 toast + 桌面通知）。
    startPluginNotify();
    // 子面板（如 Dashboard）请求切换 Tab（含插件动态 Tab 的 id）。
    this.addEventListener('ah-goto', (e) => {
      const t = (e as CustomEvent<string>).detail;
      if (t) this.setTab(t);
    });
    // 全局运行中指示器：任意面板运行时亮起，全部结束后熄灭。
    window.addEventListener('ah:run:start', () => {
      this.globalRunning = true;
      window.dispatchEvent(new Event('ah:bar:start'));
    });
    window.addEventListener('ah:run:stop', () => {
      this.globalRunning = false;
      window.dispatchEvent(new Event('ah:bar:stop'));
    });
    // History 路由：浏览器后退 / 前进时从 pathname 恢复 Tab（SPA fallback 保证刷新可用）。
    this.onPopState = () => {
      this.tab = initialTabFromPath();
      this.closeDrawer();
    };
    window.addEventListener('popstate', this.onPopState);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('popstate', this.onPopState);
    window.removeEventListener(
      'ah-plugins-changed',
      this.onPluginsChanged as EventListener
    );
    window.removeEventListener(
      'ah-reminder-unread',
      this.onReminderUnread as EventListener
    );
    stopPluginNotify();
  }

  /** History 路由的 popstate 处理器引用（disconnectedCallback 解绑用）。 */
  private onPopState = () => {};

  private onPluginsChanged = () => {
    void this.loadPluginViews();
  };

  /** 未读提醒数变化：刷新红点状态（detail 含归属 tabId 与最新计数）。 */
  private onReminderUnread = (e: CustomEvent<ReminderUnread>) => {
    const d = e.detail;
    this.reminderUnread = {
      tabId: d?.tabId ?? '',
      count: Number(d?.count) || 0
    };
  };

  /**
   * 统一的 Tab 切换入口：所有写入点（菜单点击 / ah-goto / 插件 Tab）都必须走这里，
   * 同步 pushState 写入路径，使浏览器后退 / 前进 / 刷新与 Tab 状态保持一致。
   */
  private setTab(tab: string) {
    this.tab = tab;
    const target = `/${tab}`;
    if (window.location.pathname !== target) {
      history.pushState({ tab }, '', target);
    }
  }

  /**
   * 拉取服务端 /api/plugins 的插件视图列表，填充前端注册表与动态 Tab。
   * 鉴权令牌（若有）随请求携带；失败仅告警，不阻断主面板渲染。
   */
  private async loadPluginViews() {
    try {
      const res = await authedFetch('/api/plugins');
      if (!res.ok) return;
      const data = (await res.json()) as {
        views?: Array<{ tabId: string; label: string; html: string }>;
      };
      const views = data.views ?? [];
      pluginUIRegistry.reset();
      for (const v of views) pluginUIRegistry.register(v);
      // 以静态 Tab 已有 short 为种子做去重，避免插件 Tab 与静态 Tab、插件 Tab 之间首字撞车。
      const used = new Set(TABS.map((t) => t.short));
      this.pluginTabs = views.map((v) => ({
        id: v.tabId,
        label: v.label,
        short: uniqueShort(v.label, used)
      }));
    } catch (e) {
      // 拉取失败不阻断主面板（回退旧快照），但要让用户知道视图可能不是最新的。
      notifyError(e, {
        title: '插件视图',
        fallback: '插件视图加载失败，展示的可能是旧数据',
        key: 'plugin-views'
      });
    }
  }

  /**
   * 打开插件动态 Tab：先向服务端重新拉取插件视图（服务端会调用插件 view.render()
   * 实时聚合 SQL 数据），再切换到目标 Tab。
   *
   * 修复：插件视图 HTML 是服务端按请求实时渲染的，若只在页面加载时拉取一次并缓存，
   * 之后点击 Tab 注入的是旧快照（如「客资看板」首次进入无数据、需手动刷新才出现）。
   * 这里点击时重新拉取，保证每次进入都看到最新数据；拉取失败则回退旧快照，不阻断切换。
   */
  private openPluginTab(id: string) {
    // 先即时切换 Tab（高亮 + 骨架屏），再异步拉取，消除「点击后无反应」等待感。
    this.setTab(id);
    this.closeDrawer();
    // 进入承载提醒的 Tab 即清零未读——红点的使命就是把这个 Tab 里
    // 的「提醒历史」推到用户眼前，看到即算已读。
    if (this.reminderUnread.tabId === id) clearReminderUnread();
    this.pluginLoading = id;
    void this.loadPluginViews().finally(() => {
      if (this.pluginLoading === id) this.pluginLoading = null;
    });
  }

  /**
   * 拉取服务端状态。失败时除保留顶栏 pill 文案外，额外弹一条通知
   * （此前只把错误静默写进 pill，用户切到别的 Tab 就完全看不到）。
   */
  private refreshState() {
    client
      .getState()
      .then((s) => {
        this.state = s;
        this.err = null;
      })
      .catch((e) => {
        this.err = String(e?.message ?? e);
        notifyError(e, { title: '服务端状态', key: 'app-state' });
      });
  }

  /** 拉取当前登录用户资料（username / role / email），供顶栏头像菜单展示。 */
  private async loadMe() {
    const me = await fetchMe();
    if (me) this.me = me;
  }

  private onToggleTheme() {
    this.theme = toggleTheme();
  }

  private onToggleSidebar() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(this.sidebarCollapsed));
  }

  private onToggleDrawer() {
    this.drawerOpen = !this.drawerOpen;
    this.syncBodyScroll();
  }

  private closeDrawer() {
    if (!this.drawerOpen) return;
    this.drawerOpen = false;
    this.syncBodyScroll();
  }

  /** 移动端抽屉打开时锁定背景滚动，关闭后还原。 */
  private syncBodyScroll() {
    document.body.style.overflow = this.drawerOpen ? 'hidden' : '';
  }

  render() {
    return html`
      <div class="shell ${this.tab === 'chat' ? 'chat-mode' : ''}">
        <aside
          class="sidebar ${this.sidebarCollapsed ? 'collapsed' : ''} ${this
            .drawerOpen
            ? 'open'
            : ''}"
        >
          <div class="brand">
            <svg
              class="logo"
              viewBox="0 0 100 100"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M50 6 L84 20 L50 34 L16 20 Z" />
              <path d="M50 36 L84 50 L50 64 L16 50 Z" />
              <path d="M50 66 L84 80 L50 94 L16 80 Z" />
            </svg>
            <!-- <span class="brand-text">Agent Harness</span>
            <button
              class="sidebar-toggle"
              title=${this.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              @click=${() => this.onToggleSidebar()}
              aria-label=${this.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            >
              ${this.sidebarCollapsed ? '›' : '‹'}
            </button> -->
          </div>
          <nav class="nav">
            ${TABS.map(
              (t) => html`
                <button
                  class="nav-item ${this.tab === t.id ? 'active' : ''}"
                  data-short=${t.short}
                  title=${t.label}
                  @click=${() => {
                    this.setTab(t.id);
                    this.closeDrawer();
                  }}
                >
                  <span class="nav-text">${t.label}</span>
                </button>
              `
            )}
          </nav>
          ${this.pluginTabs.length
            ? html`<div class="nav-sep"></div>
                ${this.pluginTabs.map((t) => {
                  // 未读红点：仅当该 Tab 正是提醒归属 Tab 且计数 > 0 时出现。
                  const unread =
                    this.reminderUnread.tabId === t.id
                      ? this.reminderUnread.count
                      : 0;
                  return html`<button
                    class="nav-item plugin ${this.tab === t.id ? 'active' : ''}"
                    data-short=${t.short}
                    title=${unread > 0
                      ? `${t.label}（${unread} 条未读提醒）`
                      : t.label}
                    @click=${() => this.openPluginTab(t.id)}
                  >
                    <span class="nav-text">${t.label}</span>
                    ${unread > 0
                      ? html`<span
                          class="nav-dot"
                          aria-label=${`${unread} 条未读提醒`}
                          >${unread > 99 ? '99+' : unread}</span
                        >`
                      : ''}
                  </button>`;
                })}`
            : ''}
          <div class="nav-spacer"></div>
          <div class="sidebar-foot">
            <button
              class="theme-toggle"
              title=${this.theme === 'dark' ? '切换亮色主题' : '切换暗色主题'}
              @click=${() => this.onToggleTheme()}
            >
              <span class="theme-text"
                >${this.theme === 'dark' ? '暗色主题' : '亮色主题'}</span
              >
              <span class="theme-icon"
                >${this.theme === 'dark' ? '☾' : '☀'}</span
              >
            </button>
          </div>
        </aside>

        <div
          class="scrim ${this.drawerOpen ? 'show' : ''}"
          @click=${() => this.closeDrawer()}
        ></div>

        <div class="main">
          <header class="topbar">
            <button
              class="menu-btn"
              title="打开导航"
              @click=${() => this.onToggleDrawer()}
              aria-label="打开导航"
            >
              ☰
            </button>
            <div class="state">
              ${this.state
                ? html`
                    <span class="pill ${this.state.openrouter ? 'ok' : ''}">
                      LLM ${this.state.openrouter ? 'live' : 'mock'}
                    </span>
                    ${this.globalRunning
                      ? html`<span class="pill running">运行中</span>`
                      : ''}
                  `
                : html`<span class="pill err">${this.err ?? '连接中…'}</span>`}
            </div>
            ${this.me
              ? html`<ah-user-menu
                  username=${this.me.username}
                  role=${this.me.role}
                  email=${this.me.email ?? ''}
                ></ah-user-menu>`
              : ''}
          </header>

          <main class="content ${this.tab === 'chat' ? 'chat' : ''}">
            <ah-dashboard ?hidden=${this.tab !== 'dashboard'}></ah-dashboard>
            <ah-chat ?hidden=${this.tab !== 'chat'}></ah-chat>
            <ah-run ?hidden=${this.tab !== 'run'}></ah-run>
            <ah-verify ?hidden=${this.tab !== 'verify'}></ah-verify>
            <ah-env ?hidden=${this.tab !== 'env'}></ah-env>
            <ah-mcp ?hidden=${this.tab !== 'mcp'}></ah-mcp>
            <ah-approvals ?hidden=${this.tab !== 'approvals'}></ah-approvals>
            <ah-observability
              ?hidden=${this.tab !== 'observability'}
            ></ah-observability>
            <ah-plugins ?hidden=${this.tab !== 'plugins'}></ah-plugins>
            <ah-provider-key-settings
              ?hidden=${this.tab !== 'settings'}
            ></ah-provider-key-settings>
            ${this.pluginTabs.some((t) => t.id === this.tab)
              ? html`<div class="plugin-view">
                  ${this.pluginLoading === this.tab
                    ? html`<div class="skeleton">
                        <div class="sk-line" style="width:40%"></div>
                        <div class="sk-line" style="width:90%"></div>
                        <div class="sk-line" style="width:80%"></div>
                        <div class="sk-line" style="width:95%"></div>
                        <div class="sk-line" style="width:60%"></div>
                      </div>`
                    : unsafeHTML(pluginUIRegistry.getHtml(this.tab))}
                </div>`
              : ''}
          </main>
        </div>
      </div>
    `;
  }
}
