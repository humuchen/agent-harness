<script lang="ts">
  import { onMount } from 'svelte';
  import { authedFetch } from './api';
  import { notifyError } from './utils/errors';

  let { visible = true }: { visible?: boolean } = $props();

  interface AuditEvent {
    ts?: string;
    tenantId?: string | null;
    actor?: string;
    action: string;
    outcome: 'success' | 'failure' | 'denied' | 'info';
    target?: string;
    detail?: Record<string, unknown>;
  }
  interface AuditResult {
    count: number;
    total: number;
    events: AuditEvent[];
    summary: {
      byOutcome: Record<string, number>;
      topActions: Array<{ action: string; count: number }>;
      actors: number;
      window?: { from: string; to: string };
    };
    file: string | null;
    truncatedLines: number;
  }

  const PAGE = 50;

  function fmtTime(ts?: string): string {
    if (!ts) return '—';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  const OUTCOME_LABEL: Record<string, string> = {
    success: '成功',
    failure: '失败',
    denied: '拒绝',
    info: '信息'
  };

  let data: AuditResult | null = $state(null);
  let loading = $state(true);
  let offset = $state(0);
  let fActor = $state('');
  let fAction = $state('');
  let fOutcome = $state('');
  let fQ = $state('');

  let total = $derived(data?.total ?? 0);
  let denied = $derived(data?.summary.byOutcome.denied ?? 0);
  let failure = $derived(data?.summary.byOutcome.failure ?? 0);
  let actors = $derived(data?.summary.actors ?? 0);
  let canPrev = $derived(offset > 0);
  let canNext = $derived(offset + PAGE < total);

  onMount(() => {
    void refresh();
  });

  export async function refresh(): Promise<void> {
    // 隐藏态挂载（非当前 Tab）时不发起首屏请求；切到本 Tab 时由 app 壳的 activatePanel 补拉。
    if (!visible) return;
    loading = true;
    try {
      const qs = new URLSearchParams();
      qs.set('limit', String(PAGE));
      qs.set('offset', String(offset));
      if (fActor.trim()) qs.set('actor', fActor.trim());
      if (fAction.trim()) qs.set('action', fAction.trim());
      if (fOutcome) qs.set('outcome', fOutcome);
      if (fQ.trim()) qs.set('q', fQ.trim());
      const res = await authedFetch(`/api/audit?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = (await res.json()) as AuditResult;
    } catch (e: any) {
      notifyError(e, { title: '合规审计', key: 'audit' });
    } finally {
      loading = false;
    }
  }

  /** 过滤条件变更：回到第一页再查。 */
  function applyFilters(): void {
    offset = 0;
    void refresh();
  }

  function outcomeClass(o: string): string {
    if (o === 'denied' || o === 'failure') return 'warn';
    if (o === 'success') return 'ok';
    return '';
  }
</script>

<div class="ah-c audit-root" hidden={!visible}>
  <section style="border:none;background:none;box-shadow:none;padding:8px">
    <div class="row-between" style="margin-bottom:14px">
      <div>
        <div class="section-title" style="margin:0">合规审计</div>
        <div class="muted-sm">
          谁在何时做了什么 · 谁审批了谁 · 越权拦截记录
          {#if data?.file}
            · 源文件 <span class="mono">{data.file}</span>
          {/if}
        </div>
      </div>
      <button class="ghost refresh-btn" onclick={() => refresh()}>
        {loading ? '加载中…' : '刷新'}
      </button>
    </div>

    {#if data && !data.file}
      <div class="warn-banner">
        审计日志未落盘：未配置 <code>AUDIT_LOG</code>，或文件尚未产生。
        配置后此处将显示完整审计时间线（鉴权 / 审批 / 敏感动作 /
        配额拒绝）。
      </div>
    {/if}
    {#if data && data.truncatedLines > 0}
      <div class="warn-banner">
        审计文件较大，已忽略更早的 {data.truncatedLines}
        行（仅展示最新窗口）。
      </div>
    {/if}

    <div class="cards">
      <div class="kpi">
        <div class="v">{total}</div>
        <div class="k">命中事件</div>
      </div>
      <div class="kpi">
        <div class="v {denied ? 'warn' : 'ok'}">{denied}</div>
        <div class="k">越权/拒绝</div>
      </div>
      <div class="kpi">
        <div class="v {failure ? 'warn' : 'ok'}">{failure}</div>
        <div class="k">失败</div>
      </div>
      <div class="kpi">
        <div class="v accent">{actors}</div>
        <div class="k">参与主体</div>
      </div>
    </div>

    <div class="filter-bar">
      <input
        placeholder="主体（actor）"
        value={fActor}
        oninput={(e: Event) => (fActor = (e.target as HTMLInputElement).value)}
        onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && applyFilters()}
      />
      <input
        placeholder="动作（如 agent.run）"
        value={fAction}
        oninput={(e: Event) => (fAction = (e.target as HTMLInputElement).value)}
        onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && applyFilters()}
      />
      <select
        onchange={(e: Event) =>
          (fOutcome = (e.target as HTMLSelectElement).value)}
      >
        <option value="">全部结果</option>
        <option value="success">成功</option>
        <option value="failure">失败</option>
        <option value="denied">拒绝</option>
        <option value="info">信息</option>
      </select>
      <input
        class="grow"
        placeholder="自由文本（动作 / 主体 / 目标 / 详情）"
        value={fQ}
        oninput={(e: Event) => (fQ = (e.target as HTMLInputElement).value)}
        onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && applyFilters()}
      />
      <button class="ghost" onclick={() => applyFilters()}>
        查询
      </button>
      <button
        class="ghost"
        onclick={() => {
          fActor = '';
          fAction = '';
          fOutcome = '';
          fQ = '';
          applyFilters();
        }}
      >
        重置
      </button>
    </div>

    <section>
      <div class="panel-scroll">
        <table class="matrix">
          <thead>
            <tr>
              <th>时间</th>
              <th>主体</th>
              <th>动作</th>
              <th>结果</th>
              <th>目标</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {#each data?.events ?? [] as e}
              <tr>
                <td class="meta">{fmtTime(e.ts)}</td>
                <td class="act">{e.actor ?? '—'}</td>
                <td class="mono">{e.action}</td>
                <td>
                  <span class="pill {outcomeClass(e.outcome)}">
                    {OUTCOME_LABEL[e.outcome] ?? e.outcome}
                  </span>
                </td>
                <td class="meta">{e.target ?? '—'}</td>
                <td
                  class="meta mono"
                  style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                >
                  {e.detail ? JSON.stringify(e.detail) : '—'}
                </td>
              </tr>
            {/each}
            {#if (data?.events ?? []).length === 0}
              <tr>
                <td colspan="6" class="muted">
                  {loading ? '加载中…' : '无匹配审计记录'}
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
      <div class="pager">
        <span
          >共 {total} 条 · 第 {Math.floor(offset / PAGE) + 1}
          页</span
        >
        <button
          class="ghost"
          disabled={!canPrev}
          onclick={() => {
            offset = Math.max(0, offset - PAGE);
            void refresh();
          }}
        >
          上一页
        </button>
        <button
          class="ghost"
          disabled={!canNext}
          onclick={() => {
            offset += PAGE;
            void refresh();
          }}
        >
          下一页
        </button>
      </div>
    </section>
  </section>
</div>

<style>
  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;
  }
  .filter-bar input,
  .filter-bar select {
    padding: 6px 10px;
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-sm);
    background: transparent;
    color: var(--ah-text);
    font: inherit;
    font-size: 13px;
    min-width: 120px;
  }
  .filter-bar input.grow {
    flex: 1;
    min-width: 180px;
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 12px;
    font-size: 13px;
    color: var(--ah-text-muted);
  }
  .mono {
    font-family: var(--ah-font-mono);
    font-size: 12px;
  }
  .warn-banner {
    border: 1px solid var(--ah-warning);
    background: var(--ah-warning-soft);
    color: var(--ah-text);
    border-radius: var(--ah-radius-md);
    padding: 10px 12px;
    font-size: 13px;
    margin-bottom: 12px;
  }
</style>
