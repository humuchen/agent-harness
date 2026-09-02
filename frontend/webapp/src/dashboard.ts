/** 沙箱能力标签：把 `active` 四个原语渲染成「已生效 / 未生效」芯片。
 * 供 Dashboard 顶栏展示当前 shell 执行被哪些 OS 隔离约束保护。
 */
export function renderSandboxChip(s: NonNullable<ServerState['sandbox']>) {
  const pills = [
    ['namespaces', 'NS'],
    ['seccomp', 'seccomp'],
    ['resourceLimits', 'RL'],
    ['capabilities', 'caps']
  ] as const;
  const active = pills.filter(([k]) => s.active[k]).map(([, l]) => l);
  const inactive = pills.filter(([k]) => !s.active[k]).map(([, l]) => l);
  const icon = s.supported ? '🛡' : '⚠️';
  const body =
    s.backend === 'os-fallback-local'
      ? `硬化本地（${inactive.join('/') || '无 OS 原语'}）${
          s.reason ? ` — ${s.reason}` : ''
        }`
      : `${s.backend} (${active.join('/')})`;
  return html`<span class="pill sandbox" title="${body}">${icon} 沙箱</span>`;
}
import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { client } from './api';
import type { ApprovalTicket, ServerState } from '@agent-harness/client';
import { sharedStyles } from './styles';
import { notifyError } from './utils/errors';

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
  jobs: Array<{ id: string; status: string; mode: string; enqueuedAt: number }>;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天 ${h}时`;
  if (h > 0) return `${h}时 ${m}分`;
  return `${m}分`;
}

function fmtAge(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** 跨 latency 直方图按样本量加权得到平均延迟。 */
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

@customElement('ah-dashboard')
export class AhDashboard extends LitElement {
  static styles = [sharedStyles];

  @state() state: ServerState | null = null;
  @state() metrics: Metrics | null = null;
  @state() jobs: JobsView | null = null;
  @state() pending: ApprovalTicket[] = [];
  @state() loading = true;

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  private async refresh() {
    this.loading = true;
    try {
      const [s, m, j, a] = await Promise.all([
        client.getState(),
        client.getMetrics() as Promise<Metrics>,
        client.getJobs() as Promise<JobsView>,
        client
          .listApprovals('pending')
          .catch(() => ({ tickets: [] as ApprovalTicket[] }))
      ]);
      this.state = s;
      this.metrics = m;
      this.jobs = j;
      this.pending = a.tickets;
    } catch (e: any) {
      notifyError(e, { title: '总览', key: 'dashboard' });
    } finally {
      this.loading = false;
    }
  }

  private goto(tab: string) {
    this.dispatchEvent(
      new CustomEvent('ah-goto', { detail: tab, bubbles: true, composed: true })
    );
  }

  render() {
    if (this.loading && !this.state) {
      return html`<section><p class="muted">加载总览…</p></section>`;
    }
    const s = this.state;
    const m = this.metrics;
    const j = this.jobs;
    const running = j?.queue.running ?? 0;
    const queued = j?.queue.queued ?? 0;
    const envCount = s?.envs.length ?? 0;
    const mcpCount = s?.mcpServers.length ?? 0;
    const cost = m ? `$${m.cost.toFixed(2)}` : '—';

    return html`
      <section style="border:none;background:none;box-shadow:none;padding:0">
        <div class="hero">
          <h2>Agent Harness 控制台</h2>
          <div class="hero-sub">
            记忆后端 ${m ? (m as any).memory?.backend ?? '—' : '—'} ·
            ${s?.sandbox
              ? html`沙箱 <b>${s.sandbox.backend}</b>${s.sandbox.supported
                    ? '（' +
                      Object.entries(s.sandbox.active)
                        .filter(([, v]) => v)
                        .map(([k]) => k)
                        .join('/') +
                      '）'
                    : ' — ' + s.sandbox.reason}`
              : '沙箱：硬化本地（无 OS 级隔离）'}
          </div>
          <div class="hero-stats">
            <div class="hero-stat">
              <div class="v">${fmtUptime(m?.uptimeMs ?? 0)}</div>
              <div class="k">运行时长</div>
            </div>
            <div class="hero-stat">
              <div class="v">${j?.queue.jobs ?? 0}</div>
              <div class="k">累计任务</div>
            </div>
            <div class="hero-stat">
              <div class="v accent">${running}</div>
              <div class="k">运行中</div>
            </div>
            <div class="hero-stat">
              <div class="v warn">${queued}</div>
              <div class="k">排队中</div>
            </div>
            <div class="hero-stat">
              <div class="v">${envCount}</div>
              <div class="k">环境数</div>
            </div>
          </div>
        </div>

        <div class="cards">
          <div class="kpi">
            <div class="v accent">${running}</div>
            <div class="k">运行任务</div>
          </div>
          <div class="kpi">
            <div class="v">${envCount}</div>
            <div class="k">就绪环境</div>
          </div>
          <div class="kpi">
            <div class="v">${mcpCount}</div>
            <div class="k">已接入 MCP</div>
          </div>
          <div class="kpi">
            <div class="v ${this.pending.length ? 'warn' : 'ok'}">
              ${this.pending.length}
            </div>
            <div class="k">待审工单</div>
          </div>
          <div class="kpi">
            <div class="v">${cost}</div>
            <div class="k">累计花费</div>
          </div>
        </div>

        <div class="two">
          <section>
            <div class="row-between">
              <div class="section-title">实时活动</div>
              <button class="link" @click=${() => this.goto('observability')}>
                查看队列 →
              </button>
            </div>
            <ul class="list">
              ${(j?.jobs ?? []).slice(0, 6).map(
                (job) => html`
                  <li>
                    <span class="meta">${job.id}</span>
                    <span class="pill ${job.status}">${job.status}</span>
                    <span class="muted-sm"
                      >· ${job.mode} · ${fmtAge(job.enqueuedAt)}前</span
                    >
                  </li>
                `
              )}
              ${(j?.jobs ?? []).length === 0
                ? html`<li class="muted">暂无任务</li>`
                : nothing}
            </ul>
          </section>

          <section>
            <div class="row-between">
              <div class="section-title">最近环境</div>
              <button class="link" @click=${() => this.goto('env')}>
                管理环境 →
              </button>
            </div>
            <ul class="list">
              ${(s?.envs ?? []).slice(0, 4).map(
                (e) => html`
                  <li>
                    <b>${e.envId}</b>
                    <span class="pill ${e.status}">${e.status}</span><br />
                    <span class="muted-sm"
                      >${e.branch ?? '—'}${e.owner ? ' · ' + e.owner : ''}</span
                    >
                  </li>
                `
              )}
              ${(s?.envs ?? []).length === 0
                ? html`<li class="muted">暂无环境</li>`
                : nothing}
            </ul>
          </section>
        </div>

        <div class="row">
          <button @click=${() => this.goto('run')}>快速运行</button>
          <button class="ghost" @click=${() => this.goto('approvals')}>
            待审 ${this.pending.length} 项
          </button>
          <button class="ghost" @click=${() => this.refresh()}>刷新</button>
        </div>
      </section>
    `;
  }
}
