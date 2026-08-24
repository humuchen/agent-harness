import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { client } from './api';
import type {
  StreamEvent,
  EnvAction,
  McpServerMeta,
  McpPreset,
  ApprovalTicket,
} from '@agent-harness/client';
import { sharedStyles } from './styles';

/* ------------------------------ 通用辅助 ------------------------------ */

function EventRow(ev: StreamEvent) {
  const { type, ...rest } = ev;
  const preview = Object.keys(rest).length ? JSON.stringify(rest) : '';
  return html`<div class="ev">
    <span class="ev-type">${type}</span>
    <span class="ev-body">${preview}</span>
  </div>`;
}

function ErrorBox(msg: string | null) {
  return msg ? html`<div class="error">${msg}</div>` : nothing;
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
  @state() error: string | null = null;
  private abort?: AbortController;

  private async run() {
    this.error = null;
    this.events = [];
    this.running = true;
    const ac = new AbortController();
    this.abort = ac;
    try {
      for await (const ev of client.streamVerify({ signal: ac.signal })) {
        this.events = [...this.events, ev];
      }
    } catch (e: any) {
      this.error = String(e?.message ?? e);
    } finally {
      this.running = false;
    }
  }

  render() {
    return html`
      <section>
        <h2>自检 / 验证</h2>
        <p class="muted">对服务端能力做三组断言（MCP 连接 / 护栏 / 环境流水线时序）。</p>
        <div class="row">
          <button ?disabled=${this.running} @click=${() => this.run()}>
            ${this.running ? '验证中…' : '运行验证'}
          </button>
          <button ?disabled=${!this.running} @click=${() => this.abort?.abort()}>停止</button>
        </div>
        ${ErrorBox(this.error)}
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
  @state() error: string | null = null;

  private async submit() {
    this.error = null;
    this.events = [];
    this.running = true;
    try {
      for await (const ev of client.streamEnv({
        action: this.action,
        branch: this.branch || undefined,
        ttl_hours: this.ttl ? Number(this.ttl) : undefined,
        region: this.region || undefined,
        owner: this.owner || undefined,
        env_id: this.envId || undefined,
      })) {
        this.events = [...this.events, ev];
      }
      this.dispatchEvent(new CustomEvent('ah-refresh', { bubbles: true, composed: true }));
    } catch (e: any) {
      this.error = String(e?.message ?? e);
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
            <select @change=${(e: Event) => (this.action = (e.target as HTMLSelectElement).value as EnvAction)}>
              <option value="create">创建</option>
              <option value="destroy">销毁</option>
            </select>
          </label>
          <label>分支<input .value=${this.branch} ?disabled=${!isCreate} @input=${(e: Event) => (this.branch = (e.target as HTMLInputElement).value)} /></label>
          <label>TTL(小时)<input .value=${this.ttl} ?disabled=${!isCreate} @input=${(e: Event) => (this.ttl = (e.target as HTMLInputElement).value)} /></label>
          <label>区域<input .value=${this.region} ?disabled=${!isCreate} @input=${(e: Event) => (this.region = (e.target as HTMLInputElement).value)} /></label>
          <label>拥有者<input .value=${this.owner} ?disabled=${!isCreate} @input=${(e: Event) => (this.owner = (e.target as HTMLInputElement).value)} /></label>
          <label>env_id(销毁时填)<input .value=${this.envId} ?disabled=${isCreate} @input=${(e: Event) => (this.envId = (e.target as HTMLInputElement).value)} /></label>
        </div>
        <div class="row">
          <button ?disabled=${this.running} @click=${() => this.submit()}>
            ${this.running ? '处理中…' : isCreate ? '创建环境' : '销毁环境'}
          </button>
        </div>
        ${ErrorBox(this.error)}
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
  @state() name = '';
  @state() url = '';
  /** 预设市场按 id 暂存的 token（bearer 型预设接入时透传）。 */
  @state() tokens: Record<string, string> = {};
  @state() error: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  private async refresh() {
    this.error = null;
    try {
      const [s, p] = await Promise.all([client.getMcpServers(), client.getMcpPresets()]);
      this.servers = s.servers;
      this.presets = p.presets;
    } catch (e: any) {
      this.error = String(e?.message ?? e);
    }
  }

  private async add() {
    this.error = null;
    try {
      await client.addMcpServer({ name: this.name, url: this.url });
      this.name = '';
      this.url = '';
      await this.refresh();
      this.dispatchEvent(new CustomEvent('ah-refresh', { bubbles: true, composed: true }));
    } catch (e: any) {
      this.error = String(e?.message ?? e);
    }
  }

  private async preset(id: string, token?: string) {
    this.error = null;
    try {
      await client.connectMcpPreset(id, token);
      await this.refresh();
      this.dispatchEvent(new CustomEvent('ah-refresh', { bubbles: true, composed: true }));
    } catch (e: any) {
      this.error = String(e?.message ?? e);
    }
  }

  render() {
    return html`
      <div class="mcp-layout">
        <h2>MCP 服务</h2>
        <div class="two">
          <!-- 左栏：添加表单卡片 + 已接入列表 -->
          <div class="stack">
            <div class="card">
              <div class="section-title">添加服务</div>
              <div class="row">
                <label>名称<input .value=${this.name} @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)} /></label>
                <label class="grow">URL<input .value=${this.url} @input=${(e: Event) => (this.url = (e.target as HTMLInputElement).value)} placeholder="https://... 或留空用 command" /></label>
              </div>
              <div class="row" style="margin-top:12px">
                <button @click=${() => this.add()}>添加</button>
                <button class="ghost" @click=${() => this.refresh()}>刷新</button>
              </div>
            </div>
            ${ErrorBox(this.error)}
            <div class="card">
              <div class="section-title">已接入</div>
              <ul class="list">
                ${this.servers.map(
                  (s) => html`<li>
                    <b>${s.name}</b> · ${s.status} · ${s.toolCount} 工具
                    ${s.status === 'error' && s.error
                      ? html`<div class="mcp-err">⚠ ${s.error}</div>`
                      : nothing}
                  </li>`
                )}
              </ul>
              ${this.servers.length === 0 ? html`<p class="muted">暂无已接入服务</p>` : nothing}
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
                            (this.tokens = { ...this.tokens, [p.id]: (e.target as HTMLInputElement).value })}
                          placeholder=${p.authPlaceholder ?? ''}
                      /></label>`
                    : nothing;
                return html`<li class="preset">
                  <div class="preset-head">
                    <b>${p.name}</b>
                    <span class="chip">${p.authType}</span>
                    ${p.recommended ? html`<span class="chip ok">推荐</span>` : nothing}
                  </div>
                  ${p.note ? html`<div class="muted preset-note">${p.note}</div>` : nothing}
                  ${p.oneClick === false
                    ? html`<div class="row" style="margin-top:8px">
                        <a class="ghost-link" href=${p.docUrl ?? '#'} target="_blank" rel="noopener"
                          >查看接入说明 ›</a
                        >
                      </div>`
                    : html`<div class="row" style="margin-top:8px">
                        ${tokenInput}
                        <button @click=${() => this.preset(p.id, this.tokens[p.id])}>一键接入</button>
                      </div>`}
                </li>`;
              })}
            </ul>
            ${this.presets.length === 0 ? html`<p class="muted">暂无预设</p>` : nothing}
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
  @state() error: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  private async refresh() {
    this.error = null;
    try {
      this.items = (await client.listApprovals()).tickets;
    } catch (e: any) {
      this.error = String(e?.message ?? e);
    }
  }

  private async decide(id: string, decision: 'approve' | 'reject') {
    this.error = null;
    try {
      await client.decideApproval(id, decision);
      await this.refresh();
    } catch (e: any) {
      this.error = String(e?.message ?? e);
    }
  }

  render() {
    return html`
      <section>
        <h2>审批工单</h2>
        <div class="row">
          <button class="ghost" @click=${() => this.refresh()}>刷新</button>
        </div>
        ${ErrorBox(this.error)}
        <ul class="list">
          ${this.items.length === 0
            ? html`<li class="muted">暂无工单</li>`
            : this.items.map(
                (a) => html`
                  <li>
                    <b>${a.id}</b> · ${a.action} · ${a.status}<br />
                    <span class="muted">decision: ${a.decision ?? '-'}${a.note ? ' / ' + a.note : ''}</span><br />
                    <button ?disabled=${a.status !== 'pending'} @click=${() => this.decide(a.id, 'approve')}>通过</button>
                    <button ?disabled=${a.status !== 'pending'} @click=${() => this.decide(a.id, 'reject')}>拒绝</button>
                  </li>
                `
              )}
        </ul>
      </section>
    `;
  }
}
