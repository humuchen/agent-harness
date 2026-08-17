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
import { getToken } from './api';
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
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border, #2a2f3a); }
    th { color: var(--muted, #8b93a7); font-weight: 600; font-size: 12px; }
    .state-enabled { color: #4ade80; }
    .state-disabled { color: #f87171; }
    button { margin-right: 6px; }
    .hint { color: var(--muted, #8b93a7); font-size: 12px; margin-top: 10px; }
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
      const token = getToken();
      const res = await fetch(
        '/api/plugins',
        token ? { headers: { authorization: `Bearer ${token}` } } : {}
      );
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
      const token = getToken();
      const res = await fetch(
        `/api/plugins/${encodeURIComponent(id)}/${action}`,
        {
          method: 'POST',
          headers: token ? { authorization: `Bearer ${token}` } : {},
          body: action === 'upgrade' ? JSON.stringify({ version: 'latest' }) : undefined,
        }
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      await this.refresh();
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
            <table>
              <thead>
                <tr><th>ID</th><th>名称</th><th>版本</th><th>状态</th><th>依赖</th><th>操作</th></tr>
              </thead>
              <tbody>
                ${this.plugins.map(
                  (p) => html`
                    <tr>
                      <td>${esc(p.id)}</td>
                      <td>${esc(p.name)}</td>
                      <td>${esc(p.version)}</td>
                      <td class=${p.state === 'enabled' ? 'state-enabled' : 'state-disabled'}>${esc(p.state)}</td>
                      <td>${esc(p.dependencies.join(', ') || '-')}</td>
                      <td>
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
            </table>`}
      </div>
    `;
  }
}
