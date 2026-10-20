<script lang="ts" module>
  /**
   * 沙箱控制台（ah-sandbox）。Svelte 5 迁移版
   *
   * 管理 Agent 可用的受控会话：创建 / 列举 / 销毁。
   * 数据来自后端 `browser-sandbox.ts`（会话管理器），通过
   * `GET /api/sandbox/sessions` 与 `POST|DELETE /api/sandbox/sessions[/<id>]` 交互。
   *
   * 注意：本组件不引入任何服务端内部类型，SandboxSession / SandboxStatus
   * 在本地定义，仅与后端保持一致的形状。
   *
   * 面板契约（MIGRATION-GUIDE §5）：常驻挂载，visible prop 控制显隐，
   * 公开 refresh() 由 App 壳 bind:this 调用。
   */

  /** 与 access/server/src/browser-sandbox.ts 的 SandboxStatus 保持一致。 */
  export type SandboxStatus = 'creating' | 'ready' | 'destroyed' | 'error';

  /** 与 access/server/src/browser-sandbox.ts 的 SandboxSession 保持一致。 */
  export interface SandboxSession {
    id: string;
    status: SandboxStatus;
    targetUrl?: string;
    createdAt: string;
    owner: string;
    logs: string[];
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { authedFetch } from './api';
  import { notifyError } from './utils/errors';

  interface SessionList {
    items: SandboxSession[];
  }

  let { visible = true }: { visible?: boolean } = $props();

  let items: SandboxSession[] = $state([]);
  let loading = $state(true);
  let targetUrl = $state('');
  let busy = $state(false);

  onMount(() => {
    void refresh();
  });

  export async function refresh(): Promise<void> {
    // 隐藏态挂载（非当前 Tab）时不发起首屏请求；切到本 Tab 时由 app.ts 的 activatePanel 补拉。
    if (!visible) return;
    loading = true;
    try {
      const res = await authedFetch('/api/sandbox/sessions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SessionList;
      items = data.items ?? [];
    } catch (e: any) {
      notifyError(e, { title: '沙箱', key: 'sandbox' });
      items = [];
    } finally {
      loading = false;
    }
  }

  async function createSession(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const url = targetUrl.trim() || undefined;
      const res = await authedFetch('/api/sandbox/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetUrl: url })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      targetUrl = '';
      await refresh();
    } catch (e: any) {
      notifyError(e, { title: '创建会话', key: 'sandbox-create' });
    } finally {
      busy = false;
    }
  }

  async function destroySession(id: string): Promise<void> {
    try {
      const res = await authedFetch(`/api/sandbox/sessions/${id}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e: any) {
      notifyError(e, { title: '销毁会话', key: 'sandbox-destroy' });
    }
  }

  function shortId(id: string): string {
    return id.slice(0, 8);
  }
</script>

<div class="ah-c sandbox-console-root" hidden={!visible}>
  {#if loading}
    <div class="muted">加载中…</div>
  {:else}
    <section style="border:none;background:none;box-shadow:none;padding:8px">
      <div class="row-between" style="margin-bottom:14px">
        <div>
          <div class="section-title" style="margin:0">沙箱</div>
          <div class="muted-sm">受控会话 · 创建 / 列举 / 销毁</div>
        </div>
        <button class="ghost refresh-btn" onclick={() => void refresh()}>
          刷新
        </button>
      </div>
      <div class="toolbar">
        <input
          class="url"
          type="text"
          placeholder="目标 URL（可留空 → about:blank）"
          value={targetUrl}
          oninput={(e: Event) =>
            (targetUrl = (e.target as HTMLInputElement).value)}
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === 'Enter') void createSession();
          }}
        />
        <button disabled={busy} onclick={() => void createSession()}>
          创建会话
        </button>
      </div>
      {#if items.length === 0}
        <div class="empty">暂无沙箱会话，输入目标 URL 后点击「创建会话」。</div>
      {:else}
        <ul class="sessions">
          {#each items as s}
            <li class="session">
              <span class="id" title={s.id}>{shortId(s.id)}</span>
              <span class="badge {s.status}">{s.status}</span>
              <span class="url" title={s.targetUrl ?? 'about:blank'}
                >{s.targetUrl ?? 'about:blank'}</span
              >
              <span class="meta">{new Date(s.createdAt).toLocaleString()}</span>
              <button class="destroy" onclick={() => void destroySession(s.id)}>
                销毁
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 14px;
  }
  input.url {
    flex: 1 1 280px;
    min-width: 200px;
    padding: 8px 10px;
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-sm);
    background: var(--ah-surface-2);
    color: var(--ah-text);
    font-family: var(--ah-font-mono);
    font-size: 13px;
  }
  button.primary {
    padding: 8px 16px;
    border: 1px solid var(--ah-accent);
    border-radius: var(--ah-radius-sm);
    background: var(--ah-accent);
    color: var(--ah-on-accent, #fff);
    cursor: pointer;
    font-weight: 600;
  }
  button.primary:disabled {
    opacity: 0.6;
    cursor: default;
  }
  ul.sessions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  li.session {
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-md);
    background: var(--ah-surface-1);
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .id {
    font-family: var(--ah-font-mono);
    font-size: 12px;
    color: var(--ah-text-muted);
  }
  .badge {
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 999px;
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .badge.ready {
    color: var(--ah-success, #2f9e44);
    border-color: var(--ah-success, #2f9e44);
  }
  .badge.creating {
    color: var(--ah-accent);
    border-color: var(--ah-accent);
  }
  .badge.error {
    color: var(--ah-danger, #e03131);
    border-color: var(--ah-danger, #e03131);
  }
  .badge.destroyed {
    color: var(--ah-text-muted);
  }
  .url {
    font-family: var(--ah-font-mono);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
  }
  .meta {
    color: var(--ah-text-muted);
    font-size: 12px;
    white-space: nowrap;
  }
  button.destroy {
    padding: 5px 12px;
    border: 1px solid var(--ah-danger, #e03131);
    border-radius: var(--ah-radius-sm);
    background: transparent;
    color: var(--ah-danger, #e03131);
    cursor: pointer;
    font-weight: 600;
  }
  button.destroy:hover {
    background: var(--ah-danger, #e03131);
    color: #fff;
  }
  .empty {
    border: 1px dashed var(--ah-border);
    border-radius: var(--ah-radius-md);
    padding: 28px;
    text-align: center;
    color: var(--ah-text-muted);
  }
</style>
