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

  /**
   * 角色列（矩阵表头与单元格的数据来源）。
   * 优先使用接口返回的 `roles`；当它缺失 / 为空（如接口返回被截断、字段缺失）时，
   * 回退到从 `permissions` 的键推导 —— 因为权限数据才是角色集合的权威来源，
   * 这样即便 `roles` 字段不完整，凡拥有权限数据的角色都不会被漏列。
   */
  private roleColumns(): string[] {
    const r = this.roles;
    if (!r) return [];
    if (Array.isArray(r.roles) && r.roles.length > 0) return r.roles;
    if (r.permissions && typeof r.permissions === 'object') return Object.keys(r.permissions);
    return [];
  }

  /** 把所有角色的动作并集收集为矩阵行（按字母序）。对缺失 / 非数组字段做防御。 */
  private matrixRows(): { action: string; byRole: Record<string, boolean> }[] {
    const r = this.roles;
    if (!r || !r.permissions) return [];
    const roles = this.roleColumns();
    const actions = new Set<string>();
    for (const list of Object.values(r.permissions)) {
      // 接口可能返回 null / 非数组（字段缺失或数据不完整），需防御。
      if (Array.isArray(list)) list.forEach((a) => actions.add(a));
    }
    return [...actions]
      .sort()
      .map((action) => ({
        action,
        byRole: Object.fromEntries(
          roles.map((role) => [role, Array.isArray(r.permissions[role]) && r.permissions[role].includes(action)])
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
    const roleCols = this.roleColumns();

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
            <div class="section-title">
              运行队列
              ${j?.jobs?.length ? html`<span class="count">${j.jobs.length}</span>` : nothing}
            </div>
            <section>
              <div class="panel-scroll">
                <table class="matrix">
                  <thead>
                    <tr><th>JOB</th><th>MODE</th><th>STATUS</th><th>AGE</th></tr>
                  </thead>
                  <tbody>
                    ${(j?.jobs ?? []).map(
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
              </div>
            </section>
          </div>

          <div>
            <div class="section-title">
              记忆会话
              ${this.sessions?.sessions?.length ? html`<span class="count">${this.sessions.sessions.length}</span>` : nothing}
            </div>
            <section>
              <div class="kv">
                <div class="item"><span class="m">后端</span><span>${this.sessions?.backend ?? '—'}</span></div>
                <div class="item"><span class="m">会话数</span><span>${this.sessions?.sessions.length ?? 0}</span></div>
              </div>
              <div class="panel-scroll" style="margin-top:10px">
                <ul class="list">
                  ${(this.sessions?.sessions ?? []).map((k) => html`<li class="meta">${k}</li>`)}
                  ${(this.sessions?.sessions ?? []).length === 0 ? html`<li class="muted">暂无会话</li>` : nothing}
                </ul>
              </div>
            </section>
          </div>
        </div>

        <div class="section-title">角色与权限（RBAC）</div>
        <section>
          <div class="row-between" style="margin-bottom:10px">
            <span class="muted-sm">
              鉴权模式 <span class="role-badge">${this.roles?.mode ?? '—'}</span> ·
              身份源 <span class="role-badge">${this.roles?.provider ?? '—'}</span>
              ${rows.length || roleCols.length
                ? html`· <b class="accent-sm">${rows.length}</b> 个动作 / <b class="accent-sm">${roleCols.length}</b> 个角色`
                : nothing}
            </span>
            <button class="ghost" @click=${() => this.refresh()}>刷新</button>
          </div>
          ${this.roles?.mode === 'off'
            ? html`<div class="note" style="margin-bottom:10px">
                开放模式（未强制鉴权）：以下为<b>默认角色权限参考</b>，当前所有请求默认拥有完整权限。配置
                <code>UI_TOKENS</code> / <code>UI_ROLE_PERMISSIONS</code> 后此处将显示实际生效的矩阵。
              </div>`
            : nothing}
          <div class="matrix-scroll">
            <table class="matrix">
              <thead>
                <tr>
                  <th class="sticky-col">ACTION</th>
                  ${roleCols.map((r) => html`<th style="text-align:center">${r.toUpperCase()}</th>`)}
                </tr>
              </thead>
              <tbody>
                ${rows.map(
                  (row) => html`
                    <tr>
                      <td class="act sticky-col">${row.action}</td>
                      ${roleCols.map(
                        (r) => html`<td class="center">${row.byRole[r] ? html`<span class="check">✓</span>` : html`<span class="dash">—</span>`}</td>`
                      )}
                    </tr>
                  `
                )}
                ${rows.length === 0
                  ? html`<tr><td colspan="${roleCols.length + 1}" class="muted">${
                      this.roles && (this.roles.mode === 'off' || roleCols.length === 0)
                        ? '鉴权未启用（开放模式）：所有请求默认拥有完整权限（等效 admin）'
                        : '无权限数据'
                    }</td></tr>`
                  : nothing}
              </tbody>
            </table>
          </div>
          ${rows.length > 12
            ? html`<div class="scroll-hint">↓ 矩阵较长，可在上方区域内滚动查看全部 ${rows.length} 个动作</div>`
            : nothing}
        </section>
      </section>
    `;
  }
}
