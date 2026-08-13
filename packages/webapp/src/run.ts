import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { client } from './api';
import { ApprovalRequiredError } from '@agent-harness/client';
import type { RunMode, StreamEvent } from '@agent-harness/client';
import { sharedStyles } from './styles';
import { toRichHtml, escapeHtml } from './markdown';

/* ------------------------------ 类型 ------------------------------ */

interface Phase {
  key: string;
  label: string;
  sub?: string;
  status: 'pending' | 'active' | 'done';
}

type BlockKind = 'user' | 'think' | 'tool' | 'tool-result' | 'warn' | 'error';

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
  { key: 'summarize', label: '总结', sub: '整合最终结果', status: 'pending' },
];

const TAG_LABEL: Record<BlockKind, string> = {
  user: '任务',
  think: '思考',
  tool: '工具',
  'tool-result': '结果',
  warn: '护栏',
  error: '错误',
};

/* ------------------------------ Run ------------------------------ */

@customElement('ah-run')
export class AhRun extends LitElement {
  static styles = [sharedStyles];

  @state() mode: RunMode = 'mock';
  @state() prompt = '列出当前目录的 .ts 文件';
  @state() model = '';
  @state() maxSteps = '';
  @state() sessionId = '';
  @state() reconnect = '';
  @state() showAdvanced = false;

  @state() running = false;
  @state() finished = false;
  @state() error: string | null = null;
  @state() ticket: string | null = null;

  @state() view: 'thinking' | 'result' | 'all' = 'all';
  @state() phases: Phase[] = PHASES.map((p) => ({ ...p }));
  @state() trace: TraceBlock[] = [];
  @state() final = '';
  @state() jobId: string | null = null;
  @state() toolsCount = 0;
  @state() steps = 0;
  @state() cost = 0;
  @state() toast: string | null = null;

  private nextId = 1;
  private abort?: AbortController;
  private toastTimer?: number;

  /* ----------------------- 事件 → 阶段 / 轨迹 映射 ----------------------- */

  private markActive(idx: number) {
    this.phases = this.phases.map((p, i) => {
      if (i === idx) return { ...p, status: 'active' };
      if (i < idx && p.status === 'pending') return { ...p, status: 'done' };
      return p;
    });
  }

  private markDone(idx: number) {
    this.phases = this.phases.map((p, i) => (i === idx ? { ...p, status: 'done' } : p));
  }

  private allDone() {
    this.phases = this.phases.map((p) => ({ ...p, status: 'done' }));
  }

  private push(block: Omit<TraceBlock, 'id'>) {
    this.trace = [...this.trace, { id: this.nextId++, ...block }];
  }

  private ingest(ev: StreamEvent) {
    switch (ev.type) {
      case 'job:accepted':
        this.jobId = (ev as any).jobId ?? this.jobId;
        break;
      case 'run:start':
        this.markActive(0);
        this.push({ kind: 'user', text: String((ev as any).input ?? this.prompt) });
        break;
      case 'run:tools':
        this.toolsCount = (ev as any).tools?.length ?? this.toolsCount;
        break;
      case 'step:start':
        this.markActive(1);
        break;
      case 'llm:call':
        this.markDone(1);
        this.markActive(3);
        break;
      case 'llm:response': {
        this.markActive(3);
        const content = (ev as any).content;
        if (content) this.push({ kind: 'think', text: String(content), step: (ev as any).step });
        break;
      }
      case 'tool:start':
        this.markActive(2);
        this.push({
          kind: 'tool',
          text: `调用工具：${(ev as any).call?.name ?? 'unknown'}`,
          step: (ev as any).step,
          detail: safeJson((ev as any).call?.arguments),
        });
        break;
      case 'tool:result':
        this.markDone(2);
        this.push({
          kind: 'tool-result',
          text: `${(ev as any).call?.name ?? 'unknown'} → ${(ev as any).errored ? '失败' : '完成'}`,
          step: (ev as any).step,
          detail: safeJson((ev as any).result),
        });
        break;
      case 'guardrail:blocked':
        this.push({
          kind: 'warn',
          text: `护栏拦截(${(ev as any).phase})：${(ev as any).reason ?? ''}`,
        });
        break;
      case 'run:cost':
        this.cost = (ev as any).cumulativeCost ?? this.cost;
        break;
      case 'run:end':
        this.markDone(3);
        this.markDone(4);
        this.allDone();
        this.final = String((ev as any).final ?? '');
        this.steps = (ev as any).steps ?? this.steps;
        break;
      case 'error':
        this.push({ kind: 'error', text: String((ev as any).message ?? ev) });
        break;
      case 'env:status':
      case '_env_done':
        this.dispatchEvent(new CustomEvent('ah-refresh', { bubbles: true, composed: true }));
        break;
      default:
        // 未知事件类型：以原始 JSON 兜底展示，保证不丢信息
        this.push({ kind: 'think', text: safeJson(ev) });
        break;
    }
  }

