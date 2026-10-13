<script lang="ts">
  import { client } from './api';
  import type { EnvAction, StreamEvent } from '@agent-harness/client';
  import { EventRow, reportError } from './panels-utils';
  import { APP_EVENTS } from './app-events';

  let { visible = true }: { visible?: boolean } = $props();

  let action: EnvAction = $state('create');
  let branch = $state('main');
  let ttl = $state('8');
  let region = $state('');
  let owner = $state('');
  let envId = $state('');
  let events: StreamEvent[] = $state([]);
  let running = $state(false);

  let rootEl: HTMLElement;

  async function submit() {
    events = [];
    running = true;
    try {
      for await (const ev of client.streamEnv({
        action: action,
        branch: branch || undefined,
        ttl_hours: ttl ? Number(ttl) : undefined,
        region: region || undefined,
        owner: owner || undefined,
        env_id: envId || undefined
      })) {
        events = [...events, ev];
      }
      rootEl.dispatchEvent(
        new CustomEvent(APP_EVENTS.refresh, { bubbles: true, composed: true })
      );
    } catch (e) {
      reportError('env', e);
    } finally {
      running = false;
    }
  }
</script>

<div class="ah-c env-root" bind:this={rootEl} hidden={!visible}>
  <section>
    <h2>临时 / 预览环境</h2>
    <div class="row">
      <label>
        动作
        <select
          onchange={(e: Event) =>
            (action = (e.target as HTMLSelectElement).value as EnvAction)}
        >
          <option value="create">创建</option>
          <option value="destroy">销毁</option>
        </select>
      </label>
      <label>分支<input
        value={branch}
        disabled={action !== 'create'}
        oninput={(e: Event) => (branch = (e.target as HTMLInputElement).value)}
      /></label>
      <label>TTL(小时)<input
        value={ttl}
        disabled={action !== 'create'}
        oninput={(e: Event) => (ttl = (e.target as HTMLInputElement).value)}
      /></label>
      <label>区域<input
        value={region}
        disabled={action !== 'create'}
        oninput={(e: Event) => (region = (e.target as HTMLInputElement).value)}
      /></label>
      <label>拥有者<input
        value={owner}
        disabled={action !== 'create'}
        oninput={(e: Event) => (owner = (e.target as HTMLInputElement).value)}
      /></label>
      <label>env_id(销毁时填)<input
        value={envId}
        disabled={action === 'create'}
        oninput={(e: Event) => (envId = (e.target as HTMLInputElement).value)}
      /></label>
    </div>
    <div class="row">
      <button disabled={running} onclick={submit}>
        {running ? '处理中…' : action === 'create' ? '创建环境' : '销毁环境'}
      </button>
    </div>
    <div class="stream">
      {#each events as ev}{@html EventRow(ev)}{/each}
    </div>
  </section>
</div>
