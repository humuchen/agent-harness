/**
 * 工作台（Workspace）路由：用户层「六宫格」入口。
 *
 * 定位：把此前偏「工程视角」的控制台（总览 / 运行 / 验证 / 可观测 …）补上一个
 * **面向全体员工的业务视角首页**，对齐参考架构图的用户层入口：
 *   对话任务 · 工作空间 · 文件资料 · 任务记录 · 成果物 · 历史会话
 *
 * 数据全部来自真实接口（零 mock）：
 *   - 对话任务 / 历史会话 → listChatSessions()
 *   - 工作空间           → listAgents() + getMcpServers() + getPlugins 概览
 *   - 文件资料           → getSessions()（记忆后端 + 会话文件）+ 上传入口
 *   - 任务记录           → getJobs()（队列深度 + 最近任务）
 *   - 成果物             → listRecipes()（运行配方版本）
 *
 * 交互：点击卡片经 `ah-goto` 自定义事件切换 Tab（app.ts 监听），与侧边栏导航同源。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { client } from './api';
import { sharedStyles } from './styles';
import { notifyError } from './utils/errors';

interface ChatSessionLite {
  id: string;
  title: string;
  updatedAt: number;
}
interface QueueStats {
  queued?: number;
  running?: number;
  concurrency?: number;
}
interface JobsView {
  queue: QueueStats;
  jobs: Array<{ id: string; status: string }>;
}
interface RecipeLite {
  id: string;
  name?: string;
  createdAt?: number;
}
interface SessionsView {
  backend: string;
  sessions: string[];
}

function fmtAge(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

@customElement('ah-workspace')
export class AhWorkspace extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .ws-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 20px;
      }
      .ws-title {
        font-family: var(--ah-font-display);
        font-size: 22px;
        font-weight: 650;
        letter-spacing: -0.01em;
      }
      .ws-sub {
        color: var(--ah-text-muted);
        font-size: 13px;
        margin-top: 4px;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
      }
      @media (max-width: 1100px) {
        .tiles {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 680px) {
        .tiles {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .tile {
        position: relative;
        display: flex;
        gap: 14px;
        text-align: left;
        padding: 18px;
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-lg);
        background: var(--ah-surface, rgba(255, 255, 255, 0.02));
        cursor: pointer;
        transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
        font: inherit;
        color: inherit;
        width: 100%;
      }
      .tile:hover {
        border-color: var(--ah-accent);
        transform: translateY(-1px);
        box-shadow: var(--ah-shadow);
      }
      .tile:focus-visible {
        outline: 2px solid var(--ah-accent);
        outline-offset: 2px;
      }
      .tile-icon {
        flex: none;
        width: 40px;
        height: 40px;
        border-radius: var(--ah-radius-md);
        display: grid;
        place-items: center;
        background: var(--ah-accent-soft);
        color: var(--ah-accent);
      }
      .tile-body {
        min-width: 0;
        flex: 1;
      }
      .tile-title {
        font-size: 14px;
        font-weight: 600;
      }
      .tile-metric {
        font-family: var(--ah-font-display);
        font-size: 26px;
        font-weight: 680;
        line-height: 1.2;
        margin: 2px 0 2px;
      }
      .tile-metric.small {
        font-size: 15px;
        font-weight: 600;
      }
      .tile-desc {
        color: var(--ah-text-muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .tile-arrow {
        position: absolute;
        top: 16px;
        right: 16px;
        color: var(--ah-text-faint);
        font-size: 14px;
      }
      .recent {
        margin-top: 22px;
      }
      .recent-item {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 9px 0;
        border-bottom: 1px solid var(--ah-border);
        cursor: pointer;
        font-size: 13px;
      }
      .recent-item:last-child {
        border-bottom: none;
      }
      .recent-item:hover .recent-title {
        color: var(--ah-accent);
      }
      .recent-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .recent-age {
        flex: none;
        color: var(--ah-text-faint);
        font-size: 12px;
      }
    `,
  ];

  @state() sessions: ChatSessionLite[] = [];
  @state() jobs: JobsView | null = null;
  @state() recipes: RecipeLite[] = [];
  @state() agentCount = 0;
  @state() mcpCount = 0;
  @state() memSessions: SessionsView | null = null;
  @state() loading = true;

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    // 各数据源相互独立：任一失败不影响其余格（用 allSettled 而非 all）。
    const [sessions, jobs, recipes, agents, mcp, mem] = await Promise.allSettled([
      client.listChatSessions() as Promise<ChatSessionLite[]>,
      client.getJobs() as Promise<JobsView>,
      client.listRecipes() as Promise<{ recipes: RecipeLite[] }>,
      client.listAgents() as Promise<{ agents: unknown[] }>,
      client.getMcpServers() as Promise<{ servers: unknown[] }>,
      client.getSessions() as Promise<SessionsView>,
    ]);
    if (sessions.status === 'fulfilled') this.sessions = sessions.value ?? [];
    if (jobs.status === 'fulfilled') this.jobs = jobs.value;
    if (recipes.status === 'fulfilled') this.recipes = recipes.value?.recipes ?? [];
    if (agents.status === 'fulfilled') this.agentCount = agents.value?.agents?.length ?? 0;
    if (mcp.status === 'fulfilled') this.mcpCount = mcp.value?.servers?.length ?? 0;
    if (mem.status === 'fulfilled') this.memSessions = mem.value;
    // 全部失败才提示（部分失败属正常降级，不打扰用户）。
    const allFailed = [sessions, jobs, recipes, agents, mcp, mem].every(
      (r) => r.status === 'rejected'
    );
    if (allFailed) {
      notifyError((sessions as PromiseRejectedResult).reason, {
        title: '工作台',
        key: 'workspace',
      });
    }
    this.loading = false;
  }

  /** 经 `ah-goto` 事件切换 Tab（app.ts 监听；需 bubbles + composed 穿透 shadow DOM）。 */
  private goto(tab: string): void {
    this.dispatchEvent(
      new CustomEvent('ah-goto', {
        detail: tab,
        bubbles: true,
        composed: true,
      })
    );
  }

  private icon(name: string) {
    const paths: Record<string, string> = {
      chat: 'M4 5h16v11H7l-3 3V5z',
      workspace: 'M3 3h7v7H3V3zm11 0h7v7h-7V3zM3 14h7v7H3v-7zm11 0h7v7h-7v-7z',
      files: 'M6 2h8l4 4v16H6V2zm8 0v4h4',
      tasks: 'M4 6h16M4 12h16M4 18h10',
      artifacts: 'M12 2l3 6 6 1-4.5 4.5L18 20l-6-3-6 3 1.5-6.5L3 9l6-1 3-6z',
      history: 'M12 8v5l3 2M3.05 11a9 9 0 1 0 2.6-6.4L3 7M3 3v4h4',
    };
    return html`<svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d=${paths[name] ?? paths.chat}></path>
    </svg>`;
  }

  render() {
    const sessionCount = this.sessions.length;
    const queueDepth = (this.jobs?.queue?.queued ?? 0) + (this.jobs?.queue?.running ?? 0);
    const jobCount = this.jobs?.jobs?.length ?? 0;
    const recipeCount = this.recipes.length;
    const memBackend = this.memSessions?.backend ?? '—';
    const memCount = this.memSessions?.sessions?.length ?? 0;
    const recent = [...this.sessions]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 5);

    return html`
      <section style="border:none;background:none;box-shadow:none;padding:0">
        <div class="ws-head">
          <div>
            <div class="ws-title">工作台</div>
            <div class="ws-sub">
              对话、任务、资料与成果的统一入口 · 数据实时来自服务端
            </div>
          </div>
          <button class="ghost" @click=${() => this.refresh()}>
            ${this.loading ? '刷新中…' : '刷新'}
          </button>
        </div>

        <div class="tiles">
          <button class="tile" @click=${() => this.goto('chat')}>
            <span class="tile-arrow">→</span>
            <span class="tile-icon">${this.icon('chat')}</span>
            <span class="tile-body">
              <span class="tile-title">对话任务</span>
              <span class="tile-metric">${sessionCount}</span>
              <span class="tile-desc">与 agent 对话、下达任务、查看实时执行</span>
            </span>
          </button>

          <button class="tile" @click=${() => this.goto('plugins')}>
            <span class="tile-arrow">→</span>
            <span class="tile-icon">${this.icon('workspace')}</span>
            <span class="tile-body">
              <span class="tile-title">工作空间</span>
              <span class="tile-metric small">
                ${this.agentCount} 智能体 · ${this.mcpCount} MCP
              </span>
              <span class="tile-desc">已注册能力与工具服务，供对话与工作流调用</span>
            </span>
          </button>

          <button class="tile" @click=${() => this.goto('chat')}>
            <span class="tile-arrow">→</span>
            <span class="tile-icon">${this.icon('files')}</span>
            <span class="tile-body">
              <span class="tile-title">文件资料</span>
              <span class="tile-metric small">${memBackend} · ${memCount} 会话</span>
              <span class="tile-desc">上传图片 / 文本随对话引用，记忆按会话隔离持久化</span>
            </span>
          </button>

          <button class="tile" @click=${() => this.goto('observability')}>
            <span class="tile-arrow">→</span>
            <span class="tile-icon">${this.icon('tasks')}</span>
            <span class="tile-body">
              <span class="tile-title">任务记录</span>
              <span class="tile-metric">${queueDepth}</span>
              <span class="tile-desc">运行队列深度 · 最近 ${jobCount} 条任务可回看</span>
            </span>
          </button>

          <button class="tile" @click=${() => this.goto('observability')}>
            <span class="tile-arrow">→</span>
            <span class="tile-icon">${this.icon('artifacts')}</span>
            <span class="tile-body">
              <span class="tile-title">成果物</span>
              <span class="tile-metric">${recipeCount}</span>
              <span class="tile-desc">已保存的运行配方版本，支持回归比对与复用</span>
            </span>
          </button>

          <button class="tile" @click=${() => this.goto('chat')}>
            <span class="tile-arrow">→</span>
            <span class="tile-icon">${this.icon('history')}</span>
            <span class="tile-body">
              <span class="tile-title">历史会话</span>
              <span class="tile-metric">${sessionCount}</span>
              <span class="tile-desc">跨设备同步的会话记录，含 IM 渠道来源的对话</span>
            </span>
          </button>
        </div>

        <div class="recent">
          <div class="section-title">最近会话</div>
          <section>
            ${recent.length === 0
              ? html`<div class="muted">暂无会话，点击「对话任务」开始第一次对话。</div>`
              : recent.map(
                  (s) => html`
                    <div
                      class="recent-item"
                      @click=${() => this.goto('chat')}
                      title=${s.title}
                    >
                      <span class="recent-title">${s.title || '未命名会话'}</span>
                      <span class="recent-age">
                        ${s.updatedAt ? fmtAge(s.updatedAt) : nothing}
                      </span>
                    </div>
                  `
                )}
          </section>
        </div>
      </section>
    `;
  }
}
