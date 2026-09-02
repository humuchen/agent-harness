import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { client } from './api';
import type {
  StreamEvent,
  EnvAction,
  McpServerMeta,
  McpPreset,
  ApprovalTicket
} from '@agent-harness/client';
import { sharedStyles } from './styles';
import { notifyError } from './utils/errors';
import { notify } from './components/ah-notification';

/* ------------------------------ 通用辅助 ------------------------------ */

function EventRow(ev: StreamEvent) {
  const { type, ...rest } = ev;
  const preview = Object.keys(rest).length ? JSON.stringify(rest) : '';
  return html`<div class="ev">
    <span class="ev-type">${type}</span>
    <span class="ev-body">${preview}</span>
  </div>`;
}

/**
 * 面板名 → 通知标题的映射：错误提示带上「哪个面板出的错」，
 * 用户不必猜（此前各面板只把 message 原样塞进内联红条）。
 */
const PANEL_TITLE = {
  verify: '自检 / 验证',
  env: '临时环境',
  mcp: 'MCP 服务',
  approvals: '审批工单'
} as const;

/** 面板错误统一出口：归一化文案 + notification 弹出。 */
function reportError(scope: keyof typeof PANEL_TITLE, e: unknown): void {
  notifyError(e, { title: PANEL_TITLE[scope], key: `panel-${scope}` });
}

/* ------------------------------ Run ------------------------------
 * 运行时面板已迁移到独立文件 ./run.ts（思考 Trace + 最终结果 双栏交互）。
 * 保留 verify / env / mcp / approvals 在此文件。 */

/* ------------------------------ Verify ------------------------------ */

@customElement('ah-verify')
export class AhVerify extends LitElement {
  static styles = [sharedStyles];

  @state() events: StreamEvent[] = [];
  @state() running = false;
  private abort?: AbortController;

  private async run() {
    this.events = [];
    this.running = true;
    const ac = new AbortController();
    this.abort = ac;
    try {
      for await (const ev of client.streamVerify({ signal: ac.signal })) {
        this.events = [...this.events, ev];
      }
    } catch (e: any) {
      reportError('verify', e);
    } finally {
      this.running = false;
    }
  }

  render() {
    return html`
      <section>
        <h2>自检 / 验证</h2>
        <p class="muted">
          对服务端能力做三组断言（MCP 连接 / 护栏 / 环境流水线时序）。
        </p>
        <div class="row">
          <button ?disabled=${this.running} @click=${() => this.run()}>
            ${this.running ? '验证中…' : '运行验证'}
          </button>
          <button
            ?disabled=${!this.running}
            @click=${() => this.abort?.abort()}
          >
            停止
          </button>
        </div>
        <div class="stream">${this.events.map(EventRow)}</div>
      </section>
    `;
  }
}

/* ------------------------------ Env ------------------------------ */

@customElement('ah-env')
export class AhEnv extends LitElement {
  static styles = [sharedStyles];

  @state() action: EnvAction = 'create';
  @state() branch = 'main';
  @state() ttl = '8';
  @state() region = '';
  @state() owner = '';
  @state() envId = '';
  @state() events: StreamEvent[] = [];
  @state() running = false;

  private async submit() {
    this.events = [];
    this.running = true;
    try {
      for await (const ev of client.streamEnv({
        action: this.action,
        branch: this.branch || undefined,
        ttl_hours: this.ttl ? Number(this.ttl) : undefined,
        region: this.region || undefined,
        owner: this.owner || undefined,
        env_id: this.envId || undefined
      })) {
        this.events = [...this.events, ev];
      }
      this.dispatchEvent(
        new CustomEvent('ah-refresh', { bubbles: true, composed: true })
      );
    } catch (e: any) {
      reportError('env', e);
    } finally {
      this.running = false;
    }
  }

