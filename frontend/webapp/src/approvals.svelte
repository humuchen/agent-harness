<script lang="ts">
  import { onMount } from 'svelte';
  import { client } from './api';
  import type { ApprovalTicket } from '@agent-harness/client';
  import { reportError } from './panels-utils';
  import { notify } from './components/ah-notification';

  let { visible = true }: { visible?: boolean } = $props();

  let items: ApprovalTicket[] = $state([]);

  onMount(() => {
    void refresh();
  });

  export async function refresh(): Promise<void> {
    // 隐藏态挂载（非当前 Tab）时不发起首屏请求；切到本 Tab 时由 app.ts 的 activatePanel 补拉。
    if (!visible) return;
    try {
      items = (await client.listApprovals()).tickets;
    } catch (e) {
      reportError('approvals', e);
    }
  }

  async function decide(id: string, decision: 'approve' | 'reject'): Promise<void> {
    try {
      await client.decideApproval(id, decision);
      await refresh();
      notify.success(decision === 'approve' ? '工单已通过' : '工单已拒绝');
    } catch (e) {
      reportError('approvals', e);
    }
  }
</script>

<div class="ah-c approvals-root" hidden={!visible}>
  <section>
    <h2>审批工单</h2>
    <div class="row">
      <button class="ghost" onclick={() => refresh()}>刷新</button>
    </div>
    <ul class="list">
      {#if items.length === 0}
        <li class="muted">暂无工单</li>
      {:else}
        {#each items as a}
          <li>
            <b>{a.id}</b> · {a.action} · {a.status}<br />
            <span class="muted"
              >decision:
              {a.decision ?? '-'}{a.note ? ' / ' + a.note : ''}</span
            ><br />
            <button
              disabled={a.status !== 'pending'}
              onclick={() => decide(a.id, 'approve')}
            >
              通过
            </button>
            <button
              disabled={a.status !== 'pending'}
              onclick={() => decide(a.id, 'reject')}
            >
              拒绝
            </button>
          </li>
        {/each}
      {/if}
    </ul>
  </section>
</div>
