<script lang="ts" module>
  /**
   * 可观测（Observability）路由：指标卡 + 运行队列 + 会话 + RBAC 权限矩阵。Svelte 5 迁移版
   * 数据来自 getMetrics / getJobs / getSessions / getRoles（均为真实接口）。
   * RBAC 矩阵直接由服务端 /api/roles 的 permissions 动态生成，新增动作/角色自动同步。
   */
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { client } from './api';
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
    jobs: Array<{
      id: string;
      status: string;
      mode: string;
      enqueuedAt: number;
      startedAt: number | null;
      finishedAt: number | null;
    }>;
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

  let { visible = true }: { visible?: boolean } = $props();

  let metrics = $state<Metrics | null>(null);
  let jobs = $state<JobsView | null>(null);
  let sessions: { backend: string; sessions: string[] } | null = $state(null);
  let roles: RolesView | null = $state(null);
  let loading = $state(true);

  onMount(() => {
    void refresh();
  });

  export async function refresh() {
    // 隐藏态挂载（非当前 Tab）时不发起首屏请求；切到本 Tab 时由 app.ts 的 activatePanel 补拉。
    if (!visible) return;
    loading = true;
    try {
      const [m, j, se, r] = await Promise.all([
        client.getMetrics() as Promise<Metrics>,
        client.getJobs() as Promise<JobsView>,
        client.getSessions(),
        client.getRoles() as Promise<RolesView>
      ]);
      metrics = m;
      jobs = j;
      sessions = se;
      roles = r;
    } catch (e: any) {
      notifyError(e, { title: '可观测', key: 'observability' });
    } finally {
      loading = false;
    }
  }

  /**
   * 角色列（矩阵表头与单元格的数据来源）。
   * 优先使用接口返回的 `roles`；当它缺失 / 为空（如接口返回被截断、字段缺失）时，
   * 回退到从 `permissions` 的键推导 —— 因为权限数据才是角色集合的权威来源，
   * 这样即便 `roles` 字段不完整，凡拥有权限数据的角色都不会被漏列。
   */
  function roleColumns(): string[] {
    const r = roles;
    if (!r) return [];
    if (Array.isArray(r.roles) && r.roles.length > 0) return r.roles;
    if (r.permissions && typeof r.permissions === 'object')
      return Object.keys(r.permissions);
    return [];
  }

  /** 把所有角色的动作并集收集为矩阵行（按字母序）。对缺失 / 非数组字段做防御。 */
  function matrixRows(): { action: string; byRole: Record<string, boolean> }[] {
    const r = roles;
    if (!r || !r.permissions) return [];
    const cols = roleColumns();
    const actions = new Set<string>();
    for (const list of Object.values(r.permissions)) {
      // 接口可能返回 null / 非数组（字段缺失或数据不完整），需防御。
      if (Array.isArray(list)) list.forEach((a) => actions.add(a));
    }
    return [...actions].sort().map((action) => ({
      action,
      byRole: Object.fromEntries(
        cols.map((role) => [
          role,
          Array.isArray(r.permissions[role]) &&
            r.permissions[role].includes(action)
        ])
      )
    }));
  }

  const errCount = $derived(metrics?.counters?.errors ?? 0);
  const cost = $derived(metrics ? `$${metrics.cost.toFixed(2)}` : '—');
  const queueDepth = $derived(
    (metrics?.queue?.queued ?? jobs?.queue.queued ?? 0) +
      (metrics?.queue?.running ?? jobs?.queue.running ?? 0)
  );
  const rows = $derived(matrixRows());
  const roleCols = $derived(roleColumns());
</script>

