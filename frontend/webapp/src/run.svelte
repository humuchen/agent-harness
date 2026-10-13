<script lang="ts">
  import { onMount } from 'svelte';
  import { client } from './api';
  import { ApprovalRequiredError } from '@agent-harness/client';
  import type { RunMode, StreamEvent } from '@agent-harness/client';

  /** 从索引签名事件里安全取对象字段（unknown → Record | undefined）。 */
  function asObj(v: unknown): Record<string, unknown> | undefined {
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  }
  import { toRichHtml, escapeHtml } from './utils/markdown';
  import {
    agentContext,
    type UploadedFile
  } from './agent-context';
  import { SessionStateMachine } from './utils/session-state';
  import { notifyError } from './utils/errors';
  import { notify } from './components/ah-notification';
  import './components/suggestions';
  import './components/file-upload';
  import { APP_EVENTS } from './app-events';

  let { visible = true }: { visible?: boolean } = $props();

  /* ------------------------------ 类型 ------------------------------ */

  interface Phase {
    key: string;
    label: string;
    sub?: string;
    status: 'pending' | 'active' | 'done';
  }

  type BlockKind =
    | 'user'
    | 'think'
    | 'tool'
    | 'tool-result'
    | 'warn'
    | 'error'
    | 'answer';

  interface TraceBlock {
    id: number;
    kind: BlockKind;
    text: string;
    detail?: string;
    step?: number;
  }

  const PHASES: Phase[] = [
    { key: 'understand', label: '理解', sub: '解析任务意图', status: 'pending' },
    { key: 'plan', label: '规划', sub: '拟定执行步骤', status: 'pending' },
    { key: 'tool', label: '调用工具', sub: '执行外部动作', status: 'pending' },
    { key: 'reason', label: '推理', sub: '模型思考与决策', status: 'pending' },
    { key: 'summarize', label: '总结', sub: '整合最终结果', status: 'pending' }
  ];

  const TAG_LABEL: Record<BlockKind, string> = {
    user: '任务',
    think: '思考',
    tool: '工具',
    'tool-result': '结果',
    warn: '护栏',
    error: '错误',
    answer: '回答'
  };

  /** 快捷建议（点击即填入输入框，覆盖新增内置工具的使用场景）。 */
  const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
    { label: '查天气', prompt: '帮我查一下上海的天气，未来 3 天' },
    {
      label: '数据分析',
      prompt:
        '把下面这段 CSV 解析出来，并按 amount 汇总：\nname,amount\nAlice,10\nBob,20\nAlice,15'
    },
    { label: '计算', prompt: '计算 pow(2,10) + sqrt(16) - 3.5' },
    { label: '时间', prompt: '现在几点了？' }
  ];

  /* ------------------------------ 状态 ------------------------------ */

  let mode: RunMode = $state('mock');
  let prompt = $state('列出当前目录的 .ts 文件');
  let model = $state('');
  let maxSteps = $state('');
  let sessionId = $state('');
  /** 服务端分配的会话 key（连续追问用）。为空表示尚未建立会话，下次运行由服务端生成。 */
  let conversationId = $state('');
  let reconnect = $state('');
  let showAdvanced = $state(false);

  let running = $state(false);
  let finished = $state(false);
  let error: string | null = $state(null);
  let ticket: string | null = $state(null);

  let view: 'thinking' | 'result' | 'all' = $state('all');
  let phases: Phase[] = $state(PHASES.map((p) => ({ ...p })));
  let trace: TraceBlock[] = $state([]);
  let final = $state('');
  let jobId: string | null = $state(null);
  let toolsCount = $state(0);
  let steps = $state(0);
  let cost = $state(0);

  let nextId = 1;
  let abort: AbortController | undefined;
  /** 会话状态机：把 running/finished 从散落的布尔收敛为受控迁移。 */
  let session = new SessionStateMachine();
  /** 附件（来自 <ah-file-upload>，同时写入 agentContext 供各面板共享）。 */
  let attachments: UploadedFile[] = $state([]);

  /** 根元素引用：APP_EVENTS.refresh 事件从其派发（原 this.dispatchEvent，bubbles+composed）。 */
  let rootEl: HTMLElement;

  let showThinking = $derived(view === 'thinking' || view === 'all');
  let showResult = $derived(view === 'result' || view === 'all');

  /* ----------------------- 事件 → 阶段 / 轨迹 映射 ----------------------- */

  function markActive(idx: number) {
    phases = phases.map((p, i) => {
      if (i === idx) return { ...p, status: 'active' };
      if (i < idx && p.status === 'pending') return { ...p, status: 'done' };
      return p;
    });
  }

  function markDone(idx: number) {
    phases = phases.map((p, i) =>
      i === idx ? { ...p, status: 'done' } : p
    );
  }

  function allDone() {
    phases = phases.map((p) => ({ ...p, status: 'done' }));
  }

  function push(block: Omit<TraceBlock, 'id'>) {
    trace = [...trace, { id: nextId++, ...block }];
  }

  function ingest(ev: StreamEvent) {
    switch (ev.type) {
      case 'job:accepted':
        jobId = ev.jobId == null ? jobId : String(ev.jobId);
        // 服务端分配的会话 key：后续追问原样带回，即可复用同一 Memory 窗口续上对话。
        if (ev.sessionKey != null) conversationId = String(ev.sessionKey);
        break;
      case 'run:start':
        markActive(0);
        push({
          kind: 'user',
          text: String(ev.input ?? prompt)
        });
        break;
      case 'run:tools':
        toolsCount = (ev.tools as unknown[] | undefined)?.length ?? toolsCount;
        break;
      case 'step:start':
        markActive(1);
        break;
      case 'llm:call':
        markDone(1);
        markActive(3);
        break;
      case 'llm:response': {
        markActive(3);
        const content = ev.content;
        if (content)
          push({
            kind: 'think',
            text: String(content),
            step: ev.step == null ? undefined : Number(ev.step)
          });
        break;
      }
      case 'tool:start':
        markActive(2);
        push({
          kind: 'tool',
          text: `调用工具：${String(asObj(ev.call)?.name ?? 'unknown')}`,
          step: ev.step == null ? undefined : Number(ev.step),
          detail: safeJson(asObj(ev.call)?.arguments)
        });
        break;
      case 'tool:result':
        markDone(2);
        push({
          kind: 'tool-result',
          text: `${String(asObj(ev.call)?.name ?? 'unknown')} → ${
            ev.errored ? '失败' : '完成'
          }`,
          step: ev.step == null ? undefined : Number(ev.step),
          detail: safeJson(ev.result)
        });
        break;
      case 'guardrail:blocked':
        // 护栏拦截的内部原因属诊断信息，仅记入调用链路（trace detail / 服务端日志），
        // 不在运行面板直接展示；这里只给一条中性合规提示。
        push({
          kind: 'warn',
          text:
            ev.phase === 'input'
              ? '输入触发内容安全策略，本轮未发送'
              : '回复触发内容安全策略，已按合规要求调整'
        });
        break;
      case 'run:cost':
        cost = typeof ev.cumulativeCost === 'number' ? ev.cumulativeCost : cost;
        break;
      case 'run:end':
        markDone(3);
        markDone(4);
        allDone();
        final = String(ev.final ?? '');
        steps = typeof ev.steps === 'number' ? ev.steps : steps;
        // 会话状态机推进到 finished（订阅回调会把 running/finished 同步到位）。
        if (session.can('finish')) session.finish();
        // 把本轮最终回答作为一条「回答」块追加进对话轨迹，使多轮聊天记录连续可读。
        if (final) push({ kind: 'answer', text: final });
        break;
      case 'error':
        push({ kind: 'error', text: String(ev.message ?? ev) });
        break;
      case 'env:status':
      case '_env_done':
        rootEl.dispatchEvent(
          new CustomEvent(APP_EVENTS.refresh, { bubbles: true, composed: true })
        );
        break;
      default:
        // 未知事件类型：以原始 JSON 兜底展示，保证不丢信息
        push({ kind: 'think', text: safeJson(ev) });
        break;
    }
  }

  /* ----------------------- 运行 / 停止 / 新会话 ----------------------- */

  /**
   * 启动/继续一次运行。连续对话模式下**不清空** trace 与 nextId，
   * 而是把本轮的 user/answer 块追加到既有对话轨迹之后，实现连续追问。
   * 全量重置（清空对话、开新会话）由 newConversation() 负责。
   */
  async function run() {
    error = null;
    ticket = null;
    final = '';
    jobId = null;
    toolsCount = 0;
    steps = 0;
    cost = 0;
    // 注意：不重置 trace / nextId / conversationId —— 保留跨轮对话。
    phases = PHASES.map((p) => ({ ...p }));
    // 由会话状态机统一驱动 running/finished（非法的重复 start 由 can() 挡住）。
    if (session.can('start')) session.transition('start');

    // 连续对话：若尚未建立会话，由客户端生成唯一会话 key 并稳定携带，
    // 服务端据此复用同一 Memory 缓存窗口。持久化到 localStorage 以便刷新后续接。
    if (!conversationId) {
      conversationId = `sid_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      try {
        localStorage.setItem('ah_conversation_id', conversationId);
      } catch {
        /* 隐私模式等场景忽略 */
      }
    }

    const ac = new AbortController();
    abort = ac;
    try {
      for await (const ev of client.streamRun(
        {
          mode: mode,
          prompt: prompt,
          model: model || undefined,
          maxSteps: maxSteps ? Number(maxSteps) : undefined,
          // 优先用客户端生成的会话 key（连续追问复用同一 Memory 窗口）；
          // 高级选项里手动填写的 sessionId 作为可选的显式会话隔离覆盖。
          sessionId: conversationId || sessionId || undefined,
          jobId: reconnect || undefined
        },
        { signal: ac.signal }
      )) {
        ingest(ev);
      }
    } catch (e) {
      if (e instanceof ApprovalRequiredError) {
        ticket = `需要审批：ticket ${e.ticketId}（在「审批」页裁决后重投）`;
        notify.warning(ticket, { title: '需要审批', key: 'run-approval' });
        if (session.can('approve')) session.requestApproval();
      } else {
        error = String(e instanceof Error ? e.message : e);
        // 运行失败统一走通知组件（用户主动点「停止」属 AbortError，内部会静默跳过）。
        notifyError(e, { title: '运行失败', key: 'run' });
        // 被 stop() 中止后状态已为 aborted，不再覆盖为 error。
        if (session.can('error')) session.fail();
      }
    } finally {
      // 兜底：正常路径已在 run:end 里 finish()，这里保证任何异常路径也能收敛。
      if (session.active) session.finish();
    }
  }

  /** 开新会话：清空全部状态并丢弃会话 key，下次运行由服务端分配全新会话。 */
  function newConversation() {
    abort?.abort();
    trace = [];
    nextId = 1;
    final = '';
    error = null;
    ticket = null;
    jobId = null;
    conversationId = '';
    try {
      localStorage.removeItem('ah_conversation_id');
    } catch {
      /* 忽略 */
    }
    reconnect = '';
    toolsCount = 0;
    steps = 0;
    cost = 0;
    phases = PHASES.map((p) => ({ ...p }));
    session.reset();
    finished = false;
    running = false;
  }

  /** 组件挂载时尝试恢复上次会话 key（服务器若配了持久化后端则可继续历史对话）。 */
  onMount(() => {
    try {
      const saved = localStorage.getItem('ah_conversation_id');
      if (saved) conversationId = saved;
    } catch {
      /* 忽略 */
    }
    // 会话状态机 → UI 布尔态单向同步；后续只改状态机，不再手动改 running/finished。
    const unsubscribe = session.subscribe((p) => {
      running = p === 'running' || p === 'awaiting_approval';
      finished = p === 'finished' || p === 'error' || p === 'aborted';
      // 全局运行中指示器：有任一面板在运行时亮起，全部结束后熄灭。
      window.dispatchEvent(
        new Event(running ? APP_EVENTS.runStart : APP_EVENTS.runStop)
      );
    });
    return unsubscribe;
  });

  function stop() {
    if (session.can('abort')) session.abort();
    abort?.abort();
  }

  /* ----------------------- 复制 / 导出 ----------------------- */

  async function copyFinal() {
    try {
      await navigator.clipboard.writeText(final || '（暂无结果）');
      notify.success('已复制最终结果');
    } catch {
      notify.error('复制失败：浏览器拒绝了剪贴板权限');
    }
  }

  function exportRun() {
    const blocks = trace
      .map(
        (b) =>
          `<div class="tb"><span class="tb-tag">${escapeHtml(
            TAG_LABEL[b.kind]
          )}</span>${toRichHtml(b.text)}</div>`
      )
      .join('\n');
    const htmlDoc = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent 运行结果</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 860px; margin: 28px auto; padding: 0 18px; line-height: 1.7; color: #1d1d1f; }
  h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 28px; border-bottom: 1px solid #e5e5ea; padding-bottom: 6px; }
  pre { background: #f5f5f7; padding: 12px 14px; border-radius: 10px; overflow: auto; }
  code { background: #f0f0f2; padding: 1px 5px; border-radius: 5px; font-size: 0.92em; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #2997ff; margin: 12px 0; padding: 4px 14px; color: #555; background: #f7faff; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; } th, td { border: 1px solid #d2d2d7; padding: 6px 10px; text-align: left; } th { background: #f5f5f7; }
  .tb { margin: 8px 0; padding: 8px 12px; border-left: 3px solid #2997ff; background: #fafafa; border-radius: 6px; }
  .tb-tag { font-size: 12px; color: #2997ff; font-weight: 600; margin-right: 8px; }
  .meta { color: #86868b; font-size: 13px; border-top: 1px solid #e5e5ea; margin-top: 20px; padding-top: 10px; }
  a { color: #2997ff; }
</style>
</head>
<body>
  <h1>Agent 运行结果</h1>
  <h2>任务</h2>
  <p>${escapeHtml(prompt)}</p>
  <h2>思考轨迹</h2>
  ${blocks}
  <h2>最终结果</h2>
  ${toRichHtml(final)}
  <div class="meta">jobId: ${escapeHtml(String(jobId ?? '-'))} · 步数: ${
      steps
    } · 花费: $${cost.toFixed(4)} · 工具: ${toolsCount}</div>
</body>
</html>`;
    const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-run-${jobId ?? Date.now()}.html`;
    a.click();
    URL.revokeObjectURL(url);
    notify.success('已导出运行记录（HTML）');
  }

  /** 把任意值安全转成单行/多行 JSON 预览，失败则原样字符串化。 */
  function safeJson(v: unknown): string {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v.length > 600 ? v.slice(0, 600) + '…' : v;
    try {
      const s = JSON.stringify(v, null, 2);
      return s.length > 600 ? s.slice(0, 600) + '…' : s;
    } catch {
      return String(v);
    }
  }
</script>

<div class="ah-c run-root" bind:this={rootEl} hidden={!visible}>
  <section style="border:none;background:none;box-shadow:none;padding:8px">
    <div class="run-head">
      <h2 class="run-title">运行时</h2>
      <div class="run-head-right">
        <div class="seg">
          <button
            class={view === 'thinking' ? 'active' : ''}
            onclick={() => (view = 'thinking')}
          >
            思考
          </button>
          <button
            class={view === 'result' ? 'active' : ''}
            onclick={() => (view = 'result')}
          >
            结果
          </button>
          <button
            class={view === 'all' ? 'active' : ''}
            onclick={() => (view = 'all')}
          >
            全览
          </button>
        </div>
        {#if conversationId}
          <span class="pill session" title={conversationId}
            >会话 {conversationId.slice(0, 12)}</span
          >
        {/if}
        {#if running}
          <span class="pill running">运行中</span
          ><button class="ghost" onclick={() => stop()}>
            停止
          </button>
        {:else if finished}
          <span class="pill done">已完成</span
          ><button class="ghost" onclick={() => newConversation()}>
            新会话
          </button>
        {:else}
          <span class="pill">空闲</span>
        {/if}
      </div>
    </div>

    <div class="run-task card">
      <label class="block">
        任务提示词
        <textarea
          rows="3"
          value={prompt}
          disabled={running}
          oninput={(e: Event) =>
            (prompt = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
      </label>
      <ah-suggestions
        items={SUGGESTIONS}
        disabled={running}
        onsuggestion-picked={(e: Event) => {
          prompt = (e as CustomEvent<string>).detail;
        }}
      ></ah-suggestions>
      <ah-file-upload
        files={attachments}
        max-files="3"
        max-size-mb="5"
        accept=".txt,.md,.csv,.json,.log"
        disabled={running}
        onfiles-changed={(e: Event) => {
          attachments = (e as CustomEvent<UploadedFile[]>).detail;
          agentContext.set('files', attachments);
        }}
        onerror={(e: Event) =>
          notify.warning((e as CustomEvent<string>).detail, {
            title: '附件',
            key: 'run-upload'
          })}
      ></ah-file-upload>
      <div class="row">
        <button disabled={running} onclick={() => run()}>
          {running ? '运行中…' : '运行 Agent'}
        </button>
        <button
          class="ghost"
          onclick={() => (showAdvanced = !showAdvanced)}
        >
          {showAdvanced ? '收起高级' : '高级选项'}
        </button>
        {#if conversationId}
          <span class="muted"
            >已建立会话，再次运行即为「连续追问」</span
          >
        {/if}
      </div>
      {#if showAdvanced}
        <div class="run-advanced">
          <label
            >模式
            <select
              disabled={running}
              onchange={(e: Event) =>
                (mode = (e.target as HTMLSelectElement)
                  .value as RunMode)}
            >
              <option value="mock" selected={mode === 'mock'}>
                mock（离线）
              </option>
              <option value="real" selected={mode === 'real'}>
                real（真实 LLM）
              </option>
              <option
                value="real-mcp"
                selected={mode === 'real-mcp'}
              >
                real-mcp
              </option>
            </select>
          </label>
          <label
            >模型<input
              value={model}
              disabled={running}
              oninput={(e: Event) =>
                (model = (e.target as HTMLInputElement).value)}
              placeholder="留空用服务端默认"
          /></label>
          <label
            >最大步数<input
              value={maxSteps}
              disabled={running}
              oninput={(e: Event) =>
                (maxSteps = (e.target as HTMLInputElement).value)}
              placeholder="留空用默认 24"
          /></label>
          <label
            >会话 ID<input
              value={sessionId}
              disabled={running}
              oninput={(e: Event) =>
                (sessionId = (e.target as HTMLInputElement).value)}
              placeholder="多租户隔离 key"
          /></label>
          <label
            >重连 jobId<input
              value={reconnect}
              disabled={running}
              oninput={(e: Event) =>
                (reconnect = (e.target as HTMLInputElement).value)}
              placeholder="断线重连用，可留空"
          /></label>
        </div>
      {/if}
    </div>

    {#if ticket}<div class="warn">{ticket}</div>{/if}

    <div class="run-two">
      {#if showThinking}
        <div class="card">
          <div class="run-col-title"><h3>思考 Trace</h3></div>
          <div class="phase-list">
            {#each phases as p}
              <div class="phase {p.status}">
                <span class="dot"
                  >{p.status === 'done'
                    ? '✓'
                    : p.status === 'active'
                    ? '◌'
                    : ''}</span
                >
                <span class="label">{p.label}</span>
                {#if p.sub}<span class="sub">· {p.sub}</span>{/if}
              </div>
            {/each}
          </div>
          <div class="trace">
            {#each trace as b (b.id)}
              <div class="trace-block {b.kind}">
                <div class="tb-head">
                  <span class="tb-tag">{TAG_LABEL[b.kind]}</span>{#if b.step != null
                    }<span class="sub">step {b.step}</span>{/if}
                </div>
                <div class="tb-body">{@html toRichHtml(b.text)}</div>
                {#if b.detail}<div class="tb-detail">{b.detail}</div>{/if}
              </div>
            {/each}
            {#if running}<span class="caret"></span>{/if}
            {#if trace.length === 0 && !running}
              <span class="muted">运行后这里会实时显示思考轨迹…</span>
            {/if}
          </div>
        </div>
      {/if}
      {#if showResult}
        <div class="card">
          <div class="run-col-title"><h3>最终结果</h3></div>
          {#if !finished}
            <div class="result-empty">
              <span class="spinner"></span>
              <span>最终结果生成中…</span>
              <div class="skeleton">
                <span class="sk-line" style="width:92%"></span>
                <span class="sk-line" style="width:78%"></span>
                <span class="sk-line" style="width:85%"></span>
              </div>
            </div>
          {:else if error}
            <div class="muted">
              运行失败，详见通知提示与左侧思考 Trace。
            </div>
          {:else}
            <div class="deliverable">
              <span class="k">执行步数</span><span class="v">{steps}</span>
            </div>
            <div class="deliverable">
              <span class="k">累计花费</span
              ><span class="v accent">${cost.toFixed(4)}</span>
            </div>
            <div class="deliverable">
              <span class="k">调用工具</span
              ><span class="v ok">{toolsCount} 个</span>
            </div>
            <div class="codeblock rich">
              {#if final}
                {@html toRichHtml(final)}
              {:else}
                （模型未返回最终文本）
              {/if}
            </div>
            <div class="run-actions">
              <button onclick={() => copyFinal()}>复制</button>
              <button onclick={() => exportRun()}>导出</button>
              <button class="ghost" onclick={() => newConversation()}>
                新会话
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </section>
</div>
