/**
 * chat.ts 运行管线抽离（Phase 5 余下 + Phase 6，A+B+C 合并）。
 *
 * 把「SSE 消费 + 断连重连续传 + 事件汇入(ingest) + 发送编排(dispatchPrompt) +
 * 断连恢复(resumeLost) + 手动停止(stop) + 看门狗/可见性体检(onVisibilityChange/silentWatchdog)」
 * 这一整条运行生命周期，从 AhChat 抽成 `ChatRunRuntime` 轻量控制器。
 *
 * 设计要点（沿用 ChatTypewriter 的 caps 范式、零改动 render）：
 * - **运行内部簿记状态**迁入本控制器自有字段：jobBy / lastSeqBy / lastEventAt /
 *   finishedBy / erroredBy / keepAliveAbort / lastInputBy / abortBy / watchTimer。
 *   ingest / dispatchPrompt / resumeLost / stop / 看门狗 直接读写 `this.X`，逐字不变。
 * - **会话领域数据 + 渲染相关状态**仍留 AhChat（threads / streamIdx / traces / sessions /
 *   messages / planExec / backendUsage / 配置字段 / connState / streaming 等），经
 *   `RunDeps` 桥接（箭头函数），render 与组件其余路径零改动。
 * - typewriter 控制器直接注入（与 ingest / dispatch 共享缓冲，同 ChatTypewriter 设计）。
 * - 已抽出的退避状态机 `runWithReconnect`（纯函数）+ `sleep` + `isJobGone` 复用，
 *   本类的 runWithReconnect 方法仅以自身状态拼接 deps 后委托之。
 *
 * 方法体与原 chat.ts 逐字一致，仅把 AhChat 成员访问改写为 `deps.X`；行为不变。
 */
import { ApiError, StreamEvent, RunMode } from '@agent-harness/client';
import {
  ChatMsg,
  ExecutionPlanView,
  TraceCtx,
  PlanExecState
} from './chat-types';
import { ChatTypewriter } from './chat-typewriter';
import { notifyError } from './utils/errors';
import { escapeHtml } from './utils/markdown';
import { safeJson } from './utils/chat-utils';
import { agentContext } from './agent-context';
import { MY_ORIGIN } from './chat-sync';

/** 后端上下文用量（与 AhChat 内联类型同构）。 */
export interface BackendUsage {
  window: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  breakdown: {
    system: number;
    tools: number;
    messages: number;
    mcp: number;
    skills: number;
    completion: number;
  };
}

/** AhChat 经此接口把领域数据 / 渲染状态 / 行为方法桥接给运行控制器。 */
export interface RunDeps {
  /* ----- 渲染相关状态（仍留 AhChat，render 直接消费） ----- */
  getConnState(sid: string): 'connected' | 'reconnecting' | 'lost';
  setConn(sid: string, val: 'connected' | 'reconnecting' | 'lost'): void;
  getStreaming(sid: string): boolean;
  getStreamingDict(): Record<string, boolean>;
  setStreaming(sid: string, val: boolean): void;

  /* ----- 会话领域数据 ----- */
  threadFor(sid: string): ChatMsg[];
  setStreamIdx(sid: string, idx: number): void;
  setThreads(sid: string, t: ChatMsg[]): void;
  getThreads(sid: string): ChatMsg[] | undefined;
  getActiveId(): string;
  setMessages(t: ChatMsg[]): void;
  getTraces(sid: string): TraceCtx | undefined;
  getPlanExec(): Record<number, PlanExecState>;
  setPlanExec(v: Record<number, PlanExecState>): void;
  getServerCtxWindow(): number;
  getBackendUsage(): BackendUsage | null;
  setBackendUsage(v: BackendUsage | null): void;
  getMode(): RunMode;
  getModel(): string;
  getAgentId(): string;
  getWeb(): boolean;
  getInteractionMode(): 'qa' | 'plan';
  getAttachments(): unknown[];
  setShowCtxUsage(b: boolean): void;
  setRunCumulative(v: null): void;

  /* ----- 行为方法（留在 AhChat） ----- */
  curSession(sid: string): ChatMsg | null;
  patchSession(sid: string, p: Partial<ChatMsg>): void;
  resetTrace(sid: string): void;
  customModelEndpoint(): Promise<Record<string, unknown>>;
  traceHandle(ev: unknown, sid: string): void;
  autoCollapseThink(sid: string): void;
  rebuildTraceMessages(sid: string): void;
  saveHistory(sid: string): void;
  resetScrollToBottom(): void;
  nextId(): number;
  requestUpdate(): void;

