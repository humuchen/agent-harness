import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { client, getToken, setToken } from './api';
import type { ServerState } from '@agent-harness/client';
import { sharedStyles } from './styles';
import { getTheme, toggleTheme, type Theme } from './theme/tokens';

type Tab = 'dashboard' | 'run' | 'verify' | 'env' | 'mcp' | 'approvals' | 'observability' | 'chat';

const SIDEBAR_COLLAPSED_KEY = 'ah:sidebar-collapsed';

const TABS: Array<{ id: Tab; label: string; short: string }> = [
  { id: 'dashboard', label: '总览', short: '览' },
  { id: 'chat', label: '对话', short: '话' },
  { id: 'verify', label: '验证', short: '验' },
  { id: 'env', label: '环境', short: '环' },
  { id: 'mcp', label: 'MCP', short: 'M' },
  { id: 'approvals', label: '审批', short: '审' },
  { id: 'observability', label: '可观测', short: '观' },
];

/**
 * 移动端「对话」Tab 专用外壳锁定样式：把应用壳钉成整屏（fixed + inset:0），
 * 聊天区填满剩余空间、输入框固定在底部，无需滚动外层页面即可输入。
 * 仅 chat Tab 生效（.shell.chat-mode），其它 Tab 仍走 sharedStyles 的自然滚动，
 * 不影响 ah-run / ah-dashboard 等面板在移动端的内容滚动需求。
 */
const chatShellCss = css`
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
    /* 移动端对话页：隐藏令牌输入/刷新按钮，仅留状态与菜单，节省竖向空间 */
    .shell.chat-mode .topbar .token,
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
 * 面板通过 dispatchEvent(new CustomEvent('ah-refresh')) 通知顶栏刷新状态。
 */
@customElement('ah-app')
export class AhApp extends LitElement {
  static styles = [sharedStyles, chatShellCss];

  @state() private tab: Tab = 'dashboard';
  @state() private token = getToken();
  @state() private state: ServerState | null = null;
  @state() private err: string | null = null;
  @state() private theme: Theme = getTheme();
  @state() private sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) !== 'false';
  @state() private drawerOpen = false;

  connectedCallback() {
    super.connectedCallback();
    this.refreshState();
    this.theme = getTheme();
    // 监听子面板发来的刷新请求（如创建/销毁环境后）。
    this.addEventListener('ah-refresh', () => this.refreshState());
    // 子面板（如 Dashboard）请求切换 Tab。
    this.addEventListener('ah-goto', (e) => {
      const t = (e as CustomEvent<string>).detail;
      if (t === 'run' || t === 'verify' || t === 'env' || t === 'mcp' || t === 'approvals' || t === 'observability' || t === 'dashboard') {
        this.tab = t;
      }
    });
  }

  private refreshState() {
    client
      .getState()
      .then((s) => {
        this.state = s;
        this.err = null;
      })
      .catch((e) => {
        this.err = String(e?.message ?? e);
      });
  }

  private onTokenInput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    this.token = v;
    setToken(v);
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
        <aside class="sidebar ${this.sidebarCollapsed ? 'collapsed' : ''} ${this.drawerOpen ? 'open' : ''}">
          <div class="brand">
            <svg class="logo" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
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
                    this.tab = t.id;
                    this.closeDrawer();
                  }}
                >
                  <span class="nav-text">${t.label}</span>
                </button>
              `
            )}
          </nav>
          <div class="nav-spacer"></div>
          <div class="sidebar-foot">
            <button
              class="theme-toggle"
              title=${this.theme === 'dark' ? '切换亮色主题' : '切换暗色主题'}
              @click=${() => this.onToggleTheme()}
            >
              <span class="theme-text">${this.theme === 'dark' ? '暗色主题' : '亮色主题'}</span>
              <span class="theme-icon">${this.theme === 'dark' ? '☾' : '☀'}</span>
            </button>
          </div>
        </aside>

        <div class="scrim ${this.drawerOpen ? 'show' : ''}" @click=${() => this.closeDrawer()}></div>

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
                    <span class="pill">model: ${this.state.model}</span>
                    <span class="pill">env: ${this.state.envs.length}</span>
                    <span class="pill">mcp: ${this.state.mcpServers.length}</span>
                  `
                : html`<span class="pill err">${this.err ?? '连接中…'}</span>`}
            </div>
            <input
              class="token"
              placeholder="Bearer 令牌（可选）"
              .value=${this.token}
              @input=${this.onTokenInput}
            />
            <button class="ghost" @click=${() => this.refreshState()}>
              刷新状态
            </button>
          </header>

          <main class="content ${this.tab === 'chat' ? 'chat' : ''}">
            ${this.tab === 'dashboard' ? html`<ah-dashboard></ah-dashboard>` : ''}
            ${this.tab === 'chat' ? html`<ah-chat></ah-chat>` : ''}
            ${this.tab === 'run' ? html`<ah-run></ah-run>` : ''}
            ${this.tab === 'verify' ? html`<ah-verify></ah-verify>` : ''}
            ${this.tab === 'env' ? html`<ah-env></ah-env>` : ''}
            ${this.tab === 'mcp' ? html`<ah-mcp></ah-mcp>` : ''}
            ${this.tab === 'approvals' ? html`<ah-approvals></ah-approvals>` : ''}
            ${this.tab === 'observability' ? html`<ah-observability></ah-observability>` : ''}
          </main>
        </div>
      </div>
    `;
  }
}