  render() {
    const isCreate = this.action === 'create';
    return html`
      <section>
        <h2>临时 / 预览环境</h2>
        <div class="row">
          <label>
            动作
            <select
              @change=${(e: Event) =>
                (this.action = (e.target as HTMLSelectElement)
                  .value as EnvAction)}
            >
              <option value="create">创建</option>
              <option value="destroy">销毁</option>
            </select>
          </label>
          <label
            >分支<input
              .value=${this.branch}
              ?disabled=${!isCreate}
              @input=${(e: Event) =>
                (this.branch = (e.target as HTMLInputElement).value)}
          /></label>
          <label
            >TTL(小时)<input
              .value=${this.ttl}
              ?disabled=${!isCreate}
              @input=${(e: Event) =>
                (this.ttl = (e.target as HTMLInputElement).value)}
          /></label>
          <label
            >区域<input
              .value=${this.region}
              ?disabled=${!isCreate}
              @input=${(e: Event) =>
                (this.region = (e.target as HTMLInputElement).value)}
          /></label>
          <label
            >拥有者<input
              .value=${this.owner}
              ?disabled=${!isCreate}
              @input=${(e: Event) =>
                (this.owner = (e.target as HTMLInputElement).value)}
          /></label>
          <label
            >env_id(销毁时填)<input
              .value=${this.envId}
              ?disabled=${isCreate}
              @input=${(e: Event) =>
                (this.envId = (e.target as HTMLInputElement).value)}
          /></label>
        </div>
        <div class="row">
          <button ?disabled=${this.running} @click=${() => this.submit()}>
            ${this.running ? '处理中…' : isCreate ? '创建环境' : '销毁环境'}
          </button>
        </div>
        <div class="stream">${this.events.map(EventRow)}</div>
      </section>
    `;
  }
}

/* ------------------------------ MCP ------------------------------ */

@customElement('ah-mcp')
export class AhMcp extends LitElement {
  static styles = [sharedStyles];

  @state() servers: McpServerMeta[] = [];
  @state() presets: McpPreset[] = [];

  /** 添加服务表单的状态 */
  @state() addForm = {
    name: '',
    type: 'http' as 'http' | 'stdio',
    url: '',
    command: '',
    params: '',
    envs: {} as Record<string, string>,
    /** HTTP/SSE 传输类型（auto 由服务端探测）。 */
    transportType: 'auto' as 'auto' | 'sse' | 'streamable-http',
    /** HTTP/SSE 自定义请求头（如鉴权 Bearer）。 */
    headers: {} as Record<string, string>
  };

  /** 添加/接入操作是否进行中（防重复点击） */
  @state() adding = false;
  /** 已接入列表是否展开 */
  @state() serversExpanded = true;
  /** 每个服务器的工具列表是否展开（key: server name） */
  @state() toolsExpanded: Record<string, boolean> = {};

  /** 预设市场按 id 暂存的 token（bearer 型预设接入时透传）。 */
  @state() tokens: Record<string, string> = {};

  /** 已接入列表自动刷新定时器（连接状态变化无需手动刷新）。 */
  private refreshTimer?: ReturnType<typeof setInterval>;

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
    // 每 10s 静默刷新一次已接入列表（连接状态 / 工具数会变化）。
    this.refreshTimer = window.setInterval(() => this.refresh(true), 10000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
  }

  private async refresh(silent = false) {
    try {
      const [s, p] = await Promise.all([
        client.getMcpServers(),
        client.getMcpPresets()
      ]);
      this.servers = s.servers;
      this.presets = p.presets;
    } catch (e: any) {
      // 静默刷新（自动轮询）不弹错误，避免刷屏；手动刷新仍报错。
      if (!silent) reportError('mcp', e);
    }
  }

  private async add() {
    if (this.adding) return;
    this.adding = true;
    // 先取名字（重置表单前），避免「未命名」误报。
    const addedName = this.addForm.name.trim() || '未命名';
    const envEntries = Object.entries(this.addForm.envs).filter(([k]) => k);
    const headerEntries = Object.entries(this.addForm.headers).filter(([k]) => k);
    try {
      if (this.addForm.type === 'http') {
        await client.addMcpServer({
          name: this.addForm.name,
          url: this.addForm.url,
          transportType:
            this.addForm.transportType === 'auto'
              ? undefined
              : this.addForm.transportType,
          headers:
            headerEntries.length > 0
              ? (Object.fromEntries(headerEntries) as Record<string, string>)
              : undefined
        });
      } else {
        // stdio: Command + Params（空格分割）+ Envs
        const params = this.addForm.params.trim().split(/\s+/).filter(Boolean);
        await client.addMcpServer({
          name: this.addForm.name,
          command: this.addForm.command,
          args: params,
          env:
            envEntries.length > 0
              ? (Object.fromEntries(envEntries) as Record<string, string>)
              : undefined
        });
      }
      this.addForm = {
        name: '',
        type: 'http',
        url: '',
        command: '',
        params: '',
        envs: {},
        transportType: 'auto',
        headers: {}
      };
      await this.refresh();
      notify.success(`MCP 服务「${addedName}」已接入`);
      this.dispatchEvent(
        new CustomEvent('ah-refresh', { bubbles: true, composed: true })
      );
    } catch (e: any) {
      reportError('mcp', e);
    } finally {
      this.adding = false;
    }
  }