  /* ----- SSE 客户端（client.streamRun） ----- */
  streamRun(
    payload: Record<string, unknown>,
    opts: { signal: AbortSignal }
  ): AsyncIterable<unknown>;
}

/**
 * 判定「job 已被服务端淘汰」：4xx 客户端错误（非 5xx 服务端暂态），
 * 此时 jobId 失效、仅凭 jobId 无法续传，直接放弃重试。
 */
export function isJobGone(rawErr: unknown): boolean {
  return (
    rawErr instanceof ApiError && rawErr.status >= 400 && rawErr.status < 500
  );
}

/** 可被 AbortSignal 提前打断的 sleep（用户停止时立即结束退避等待）。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * 断连重连续传引擎所需的极简依赖（与原 AhChat 的 run 局部状态桥接）。
 * 与 ChatRunRuntime 的 RunDeps（含大块领域数据 / 行为方法）分离，互不牵扯类型，
 * 便于本函数独立测试（见 chat-run-runtime.test.ts）。
 */
export interface ReconnectDeps {
  streamRun(
    payload: Record<string, unknown>,
    opts: { signal: AbortSignal }
  ): AsyncIterable<unknown>;
  onEvent(ev: unknown, sid: string): void;
  getJobId(sid: string): string;
  getLastSeq(sid: string): number;
  isFinished(sid: string): boolean;
  getKeepAliveAbort(sid: string): boolean;
  clearKeepAliveAbort(sid: string): void;
  getConnState(sid: string): 'connected' | 'reconnecting' | 'lost';
  setConn(sid: string, val: 'connected' | 'reconnecting' | 'lost'): void;
}

/**
 * 消费一次 run 的 SSE 事件流，并在意外断连时自动重连续传。
 * 详见 chat.ts 原 runWithReconnect 注释；此处仅把实例成员访问改为 deps 桥接，逻辑逐字一致。
 */
export async function runWithReconnect(
  sid: string,
  input: Record<string, unknown>,
  ac: AbortController,
  deps: ReconnectDeps,
  sleepFn: (ms: number, signal?: AbortSignal) => Promise<void> = sleep
): Promise<void> {
  const MAX_ATTEMPTS = 6;
  let attempts = 0;
  let first = true;
  while (true) {
    try {
      const payload: Record<string, unknown> = first
        ? input
        : {
            ...input,
            jobId: deps.getJobId(sid),
            since: deps.getLastSeq(sid) ?? -1
          };
      first = false;
      for await (const ev of deps.streamRun(payload, { signal: ac.signal })) {
        if (deps.getConnState(sid) !== 'connected') deps.setConn(sid, 'connected');
        deps.onEvent(ev, sid);
      }
      if (deps.getConnState(sid) !== 'connected') deps.setConn(sid, 'connected');
      return;
    } catch (rawErr: any) {
      const aborted = ac.signal.aborted;
      const wasKeepAlive = deps.getKeepAliveAbort(sid) === true;
      deps.clearKeepAliveAbort(sid);
      if (aborted && !wasKeepAlive) {
        if (deps.getConnState(sid) !== 'connected') deps.setConn(sid, 'connected');
        throw Object.assign(
          rawErr instanceof Error ? rawErr : new Error(String(rawErr)),
          { name: 'UserStoppedRun' }
        );
      }
      if (deps.isFinished(sid)) return;
      attempts += 1;
      const jobGone =
        rawErr instanceof ApiError &&
        rawErr.status >= 400 &&
        rawErr.status < 500;
      if (jobGone || !deps.getJobId(sid) || attempts > MAX_ATTEMPTS) {
        throw rawErr;
      }
      const delay = Math.min(8000, 1000 * 2 ** (attempts - 1));
      deps.setConn(sid, 'reconnecting');
      await sleepFn(delay, ac.signal);
      if (ac.signal.aborted && !deps.getKeepAliveAbort(sid)) {
        if (deps.getConnState(sid) !== 'connected') deps.setConn(sid, 'connected');
        throw Object.assign(new Error('user stopped during reconnect'), {
          name: 'UserStoppedRun'
        });
      }
    }
  }
}

