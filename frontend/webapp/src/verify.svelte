<script lang="ts">
  import { client } from './api';
  import type { StreamEvent } from '@agent-harness/client';
  import { EventRow, reportError } from './panels-utils';

  let { visible = true }: { visible?: boolean } = $props();

  let events: StreamEvent[] = $state([]);
  let running = $state(false);
  let abort: AbortController | undefined;

  async function run() {
    events = [];
    running = true;
    const ac = new AbortController();
    abort = ac;
    try {
      for await (const ev of client.streamVerify({ signal: ac.signal })) {
        events = [...events, ev];
      }
    } catch (e) {
      reportError('verify', e);
    } finally {
      running = false;
    }
  }
</script>

<div class="ah-c verify-root" hidden={!visible}>
  <section>
    <h2>自检 / 验证</h2>
    <p class="muted">
      对服务端能力做三组断言（MCP 连接 / 护栏 / 环境流水线时序）。
    </p>
    <div class="row">
      <button disabled={running} onclick={run}>
        {running ? '验证中…' : '运行验证'}
      </button>
      <button
        disabled={!running}
        onclick={() => abort?.abort()}
      >
        停止
      </button>
    </div>
    <div class="stream">
      {#each events as ev}{@html EventRow(ev)}{/each}
    </div>
  </section>
</div>