<div class="ah-c observability-root" hidden={!visible}>
  {#if loading && !metrics}
    <section><p class="muted">加载可观测数据…</p></section>
  {:else}
    <section style="border:none;background:none;box-shadow:none;padding:8px">
      <div class="cards">
        <div class="kpi">
          <div class="v">{avgLatency(metrics)}ms</div>
          <div class="k">平均延迟</div>
        </div>
        <div class="kpi">
          <div class="v {errCount ? 'warn' : 'ok'}">{errCount}</div>
          <div class="k">错误数</div>
        </div>
        <div class="kpi">
          <div class="v">{cost}</div>
          <div class="k">累计花费</div>
        </div>
        <div class="kpi">
          <div class="v accent">{queueDepth}</div>
          <div class="k">队列深度</div>
        </div>
      </div>

      <div class="two">
        <div>
          <div class="section-title">
            运行队列
            {#if jobs?.jobs?.length}
              <span class="count">{jobs.jobs.length}</span>
            {/if}
          </div>
          <section>
            <div class="panel-scroll">
              <table class="matrix">
                <thead>
                  <tr>
                    <th>JOB</th>
                    <th>MODE</th>
                    <th>STATUS</th>
                    <th>AGE</th>
                  </tr>
                </thead>
                <tbody>
                  {#each jobs?.jobs ?? [] as job}
                    <tr>
                      <td class="act">{job.id}</td>
                      <td class="muted-sm">{job.mode}</td>
                      <td>
                        <span class="pill {job.status}">{job.status}</span>
                      </td>
                      <td class="meta">
                        {fmtAge(job.startedAt ?? job.enqueuedAt)}
                      </td>
                    </tr>
                  {/each}
                  {#if (jobs?.jobs ?? []).length === 0}
                    <tr>
                      <td colspan="4" class="muted">队列为空</td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div>
          <div class="section-title">
            记忆会话
            {#if sessions?.sessions?.length}
              <span class="count">{sessions.sessions.length}</span>
            {/if}
          </div>
          <section>
            <div class="kv">
              <div class="item">
                <span class="m">后端</span
                ><span>{sessions?.backend ?? '—'}</span>
              </div>
              <div class="item">
                <span class="m">会话数</span
                ><span>{sessions?.sessions.length ?? 0}</span>
              </div>
            </div>
            <div class="panel-scroll" style="margin-top:10px">
              <ul class="list">
                {#each sessions?.sessions ?? [] as k}
                  <li class="meta">{k}</li>
                {/each}
                {#if (sessions?.sessions ?? []).length === 0}
                  <li class="muted">暂无会话</li>
                {/if}
              </ul>
            </div>
          </section>
        </div>
      </div>

      <div class="section-title">角色与权限（RBAC）</div>
      <section>
        <div class="row-between" style="margin-bottom:10px">
          <span class="muted-sm">
            鉴权模式
            <span class="role-badge">{roles?.mode ?? '—'}</span> ·
            身份源
            <span class="role-badge">{roles?.provider ?? '—'}</span>
            {#if rows.length || roleCols.length}· <b class="accent-sm"
                >{rows.length}</b
              > 个动作 /
              <b class="accent-sm">{roleCols.length}</b> 个角色{/if}
          </span>
          <button class="ghost refresh-btn" onclick={() => void refresh()}>
            刷新
          </button>
        </div>
        {#if roles?.mode === 'off'}
          <div class="note" style="margin-bottom:10px">
            开放模式（未强制鉴权）：以下为<b>默认角色权限参考</b>，当前所有请求默认拥有完整权限。配置
            <code>UI_TOKENS</code> /
            <code>UI_ROLE_PERMISSIONS</code> 后此处将显示实际生效的矩阵。
          </div>
        {/if}
        <div class="matrix-scroll">
          <table class="matrix">
            <thead>
              <tr>
                <th class="sticky-col">ACTION</th>
                {#each roleCols as r}
                  <th style="text-align:center">{r.toUpperCase()}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each rows as row}
                <tr>
                  <td class="act sticky-col">{row.action}</td>
                  {#each roleCols as r}
                    <td class="center">
                      {#if row.byRole[r]}
                        <span class="check">✓</span>
                      {:else}
                        <span class="dash">—</span>
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/each}
              {#if rows.length === 0}
                <tr>
                  <td colspan={roleCols.length + 1} class="muted">
                    {#if roles && (roles.mode === 'off' || roleCols.length === 0)}
                      鉴权未启用（开放模式）：所有请求默认拥有完整权限（等效 admin）
                    {:else}
                      无权限数据
                    {/if}
                  </td>
                </tr>
              {/if}
            </tbody>
          </table>
        </div>
        {#if rows.length > 12}
          <div class="scroll-hint">
            ↓ 矩阵较长，可在上方区域内滚动查看全部 {rows.length} 个动作
          </div>
        {/if}
      </section>
    </section>
  {/if}
</div>