/**
 * 运行生命周期控制器：持有 run 局部簿记状态，委托 AhChat 的领域数据 / 行为。
 */
export class ChatRunRuntime {
  /* ----- 运行内部簿记状态（迁入本控制器） ----- */
  private jobBy: Record<string, string> = {};
  private lastSeqBy: Record<string, number> = {};
  private lastEventAt: Record<string, number> = {};
  private finishedBy: Record<string, boolean> = {};
  private erroredBy: Record<string, boolean> = {};
  private keepAliveAbort: Record<string, boolean> = {};
  private lastInputBy: Record<string, Record<string, unknown>> = {};
  private abortBy: Record<string, AbortController> = {};
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private deps: RunDeps,
    public typewriter: ChatTypewriter
  ) {}

  /** 渲染层用（ChatRenderCtx.jobBy）：暴露当前 jobId 映射，供断连横幅判断可否「重新连接」。 */
  get jobMap(): Record<string, string> {
    return this.jobBy;
  }

  /* ============================ 断线恢复引擎 ============================ */

  /**
   * 消费一次 run 的 SSE 事件流，并在意外断连时自动重连续传。
   * 重试 / 退避状态机见本模块 runWithReconnect（纯函数）；此处仅以本控制器状态拼接 deps。
   */
  private async runWithReconnect(
    sid: string,
    input: Record<string, unknown>,
    ac: AbortController
  ): Promise<void> {
    return runWithReconnect(sid, input, ac, {
      streamRun: (payload, opts) => this.deps.streamRun(payload, opts),
      onEvent: (ev, s) => this.ingest(ev as StreamEvent, s),
      getJobId: (s) => this.jobBy[s] ?? '',
      getLastSeq: (s) => this.lastSeqBy[s] ?? -1,
      isFinished: (s) => !!this.finishedBy[s],
      getKeepAliveAbort: (s) => this.keepAliveAbort[s] === true,
      clearKeepAliveAbort: (s) => {
        this.keepAliveAbort[s] = false;
      },
      getConnState: (s) => this.deps.getConnState(s),
      setConn: (s, v) => this.deps.setConn(s, v)
    });
  }

  /** 手动停止当前显示会话的 run（仅中止该会话，不影响其它后台 run）。 */
  stop() {
    const ac = this.abortBy[this.deps.getActiveId()];
    ac?.abort();
  }

  /** 手动重试入口（顶部断连横幅按钮）：对仍持有 jobId 的会话发起恢复。 */
  async resumeLost(sid: string) {
    if (!sid || this.deps.getStreaming(sid) || this.finishedBy[sid]) return;
    if (!this.jobBy[sid]) {
      // jobId 已不可用（服务端重启淘汰）：只能整段重发，提示用户重新发送消息。
      this.deps.patchSession(sid, { error: true });
      return;
    }
    const input = this.lastInputBy[sid] ?? {};
    const ac = new AbortController();
    this.abortBy[sid] = ac;
    this.typewriter.received[sid] = false;
    this.typewriter.pending[sid] = { content: '', reasoning: '' };
    this.deps.setStreaming(sid, true);
    this.deps.setConn(sid, 'reconnecting');
    try {
      await this.runWithReconnect(sid, input, ac);
    } catch (e: any) {
      if ((e as any)?.name !== 'UserStoppedRun') {
        this.deps.setConn(sid, 'lost');
        this.deps.patchSession(sid, {
          error: true,
          content:
            (this.deps.curSession(sid)?.content ?? '') ||
            `⚠️ 重连失败：${e?.message ?? e}（请重新发送消息）`
        });
        notifyError(e, { title: '重连失败', key: `chat-run-${sid}` });
      }
    } finally {
      this.typewriter.stopTypewriter();
      if (ac.signal.aborted) {
        this.typewriter.flushTypewriter(sid);
      } else {
        await this.typewriter.drainTypewriter(sid);
      }
      const c = this.deps.curSession(sid);
      if (c && !c.content && this.typewriter.finalBy[sid]) {
        this.deps.patchSession(sid, { content: this.typewriter.finalBy[sid] });
      }
      this.deps.autoCollapseThink(sid);
      this.deps.rebuildTraceMessages(sid);
      const tc2 = this.deps.getTraces(sid);
      if (tc2?.root) {
        this.deps.patchSession(sid, { trace: [tc2.root] });
      }
      this.deps.setStreaming(sid, false);
      this.abortBy[sid] = undefined as any;
      if (this.deps.getActiveId() === sid)
        this.deps.setMessages(this.deps.getThreads(sid) ?? []);
      this.deps.saveHistory(sid);
    }
  }

  /* ============================ SSE 事件汇入 ============================ */

  ingest(ev: StreamEvent, sid: string) {
    // 每次都从最新 this.threads[sid] 读取当前消息：patch 会整体替换数组与对象，
    // 早期捕获的引用是「旧快照」，直接用它做增量拼接会丢内容 / 看不到已落下的工具卡。
    const cur = (): ChatMsg | null => this.deps.curSession(sid);
    const patch = (p: Partial<ChatMsg>) => this.deps.patchSession(sid, p);
    // 终结事件（最终答复已到达 / 流结束 / 运行出错）：立即解除该会话的「流式」状态。
    const et = (ev as any).type;
    if (et === 'run:end' || et === '_done' || et === 'error') {
      this.deps.setStreaming(sid, false);
    }
    // 断线恢复簿记：记录 jobId（重连凭据）、最大事件 seq（续传游标）、
    // 活跃时间戳（看门狗/切回标签页的健康判定）与终结标记。
    const anyEv = ev as any;
    if (et === 'job:accepted' && anyEv.jobId) {
      this.jobBy[sid] = String(anyEv.jobId);
    }
    if (typeof anyEv.seq === 'number') {
      this.lastSeqBy[sid] = Math.max(this.lastSeqBy[sid] ?? -1, anyEv.seq);
    }
    this.lastEventAt[sid] = Date.now();
    if (et === 'run:end' || et === '_done' || et === 'error') {
      this.finishedBy[sid] = true;
      // 记录本轮 run 是否出现过 error 事件：dispatchPrompt 收尾时据此区分
      // 「成功收尾」与「带错误收尾」，计划执行循环依赖这一判定中止后续任务。
      if (et === 'error') this.erroredBy[sid] = true;
      // 运行已终结：链路无论此前是否断连过都视为恢复，立即摘掉「连接中断」横幅。
      if (this.deps.getConnState(sid) !== 'connected')
        this.deps.setConn(sid, 'connected');
    }
    // 把事件汇入调用链路追踪树（独立于内容/工具卡，结构化记录 LLM↔工具↔检索 过程）。
    this.deps.traceHandle(ev, sid);
    switch (ev.type) {
      case 'job:accepted':
        // jobId 仅用于潜在调试，无需持久；忽略。
        break;
      case 'plan:proposed': {
        // 计划模式（P0）：服务端解析成功后补发的结构化计划 —— 挂到流式消息上渲染计划卡片。
        const c = cur();
        const plan = anyEv.plan as ExecutionPlanView | undefined;
        if (!c || !plan || !plan.tasks?.length) break;
        // 去重防御：模型偶尔会把已确认执行中/已完成的计划原样再输出一遍。
        const dupSrc = [...(this.deps.getThreads(sid) ?? [])]
          .reverse()
          .find(
            (p) =>
              p.id !== c.id &&
              p.plan &&
              p.plan.goal === plan.goal &&
              p.plan.tasks.length === plan.tasks.length &&
              ['running', 'done'].includes(
                this.deps.getPlanExec()[p.id]?.status ?? 'pending'
              )
          );
        patch({
          plan,
          ...(c.content?.trim()
            ? {}
            : {
                content: `已生成执行计划（共 ${plan.tasks.length} 个任务）：${plan.goal}。确认后将按依赖顺序逐任务执行。`
              })
        });
        this.deps.setPlanExec({
          ...this.deps.getPlanExec(),
          [c.id]: dupSrc
            ? {
                ...(this.deps.getPlanExec()[dupSrc.id] ?? {
                  status: 'pending',
                  done: {}
                })
              }
            : { status: 'pending', done: {} }
        });
        break;
      }
      case 'llm:token': {
        const c = cur();
        if (c) {
          this.typewriter.received[sid] = true;
          const p = this.typewriter.pending[sid];
          if (p) p.content += String((ev as any).delta ?? '');
          // 首个回答 token 到达 = 思考阶段结束：自动折叠本轮思考面板。
          if (!c.content) this.deps.autoCollapseThink(sid);
          this.typewriter.ensureTypewriter();
        }
        break;
      }
      case 'llm:reasoning': {
        const c = cur();
        if (c) {
          const p = this.typewriter.pending[sid];
          if (p) p.reasoning += String((ev as any).delta ?? '');
          this.typewriter.ensureTypewriter();
        }
        break;
      }
      case 'llm:response': {
        // 关键修复：若已通过 llm:token 增量构建了内容，不再用 llm:response 覆盖。
        const c = cur();
        if (c && !this.typewriter.received[sid]) {
          const respContent = String((ev as any).content ?? '');
          if (respContent) patch({ content: respContent });
          // 标记已处理：避免重复 llm:response 事件二次覆盖（逆序/重复内容根因），
          // 且不影响后续 llm:token 增量追加（token 分支不读此标志做门禁）。
          this.typewriter.received[sid] = true;
        }
        break;
      }
      case 'tool:start': {
        const c = cur();
        if (!c) break;
        const tools = [...(c.tools ?? [])];
        tools.push({
          name: (ev as any).call?.name ?? 'unknown',
          args: safeJson((ev as any).call?.arguments)
        });
        patch({ tools });
        break;
      }
      case 'tool:result': {
        const c = cur();
        if (!c) break;
        const tools = [...(c.tools ?? [])];
        const evName = (ev as any).call?.name;
        // 回填最近一条同名且尚未有结果的工具卡。
        if (evName !== undefined) {
          for (let i = tools.length - 1; i >= 0; i--) {
            const tv = tools[i];
            if (!tv) continue;
            if (tv.name === evName && tv.result === undefined) {
              tools[i] = {
                ...tv,
                result: String((ev as any).result ?? ''),
                errored: Boolean((ev as any).errored)
              };
              break;
            }
          }
        }
        patch({ tools });
        break;
      }
      case 'guardrail:blocked': {
        const c = cur();
        if (c)
          patch({
            content:
              c.content +
              `\n\n> ⚠️ 护栏拦截（${escapeHtml(
                String((ev as any).phase ?? '')
              )}）：${escapeHtml(String((ev as any).reason ?? ''))}`
          });
        break;
      }
      case 'llm:usage': {
        // 后端精确上下文用量：更新浮层数据源，并同步给 dashboard 汇总（跨页面共享）。
        const u = ev as any;
        if (u && u.breakdown) {
          const win =
            this.deps.getServerCtxWindow() > 0
              ? this.deps.getServerCtxWindow()
              : Number.isFinite(Number(u.window)) && Number(u.window) > 0
              ? Number(u.window)
              : 0;
          // 会话级累计窗口占用：跨 run 累加，窗口口径变化时重新初始化。
          const prev = this.deps.getBackendUsage();
          if (prev && prev.window === win && prev.breakdown && u.breakdown) {
            this.deps.setBackendUsage({
              window: win,
              promptTokens: prev.promptTokens + u.promptTokens,
              completionTokens: prev.completionTokens + u.completionTokens,
              totalTokens: prev.totalTokens + u.totalTokens,
              breakdown: {
                system: prev.breakdown.system + (u.breakdown.system ?? 0),
                tools: prev.breakdown.tools + (u.breakdown.tools ?? 0),
                messages: prev.breakdown.messages + (u.breakdown.messages ?? 0),
                mcp: prev.breakdown.mcp + (u.breakdown.mcp ?? 0),
                skills: prev.breakdown.skills + (u.breakdown.skills ?? 0),
                completion:
                  prev.breakdown.completion + (u.breakdown.completion ?? 0)
              }
            });
          } else {
            this.deps.setBackendUsage({
              window: win,
              promptTokens: u.promptTokens,
              completionTokens: u.completionTokens,
              totalTokens: u.totalTokens,
              breakdown: u.breakdown
            });
          }
          const totalPct =
            win > 0 ? Math.min(100, (Number(u.totalTokens) / win) * 100) : 0;
          agentContext.set('lastContextUsage', {
            totalPct,
            totalTokens: Number(u.totalTokens),
            window: win,
            model: u.model,
            updatedAt: Date.now()
          });
          // 用量更新后立即镜像落盘。
          this.deps.saveHistory(sid);
        }
        break;
      }
      case 'run:end': {
        const finalStr = String((ev as any).final ?? '');
        this.typewriter.finalBy[sid] = finalStr;
        // 仅在没有 token 增量（非流式回退）时才用 final 直接赋值；计划卡片跳过原始 JSON 外泄。
        if (!this.typewriter.received[sid] && finalStr) {
          const c = cur();
          if (c && !c.plan) patch({ content: finalStr });
          else if (c && c.plan && !c.content?.trim()) {
            const plan = c.plan as
              | { goal?: string; tasks?: unknown[] }
              | undefined;
            patch({
              content: `已生成执行计划（共 ${
                plan?.tasks?.length ?? '?'
              } 个任务）：${plan?.goal ?? ''}。确认后将按依赖顺序逐任务执行。`
            });
          }
        }
        break;
      }
      case 'error': {
        const c = cur();
        if (c)
          patch({
            error: true,
            // 保留已有内容；内容为空时才填错误占位。
            content:
              c.content || `⚠️ ${escapeHtml(String((ev as any).message ?? ev))}`
          });
        break;
      }
      default:
        break;
    }
  }

  /* ============================ 发送编排 ============================ */

  async dispatchPrompt(
    sessionId: string,
    content: string,
    imageAttachments: Array<{ url: string; name: string; type: string }> = [],
    opts: { planTask?: boolean; attachments?: unknown[] } = {}
  ): Promise<'ok' | 'stopped' | 'error'> {
    // 当前会话消息缓冲：追加 user + assistant(空)，并记录流式下标。
    const t = this.deps.threadFor(sessionId);
    t.push({
      id: this.deps.nextId(),
      role: 'user',
      content,
      attachments: opts.attachments
        ? [...opts.attachments]
        : [...this.deps.getAttachments()]
    } as ChatMsg);
    t.push({ id: this.deps.nextId(), role: 'assistant', content: '' } as ChatMsg);
    this.deps.setStreamIdx(sessionId, t.length - 1);
    this.deps.setThreads(sessionId, t);
    // 重置该会话的流式状态（防御上轮残留的缓冲 / 定时器泄漏到本轮）。
    this.typewriter.received[sessionId] = false;
    this.typewriter.pending[sessionId] = { content: '', reasoning: '' };
    this.typewriter.finalBy[sessionId] = '';
    // 断线恢复簿记归零：新一轮 run 重新记录 jobId / seq 游标 / 终结标记 / 错误标记。
    this.finishedBy[sessionId] = false;
    this.jobBy[sessionId] = '';
    this.lastSeqBy[sessionId] = -1;
    this.erroredBy[sessionId] = false;
    this.deps.setConn(sessionId, 'connected');
    this.deps.resetTrace(sessionId);
    this.typewriter.stopTypewriter();
    this.deps.setStreaming(sessionId, true);
    if (this.deps.getActiveId() === sessionId) this.deps.setMessages(t);
    // 发送新消息：强制钉底并滚到最新内容。
    this.deps.resetScrollToBottom();
    this.deps.setShowCtxUsage(false);
    // 仅清空「本运行累计」（本次 run 的真实消耗，run:cost 会重新赋值）。
    this.deps.setRunCumulative(null);
    // 容错持久化：用户消息一入缓冲立即镜像落盘。
    this.deps.saveHistory(sessionId);

    const endpoint = await this.deps.customModelEndpoint();
    const input: Record<string, unknown> = {
      mode: this.deps.getMode(),
      prompt: content,
      model: this.deps.getModel() || undefined,
      ctxWindow:
        this.deps.getServerCtxWindow() > 0
          ? this.deps.getServerCtxWindow()
          : undefined,
      ...endpoint,
      agentId: this.deps.getAgentId() || undefined,
      sessionId,
      chatSessionId: sessionId,
      attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
      web: this.deps.getWeb() || undefined,
      // 交互模式（P0 计划模式）：仅用户手动选择 plan 且非任务执行派发时进入 propose 阶段。
      interactionMode:
        this.deps.getInteractionMode() === 'plan' && !opts.planTask
          ? 'plan'
          : undefined,
      planPhase:
        this.deps.getInteractionMode() === 'plan' && !opts.planTask
          ? 'propose'
          : undefined,
      // 设备指纹：服务端跨设备广播据此区分本端回声与他端消息，前端按 origin 去重。
      origin: MY_ORIGIN
    };
    // 断连后「重新连接」按钮需要原始入参。
    this.lastInputBy[sessionId] = input;

    const ac = new AbortController();
    this.abortBy[sessionId] = ac;
    try {
      await this.runWithReconnect(sessionId, input, ac);
      // 流正常关闭 ≠ 运行成功：需检查本轮是否收到过 error，收到则按失败返回。
      if (this.erroredBy[sessionId]) {
        return 'error';
      }
      return 'ok';
    } catch (e: any) {
      if ((e as any)?.name === 'UserStoppedRun') {
        // 用户主动停止：保留已揭示内容，不标错误。
        return 'stopped';
      } else {
        // 彻底断连（重试耗尽 / job 已被服务端淘汰）：标记断开 + 错误提示。
        this.deps.setConn(sessionId, 'lost');
        this.deps.patchSession(sessionId, {
          error: true,
          content:
            (this.deps.curSession(sessionId)?.content ?? '') ||
            `⚠️ ${e?.message ?? e}`
        });
        notifyError(e, { title: '对话中断', key: `chat-run-${sessionId}` });
        return 'error';
      }
    } finally {
      // 先停掉 interval 定时器，再按打字节奏把剩余缓冲揭示完（drain）。
      this.typewriter.stopTypewriter();
      if (ac.signal.aborted) {
        this.typewriter.flushTypewriter(sessionId);
      } else {
        await this.typewriter.drainTypewriter(sessionId);
      }
      const c = this.deps.curSession(sessionId);
      if (c && !c.content && this.typewriter.finalBy[sessionId]) {
        this.deps.patchSession(sessionId, {
          content: this.typewriter.finalBy[sessionId]
        });
      }
      // 兜底：非流式回退路径内容不经 llm:token 到达，run 收尾时再尝试折叠一次。
      this.deps.autoCollapseThink(sessionId);
      // 运行收尾：用完整消息内容重建调用链路 LLM 节点的 messages 上下文。
      this.deps.rebuildTraceMessages(sessionId);
      const tc = this.deps.getTraces(sessionId);
      if (tc?.root) {
        this.deps.patchSession(sessionId, { trace: [tc.root] });
      }
      this.deps.setStreaming(sessionId, false);
      this.abortBy[sessionId] = undefined as any;
      if (this.deps.getActiveId() === sessionId)
        this.deps.setMessages(this.deps.getThreads(sessionId) ?? []);
      // 容错持久化：run 收尾把最终消息镜像落盘。
      this.deps.saveHistory(sessionId);
    }
  }

  /* ============================ 看门狗 / 可见性体检 ============================ */

  /** 启动静默看门狗：可见状态下流式会话 60s 无事件则强制唤醒重连。 */
  startWatchdog() {
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => this.silentWatchdog(), 5000);
    }
  }

  /** 停止静默看门狗。 */
  stopWatchdog() {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  /**
   * 切回标签页（visibilitychange→visible）：对流式中的会话做连接体检。
   * - 已标记 lost：立即唤醒重连；
   * - 超过 10s 无任何事件：视为后台期间连接已被冻结/回收，abort 唤醒挂起的
   *   read()，统一走 runWithReconnect 的续传路径（keepAliveAbort 标记区分用户停止）。
   */
  onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return;
    const streaming = this.deps.getStreamingDict();
    for (const sid in streaming) {
      if (!streaming[sid] || this.finishedBy[sid]) continue;
      const silentFor = Date.now() - (this.lastEventAt[sid] ?? Date.now());
      const lost = this.deps.getConnState(sid) === 'lost';
      if (lost || silentFor > 10_000) {
        this.keepAliveAbort[sid] = true;
        if (this.abortBy[sid]) this.abortBy[sid]?.abort();
        else void this.resumeLost(sid);
      }
    }
  };

  /** 静默看门狗：可见状态下流式会话 60s 无事件则强制唤醒重连（防御 read() 静默挂死）。 */
  silentWatchdog() {
    if (document.visibilityState !== 'visible') return;
    const streaming = this.deps.getStreamingDict();
    for (const sid in streaming) {
      if (!streaming[sid] || this.finishedBy[sid]) continue;
      const silentFor = Date.now() - (this.lastEventAt[sid] ?? Date.now());
      if (silentFor > 60_000 && !this.keepAliveAbort[sid]) {
        this.keepAliveAbort[sid] = true;
        this.abortBy[sid]?.abort();
      }
    }
  }
}
