import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { client, getToken, setToken } from './api';
import type { ServerState } from '@agent-harness/client';
import { sharedStyles } from './styles';
import { getTheme, toggleTheme, type Theme } from './theme/tokens';

type Tab = 'dashboard' | 'run' | 'verify' | 'env' | 'mcp' | 'approvals' | 'observability';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'dashboard', label: '总览' },
  { id: 'run', label: '运行' },
  { id: 'verify', label: '验证' },
  { id: 'env', label: '环境' },
  { id: 'mcp', label: 'MCP' },
  { id: 'approvals', label: '审批' },
  { id: 'observability', label: '可观测' },
];

/**
 * 顶层应用壳：顶栏（连接状态 + 令牌）、Tab 导航、各面板容器。
 * 面板通过 dispatchEvent(new CustomEvent('ah-refresh')) 通知顶栏刷新状态。
 */
@customElement('ah-app')
export class AhApp extends LitElement {
  static styles = [sharedStyles];

  @state() private tab: Tab = 'dashboard';
  @state() private token = getToken();
  @state() private state: ServerState | null = null;
  @state() private err: string | null = null;
  @state() private theme: Theme = getTheme();

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

  render() {
    return html`
      <div class="shell">
        <aside class="sidebar">
          <div class="brand"><span class="logo"></span> Agent Harness</div>
          <nav class="nav">
            ${TABS.map(
              (t) => html`
                <button
                  class="nav-item ${this.tab === t.id ? 'active' : ''}"
                  @click=${() => (this.tab = t.id)}
                >
                  ${t.label}
                </button>
              `
            )}
          </nav>
          <div class="nav-spacer"></div>
          <div class="sidebar-foot">
            <button class="theme-toggle" @click=${() => this.onToggleTheme()}>
              ${this.theme === 'dark' ? '暗色主题' : '亮色主题'}
            </button>
          </div>
        </aside>

        <div class="main">
          <header class="topbar">
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

          <main class="content">
            ${this.tab === 'dashboard' ? html`<ah-dashboard></ah-dashboard>` : ''}
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
