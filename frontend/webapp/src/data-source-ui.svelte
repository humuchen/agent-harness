<script lang="ts" module>
  /**
   * 数据源管理（ah-datasources，P1-x）。Svelte 5 迁移版
   *
   * 展示已注册数据源（来自 `GET /api/datasources`，后端 data-source.ts），
   * 提供「测试连接」按钮探测每个数据源连通性并展示结果
   * （ok 徽标 + 消息 + 延迟）。数据定义类型在本地声明，webapp 不导入服务端内部。
   *
   * 面板契约（MIGRATION-GUIDE §5）：常驻挂载，visible prop 控制显隐，
   * 公开 refresh() 由 App 壳 bind:this 调用。
   */

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
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { authedFetch } from './api';
  import { notifyError } from './utils/errors';

  let { visible = true }: { visible?: boolean } = $props();

  let items: DataSourceDef[] = $state([]);
  let loading = $state(true);
  let testing = $state(new Set<string>());
  let results = $state(new Map<string, ConnectionResult>());

  onMount(() => {
    void refresh();
  });

  export async function refresh(): Promise<void> {
    // 隐藏态挂载（非当前 Tab）时不发起首屏请求；切到本 Tab 时由 app.ts 的 activatePanel 补拉。
    if (!visible) return;
    loading = true;
    try {
      const res = await authedFetch('/api/datasources');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: DataSourceDef[] };
      items = data.items ?? [];
    } catch (e: any) {
      notifyError(e, { title: '数据源', key: 'datasources' });
    } finally {
      loading = false;
    }
  }

  async function testConnection(id: string): Promise<void> {
    const s = new Set(testing);
    s.add(id);
    testing = s;
    try {
      const res = await authedFetch(
        `/api/datasources/${encodeURIComponent(id)}/test`,
        {
          method: 'POST'
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as ConnectionResult;
      const next = new Map(results);
      next.set(id, result);
      results = next;
    } catch (e: any) {
      const next = new Map(results);
      next.set(id, { ok: false, message: String(e?.message ?? e) });
      results = next;
    } finally {
      const s2 = new Set(testing);
      s2.delete(id);
      testing = s2;
    }
  }
</script>

<div class="ah-c data-source-ui-root" hidden={!visible}>
  {#if loading}
    <div class="muted">加载中…</div>
  {:else if items.length === 0}
    <div class="muted">暂无数据源</div>
  {:else}
    <section style="border:none;background:none;box-shadow:none;padding:8px">
      <div class="row-between" style="margin-bottom:14px">
        <div>
          <div class="section-title" style="margin:0">数据源</div>
          <div class="muted-sm">已注册 {items.length} 个数据源</div>
        </div>
        <button class="ghost" onclick={() => void refresh()}>刷新</button>
      </div>
      <div class="ds-list">
        {#each items as ds}
          {@const isTesting = testing.has(ds.id)}
          {@const result = results.get(ds.id)}
          <div class="ds-item">
            <span class="ds-name">{ds.name}</span>
            <span class="badge {ds.type}">{ds.type}</span>
            <span class="ds-id">{ds.id}</span>
            <span class="spacer"></span>
            <button
              class="ghost"
              disabled={isTesting}
              onclick={() => void testConnection(ds.id)}
            >
              {isTesting ? '测试中…' : '测试连接'}
            </button>
            {#if result}
              <div class="test-result">
                <span class="pill {result.ok ? 'ok' : 'err'}">
                  {result.ok ? '已连通' : '失败'}
                </span>
                <span class="msg">{result.message}</span>
                {#if result.latencyMs != null}
                  <span class="latency">· {result.latencyMs}ms</span>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
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
</style>
