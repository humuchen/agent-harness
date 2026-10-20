<script lang="ts">
/**
 * 总览 Dashboard（ah-dashboard）。Svelte 5 迁移版
 * ------------------------------------------------------------------
 * 顶栏 hero（运行时长 / 任务 / 环境 / MCP / 花费）+ KPI 卡片 +
 * 实时活动 / 最近环境双栏 + 快捷操作（快速运行 / 待审 / 刷新）。
 *
 * 面板契约（MIGRATION-GUIDE §5）：常驻挂载，visible prop 控制显隐，
 * 公开 refresh() 由 App 壳 bind:this 调用。
 *
 * 迁移说明：原文件顶部的 `renderSandboxChip()`（返回 lit TemplateResult）
 * 经全仓检索无任何调用方（死代码），且 .svelte 内无法保留 lit 模板函数，
 * 故未迁入；如需沙箱芯片请在 Svelte 侧以 snippet 重写。
 */
  import { onMount } from 'svelte';
  import { client } from './api';
  import type { ApprovalTicket, ServerState } from '@agent-harness/client';
  import { notifyError } from './utils/errors';
  import { APP_EVENTS } from './app-events';

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

  let { visible = true }: { visible?: boolean } = $props();

  let serverState = $state<ServerState | null>(null);
  let metrics = $state<Metrics | null>(null);
  let jobs = $state<JobsView | null>(null);
  let pending: ApprovalTicket[] = $state([]);
  let loading = $state(true);

  /** 根元素引用：ah-goto 事件从其派发（bubbles 穿透至 window，App 壳监听）。 */
  let rootEl: HTMLDivElement | undefined = $state();

  onMount(() => {
    void refresh();
  });

  export async function refresh() {
    // 隐藏态挂载（非当前 Tab）时不发起首屏请求；切到本 Tab 时由 app 壳的 activatePanel 补拉。
    if (!visible) return;
    loading = true;
    try {
      const [s, m, j, a] = await Promise.all([
        client.getState(),
        client.getMetrics() as Promise<Metrics>,
        client.getJobs() as Promise<JobsView>,
        client
          .listApprovals('pending')
          .catch(() => ({ tickets: [] as ApprovalTicket[] }))
      ]);
      serverState = s;
      metrics = m;
      jobs = j;
      pending = a.tickets;
    } catch (e: any) {
      notifyError(e, { title: '总览', key: 'dashboard' });
    } finally {
      loading = false;
    }
  }

  function goto(tab: string) {
    rootEl?.dispatchEvent(
      new CustomEvent(APP_EVENTS.goto, { detail: tab, bubbles: true, composed: true })
    );
  }

  let running = $derived(jobs?.queue.running ?? 0);
  let queued = $derived(jobs?.queue.queued ?? 0);
  let envCount = $derived(serverState?.envs.length ?? 0);
  let mcpCount = $derived(serverState?.mcpServers.length ?? 0);
  let cost = $derived(metrics ? `$${metrics.cost.toFixed(2)}` : '—');
  /** 沙箱已生效的 OS 原语名（hero 副标题展示）。 */
  let sandboxActive = $derived(
    serverState?.sandbox && serverState.sandbox.supported
      ? Object.entries(serverState.sandbox.active)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join('/')
      : ''
  );
</script>

<div class="ah-c dashboard-root" bind:this={rootEl} hidden={!visible}>
  {#if loading && !serverState}
    <section><p class="muted">加载总览…</p></section>
  {:else}
    <section style="border:none;background:none;box-shadow:none;padding:8px">
      <div class="hero">
        <h2>Agent Harness 控制台</h2>
        <div class="hero-sub">
          记忆后端 {metrics ? (metrics as any).memory?.backend ?? '—' : '—'} ·
          {#if serverState?.sandbox}
            沙箱 <b>{serverState.sandbox.backend}</b>{#if serverState.sandbox.supported}（{sandboxActive}）{:else} — {serverState.sandbox.reason}{/if}
          {:else}
            沙箱：硬化本地（无 OS 级隔离）
          {/if}
        </div>
        <div class="hero-stats">
          <div class="hero-stat">
            <div class="v">{fmtUptime(metrics?.uptimeMs ?? 0)}</div>
            <div class="k">运行时长</div>
          </div>
          <div class="hero-stat">
            <div class="v">{jobs?.queue.jobs ?? 0}</div>
            <div class="k">累计任务</div>
          </div>
          <div class="hero-stat">
            <div class="v accent">{running}</div>
            <div class="k">运行中</div>
          </div>
          <div class="hero-stat">
            <div class="v warn">{queued}</div>
            <div class="k">排队中</div>
          </div>
          <div class="hero-stat">
            <div class="v">{envCount}</div>
            <div class="k">环境数</div>
          </div>
        </div>
      </div>

      <div class="cards">
        <div class="kpi">
          <div class="v accent">{running}</div>
          <div class="k">运行任务</div>
        </div>
        <div class="kpi">
          <div class="v">{envCount}</div>
          <div class="k">就绪环境</div>
        </div>
        <div class="kpi">
          <div class="v">{mcpCount}</div>
          <div class="k">已接入 MCP</div>
        </div>
        <div class="kpi">
          <div class="v {pending.length ? 'warn' : 'ok'}">
            {pending.length}
          </div>
          <div class="k">待审工单</div>
        </div>
        <div class="kpi">
          <div class="v">{cost}</div>
          <div class="k">累计花费</div>
        </div>
      </div>

      <div class="two">
        <section>
          <div class="row-between">
            <div class="section-title">实时活动</div>
            <button class="link" onclick={() => goto('observability')}>
              查看队列 →
            </button>
          </div>
          <ul class="list">
            {#each (jobs?.jobs ?? []).slice(0, 6) as job}
              <li>
                <span class="meta">{job.id}</span>
                <span class="pill {job.status}">{job.status}</span>
                <span class="muted-sm">· {job.mode} · {fmtAge(job.enqueuedAt)}前</span>
              </li>
            {/each}
            {#if (jobs?.jobs ?? []).length === 0}
              <li class="muted">暂无任务</li>
            {/if}
          </ul>
        </section>

        <section>
          <div class="row-between">
            <div class="section-title">最近环境</div>
            <button class="link" onclick={() => goto('env')}>
              管理环境 →
            </button>
          </div>
          <ul class="list">
            {#each (serverState?.envs ?? []).slice(0, 4) as e}
              <li>
                <b>{e.envId}</b>
                <span class="pill {e.status}">{e.status}</span><br />
                <span class="muted-sm">{e.branch ?? '—'}{e.owner ? ' · ' + e.owner : ''}</span>
              </li>
            {/each}
            {#if (serverState?.envs ?? []).length === 0}
              <li class="muted">暂无环境</li>
            {/if}
          </ul>
        </section>
      </div>

      <div class="row">
        <button onclick={() => goto('run')}>快速运行</button>
        <button class="ghost" onclick={() => goto('approvals')}>
          待审 {pending.length} 项
        </button>
        <button class="ghost" onclick={() => void refresh()}>刷新</button>
      </div>
    </section>
  {/if}
</div>