  /**
   * 移除已接入的 MCP 服务。
   * 注意：方法名不能叫 remove —— HTMLElement 自带 remove()，
   * 同名会与基类签名冲突导致 tsc 报 TS2416/TS1238（类装饰器解析失败）。
   */
  private async removeServer(name: string) {
    if (this.adding) return;
    this.adding = true;
    try {
      await client.removeMcp(name);
      await this.refresh();
      notify.success(`已移除 MCP 服务「${name}」`);
      this.dispatchEvent(
        new CustomEvent('ah-refresh', { bubbles: true, composed: true })
      );
    } catch (e: any) {
      reportError('mcp', e);
    } finally {
      this.adding = false;
    }
  }

  private async preset(id: string, token?: string) {
    if (this.adding) return;
    this.adding = true;
    try {
      await client.connectMcpPreset(id, token);
      await this.refresh();
      notify.success('预设市场服务接入成功');
      this.dispatchEvent(
        new CustomEvent('ah-refresh', { bubbles: true, composed: true })
      );
    } catch (e: any) {
      reportError('mcp', e);
    } finally {
      this.adding = false;
    }
  }

  render() {
    const { addForm: af } = this;
    return html`
      <div class="mcp-layout">
        <h2>MCP 服务</h2>
        <div class="two">
          <!-- 左栏：添加表单卡片 + 已接入列表 -->
          <div class="stack">
            <div class="card">
              <div class="section-title">添加服务</div>
              <label
                >名称<input
                  placeholder="输入名称"
                  .value=${af.name}
                  @input=${(e: Event) =>
                    (this.addForm = {
                      ...this.addForm,
                      name: (e.target as HTMLInputElement).value
                    })}
              /></label>
              <div class="row" style="margin-top:8px">
                <label class="radio"
                  ><input
                    type="radio"
                    name="type"
                    value="http"
                    .checked=${af.type === 'http'}
                    @change=${() =>
                      (this.addForm = { ...this.addForm, type: 'http' })}
                  />
                  SSE/HTTP</label
                >
                <label class="radio"
                  ><input
                    type="radio"
                    name="type"
                    value="stdio"
                    .checked=${af.type === 'stdio'}
                    @change=${() =>
                      (this.addForm = { ...this.addForm, type: 'stdio' })}
                  />
                  STDIO</label
                >
              </div>
              ${af.type === 'http'
                ? html`<label class="grow"
                    >URL<input
                      .value=${af.url}
                      @input=${(e: Event) =>
                        (this.addForm = {
                          ...this.addForm,
                          url: (e.target as HTMLInputElement).value
                        })}
                      placeholder="https://..."
                  /></label>
                  <label class="grow"
                    >传输类型<select
                      .value=${af.transportType}
                      @change=${(e: Event) =>
                        (this.addForm = {
                          ...this.addForm,
                          transportType: (e.target as HTMLSelectElement)
                            .value as 'auto' | 'sse' | 'streamable-http'
                        })}
                    >
                      <option value="auto">自动探测</option>
                      <option value="sse">SSE</option>
                      <option value="streamable-http">Streamable HTTP</option>
                    </select></label
                  >`
                : html`<label class="grow"
                    >Command<input
                      .value=${af.command}
                      @input=${(e: Event) =>
                        (this.addForm = {
                          ...this.addForm,
                          command: (e.target as HTMLInputElement).value
                        })}
                      placeholder="npx"
                  /></label>`}
              ${af.type === 'stdio'
                ? html`<label class="grow"
                    >Params<input
                      .value=${af.params}
                      @input=${(e: Event) =>
                        (this.addForm = {
                          ...this.addForm,
                          params: (e.target as HTMLInputElement).value
                        })}
                      placeholder="-y @tokenizin/mcp-npx-fetch"
                  /></label>`
                : nothing}
              ${Object.keys(af.envs).length > 0
                ? html`<div class="env-list">
                    ${Object.entries(af.envs).map(
                      ([k, v]) => html`
                        <div class="row">
                          <input
                            .value=${k}
                            @input=${(e: Event) => {
                              const nk = (e.target as HTMLInputElement).value;
                              const next = { ...this.addForm.envs };
                              delete next[k];
                              next[nk] = v;
                              this.addForm = { ...this.addForm, envs: next };
                            }}
                            placeholder="KEY"
                          />
                          <input
                            .value=${v}
                            @input=${(e: Event) =>
                              (this.addForm = {
                                ...this.addForm,
                                envs: {
                                  ...this.addForm.envs,
                                  [k]: (e.target as HTMLInputElement).value
                                }
                              })}
                            placeholder="VALUE"
                          />
                          <button
                            class="ghost"
                            @click=${() => {
                              const { [k]: _, ...rest } = this.addForm.envs;
                              this.addForm = { ...this.addForm, envs: rest };
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      `
                    )}
                  </div>`
                : nothing}
              ${af.type === 'stdio'
                ? html`<div class="row" style="margin-top:8px">
                    <button
                      class="ghost"
                      @click=${() =>
                        (this.addForm = {
                          ...this.addForm,
                          envs: { ...this.addForm.envs, '': '' }
                        })}
                    >
                      + 添加环境变量
                    </button>
                  </div>`
                : nothing}
              ${af.type === 'http'
                ? html`<div class="section-sub">自定义请求头（如鉴权 Bearer）</div>
                    ${Object.keys(af.headers).length > 0
                      ? html`<div class="env-list">
                          ${Object.entries(af.headers).map(
                            ([k, v]) => html`
                              <div class="row">
                                <input
                                  .value=${k}
                                  @input=${(e: Event) => {
                                    const nk = (e.target as HTMLInputElement)
                                      .value;
                                    const next = { ...this.addForm.headers };
                                    delete next[k];
                                    next[nk] = v;
                                    this.addForm = {
                                      ...this.addForm,
                                      headers: next
                                    };
                                  }}
                                  placeholder="Header"
                                />
                                <input
                                  .value=${v}
                                  @input=${(e: Event) =>
                                    (this.addForm = {
                                      ...this.addForm,
                                      headers: {
                                        ...this.addForm.headers,
                                        [k]: (e.target as HTMLInputElement)
                                          .value
                                      }
                                    })}
                                  placeholder="Value"
                                />
                                <button
                                  class="ghost"
                                  @click=${() => {
                                    const { [k]: _, ...rest } =
                                      this.addForm.headers;
                                    this.addForm = {
                                      ...this.addForm,
                                      headers: rest
                                    };
                                  }}
                                >
                                  ✕
                                </button>
                              </div>
                            `
                          )}
                        </div>`
                      : nothing}
                    <div class="row" style="margin-top:8px">
                      <button
                        class="ghost"
                        @click=${() =>
                          (this.addForm = {
                            ...this.addForm,
                            headers: { ...this.addForm.headers, '': '' }
                          })}
                      >
                        + 添加请求头
                      </button>
                    </div>`
                : nothing}
              <div class="row" style="margin-top:12px">
                <button @click=${() => this.add()} ?disabled=${this.adding}>
                  ${this.adding ? '连接中...' : '添加'}
                </button>
                <button class="ghost" @click=${() => this.refresh()}>
                  刷新
                </button>
              </div>
            </div>
            <div class="card mcp-server-list">
              <div
                class="section-title collapsible"
                @click=${() => (this.serversExpanded = !this.serversExpanded)}
              >
                <span>已接入</span>
                <span class="chevron">${this.serversExpanded ? '▼' : '▶'}</span>
              </div>
              ${this.serversExpanded
                ? html`<ul class="list">
                      ${this.servers.map(
                        (s) => html`<li class="mcp-server-item">
                          <div
                            class="mcp-server-header"
                            @click=${() =>
                              (this.toolsExpanded = {
                                ...this.toolsExpanded,
                                [s.name]: !this.toolsExpanded[s.name]
                              })}
                          >
                            <div>
                              <b>${s.name}</b> · ${s.status} · ${s.toolCount}
                              工具
                            </div>
                            ${s.url
                              ? html`<div
                                  style="font-size:12px;color:var(--ah-text-dim,#8b93a7);word-break:break-all;margin-top:4px"
                                  title=${s.url ?? ''}
                                >
                                  🔗 ${s.url}
                                </div>`
                              : nothing}
                            ${s.toolCount > 0
                              ? html`<span class="chevron"
                                  >${this.toolsExpanded[s.name]
                                    ? '▼'
                                    : '▶'}</span
                                >`
                              : nothing}
                          </div>
                          ${s.status === 'error' && s.error
                            ? html`<div class="mcp-err">⚠ ${s.error}</div>`
                            : nothing}
                          ${this.toolsExpanded[s.name] && s.tools.length > 0
                            ? html`<ul class="mcp-tools">
                                ${s.tools.map(
                                  (t) => html`<li class="mcp-tool-item">
                                    <div class="mcp-tool-name">
                                      ${t.originalName}
                                    </div>
                                    ${t.description
                                      ? html`<div
                                          class="mcp-tool-desc"
                                          title="${t.description}"
                                        >
                                          ${t.description.length > 80
                                            ? t.description.slice(0, 80) + '...'
                                            : t.description}
                                        </div>`
                                      : nothing}
                                  </li>`
                                )}
                              </ul>`
                            : nothing}
                          <div class="mcp-server-actions">
                            <button
                              class="ghost"
                              @click=${(e: Event) => {
                                e.stopPropagation();
                                this.removeServer(s.name);
                              }}
                            >
                              移除
                            </button>
                          </div>
                        </li>`
                      )}
                    </ul>
                    ${this.servers.length === 0
                      ? html`<p class="muted">暂无已接入服务</p>`
                      : nothing}`
                : nothing}
            </div>
          </div>

          <!-- 右栏：预设市场卡片 -->
          <div class="card">
            <div class="section-title">预设市场</div>
            <ul class="list">
              ${this.presets.map((p) => {
                const tokenInput =
                  p.authType === 'bearer'
                    ? html`<label class="grow preset-token"
                        >${p.authLabel ?? 'Token'}<input
                          .value=${this.tokens[p.id] ?? ''}
                          @input=${(e: Event) =>
                            (this.tokens = {
                              ...this.tokens,
                              [p.id]: (e.target as HTMLInputElement).value
                            })}
                          placeholder=${p.authPlaceholder ?? ''}
                      /></label>`
                    : nothing;
                return html`<li class="preset">
                  <div class="preset-head">
                    <b>${p.name}</b>
                    <span class="chip">${p.authType}</span>
                    ${p.recommended
                      ? html`<span class="chip ok">推荐</span>`
                      : nothing}
                  </div>
                  ${p.note
                    ? html`<div class="muted preset-note">${p.note}</div>`
                    : nothing}
                  ${p.oneClick === false
                    ? html`<div class="row" style="margin-top:8px">
                        <a
                          class="ghost-link"
                          href=${p.docUrl ?? '#'}
                          target="_blank"
                          rel="noopener"
                          >查看接入说明 ›</a
                        >
                      </div>`
                    : html`<div class="row" style="margin-top:8px">
                        ${tokenInput}
                        <button
                          @click=${() => this.preset(p.id, this.tokens[p.id])}
                          ?disabled=${this.adding}
                        >
                          ${this.adding ? '连接中...' : '一键接入'}
                        </button>
                      </div>`}
                </li>`;
              })}
            </ul>
            ${this.presets.length === 0
              ? html`<p class="muted">暂无预设</p>`
              : nothing}
          </div>
        </div>
      </div>
    `;
  }
}

