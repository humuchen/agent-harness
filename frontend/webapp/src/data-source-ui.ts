/**
 * 数据源管理（ah-datasources，P1-x）。
 *
 * 展示已注册数据源（来自 `GET /api/datasources`，后端 data-source.ts），
 * 提供「测试连接」按钮探测每个数据源连通性并展示结果
 * （ok 徽标 + 消息 + 延迟）。数据定义类型在本地声明，webapp 不导入服务端内部。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authedFetch } from './api';
import { sharedStyles } from './styles';
import { notifyError } from './utils/errors';

export type DataSourceType = 'http' | 'static' | 'postgres';

export interface DataSourceDef {
  id: string;
  name: string;
  type: DataSourceType;
  config: Record<string, unknown>;
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

@customElement('ah-datasources')
export class AhDataSources extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .ds-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .ds-item {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        padding: 12px 14px;
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-md);
        background: var(--ah-surface-1);
      }
      .ds-name {
        font-weight: 600;
        font-size: 14px;
      }
      .ds-id {
        font-family: var(--ah-font-mono);
        font-size: 12px;
        color: var(--ah-text-muted);
      }
      .badge {
        font-size: 11px;
        padding: 1px 9px;
        border-radius: 999px;
        border: 1px solid var(--ah-border);
        color: var(--ah-text-muted);
        font-family: var(--ah-font-mono);
      }
      .badge.static {
        color: var(--ah-accent);
        border-color: var(--ah-accent);
      }
      .badge.http {
        color: var(--ah-success);
        border-color: var(--ah-success);
      }
      .badge.postgres {
        color: var(--ah-warning);
        border-color: var(--ah-warning);
      }
      .spacer {
        flex: 1;
      }
      .test-result {
        flex: 1 1 100%;
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 6px;
        font-size: 13px;
      }
      .test-result .msg {
        font-family: var(--ah-font-mono);
        color: var(--ah-text-muted);
      }
      .test-result .latency {
        color: var(--ah-text-faint);
        font-size: 12px;
      }
    `,
  ];

  @state() items: DataSourceDef[] = [];
  @state() loading = true;
  @state() testing = new Set<string>();
  @state() results = new Map<string, ConnectionResult>();

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    try {
      const res = await authedFetch('/api/datasources');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: DataSourceDef[] };
      this.items = data.items ?? [];
    } catch (e: any) {
      notifyError(e, { title: '数据源', key: 'datasources' });
    } finally {
      this.loading = false;
    }
  }

  private async testConnection(id: string): Promise<void> {
    const s = new Set(this.testing);
    s.add(id);
    this.testing = s;
    try {
      const res = await authedFetch(`/api/datasources/${encodeURIComponent(id)}/test`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as ConnectionResult;
      const next = new Map(this.results);
      next.set(id, result);
      this.results = next;
    } catch (e: any) {
      const next = new Map(this.results);
      next.set(id, { ok: false, message: String(e?.message ?? e) });
      this.results = next;
    } finally {
      const s2 = new Set(this.testing);
      s2.delete(id);
      this.testing = s2;
    }
  }

  render() {
    if (this.loading) return html`<div class="muted">加载中…</div>`;
    if (this.items.length === 0) {
      return html`<div class="muted">暂无数据源</div>`;
    }
    return html`
      <section style="border:none;background:none;box-shadow:none;padding:0">
        <div class="row-between" style="margin-bottom:14px">
          <div>
            <div class="section-title" style="margin:0">数据源</div>
            <div class="muted-sm">已注册 ${this.items.length} 个数据源</div>
          </div>
          <button class="ghost" @click=${() => this.refresh()}>刷新</button>
        </div>
        <div class="ds-list">
          ${this.items.map((ds) => this.renderItem(ds))}
        </div>
      </section>
    `;
  }

  private renderItem(ds: DataSourceDef): unknown {
    const isTesting = this.testing.has(ds.id);
    const result = this.results.get(ds.id);
    return html`
      <div class="ds-item">
        <span class="ds-name">${ds.name}</span>
        <span class="badge ${ds.type}">${ds.type}</span>
        <span class="ds-id">${ds.id}</span>
        <span class="spacer"></span>
        <button
          class="ghost"
          ?disabled=${isTesting}
          @click=${() => this.testConnection(ds.id)}
        >
          ${isTesting ? '测试中…' : '测试连接'}
        </button>
        ${result
          ? html`
              <div class="test-result">
                <span class="pill ${result.ok ? 'ok' : 'err'}">
                  ${result.ok ? '已连通' : '失败'}
                </span>
                <span class="msg">${result.message}</span>
                ${result.latencyMs != null
                  ? html`<span class="latency">· ${result.latencyMs}ms</span>`
                  : nothing}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}
