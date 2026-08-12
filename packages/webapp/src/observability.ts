/**
 * 可观测（Observability）路由：指标卡 + 运行队列 + 会话 + RBAC 权限矩阵。
 * 数据来自 getMetrics / getJobs / getSessions / getRoles（均为真实接口）。
 * RBAC 矩阵直接由服务端 /api/roles 的 permissions 动态生成，新增动作/角色自动同步。
 */
import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { client } from './api';
import { sharedStyles } from './styles';

interface QueueStats {
  concurrency: number;
  queued: number;
  running: number;
  jobs: number;
  sessionsRunning: number;
}
interface Metrics {
  uptimeMs: number;
  cost: number;
  counters: Record<string, number>;
  latency: Record<string, { count: number; avgMs: number }>;
  queue?: QueueStats;
}
interface JobsView {
  queue: QueueStats;
  jobs: Array<{ id: string; status: string; mode: string; enqueuedAt: number; startedAt: number | null; finishedAt: number | null }>;
}
interface RolesView {
  mode: 'off' | 'on';
  provider: string;
  roles: string[];
  permissions: Record<string, string[]>;
}

function fmtAge(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function avgLatency(m: Metrics | null): number {
  if (!m?.latency) return 0;
  let wSum = 0;
  let nSum = 0;
  for (const v of Object.values(m.latency)) {
    wSum += v.avgMs * v.count;
    nSum += v.count;
  }
  return nSum ? Math.round(wSum / nSum) : 0;
}

@customElement('ah-observability')
export class AhObservability extends LitElement {
  static styles = [sharedStyles];

  @state() metrics: Metrics | null = null;
  @state() jobs: JobsView | null = null;
  @state() sessions: { backend: string; sessions: string[] } | null = null;
  @state() roles: RolesView | null = null;
  @state() error: string | null = null;
  @state() loading = true;

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  private async refresh() {
    this.error = null;
    this.loading = true;
    try {
      const [m, j, se, r] = await Promise.all([
        client.getMetrics() as Promise<Metrics>,
        client.getJobs() as Promise<JobsView>,
        client.getSessions(),
        client.getRoles() as Promise<RolesView>,
      ]);
      this.metrics = m;
      this.jobs = j;
      this.sessions = se;
      this.roles = r;
    } catch (e: any) {
      this.error = String(e?.message ?? e);
    } finally {
      this.loading = false;
    }
  }

  /** 把所有角色的动作并集收集为矩阵行（按字母序）。 */
  private matrixRows(): { action: string; byRole: Record<string, boolean> }[] {
    if (!this.roles) return [];
    const actions = new Set<string>();
    for (const list of Object.values(this.roles.permissions)) list.forEach((a) => actions.add(a));
    return [...actions]
      .sort()
      .map((action) => ({
        action,
        byRole: Object.fromEntries(
          this.roles!.roles.map((role) => [role, this.roles!.permissions[role]?.includes(action) ?? false])
        ),
      }));
  }

  render() {
    if (this.loading && !this.metrics) {
      return html`<section><p class="muted">加载可观测数据…</p></section>`;
    }
    const m = this.metrics;
    const j = this.jobs;
    const errCount = m?.counters?.errors ?? 0;
    const cost = m ? `$${m.cost.toFixed(2)}` : '—';
    const queueDepth = (m?.queue?.queued ?? j?.queue.queued ?? 0) + (m?.queue?.running ?? j?.queue.running ?? 0);
    const rows = this.matrixRows();

    return html`
      <section style="border:none;background:none;box-shadow:none;padding:0">
        <div class="cards">
          <div class="kpi"><div class="v">${avgLatency(m)}ms</div><div class="k">平均延迟</div></div>
          <div class="kpi"><div class="v ${errCount ? 'warn' : 'ok'}">${errCount}</div><div class="k">错误数</div></div>
          <div class="kpi"><div class="v">${cost}</div><div class="k">累计花费</div></div>
          <div class="kpi"><div class="v accent">${queueDepth}</div><div class="k">队列深度</div></div>
        </div>

        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}

        <div class="two">
          <div>
            <div class="section-title">运行队列</div>
            <section>
              <table class="matrix">
                <thead>
                  <tr><th>JOB</th><th>MODE</th><th>STATUS</th><th>AGE</th></tr>
                </thead>
                <tbody>
                  ${(j?.jobs ?? []).slice(0, 8).map(
                    (job) => html`
                      <tr>
                        <td class="act">${job.id}</td>
                        <td class="muted-sm">${job.mode}</td>
                        <td><span class="pill ${job.status}">${job.status}</span></td>
                        <td class="meta">${fmtAge(job.startedAt ?? job.enqueuedAt)}</td>
                      </tr>
                    `
                  )}
                  ${(j?.jobs ?? []).length === 0 ? html`<tr><td colspan="4" class="muted">队列为空</td></tr>` : nothing}
                </tbody>
              </table>
            </section>
          </div>

          <div>
            <div class="section-title">记忆会话</div>
            <section>
              <div class="kv">
                <div class="item"><span class="m">后端</span><span>${this.sessions?.backend ?? '—'}</span></div>
                <div class="item"><span class="m">会话数</span><span>${this.sessions?.sessions.length ?? 0}</span></div>
              </div>
              <ul class="list" style="margin-top:10px">
                ${(this.sessions?.sessions ?? []).slice(0, 6).map((k) => html`<li class="meta">${k}</li>`)}
                ${(this.sessions?.sessions ?? []).length === 0 ? html`<li class="muted">暂无会话</li>` : nothing}
              </ul>
            </section>
          </div>
        </div>

        <div class="section-title">角色与权限（RBAC）</div>
        <section>
          <div class="row-between" style="margin-bottom:10px">
            <span class="muted-sm">
              鉴权模式 <span class="role-badge">${this.roles?.mode ?? '—'}</span> ·
              身份源 <span class="role-badge">${this.roles?.provider ?? '—'}</span>
            </span>
            <button class="ghost" @click=${() => this.refresh()}>↻ 刷新</button>
          </div>
          <table class="matrix">
            <thead>
              <tr>
                <th>ACTION</th>
                ${(this.roles?.roles ?? []).map((r) => html`<th style="text-align:center">${r.toUpperCase()}</th>`)}
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                (row) => html`
                  <tr>
                    <td class="act">${row.action}</td>
                    ${(this.roles?.roles ?? []).map(
                      (r) => html`<td class="center">${row.byRole[r] ? html`<span class="check">✓</span>` : html`<span class="dash">—</span>`}</td>`
                    )}
                  </tr>
                `
              )}
              ${rows.length === 0 ? html`<tr><td colspan="4" class="muted">无权限数据</td></tr>` : nothing}
            </tbody>
          </table>
        </section>
      </section>
    `;
  }
}