/* ------------------------------ Approvals ------------------------------ */

@customElement('ah-approvals')
export class AhApprovals extends LitElement {
  static styles = [sharedStyles];

  @state() items: ApprovalTicket[] = [];

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  private async refresh() {
    try {
      this.items = (await client.listApprovals()).tickets;
    } catch (e: any) {
      reportError('approvals', e);
    }
  }

  private async decide(id: string, decision: 'approve' | 'reject') {
    try {
      await client.decideApproval(id, decision);
      await this.refresh();
      notify.success(decision === 'approve' ? '工单已通过' : '工单已拒绝');
    } catch (e: any) {
      reportError('approvals', e);
    }
  }

  render() {
    return html`
      <section>
        <h2>审批工单</h2>
        <div class="row">
          <button class="ghost" @click=${() => this.refresh()}>刷新</button>
        </div>
        <ul class="list">
          ${this.items.length === 0
            ? html`<li class="muted">暂无工单</li>`
            : this.items.map(
                (a) => html`
                  <li>
                    <b>${a.id}</b> · ${a.action} · ${a.status}<br />
                    <span class="muted"
                      >decision:
                      ${a.decision ?? '-'}${a.note ? ' / ' + a.note : ''}</span
                    ><br />
                    <button
                      ?disabled=${a.status !== 'pending'}
                      @click=${() => this.decide(a.id, 'approve')}
                    >
                      通过
                    </button>
                    <button
                      ?disabled=${a.status !== 'pending'}
                      @click=${() => this.decide(a.id, 'reject')}
                    >
                      拒绝
                    </button>
                  </li>
                `
              )}
        </ul>
      </section>
    `;
  }
}
