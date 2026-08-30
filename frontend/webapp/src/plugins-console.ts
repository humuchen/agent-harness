/**
 * 插件管理控制台（Phase 4 · 热插拔 UI，通用、无业务词）。
 *
 * 与平台插件系统对接：拉取 /api/plugins 列出已安装插件（id/name/version/state/dependencies），
 * 提供「启用 / 停用 / 升级」按钮，调用服务端热插拔端点（无需重启进程）。
 * 组件不感知任何插件业务语义——它只展示插件清单与通用操作。具体能力由插件自身经
 * PluginContext 注入（工具 / 路由 / Tab），与本面板解耦。
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { client, authedFetch } from './api';
import { sharedStyles } from './styles';

interface PluginInfo {
  id: string;
  name: string;
  version: string;
  state: string;
  dependencies: string[];
}

/** HTML 转义。 */
function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]));
}

@customElement('ah-plugins')
export class AhPlugins extends LitElement {
  static styles = [sharedStyles, css`
    .wrap { padding: 18px 22px; }
    /* 表格容器随主题切换 surface，与现有面板（section / codeblock）保持一致 */
    .panel {
      background: var(--ah-surface-1);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-lg);
      padding: 8px 14px;
      overflow-x: auto;
    }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--ah-border); }
    th { color: var(--ah-text-muted); font-weight: 600; font-size: 12px; }
    .state-enabled { color: var(--ah-success); }
    .state-disabled { color: var(--ah-danger); }
    button { margin-right: 6px; }
    .hint { color: var(--ah-text-muted); font-size: 12px; margin-top: 10px; }
    /* ---- 移动端（≤640px）：6 列表格在窄屏溢出，转为卡片式堆叠布局 ---- */
    @media (max-width: 640px) {
      .wrap { padding: 12px 14px; }
      .panel { padding: 4px 10px; overflow-x: visible; }
      table { margin-top: 8px; }
      thead { display: none; }
      table, tbody, tr, td {
        display: block;
        width: 100%;
        box-sizing: border-box;
      }
      tr {
        border-bottom: 1px solid var(--ah-border);
        border-radius: 0;
        padding: 10px 2px;
      }
      tr:last-child { border-bottom: none; }
      td {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        padding: 3px 0;
        border-bottom: none;
        font-size: 13px;
        word-break: break-all;
      }
      /* 每个字段前显示原表头标签（data-label 由模板写入） */
      td::before {
        content: attr(data-label);
        flex-shrink: 0;
        color: var(--ah-text-muted);
        font-size: 12px;
        font-weight: 600;
      }
      /* 操作行：按钮换行为一组，占满宽度便于点按 */
      td.actions {
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 6px;
        padding-top: 8px;
        border-top: 1px dashed var(--ah-border);
      }
      td.actions::before { width: 100%; }
      button {
        margin-right: 0;
        min-height: 32px;
        padding: 4px 12px;
      }
    }
  `];

  @state() private loading = true;
  @state() private plugins: PluginInfo[] = [];
  @state() private err: string | null = null;
  @state() private busy: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh() {
    this.loading = true;
    this.err = null;
    try {
      const res = await authedFetch('/api/plugins');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { plugins?: PluginInfo[] };
      this.plugins = (data.plugins ?? []).map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        version: p.version ?? '-',
        state: p.state ?? 'disabled',
        dependencies: p.dependencies ?? [],
      }));
    } catch (e: any) {
      this.err = String(e?.message ?? e);
    } finally {
      this.loading = false;
    }
  }

  private async act(id: string, action: 'enable' | 'disable' | 'upgrade') {
    this.busy = `${id}:${action}`;
    this.err = null;
    try {
      const res = await authedFetch(
        `/api/plugins/${encodeURIComponent(id)}/${action}`,
        {
          method: 'POST',
          body: action === 'upgrade' ? JSON.stringify({ version: 'latest' }) : undefined,
        }
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      await this.refresh();
      // 通知其它面板（聊天页 agent 下拉 / 外壳动态 Tab）：插件集合已变，需重拉自身数据。
      window.dispatchEvent(new CustomEvent('ah-plugins-changed'));
    } catch (e: any) {
      this.err = String(e?.message ?? e);
    } finally {
      this.busy = null;
    }
  }

  render() {
    if (this.loading) return html`<div class="wrap">加载插件列表…</div>`;
    return html`
      <div class="wrap">
        <h2>插件管理</h2>
        <p class="hint">运行时启停 / 升级插件，无需重启服务进程；操作受服务端 plugin:manage 权限保护。</p>
        ${this.err ? html`<p class="state-disabled">错误：${esc(this.err)}</p>` : ''}
        ${this.plugins.length === 0
          ? html`<p class="hint">未安装任何插件。</p>`
          : html`
            <div class="panel">
            <table>
              <thead>
                <tr><th>ID</th><th>名称</th><th>版本</th><th>状态</th><th>依赖</th><th>操作</th></tr>
              </thead>
              <tbody>
                ${this.plugins.map(
                  (p) => html`
                    <tr>
                      <td data-label="ID">${esc(p.id)}</td>
                      <td data-label="名称">${esc(p.name)}</td>
                      <td data-label="版本">${esc(p.version)}</td>
                      <td data-label="状态" class=${p.state === 'enabled' ? 'state-enabled' : 'state-disabled'}>${esc(p.state)}</td>
                      <td data-label="依赖">${esc(p.dependencies.join(', ') || '-')}</td>
                      <td class="actions">
                        <button
                          ?disabled=${this.busy !== null || p.state === 'enabled'}
                          @click=${() => this.act(p.id, 'enable')}
                        >启用</button>
                        <button
                          ?disabled=${this.busy !== null || p.state !== 'enabled'}
                          @click=${() => this.act(p.id, 'disable')}
                        >停用</button>
                        <button
                          ?disabled=${this.busy !== null}
                          @click=${() => this.act(p.id, 'upgrade')}
                        >升级</button>
                        ${this.busy === `${p.id}:enable` ? '…' : ''}
                        ${this.busy === `${p.id}:disable` ? '…' : ''}
                        ${this.busy === `${p.id}:upgrade` ? '…' : ''}
                      </td>
                    </tr>`
                )}
              </tbody>
            </table>
            </div>`}
      </div>
    `;
  }
}
