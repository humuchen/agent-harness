<script lang="ts">
  import { onMount } from 'svelte';
  import { authedFetch } from './api';
  import { notifyError } from './utils/errors';

  let { visible = true }: { visible?: boolean } = $props();

  /** 与 access/server/src/artifact-store.ts 的 ArtifactMeta 保持一致（本地副本，不跨层 import）。 */
  export interface ArtifactMeta {
    id: string;
    name: string;
    kind: string;
    mimeType: string;
    sizeBytes: number;
    owner: string;
    createdAt: string;
    runId?: string;
    note?: string;
  }

  let items: ArtifactMeta[] = $state([]);
  let loading = $state(true);

  onMount(() => {
    void refresh();
  });

  function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
  }

  export async function refresh(): Promise<void> {
    // 隐藏态挂载（非当前 Tab）时不发起首屏请求；切到本 Tab 时由 app 壳的 activatePanel 补拉。
    if (!visible) return;
    loading = true;
    try {
      const res = await authedFetch('/api/artifacts');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items: ArtifactMeta[] };
      items = data.items ?? [];
    } catch (e: any) {
      notifyError(e, { title: '工件库', key: 'artifacts' });
      items = [];
    } finally {
      loading = false;
    }
  }

  async function deleteArtifact(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/artifacts/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e: any) {
      notifyError(e, { title: '删除工件', key: 'artifacts-del' });
    }
  }
</script>

<div class="ah-c artifacts-root" hidden={!visible}>
  {#if loading}
    <div class="muted">加载中…</div>
  {:else}
    <section style="border:none;background:none;box-shadow:none;padding:8px">
      <div class="row-between" style="margin-bottom:14px">
        <div>
          <div class="section-title" style="margin:0">工件库</div>
          <div class="muted-sm">
            运行产物 / 导出文件 ·
            <span class="mono">{items.length}</span> 项
          </div>
        </div>
        <button class="ghost refresh-btn" onclick={() => refresh()}>
          刷新
        </button>
      </div>
      {#if items.length === 0}
        <div class="muted">
          暂无工件。运行任务产生的产物会显示在这里。
        </div>
      {:else}
        <div class="card" style="padding:0">
          <table class="lib-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>大小</th>
                <th>所有者</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {#each items as a (a.id)}
                <tr>
                  <td class="name">{a.name}</td>
                  <td><span class="badge artifact">{a.kind}</span></td>
                  <td class="mono">{humanSize(a.sizeBytes)}</td>
                  <td class="mono">{a.owner}</td>
                  <td class="mono">{a.createdAt}</td>
                  <td>
                    <div class="actions">
                      <a
                        class="dl"
                        href="/api/artifacts/{a.id}?download=1"
                        >下载</a
                      >
                      <button
                        class="danger"
                        onclick={() => void deleteArtifact(a.id)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .lib-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .lib-table thead th {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--ah-border);
    font-family: var(--ah-font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--ah-text-faint);
    white-space: nowrap;
  }
  .lib-table td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--ah-border);
    vertical-align: middle;
  }
  .lib-table tbody tr:hover td {
    background: var(--ah-surface-2);
  }
  .name {
    font-weight: 600;
  }
  .mono {
    font-family: var(--ah-font-mono);
    font-size: 12px;
    color: var(--ah-text-muted);
  }
  .badge {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
  }
  .badge.artifact {
    color: var(--ah-accent);
    border-color: var(--ah-accent);
  }
  .actions {
    display: flex;
    gap: 8px;
    white-space: nowrap;
  }
  .dl {
    color: var(--ah-accent);
    text-decoration: none;
    font-size: 13px;
  }
  .dl:hover {
    text-decoration: underline;
  }
  button.danger {
    background: var(--ah-danger-soft);
    color: var(--ah-danger);
    border-radius: var(--ah-radius-sm);
    padding: 4px 12px;
  }
</style>
