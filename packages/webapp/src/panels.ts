import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { client, ApprovalRequiredError } from './api';
import type {
  RunMode,
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
  return msg ? html`<div class="error">⚠️ ${msg}</div>` : nothing;
}

/** 把流式事件追加进 @state 数组的便捷闭包。 */
function appendEvent(getEvents: () => StreamEvent[], setEvents: (v: StreamEvent[]) => void) {
  return (ev: StreamEvent) => setEvents([...getEvents(), ev]);
}

/* ------------------------------ Run ------------------------------ */

@customElement('ah-run')
export class AhRun extends LitElement {
  static styles = [sharedStyles];

  @state() mode: RunMode = 'mock';
  @state() prompt = '列出当前目录的 .ts 文件';
  @state() model = '';
  @state() maxSteps = '';
  @state() sessionId = '';
  @state() reconnect = '';
  @state() events: StreamEvent[] = [];
  @state() running = false;
  @state() error: string | null = null;
  @state() ticket: string | null = null;
  private abort?: AbortController;

  private async run() {
    this.error = null;
    this.ticket = null;
    this.events = [];
    this.running = true;
    const ac = new AbortController();
    this.abort = ac;
    const push = appendEvent(
      () => this.events,
      (v) => (this.events = v)
    );
    try {
      for await (const ev of client.streamRun(
        {
          mode: this.mode,
          prompt: this.prompt,
          model: this.model || undefined,
          maxSteps: this.maxSteps ? Number(this.maxSteps) : undefined,
          sessionId: this.sessionId || undefined,
          jobId: this.reconnect || undefined,
        },
        { signal: ac.signal }
      )) {
        push(ev);
        if (ev.type === 'env:status' || ev.type === '_env_done') {
          this.dispatchEvent(new CustomEvent('ah-refresh', { bubbles: true, composed: true }));
        }
      }
    } catch (e: any) {
      if (e instanceof ApprovalRequiredError) {
        this.ticket = `需要审批：ticket ${e.ticketId}（在「审批」页裁决后重投）`;
      } else {
        this.error = String(e?.message ?? e);
      }
    } finally {
      this.running = false;
    }
  }

  render() {
    return html`
      <section>
        <h2>运行 Agent</h2>
        <div class="grid">
          <label>
            模式
            <select @change=${(e: Event) => (this.mode = (e.target as HTMLSelectElement).value as RunMode)}>
              <option value="mock">mock（离线）</option>
              <option value="real">real（真实 LLM）</option>
              <option value="real-mcp">real-mcp</option>
            </select>
          </label>
          <label>模型<input .value=${this.model} @input=${(e: Event) => (this.model = (e.target as HTMLInputElement).value)} placeholder="留空用服务端默认" /></label>
          <label>最大步数<input .value=${this.maxSteps} @input=${(e: Event) => (this.maxSteps = (e.target as HTMLInputElement).value)} placeholder="留空用默认 24" /></label>
          <label>会话 ID<input .value=${this.sessionId} @input=${(e: Event) => (this.sessionId = (e.target as HTMLInputElement).value)} placeholder="多租户隔离 key" /></label>
          <label>重连 jobId<input .value=${this.reconnect} @input=${(e: Event) => (this.reconnect = (e.target as HTMLInputElement).value)} placeholder="断线重连用，可留空" /></label>
        </div>
        <label class="block">
          提示词
          <textarea rows="3" .value=${this.prompt} @input=${(e: Event) => (this.prompt = (e.target as HTMLTextAreaElement).value)}></textarea>
        </label>
        <div class="row">
          <button ?disabled=${this.running} @click=${() => this.run()}>
            ${this.running ? '运行中…' : '▶ 运行'}
          </button>
          <button ?disabled=${!this.running} @click=${() => this.abort?.abort()}>■ 停止</button>
        </div>
        ${ErrorBox(this.error)}
        ${this.ticket ? html`<div class="warn">${this.ticket}</div>` : nothing}
        <div class="stream">${this.events.map(EventRow)}</div>
      </section>
    `;
  }
}

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
            ${this.running ? '验证中…' : '▶ 运行验证'}
          </button>
          <button ?disabled=${!this.running} @click=${() => this.abort?.abort()}>■ 停止</button>
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
            ${this.running ? '处理中…' : isCreate ? '➕ 创建环境' : '🗑 销毁环境'}
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
      <section>
        <h2>MCP 服务</h2>
        <div class="row">
          <label>名称<input .value=${this.name} @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)} /></label>
          <label class="grow">URL<input .value=${this.url} @input=${(e: Event) => (this.url = (e.target as HTMLInputElement).value)} placeholder="https://... 或留空用 command" /></label>
          <button @click=${() => this.add()}>＋ 添加</button>
          <button class="ghost" @click=${() => this.refresh()}>↻ 刷新</button>
        </div>
        ${ErrorBox(this.error)}
        <h3>已接入</h3>
        <ul class="list">
          ${this.servers.map(
            (s) => html`<li><b>${s.name}</b> · ${s.status} · ${s.toolCount} 工具</li>`
          )}
        </ul>
        <h3>预设市场</h3>
        <ul class="list">
          ${this.presets.map(
            (p) => html`<li>${p.name}（${p.authType}） <button @click=${() => this.preset(p.id)}>一键接入</button></li>`
          )}
        </ul>
      </section>
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
          <button class="ghost" @click=${() => this.refresh()}>↻ 刷新</button>
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
                    <button ?disabled=${a.status !== 'pending'} @click=${() => this.decide(a.id, 'approve')}>✅ 通过</button>
                    <button ?disabled=${a.status !== 'pending'} @click=${() => this.decide(a.id, 'reject')}>❌ 拒绝</button>
                  </li>
                `
              )}
        </ul>
      </section>
    `;
  }
}