  /* ----------------------- 运行 / 停止 ----------------------- */

  private async run() {
    this.error = null;
    this.ticket = null;
    this.trace = [];
    this.final = '';
    this.jobId = null;
    this.toolsCount = 0;
    this.steps = 0;
    this.cost = 0;
    this.nextId = 1;
    this.phases = PHASES.map((p) => ({ ...p }));
    this.finished = false;
    this.running = true;

    const ac = new AbortController();
    this.abort = ac;
    try {
      for await (const ev of client.streamRun(
        {
          mode: this.mode,
          prompt: this.prompt,
          model: this.model || undefined,
          maxSteps: this.maxSteps ? Number(this.maxSteps) : undefined,
          sessionId: this.sessionId || undefined,
          jobId: this.reconnect || undefined,
        },
        { signal: ac.signal }
      )) {
        this.ingest(ev);
      }
    } catch (e: any) {
      if (e instanceof ApprovalRequiredError) {
        this.ticket = `需要审批：ticket ${e.ticketId}（在「审批」页裁决后重投）`;
      } else {
        this.error = String(e?.message ?? e);
      }
    } finally {
      this.running = false;
      this.finished = true;
    }
  }

  private stop() {
    this.abort?.abort();
  }

  /* ----------------------- 复制 / 导出 / 重试 ----------------------- */

  private async copyFinal() {
    try {
      await navigator.clipboard.writeText(this.final || '（暂无结果）');
      this.showToast('已复制最终结果');
    } catch {
      this.showToast('复制失败：浏览器拒绝了剪贴板权限');
    }
  }

