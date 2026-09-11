/**
 * 浏览器沙箱控制台（ah-sandbox）。
 *
 * 管理 Agent 可用的受控浏览器会话：创建 / 列举 / 销毁。
 * 数据来自后端 `browser-sandbox.ts`（会话管理器），通过
 * `GET /api/sandbox/sessions` 与 `POST|DELETE /api/sandbox/sessions[/<id>]` 交互。
 *
 * 注意：本组件不引入任何服务端内部类型，SandboxSession / SandboxStatus
 * 在本地定义，仅与后端保持一致的形状。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authedFetch } from './api';
import { sharedStyles } from './styles';
import { notifyError } from './utils/errors';

/** 与 access/server/src/browser-sandbox.ts 的 SandboxStatus 保持一致。 */
export type SandboxStatus = 'creating' | 'ready' | 'destroyed' | 'error';

/** 与 access/server/src/browser-sandbox.ts 的 SandboxSession 保持一致。 */
export interface SandboxSession {
  id: string;
  status: SandboxStatus;
  targetUrl?: string;
  createdAt: string;
  owner: string;
  logs: string[];
}

interface SessionList {
  items: SandboxSession[];
}

@customElement('ah-sandbox')
export class AhSandbox extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-bottom: 14px;
      }
      input.url {
        flex: 1 1 280px;
        min-width: 200px;
        padding: 8px 10px;
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-sm);
        background: var(--ah-surface-2);
        color: var(--ah-text);
        font-family: var(--ah-font-mono);
        font-size: 13px;
      }
      button.primary {
        padding: 8px 16px;
        border: 1px solid var(--ah-accent);
        border-radius: var(--ah-radius-sm);
        background: var(--ah-accent);
        color: var(--ah-on-accent, #fff);
        cursor: pointer;
        font-weight: 600;
      }
      button.primary:disabled {
        opacity: 0.6;
        cursor: default;
      }
      ul.sessions {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      li.session {
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-md);
        background: var(--ah-surface-1);
        padding: 10px 12px;
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .id {
        font-family: var(--ah-font-mono);
        font-size: 12px;
        color: var(--ah-text-muted);
      }
      .badge {
        font-size: 11px;
        padding: 1px 8px;
        border-radius: 999px;
        border: 1px solid var(--ah-border);
        color: var(--ah-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .badge.ready {
        color: var(--ah-success, #2f9e44);
        border-color: var(--ah-success, #2f9e44);
      }
      .badge.creating {
        color: var(--ah-accent);
        border-color: var(--ah-accent);
      }
      .badge.error {
        color: var(--ah-danger, #e03131);
        border-color: var(--ah-danger, #e03131);
      }
      .badge.destroyed {
        color: var(--ah-text-muted);
      }
      .url {
        font-family: var(--ah-font-mono);
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1 1 auto;
      }
      .meta {
        color: var(--ah-text-muted);
        font-size: 12px;
        white-space: nowrap;
      }
      button.destroy {
        padding: 5px 12px;
        border: 1px solid var(--ah-danger, #e03131);
        border-radius: var(--ah-radius-sm);
        background: transparent;
        color: var(--ah-danger, #e03131);
        cursor: pointer;
        font-weight: 600;
      }
      button.destroy:hover {
        background: var(--ah-danger, #e03131);
        color: #fff;
      }
      .empty {
        border: 1px dashed var(--ah-border);
        border-radius: var(--ah-radius-md);
        padding: 28px;
        text-align: center;
        color: var(--ah-text-muted);
      }
    `,
  ];

  @state() items: SandboxSession[] = [];
  @state() loading = true;
  @state() targetUrl = '';
  @state() busy = false;

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    try {
      const res = await authedFetch('/api/sandbox/sessions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SessionList;
      this.items = data.items ?? [];
    } catch (e: any) {
      notifyError(e, { title: '浏览器沙箱', key: 'sandbox' });
      this.items = [];
    } finally {
      this.loading = false;
    }
  }

  private async createSession(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const targetUrl = this.targetUrl.trim() || undefined;
      const res = await authedFetch('/api/sandbox/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetUrl })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.targetUrl = '';
      await this.refresh();
    } catch (e: any) {
      notifyError(e, { title: '创建会话', key: 'sandbox-create' });
    } finally {
      this.busy = false;
    }
  }

  private async destroySession(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/sandbox/sessions/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.refresh();
    } catch (e: any) {
      notifyError(e, { title: '销毁会话', key: 'sandbox-destroy' });
    }
  }

  private shortId(id: string): string {
    return id.slice(0, 8);
  }

  render() {
    if (this.loading) return html`<div class="muted">加载中…</div>`;
    return html`
      <section style="border:none;background:none;box-shadow:none;padding:0">
        <div class="row-between" style="margin-bottom:14px">
          <div>
            <div class="section-title" style="margin:0">浏览器沙箱</div>
            <div class="muted-sm">受控浏览器会话 · 创建 / 列举 / 销毁</div>
          </div>
          <button class="ghost" @click=${() => this.refresh()}>刷新</button>
        </div>
        <div class="toolbar">
          <input
            class="url"
            type="text"
            placeholder="目标 URL（可留空 → about:blank）"
            .value=${this.targetUrl}
            @input=${(e: Event) => (this.targetUrl = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') void this.createSession();
            }}
          />
          <button class="primary" ?disabled=${this.busy} @click=${() => this.createSession()}>
            创建会话
          </button>
        </div>
        ${this.items.length === 0
          ? html`<div class="empty">暂无沙箱会话，输入目标 URL 后点击「创建会话」。</div>`
          : html`<ul class="sessions">
              ${this.items.map(
                (s) => html`
                  <li class="session">
                    <span class="id" title=${s.id}>${this.shortId(s.id)}</span>
                    <span class="badge ${s.status}">${s.status}</span>
                    <span class="url" title=${s.targetUrl ?? 'about:blank'}
                      >${s.targetUrl ?? 'about:blank'}</span
                    >
                    <span class="meta">${new Date(s.createdAt).toLocaleString()}</span>
                    <button class="destroy" @click=${() => this.destroySession(s.id)}>
                      销毁
                    </button>
                  </li>
                `
              )}
            </ul>`}
      </section>
    `;
  }
}
