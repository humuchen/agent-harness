/**
 * CI 供应链（ah-supply-chain）。
 *
 * 可视化平台依赖的供应链安全：汇总计数、依赖表（名称 / 版本 / dev 徽标 /
 * 截断的 integrity），并展示报告签名（防篡改）。数据来自
 * `GET /api/supply-chain/report`（后端 supply-chain.ts）。「重新扫描」按钮触发
 * `POST /api/supply-chain/scan` 后刷新。
 *
 * 类型在本地定义（不 import 服务端内部类型），webapp 不得依赖 server 内部。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authedFetch } from './api';
import { sharedStyles } from './styles';
import { notifyError } from './utils/errors';

export interface DependencyReport {
  name: string;
  version: string;
  resolved?: string;
  integrity?: string;
  dev: boolean;
}

export interface SupplyChainReport {
  generatedAt: string;
  repoRoot: string;
  summary: { total: number; withIntegrity: number; dev: number; prod: number };
  dependencies: DependencyReport[];
  signature?: string;
}

@customElement('ah-supply-chain')
export class AhSupplyChain extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .chips {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 14px;
      }
      .kpi {
        background: var(--ah-surface-1);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-md);
        padding: 10px 16px;
        min-width: 92px;
      }
      .kpi .v {
        font-family: var(--ah-font-display);
        font-size: 22px;
        font-weight: 700;
        color: var(--ah-text);
        line-height: 1.1;
      }
      .kpi .k {
        font-size: 12px;
        color: var(--ah-text-muted);
        margin-top: 4px;
      }
      .kpi .v.accent {
        color: var(--ah-accent);
      }
      table.deps {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        margin-top: 4px;
      }
      table.deps th,
      table.deps td {
        text-align: left;
        padding: 8px 10px;
        border-bottom: 1px solid var(--ah-border);
      }
      table.deps thead th {
        font-family: var(--ah-font-mono);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--ah-text-faint);
      }
      table.deps td.mono {
        font-family: var(--ah-font-mono);
        font-size: 12px;
      }
      .badge {
        font-size: 11px;
        padding: 1px 8px;
        border-radius: 999px;
        border: 1px solid var(--ah-border);
        color: var(--ah-text-muted);
      }
      .badge.dev {
        color: var(--ah-warning);
        border-color: transparent;
        background: var(--ah-warning-soft);
      }
      .badge.prod {
        color: var(--ah-success);
        border-color: transparent;
        background: var(--ah-success-soft);
      }
      .sig {
        margin-top: 14px;
        font-family: var(--ah-font-mono);
        font-size: 12px;
        color: var(--ah-text-muted);
        word-break: break-all;
        background: var(--ah-surface-2);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-sm);
        padding: 8px 12px;
      }
    `,
  ];

  @state() report: SupplyChainReport | null = null;
  @state() loading = true;
  @state() scanning = false;

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    try {
      const res = await authedFetch('/api/supply-chain/report');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.report = (await res.json()) as SupplyChainReport;
    } catch (e: unknown) {
      notifyError(e, { title: 'CI 供应链', key: 'supply-chain' });
    } finally {
      this.loading = false;
    }
  }

  private async rescan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const res = await authedFetch('/api/supply-chain/scan', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.refresh();
    } catch (e: unknown) {
      notifyError(e, { title: 'CI 供应链', key: 'supply-chain' });
    } finally {
      this.scanning = false;
    }
  }

  private truncate(s?: string, n = 28): string {
    if (!s) return '';
    return s.length > n ? `${s.slice(0, n)}…` : s;
  }

  render() {
    if (this.loading) return html`<div class="muted">加载中…</div>`;
    if (!this.report) return html`<div class="muted">暂无供应链报告</div>`;

    const { summary, dependencies, signature } = this.report;
    return html`
      <section style="border:none;background:none;box-shadow:none;padding:0">
        <div class="row-between" style="margin-bottom:14px">
          <div>
            <div class="section-title" style="margin:0">CI 供应链</div>
            <div class="muted-sm">
              依赖扫描与完整性报告 · 生成于
              <span class="mono">${this.report.generatedAt}</span>
            </div>
          </div>
          <button
            class="ghost"
            ?disabled=${this.scanning}
            @click=${() => void this.rescan()}
          >
            ${this.scanning ? '扫描中…' : '重新扫描'}
          </button>
        </div>

        <div class="chips">
          <div class="kpi"><div class="v">${summary.total}</div><div class="k">依赖总数</div></div>
          <div class="kpi">
            <div class="v accent">${summary.withIntegrity}</div><div class="k">含完整性</div>
          </div>
          <div class="kpi"><div class="v">${summary.dev}</div><div class="k">dev</div></div>
          <div class="kpi"><div class="v">${summary.prod}</div><div class="k">prod</div></div>
        </div>

        ${
          dependencies.length === 0
            ? html`<div class="muted">未检测到依赖（dependencies / devDependencies 均为空）。</div>`
            : html`
                <table class="deps">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>版本</th>
                      <th>类型</th>
                      <th>完整性（sha512）</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${dependencies.map(
                      (d) => html`
                        <tr>
                          <td class="mono">${d.name}</td>
                          <td class="mono">${d.version}</td>
                          <td>
                            <span class="badge ${d.dev ? 'dev' : 'prod'}"
                              >${d.dev ? 'dev' : 'prod'}</span
                            >
                          </td>
                          <td class="mono" title=${d.integrity ?? ''}>
                            ${d.integrity ? this.truncate(d.integrity) : '—'}
                          </td>
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              `
        }

        ${
          signature
            ? html`<div class="sig">
                <div class="muted-sm" style="margin-bottom:4px">
                  报告签名（HMAC-SHA256，防篡改）
                </div>
                ${signature}
              </div>`
            : nothing
        }
      </section>
    `;
  }
}