  private exportRun() {
    const blocks = this.trace
      .map(
        (b) =>
          `<div class="tb"><span class="tb-tag">${escapeHtml(TAG_LABEL[b.kind])}</span>${toRichHtml(b.text)}</div>`
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
  <p>${escapeHtml(this.prompt)}</p>
  <h2>思考轨迹</h2>
  ${blocks}
  <h2>最终结果</h2>
  ${toRichHtml(this.final)}
  <div class="meta">jobId: ${escapeHtml(String(this.jobId ?? '-'))} · 步数: ${this.steps} · 花费: $${this.cost.toFixed(4)} · 工具: ${this.toolsCount}</div>
</body>
</html>`;
    const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-run-${this.jobId ?? Date.now()}.html`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('已导出运行记录（HTML）');
  }

  private showToast(msg: string) {
    this.toast = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toast = null), 1800);
  }

  /* ----------------------- 渲染 ----------------------- */

  private renderPhases() {
    return html`<div class="phase-list">
      ${this.phases.map(
        (p) => html`
          <div class="phase ${p.status}">
            <span class="dot">${p.status === 'done' ? '✓' : p.status === 'active' ? '◌' : ''}</span>
            <span class="label">${p.label}</span>
            ${p.sub ? html`<span class="sub">· ${p.sub}</span>` : nothing}
          </div>
        `
      )}
    </div>`;
  }

  private renderTrace() {
    const blocks = this.trace.map(
      (b) => html`
        <div class="trace-block ${b.kind}">
          <div class="tb-head"><span class="tb-tag">${TAG_LABEL[b.kind]}</span>${b.step != null ? html`<span class="sub">step ${b.step}</span>` : nothing}</div>
          <div class="tb-body">${unsafeHTML(toRichHtml(b.text))}</div>
          ${b.detail ? html`<div class="tb-detail">${b.detail}</div>` : nothing}
        </div>
      `
    );
    return html`<div class="trace">
      ${blocks}
      ${this.running ? html`<span class="caret"></span>` : nothing}
      ${this.trace.length === 0 && !this.running ? html`<span class="muted">运行后这里会实时显示思考轨迹…</span>` : nothing}
    </div>`;
  }

  private renderResult() {
    if (!this.finished) {
      return html`<div class="result-empty">
        <span class="spinner"></span>
        <span>最终结果生成中…</span>
        <div class="skeleton">
          <span class="sk-line" style="width:92%"></span>
          <span class="sk-line" style="width:78%"></span>
          <span class="sk-line" style="width:85%"></span>
        </div>
      </div>`;
    }
    if (this.error) {
      return html`<div class="error">${this.error}</div>`;
    }
    return html`
      <div class="deliverable">
        <span class="k">执行步数</span><span class="v">${this.steps}</span>
      </div>
      <div class="deliverable">
        <span class="k">累计花费</span><span class="v accent">$${this.cost.toFixed(4)}</span>
      </div>
      <div class="deliverable">
        <span class="k">调用工具</span><span class="v ok">${this.toolsCount} 个</span>
      </div>
      <div class="codeblock rich">${this.final ? unsafeHTML(toRichHtml(this.final)) : '（模型未返回最终文本）'}</div>
      <div class="run-actions">
        <button @click=${() => this.copyFinal()}>复制</button>
        <button @click=${() => this.exportRun()}>导出</button>
        <button @click=${() => this.run()}>重试</button>
      </div>
    `;
  }

  render() {
    const showThinking = this.view === 'thinking' || this.view === 'all';
    const showResult = this.view === 'result' || this.view === 'all';

    return html`
      <section style="border:none;background:none;box-shadow:none;padding:0">
        <div class="run-head">
          <h2 class="run-title">运行时</h2>
          <div class="run-head-right">
            <div class="seg">
              <button class="${this.view === 'thinking' ? 'active' : ''}" @click=${() => (this.view = 'thinking')}>思考</button>
              <button class="${this.view === 'result' ? 'active' : ''}" @click=${() => (this.view = 'result')}>结果</button>
              <button class="${this.view === 'all' ? 'active' : ''}" @click=${() => (this.view = 'all')}>全览</button>
            </div>
            ${this.running
              ? html`<span class="pill running">运行中</span><button class="ghost" @click=${() => this.stop()}>停止</button>`
              : this.finished
                ? html`<span class="pill done">已完成</span><button class="ghost" @click=${() => this.run()}>重新运行</button>`
                : html`<span class="pill">空闲</span>`}
          </div>
        </div>

        <div class="run-task card">
          <label class="block">
            任务提示词
            <textarea rows="3" .value=${this.prompt} ?disabled=${this.running} @input=${(e: Event) => (this.prompt = (e.target as HTMLTextAreaElement).value)}></textarea>
          </label>
          <div class="row">
            <button ?disabled=${this.running} @click=${() => this.run()}>
              ${this.running ? '运行中…' : this.finished ? '重新运行' : '运行 Agent'}
            </button>
            <button class="ghost" @click=${() => (this.showAdvanced = !this.showAdvanced)}>
              ${this.showAdvanced ? '收起高级' : '高级选项'}
            </button>
          </div>
          ${this.showAdvanced
            ? html`<div class="run-advanced">
                <label>模式
                  <select ?disabled=${this.running} @change=${(e: Event) => (this.mode = (e.target as HTMLSelectElement).value as RunMode)}>
                    <option value="mock" ?selected=${this.mode === 'mock'}>mock（离线）</option>
                    <option value="real" ?selected=${this.mode === 'real'}>real（真实 LLM）</option>
                    <option value="real-mcp" ?selected=${this.mode === 'real-mcp'}>real-mcp</option>
                  </select>
                </label>
                <label>模型<input .value=${this.model} ?disabled=${this.running} @input=${(e: Event) => (this.model = (e.target as HTMLInputElement).value)} placeholder="留空用服务端默认" /></label>
                <label>最大步数<input .value=${this.maxSteps} ?disabled=${this.running} @input=${(e: Event) => (this.maxSteps = (e.target as HTMLInputElement).value)} placeholder="留空用默认 24" /></label>
                <label>会话 ID<input .value=${this.sessionId} ?disabled=${this.running} @input=${(e: Event) => (this.sessionId = (e.target as HTMLInputElement).value)} placeholder="多租户隔离 key" /></label>
                <label>重连 jobId<input .value=${this.reconnect} ?disabled=${this.running} @input=${(e: Event) => (this.reconnect = (e.target as HTMLInputElement).value)} placeholder="断线重连用，可留空" /></label>
              </div>`
            : nothing}
        </div>

        ${this.ticket ? html`<div class="warn">${this.ticket}</div>` : nothing}
        ${this.error && this.running ? html`<div class="error">${this.error}</div>` : nothing}

        <div class="run-two">
          ${showThinking
            ? html`<div class="card">
                <div class="run-col-title"><h3>思考 Trace</h3></div>
                ${this.renderPhases()}
                ${this.renderTrace()}
              </div>`
            : nothing}
          ${showResult
            ? html`<div class="card">
                <div class="run-col-title"><h3>最终结果</h3></div>
                ${this.renderResult()}
              </div>`
            : nothing}
        </div>
      </section>
      ${this.toast ? html`<div class="toast">${this.toast}</div>` : nothing}
    `;
  }
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
