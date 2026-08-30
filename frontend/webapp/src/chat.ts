import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { ref, createRef } from 'lit/directives/ref.js';
import { client, authedFetch, getUsername } from './api';
// 跨设备实时同步：登录后建立常驻 SSE，接收本账户其它端写入的增量消息/标题/删除。
import {
  startChatSync,
  stopChatSync,
  MY_ORIGIN,
  type ChatSyncEvent
} from './chat-sync';
import { AhModal } from './components/ah-modal';
import { sharedStyles } from './styles';
import { chatStyles } from './chat-styles';
import {
  isRetrievalTool,
  safeJson,
  parseDeepThinking
} from './utils/chat-utils';
import {
  buildInsights,
  countTraceNodes,
  renderInsights,
  renderTraceNode
} from './chat-trace';
import { toRichHtml, escapeHtml } from './utils/markdown';
import {
  sanitizeMessages,
  mergeThreadHistories,
  saveThread,
  loadThread,
  purgeSessionMirror,
  loadIndex,
  withTimeout,
  type MirroredUsage
} from './chat-history';
import type {
  ChatSession,
  RunMode,
  StreamEvent,
  TraceNode,
  TraceKind,
  PlanExecMirror,
  ChatMessage
} from '@agent-harness/client';
import { ApiError } from '@agent-harness/client';
import { agentContext, type UploadedFile } from './agent-context';
import './components/file-upload';
import './components/model-picker';
import './components/mode-picker';
import './components/agent-picker';

/* ------------------------------ 类型 ------------------------------ */

interface ToolView {
  name: string;
  args: string;
  result?: string;
  errored?: boolean;
}

/** 计划模式（P0）：计划任务 / 计划实体（与 core ExecutionPlan 契约一致，前端本地视图类型）。 */
interface PlanTaskView {
  id: string;
  title: string;
  steps: string[];
  dependsOn: string[];
  expectedOutput: string;
}
interface ExecutionPlanView {
  goal: string;
  tasks: PlanTaskView[];
}
/** 计划执行状态（key 为携带计划的消息 id）。 */
interface PlanExecState {
  status: 'pending' | 'running' | 'done' | 'cancelled' | 'failed';
  /** 正在执行的任务 id（running 时有效）。 */
  currentTaskId?: string;
  /** 失败的任务 id（failed 时有效）：恢复执行时从此任务重跑，已完成任务跳过。 */
  failedTaskId?: string;
  /** 已完成任务 id 集合。 */
  done: Record<string, boolean>;
}

interface ChatMsg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** 推理过程（思考折叠块），仅推理模型有。 */
  reasoning?: string;
  /** 工具调用卡片列表。 */
  tools?: ToolView[];
  /** 调用链路追踪树：把本回合的 LLM↔工具↔检索 调用过程结构化记录，供深度思考界面可视化。 */
  trace?: TraceNode[];
  /** 错误态：以警示样式渲染。 */
  error?: boolean;
  /** 本次消息携带的附件（图片/文件预览）。 */
  attachments?: UploadedFile[];
  /** 计划模式（P0）：本条消息携带的结构化执行计划（plan:proposed 时写入）。 */
  plan?: ExecutionPlanView;
}

interface SessionView {
  id: string;
  title: string;
  updatedAt: number;
  /** 交互模式（问答/计划），按会话持久化，供跨设备对齐。 */
  interactionMode?: 'qa' | 'plan';
  /** 选中的模型标识，按会话持久化，供跨设备对齐。 */
  model?: string;
  /** 定向业务 agent id，按会话持久化，供跨设备对齐。 */
  agentId?: string;
}

/** 调用链路追踪树的瞬态构建上下文（每会话独立，支持多个会话并发流式互不干扰）。 */
interface TraceCtx {
  root: TraceNode | null;
  parent: TraceNode | null;
  llm: TraceNode | null;
  lastTool: TraceNode | null;
  seq: number;
}

/* ------------------------------ Chat ------------------------------ */

@customElement('ah-chat')
export class AhChat extends LitElement {
  static styles = [sharedStyles, chatStyles];

  @state() sessions: SessionView[] = [];
  @state() activeId = '';
  @state() messages: ChatMsg[] = [];
  @state() input = '';
  @state() model = '';
  @state() mode: RunMode = 'mock';

  /** 交互模式（P0）：qa=问答（直接回答）；plan=计划（先出计划→确认→逐任务执行）。
   *  localStorage 持久化跨刷新记忆。模式语义仅存在于前端，服务端只按字段透传。 */
  @state() interactionMode: 'qa' | 'plan' = 'qa';

  /** 计划执行状态（key 为携带计划的消息 id）。 */
  @state() private planExec: Record<number, PlanExecState> = {};
  @state() deepThink = true;
  @state() web = false;

  /** 每条助手消息的深度思考折叠态（key 为 message id），用于手动收起思考区。 */
  @state() thinkCollapsed: Record<string, boolean> = {};

  /** 移动端侧栏抽屉开合态（≤900px 生效）。 */
  @state() sidebarOpen = false;
  /** PC 端侧栏折叠态（默认展开）。 */
  @state() sidebarCollapsed = false;
  @state() error: string | null = null;

  /** 可选的定向业务 agent：为空则走默认通用 Agent。Web 端用它把对话路由到具体插件 agent（如医美客资）。 */
  @state() agents: { id: string; name: string }[] = [];
  @state() agentId = '';

  /** 待发送附件（本地预览用，不在 server 上传时以 DataURL 嵌入消息）。 */
  @state() attachments: UploadedFile[] = [];

  /** 当前全屏预览的附件；null 表示未打开预览。 */
  @state() private previewFile: UploadedFile | null = null;

  /**
   * 长按用户消息的编辑输入框（edit-input）弹出的全屏编辑器是否打开。
   * 与编辑草稿共享同一个 editingDraft，收起后内容回到气泡内原位编辑框。
   */
  @state() private fullscreenEditOpen = false;

  /**
   * 调用链路 / 关键信息 抽屉：当前正在查看的消息（存引用以便流式过程中内容实时刷新）；
   * null 表示抽屉关闭。section 决定抽屉内默认展示「调用链路」树还是「关键信息」摘要。
   * 同屏只开一个抽屉，按钮点击即切换目标消息。
   */
  @state() private traceDrawerMsg: ChatMsg | null = null;
  @state() private traceDrawerSection: 'trace' | 'insights' = 'trace';

  /** 悬停显示操作按钮的用户消息 id（复制 / 编辑）；-1 表示无。 */
  @state() private hoverUserMsgId = -1;

  /** 正在编辑的用户消息 id；-1 表示不在编辑态。 */
  @state() private editingMsgId = -1;

  /** 编辑中的草稿文本。 */
  @state() private editingDraft = '';

  /** 最近一次复制成功的消息 id + 时间戳：按钮短暂变为「已复制 ✓」。 */
  @state() private copiedMsgId = -1;

  /** 复制回执定时器。 */
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  /** 上传中的文件追踪（key 为文件名+时间戳） */
  private uploadingFiles: Map<
    string,
    { status: 'uploading' | 'done' | 'error'; error?: string }
  > = new Map();

  private nextId = 1;
  private scrollRef = createRef<HTMLElement>();

  /** 是否「钉」在底部：用户向上滚动看历史时为 false，新消息不再自动跟随其滚动。 */
  @state() private stickToBottom = true;

  /** 是否显示「回到底部」悬浮按钮（仅当用户离开底部时显示）。 */
  @state() private showScrollDown = false;
  /** 侧栏打开瞬间标记：防止打开后立即被 scrim 点击关闭。 */
  private _sidebarJustOpened = false;

  /** 当前选中模型的上下文窗口上限（token）。来源：模型目录官方 context_length；
   *  0 = 无数据（默认模型 / 自定义模型），「上下文用量」圆环据此隐藏。 */
  private serverCtxWindow = 0;

  /**
   * 是否隐藏「上下文用量」圆环：只有选中「有官方 context_length 的模型」才展示。
   * 默认模型（窗口未知）与自定义模型（无官方数据）一律隐藏 —— 分母不存在，
   * 百分比无意义。serverCtxWindow 仅由 model-change 携带的官方 ctx 写入。
   */
  private hideCtxRing(): boolean {
    return this.serverCtxWindow <= 0;
  }

  /** 是否展开「上下文用量」弹层。 */
  @state() private showCtxUsage = false;

  /** 后端经 SSE `llm:usage` 下发的精确上下文用量（provider usage 为权威总量）。
   *  为 null 时「上下文用量」浮层回退到前端基于消息缓冲的粗估。
   *  注意：窗口占用口径只计「输入」(promptTokens)，不含模型当轮输出(completionTokens)——
   *  输出不会进入下一轮上下文；`totalTokens` 因含 completion 仅用于「累计消耗」展示，
   *  不用于窗口占用圆环，避免圆环被 output 虚高。 */
  @state() private backendUsage: {
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
  } | null = null;

  /** 本运行累计 token 消耗（来自 run:cost 事件的 cumulativeTokens，所有 step 之和）。
   *  与「上下文用量」(单轮窗口占用) 是两个不同指标，分开展示避免混淆。 */
  @state() private runCumulative: { tokens: number; cost: number } | null =
    null;

  /**
   * 每个会话独立的流式缓冲。切换会话时，进行中的 run 仍向所属会话的缓冲写入，
   * 切回时实时恢复 —— 这是「切换会话不中断对话」的核心：
   * 显示用的 this.messages 指向当前会话的缓冲，后台 run 写的是自己的会话缓冲，二者解耦。
   */
  private threads: Record<string, ChatMsg[]> = {};

  /**
   * 会话恢复失败标记（容错持久化）：服务端历史拉取失败且无本地镜像时置 true，
   * 空线程不再被当作「已加载」缓存 —— 下次进入该会话自动重试恢复，直到成功。
   */
  private restoreFailed: Record<string, boolean> = {};

  /** 每个会话当前正在流式的 assistant 消息下标（send 时写入，run 结束后保留，供切回识别）。 */
  private streamIdx: Record<string, number> = {};

  /**
   * 按会话持久化的设置（交互模式 / 模型 / agent）。
   * 切换会话时从本表（优先）或服务端会话元数据加载到当前控件，实现「同一对话两端对齐」。
   * 用户改任一设置即写入本表 + PATCH 服务端 + 经 session:meta 广播给其它端。
   */
  private sessionSettings: Record<string, {
    interactionMode?: 'qa' | 'plan';
    model?: string;
    agentId?: string;
  }> = {};

  /**
   * 跨设备远程流式游标：标记某会话「他端发来的进行中 assistant」是否已在本地线程建了占位。
   * 用于区分「在他端回复上累积（streaming 帧）」与「新建一条本端回复（首帧 / 新轮）」，
   * 避免多轮对话时把新回复误覆盖到上一轮的 assistant 上（此前用「找最后一条 assistant」
   * 会命中旧回复，导致电脑端看不到手机端新回复）。
   */
  private remoteStreaming: Record<string, boolean> = {};

  /** 每个会话是否正在流式（支持多个会话并发进行）。
   *  MUST 为 @state 并以不可变重赋值（this.streaming = {...this.streaming, [sid]: x}）更新：
   *  直接 this.streaming[sid] = x 是对象内属性赋值，Lit 不观测，重渲染不会触发，
   *  会导致 run 结束后 UI 仍停在 streaming===true 的那一帧（一直显示「模型正在回复…」、输入框禁用）。 */
  @state() private streaming: Record<string, boolean> = {};

  /** 不可变更新某会话的流式状态，确保 Lit 触发重渲染（见 streaming 字段注释）。 */
  private setStreaming(sid: string, val: boolean) {
    this.streaming = { ...this.streaming, [sid]: val };
  }

  /** 每会话的打字机缓冲（content / reasoning 分开）。 */
  private pending: Record<string, { content: string; reasoning: string }> = {};

  /** 每会话是否已收到 llm:token 增量（防止 llm:response 整段覆盖打字机效果）。 */
  private received: Record<string, boolean> = {};

  /** run:end 携带的权威全文（仅在打字机未产生任何可见文本时作兜底）。 */
  private finalBy: Record<string, string> = {};

  /** 每会话的调用链路追踪构建上下文。 */
  private traces: Record<string, TraceCtx> = {};

  /** 每会话的中止控制器（仅停止对应会话的 run）。 */
  private abortBy: Record<string, AbortController> = {};

  /* ---------------------- 断线恢复（标签页切换 / 网络中断） ---------------------- */
  /** 每会话当前 run 的 jobId（job:accepted 时记录）：断线重连时凭它重订阅事件重放流。 */
  private jobBy: Record<string, string> = {};

  /** 每会话已收到的最大事件 seq：断线续传游标，服务端只重放 seq 大于它的部分。 */
  private lastSeqBy: Record<string, number> = {};

  /** 每会话是否已收到终结事件（run:end/_done/error）：收到后不再自动重连。 */
  private finishedBy: Record<string, boolean> = {};

  /**
   * 每会话当前 run 是否收到过 error 事件：服务端在模型/运行异常时会先发 error
   * 再照常补发 run:end 收尾，流「正常关闭」≠ 运行成功 —— 计划模式据此把该轮
   * 判为失败并立即中止后续任务派发，而不是带着坏结果继续往下跑。
   */
  private erroredBy: Record<string, boolean> = {};

  /** 每会话最近一次收到 SSE 事件的时间戳：静默看门狗与切回标签页的健康判定依据。 */
  private lastEventAt: Record<string, number> = {};

  /**
   * keepalive 中止标记：看门狗 / 切回标签页时用 abort() 唤醒挂起的 read() 走重连路径。
   * 与用户手动 stop() 共用 AbortController，靠此标记区分「系统触发的中止」与「用户主动停止」。
   */
  private keepAliveAbort: Record<string, boolean> = {};

  /** 每会话最近一次提交的完整 run 入参：彻底断连后供「重新连接」按钮恢复使用。 */
  private lastInputBy: Record<string, Record<string, unknown>> = {};

  /** 静默看门狗定时器：可见状态下某会话长时间无事件则强制唤醒走重连。 */
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  /** 每会话连接状态（驱动顶部横幅）：connected 正常 / reconnecting 自动恢复中 / lost 彻底断开。 */
  @state() private connState: Record<
    string,
    'connected' | 'reconnecting' | 'lost'
  > = {};

  /** 不可变更新某会话的连接状态，确保 Lit 触发重渲染。 */
  private setConn(sid: string, val: 'connected' | 'reconnecting' | 'lost') {
    this.connState = { ...this.connState, [sid]: val };
  }

  private typedTimer: ReturnType<typeof setInterval> | null = null;

  /** 当前是否仍有任何会话在流式（用于打字机定时器的停启判定）。 */
  private get anyStreaming(): boolean {
    for (const k in this.streaming) if (this.streaming[k]) return true;
    return false;
  }

  /** 取（或惰性创建）某会话的消息缓冲。 */
  private threadFor(sid: string): ChatMsg[] {
    return this.threads[sid] ?? (this.threads[sid] = []);
  }

  /**
   * 把某会话当前消息缓冲经接口层写入历史镜像（容错持久化，服务端 SQLite 存储）。
   * - 写入独立于恢复流程与 run 结果：发送时与 run 收尾时各写一次，任何错误场景下数据都已可靠保存；
   * - 异步 fire-and-forget：内部吞掉网络/校验异常并降级进程内缓存（见 chat-history.ts），绝不阻塞 UI。
   */
  private saveHistory(sid: string) {
    const t = this.threads[sid];
    if (!t || !t.length) return;
    const meta = this.sessions.find((s) => s.id === sid);
    // 会话级用量快照：随历史一并落盘，刷新/切换会话后回填上下文用量浮层。
    const usage: MirroredUsage | null = {
      backendUsage: this.backendUsage
        ? {
            window: this.backendUsage.window,
            promptTokens: this.backendUsage.promptTokens,
            completionTokens: this.backendUsage.completionTokens,
            totalTokens: this.backendUsage.totalTokens,
            breakdown: {
              system: this.backendUsage.breakdown.system,
              tools: this.backendUsage.breakdown.tools,
              messages: this.backendUsage.breakdown.messages,
              mcp: this.backendUsage.breakdown.mcp,
              skills: this.backendUsage.breakdown.skills,
              completion: this.backendUsage.breakdown.completion
            }
          }
        : null,
      runCumulative: this.runCumulative
        ? { tokens: this.runCumulative.tokens, cost: this.runCumulative.cost }
        : null
    };
    void saveThread(
      sid,
      { title: meta?.title ?? '新对话', updatedAt: Date.now() },
      t,
      usage
    );
  }

  /** 取某会话当前流式消息。 */
  private curSession(sid: string): ChatMsg | null {
    const idx = this.streamIdx[sid];
    const t = this.threads[sid];
    return idx >= 0 && t && t[idx] ? t[idx] : null;
  }

  /**
   * 取「截至当前」的会话消息快照，用于调用链路 LLM 节点的「消息上下文」回看。
   * 与以往在 llm:call 时一次性冻结不同，这里随流式推进实时读取 this.threads，
   * 因此助手回复生成后会自动纳入，避免「调用链路里只剩用户消息、助手回复丢失」的问题。
   * 末尾尚未产生内容的 assistant 占位（流式刚开始、本轮回复还没来）不计入。
   */
  private snapshotTraceMessages(sid: string): ChatMessage[] {
    const t = this.threads[sid];
    if (!Array.isArray(t) || !t.length) return [];
    const msgs = t.slice();
    while (
      msgs.length &&
      msgs[msgs.length - 1].role === 'assistant' &&
      !(msgs[msgs.length - 1].content ?? '')
    ) {
      msgs.pop();
    }
    return msgs.map(
      (m): ChatMessage => ({
        role: m.role as ChatMessage['role'],
        content: m.content ?? '',
        ts: typeof m.id === 'number' ? m.id : Date.now(),
        ...(m.reasoning ? { reasoning: m.reasoning } : {})
      })
    );
  }

  /** 流式推进中刷新当前 LLM 节点的消息上下文快照与计数标签。 */
  private refreshLlmTraceMessages(
    sid: string,
    tc: ReturnType<typeof this.traceCtx>
  ) {
    if (!tc.llm) return;
    const snap = this.snapshotTraceMessages(sid);
    tc.llm.messages = snap;
    if (tc.llm.meta) {
      tc.llm.meta = { ...tc.llm.meta, messages: `消息 ${snap.length || '?'}` };
    }
  }

  /**
   * 用当前线程完整内容重建某会话追踪树中所有 LLM 节点的 messages 上下文。
   * run 收尾时调用：避免打字机缓冲在落盘前尚未完全揭示，导致 trace 中 assistant
   * 内容缺失或为空。
   */
  private rebuildTraceMessages(sid: string) {
    const tc = this.traces[sid];
    if (!tc?.root) return;
    const t = this.threads[sid];
    if (!t?.length) return;
    const fullMsgs = this.snapshotTraceMessages(sid);
    const countFromMeta = (meta?: Record<string, string>) => {
      const raw = meta?.messages ?? '';
      const m = raw.match(/(\d+)/);
      return m ? Number(m[1]) : 0;
    };
    const walk = (node: TraceNode) => {
      if (node.kind === 'llm' && node.messages) {
        const want = countFromMeta(node.meta);
        if (want > 0) {
          node.messages = fullMsgs.slice(0, Math.min(want, fullMsgs.length));
        }
      }
      node.children.forEach(walk);
    };
    walk(tc.root);
  }

  /**
   * 恢复历史后补全已落盘 trace 中 assistant 消息的内容。
   * 服务端/前端在 llm:call 时 assistant 可能尚未生成，导致旧 trace 的 messages 中
   * assistant 条目内容为空；用当前线程中同序号的 assistant 实际内容回填。
   */
  private restoreTraceMessages(sid: string) {
    const t = this.threads[sid];
    if (!t?.length) return;
    const assistants = t.filter((m) => m.role === 'assistant');
    for (const m of t) {
      if (!m.trace?.length || m.role !== 'assistant') continue;
      for (const root of m.trace) {
        const walk = (node: TraceNode) => {
          if (node.kind === 'llm' && node.messages) {
            let ai = 0;
            for (const msg of node.messages) {
              if (msg.role === 'assistant') {
                const src = assistants[ai++];
                if (src) {
                  msg.content = src.content ?? '';
                  if (src.reasoning) msg.reasoning = src.reasoning;
                }
              }
            }
          }
          node.children.forEach(walk);
        };
        walk(root);
      }
    }
  }

  /** 写入某会话的流式消息（streamIdx 指向的那条），并在该会话为当前显示会话时同步 this.messages 触发重渲染。 */
  private patchSession(sid: string, p: Partial<ChatMsg>) {
    const idx = this.streamIdx[sid];
    if (idx == null || idx < 0) return;
    const t = this.threads[sid];
    if (!t || !t[idx]) return;
    const nt = t.slice();
    nt[idx] = { ...nt[idx], ...p };
    this.threads[sid] = nt;
    if (sid === this.activeId) this.messages = nt;
    // 流式消息已写入会话缓冲：同步刷新调用链路 LLM 节点的「消息上下文」快照，
    // 使助手回复生成后自动纳入调用链路（修复「切换/回看时助手消息丢失」）。
    const tc = this.traces[sid];
    if (tc && tc.llm) this.refreshLlmTraceMessages(sid, tc);
  }

  /** 重置某会话的调用链路追踪瞬态状态（防御上轮残留泄漏到本轮）。 */
  private resetTrace(sid: string) {
    this.traces[sid] = {
      root: null,
      parent: null,
      llm: null,
      lastTool: null,
      seq: 0
    };
  }
  private traceCtx(sid: string): TraceCtx {
    return (
      this.traces[sid] ??
      (this.traces[sid] = {
        root: null,
        parent: null,
        llm: null,
        lastTool: null,
        seq: 0
      })
    );
  }

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.onPreviewKeydown);
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    // 恢复上次选择的交互模式（问答/计划），跨刷新记忆。
    try {
      const saved = localStorage.getItem('ah_interaction_mode');
      if (saved === 'plan' || saved === 'qa') this.interactionMode = saved;
    } catch {
      /* ignore */
    }
    // 恢复上次的模型选择与深度思考/联网开关，跨刷新记忆。
    try {
      const m = localStorage.getItem('ah_model');
      if (m !== null) this.model = m;
      // 深度思考默认开启：不再从 localStorage 恢复关闭态 ——
      // 用户会话内可随时关闭，但刷新后一律回到默认开启。
      this.deepThink = true;
      const w = localStorage.getItem('ah_web');
      if (w !== null) this.web = w === '1';
    } catch {
      /* ignore */
    }
    // 断线恢复：切回标签页时立即体检所有流式会话；后台期间连接可能已被浏览器
    // （Memory Saver 冻结 / 节流）或代理掐断，返回后第一时间唤醒重连路径。
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    // 静默看门狗：可见状态下流式会话超过 60s 无任何事件（read() 可能静默挂死），
    // 强制中止走统一重连。恢复按 seq 游标续传，误触发无副作用，仅多一次重订阅。
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => this.silentWatchdog(), 5000);
    }
    // 会话列表加载（容错）：带超时 + 失败自动重试一次；最终失败也不清空 ——
    // 降级为本地镜像索引渲染入口，保证服务端不可达 / 曾发生恢复失败时历史会话仍可见可打开。
    const loadList = () =>
      withTimeout(client.listChatSessions(), 6000, '加载会话列表');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const list = await loadList();
        this.sessions = list.map((s: ChatSession) => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          interactionMode: s.interactionMode,
          model: s.model,
          agentId: s.agentId
        }));
        break;
      } catch {
        if (attempt === 1) {
          const idx = await loadIndex();
          this.sessions = Object.entries(idx).map(([sid, m]) => ({
            id: sid,
            title: m.title,
            updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : m.savedAt,
            interactionMode: (m as any).interactionMode,
            model: (m as any).model,
            agentId: (m as any).agentId
          }));
        }
      }
    }
    // 用镜像索引补齐入口（服务端列表为空 / 缺项时，保证历史会话可见）。
    // 典型场景：服务端重启后 chat-sessions 内存态清空（无 CHAT_SESSIONS_FILE），
    // 但 history 镜像仍落 SQLite；此处兜底从 /api/history 索引补全。
    {
      const known = new Set(this.sessions.map((s) => s.id));
      const idx = await loadIndex();
      const extra = Object.entries(idx)
        .filter(([sid]) => !known.has(sid))
        .map(([sid, m]) => ({
          id: sid,
          title: m.title,
          updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : m.savedAt,
          interactionMode: (m as any).interactionMode,
          model: (m as any).model,
          agentId: (m as any).agentId
        }));
      if (extra.length) this.sessions = [...this.sessions, ...extra];
    }
    try {
      const state = await client.getState();
      this.mode = (state as any)?.openrouter ? 'real' : 'mock';
      // /api/state 的 contextWindow 只是服务端兜底基线（无官方数据时 128K），
      // 不作为「默认模型」的真实窗口 —— 默认模型同样隐藏用量展示。
    } catch {
      /* 离线/未启动：发送时按 mock 兜底 */
    }
    // 拉取 agent 列表（失败不影响聊天，selector 退化为仅「默认 Agent」）。
    await this.refreshAgents();
    // 插件启用/停用会改变已注册 agent 集合，监听后实时刷新下拉（使已禁用插件的 agent 即时隐藏）。
    window.addEventListener('ah-plugins-changed', this.onPluginsChanged as EventListener);
    // 跨刷新恢复上次会话：读取持久化的 activeId，若存在则自动打开并渲染历史消息
    // （历史镜像经 /api/v1/history 落 SQLite，刷新不丢）。无标记则保持空白新对话。
    try {
      const saved = localStorage.getItem('ah_active_id');
      if (saved) void this.selectSession(saved);
    } catch {
      /* ignore */
    }
    // 跨设备实时同步：登录后建立常驻 SSE，接收本账户其它端写入的增量消息/标题/删除。
    // 已登录（本地有用户名）才启动；未登录（匿名）无 owner，服务端会 401，无需连接。
    if (getUsername()) {
      window.addEventListener('ah-chat-sync', this.onChatSync as EventListener);
      startChatSync(getUsername());
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onPreviewKeydown);
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    // 跨设备实时同步：组件卸载时停掉常驻 SSE 并移除事件监听（避免泄漏/重复订阅）。
    window.removeEventListener(
      'ah-chat-sync',
      this.onChatSync as EventListener
    );
    stopChatSync();
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    this.cancelComposerLongPress();
    window.removeEventListener('ah-plugins-changed', this.onPluginsChanged as EventListener);
  }

  /**
   * 消费 chat-sync.ts 经 window CustomEvent 派发的跨设备同步事件。
   * 四类事件：session:list（重拉列表）/ session:meta（标题时间）/ session:remove（删除）/
   * message:append（增量消息）。本端自己发出的回声（origin===MY_ORIGIN）由服务端不广播给
   * 发送端、且前端发送时已本地乐观插入，故此处收到的 message:append 一律视为「他端」增量，
   * 按内容去重后追加，绝不重复渲染。
   */
  private onChatSync = (ev: Event) => {
    const e = (ev as CustomEvent<ChatSyncEvent>).detail;
    if (!e || typeof e !== 'object') return;
    switch (e.type) {
      case 'session:list':
        // 新建/批量变更：重拉列表（带超时容错），与 connectedCallback 同款降级。
        void this.refreshSessions();
        break;
      case 'session:meta':
        // 标题/时间/按会话设置变更：原地更新列表项，无需重拉全量。
        this.patchSessionMeta(e.session, e.title, e.updatedAt, {
          interactionMode: e.interactionMode,
          model: e.model,
          agentId: e.agentId
        });
        break;
      case 'session:remove':
        this.removeSessionFromList(e.session);
        break;
      case 'message:append':
        // 他端写入的增量消息（含进行中流式快照）：按 origin 忽略本端回声，其余去重后合并。
        this.appendRemoteMessage(e.session, e.message, e.origin);
        break;
      default:
        break;
    }
  };

  /** 跨设备：重拉会话列表（容错降级，与 connectedCallback 一致）。 */
  private async refreshSessions() {
    try {
      const list = await withTimeout(
        client.listChatSessions(),
        6000,
        '同步会话列表'
      );
      const mapped = list.map((s: ChatSession) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        interactionMode: s.interactionMode,
        model: s.model,
        agentId: s.agentId
      }));
      this.sessions = [...mapped];
      // 用本地镜像索引补齐（服务端列表为空/缺项时历史会话仍可见）。
      const known = new Set(this.sessions.map((s) => s.id));
      const idx = await loadIndex();
      const extra = Object.entries(idx)
        .filter(([sid]) => !known.has(sid))
        .map(([sid, m]) => ({
          id: sid,
          title: m.title,
          updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : m.savedAt,
          interactionMode: (m as any).interactionMode,
          model: (m as any).model,
          agentId: (m as any).agentId
        }));
      if (extra.length) this.sessions = [...this.sessions, ...extra];
    } catch {
      /* 同步失败不阻断：下一次 enter/列表交互会重试 */
    }
  }

  /**
   * 重拉 agent 列表（写入 this.agents）。
   * 注意：后端默认 agent 的 id 为 'default'（非空串），而前端 agentId 初始值为 ''（表示「走默认」）。
   * 若直接把 'default' 塞进列表，则列表项 id 与 agentId('') 永远对不上 → 选中态(selected/✓)永远不命中，
   * 表现为「点开下拉却没有任何项高亮」。这里把后端 'default' 归一到 ''，并保证列表始终含一个
   * id='' 的默认项，从而 agentId('') 能稳定命中、默认项在展开时高亮 + 打勾。
   * 失败不影响聊天：selector 退化为仅「默认 Agent」。
   */
  private async refreshAgents() {
    try {
      const res = await client.listAgents();
      const raw = ((res?.agents as any[]) ?? []).map((a) => ({
        id: String(a.id),
        name: String(a.name ?? a.id)
      }));
      const hasDefault = raw.some((a) => a.id === 'default' || a.id === '');
      const next = hasDefault
        ? raw.map((a) => (a.id === 'default' ? { ...a, id: '' } : a))
        : [{ id: '', name: '默认' }, ...raw];
      this.agents = next;
      // 当前选中的 agent 若已随插件禁用而从注册表消失，回退到「默认」。
      if (this.agentId && !next.some((a) => a.id === this.agentId)) {
        this.agentId = '';
      }
    } catch {
      /* 拉取失败不阻断聊天：保持上一次列表（或初始化时的默认项） */
    }
  }

  /**
   * 插件启用/停用后，已注册 agent 集合变化，实时重拉下拉，使被禁用插件的 agent 即时从列表中消失。
   * 由 plugins-console 经 window 事件 'ah-plugins-changed' 广播触发。
   */
  private onPluginsChanged = () => {
    void this.refreshAgents();
  };

  /** 跨设备：原地更新列表中某会话的标题与时间（不重排，仅刷字段）。 */
  private patchSessionMeta(
    sid: string,
    title: string,
    updatedAt: number,
    meta?: {
      interactionMode?: 'qa' | 'plan';
      model?: string;
      agentId?: string;
    }
  ) {
    let changed = false;
    this.sessions = this.sessions.map((s) => {
      if (s.id !== sid) return s;
      changed = true;
      return {
        ...s,
        title: title || s.title,
        updatedAt,
        interactionMode: meta?.interactionMode !== undefined ? meta.interactionMode : s.interactionMode,
        model: meta?.model !== undefined ? meta.model : s.model,
        agentId: meta?.agentId !== undefined ? meta.agentId : s.agentId
      };
    });
    if (!changed) {
      // 列表里没有该会话（如他端新建后本端尚未见）：加入入口。
      this.sessions = [
        ...this.sessions,
        {
          id: sid,
          title,
          updatedAt,
          interactionMode: meta?.interactionMode,
          model: meta?.model,
          agentId: meta?.agentId
        }
      ];
    }
    // 若正打开该会话，按最新设置刷新当前控件，实现「两端实时对齐」。
    if (this.activeId === sid) {
      if (meta?.interactionMode !== undefined) this.interactionMode = meta.interactionMode;
      if (meta?.model !== undefined) this.model = meta.model;
      if (meta?.agentId !== undefined) this.agentId = meta.agentId;
    }
  }

  /** 跨设备：从列表中移除被他端删除的会话；若正打开则回退到空。 */
  private removeSessionFromList(sid: string) {
    this.sessions = this.sessions.filter((s) => s.id !== sid);
    if (this.activeId === sid) {
      this.activeId = '';
      this.messages = [];
      try {
        localStorage.removeItem('ah_active_id');
      } catch {
        /* ignore */
      }
    }
    // 同时清理本地线程缓冲与镜像，避免残留。
    delete this.threads[sid];
    void purgeSessionMirror(sid).catch(() => {});
  }

  /**
   * 跨设备：把他端追加的消息写入对应会话线程。
   * - origin===MY_ORIGIN（本端自己的回声）：直接忽略，本端已用本地 run 流渲染，避免重复。
   * - role==='user'：末尾相同内容则跳过（防重放），否则追加一条。
   * - role==='assistant' 且带 streaming 标记：进行中增量快照，累积覆盖该会话最后一条
   *   assistant（仅当更长，防乱序/重复帧覆盖）；无 assistant 占位则先建一条。
   * - role==='assistant' 带 final 标记（或完整消息无 streaming）：用权威全文覆盖最后一条
   *   assistant（或追加），收尾本次远程流式。
   */
  private appendRemoteMessage(sid: string, raw: unknown, origin?: string) {
    if (!raw || typeof raw !== 'object') return;
    // 本端回声：发送端自己的 /api/chat/stream 也会收到 chat-bus 的 fanout，凭 origin 丢弃，
    // 本端完全依赖本地 run 的 send(e) 流，不使用回声，避免重复/覆盖本地正在流式的内容。
    if (origin && origin === MY_ORIGIN) return;
    const m = raw as Partial<ChatMessage> & {
      role?: string;
      content?: string;
      reasoning?: string;
      streaming?: boolean;
      final?: boolean;
    };
    const role: 'user' | 'assistant' = m.role === 'user' ? 'user' : 'assistant';
    const content = typeof m.content === 'string' ? m.content : '';
    const t = this.threadFor(sid);

    if (role === 'user') {
      const last = t[t.length - 1];
      if (
        last &&
        last.role === 'user' &&
        (last.content ?? '') === content &&
        content.length > 0
      ) {
        return; // 重复，跳过
      }
      t.push({
        id: this.nextId++,
        role: 'user',
        content,
        ...(typeof m.reasoning === 'string' && m.reasoning
          ? { reasoning: m.reasoning }
          : {}),
        ...(Array.isArray(m.tools) && m.tools.length
          ? { tools: m.tools as ToolView[] }
          : {}),
        ...(Array.isArray(m.trace) && m.trace.length
          ? { trace: m.trace as TraceNode[] }
          : {})
      });
      this.threads[sid] = t;
      this.patchSessionMeta(
        sid,
        this.sessions.find((s) => s.id === sid)?.title ?? '',
        typeof m.ts === 'number' ? m.ts : Date.now()
      );
      if (this.activeId === sid) this.messages = t;
      return;
    }

    // assistant：多轮对话下，最后一条 assistant 很可能是上一轮的旧回复，不能盲目覆盖。
    // 用 remoteStreaming[sid] 游标区分两种情形：
    //   - 游标为 false（首帧 / 新一轮回复）：在末尾【追加】一条新 assistant 占位，并置游标。
    //   - 游标为 true（后续 streaming 帧）：在刚追加的那条上累积（仅当更长，防乱序帧）。
    //   - 收到 final/完整帧：直接覆盖游标指向的那条（即本端回复），并清游标收尾。
    if (!this.remoteStreaming[sid]) {
      // 新一轮远程回复：追加新 assistant（不再找「最后一条 assistant」，避免覆盖旧轮回复）。
      const msg: ChatMsg = {
        id: this.nextId++,
        role: 'assistant',
        content,
        ...(typeof m.reasoning === 'string' && m.reasoning ? { reasoning: m.reasoning } : {}),
        ...(Array.isArray(m.tools) && m.tools.length ? { tools: m.tools as ToolView[] } : {}),
        ...(Array.isArray(m.trace) && m.trace.length ? { trace: m.trace as TraceNode[] } : {})
      };
      t.push(msg);
      this.remoteStreaming[sid] = true; // 标记：后续该会话的增量/终态都作用在这条上
    } else {
      const idx = t.length - 1;
      const cur = t[idx];
      if (!cur || cur.role !== 'assistant') {
        // 防御：游标为真却末尾非 assistant（理论上不会），补建并修正。
        const msg: ChatMsg = {
          id: this.nextId++,
          role: 'assistant',
          content
        };
        t.push(msg);
      } else {
        const reasoning =
          typeof m.reasoning === 'string' && m.reasoning ? m.reasoning : cur.reasoning;
        // 终态/流式帧同样携带 tools / trace（服务端完整消息含调用链路）：
        // 必须从 m 合并进来，否则他端同步后「调用链路 / 关键信息」按钮因缺 trace 而不显示。
        const extra = {
          ...(reasoning ? { reasoning } : {}),
          ...(Array.isArray(m.tools) && m.tools.length ? { tools: m.tools as ToolView[] } : {}),
          ...(Array.isArray(m.trace) && m.trace.length ? { trace: m.trace as TraceNode[] } : {})
        };
        if (m.streaming) {
          // 进行中快照：仅当新内容更长时覆盖（防乱序/重复帧把已揭示文本截断）。
          if (content.length >= (cur.content ?? '').length) {
            t[idx] = { ...cur, content, ...extra };
          }
        } else {
          // 完整 / 终态：用权威全文直接覆盖本端回复（含 tools/trace）。
          t[idx] = { ...cur, content, ...extra };
          this.remoteStreaming[sid] = false; // 收尾，下一轮重新追加
        }
      }
    }
    this.threads[sid] = t;
    this.patchSessionMeta(
      sid,
      this.sessions.find((s) => s.id === sid)?.title ?? '',
      typeof m.ts === 'number' ? m.ts : Date.now()
    );
    if (this.activeId === sid) this.messages = t;
  }

  /**
   * 切回标签页（visibilitychange→visible）：对流式中的会话做连接体检。
   * - 已标记 lost：立即唤醒重连；
   * - 超过 10s 无任何事件：视为后台期间连接已被冻结/回收，abort 唤醒挂起的
   *   read()，统一走 runWithReconnect 的续传路径（keepAliveAbort 标记区分用户停止）。
   */
  private onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return;
    for (const sid in this.streaming) {
      if (!this.streaming[sid] || this.finishedBy[sid]) continue;
      const silentFor = Date.now() - (this.lastEventAt[sid] ?? Date.now());
      const lost = this.connState[sid] === 'lost';
      if (lost || silentFor > 10_000) {
        this.keepAliveAbort[sid] = true;
        if (this.abortBy[sid]) this.abortBy[sid]?.abort();
        else void this.resumeLost(sid);
      }
    }
  };

  /** 静默看门狗：可见状态下流式会话 60s 无事件则强制唤醒重连（防御 read() 静默挂死）。 */
  private silentWatchdog() {
    if (document.visibilityState !== 'visible') return;
    for (const sid in this.streaming) {
      if (!this.streaming[sid] || this.finishedBy[sid]) continue;
      const silentFor = Date.now() - (this.lastEventAt[sid] ?? Date.now());
      if (silentFor > 60_000 && !this.keepAliveAbort[sid]) {
        this.keepAliveAbort[sid] = true;
        this.abortBy[sid]?.abort();
      }
    }
  }

  protected updated() {
    this.scrollToBottom();
    this.scrollThinkToBottom();
  }

  /**
   * 上下文用量弹层外点关闭兜底（document 级 pointerdown）：
   * 不依赖 CSS 几何 —— 即便未来某祖先的 transform/filter 再次劫持 fixed 遮罩
   * 的包含块，点空白仍能可靠关闭。
   * 注意必须用 composedPath() 判断命中：弹层在 ah-chat 的 shadow root 内，
   * document 监听拿到的 e.target 已被重定向到宿主元素，closest 会失配。
   */
  private onDocPointerDown = (e: PointerEvent) => {
    if (!this.showCtxUsage) return;
    const path = e.composedPath();
    const inside = path.some(
      (n) =>
        n instanceof Element &&
        (n.classList.contains('ctx-pop') ||
          n.classList.contains('ctx-ring-wrap'))
    );
    if (!inside) this.showCtxUsage = false;
  };

  private scrollToBottom() {
    // 仅当用户处于「钉底」状态时才自动跟随到底部；
    // 用户若向上滚动看历史（stickToBottom=false），则保持当前位置不抢滚。
    const el = this.scrollRef.value;
    if (el && this.stickToBottom) el.scrollTop = el.scrollHeight;
  }

  /**
   * 监听消息区滚动：计算距底部距离，决定是否「钉底」跟随，并驱动浮动按钮显隐。
   * 阈值 24px：容忍亚像素/轻微回弹，认为已到底部则隐藏按钮、恢复跟随。
   */
  private onScroll() {
    const el = this.scrollRef.value;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= 24;
    this.stickToBottom = atBottom;
    this.showScrollDown = !atBottom;
  }

  /** 点击浮动按钮：平滑滚动回到底部，并重新开启「钉底」跟随（到底后按钮会被滚动事件自动隐藏）。 */
  private scrollToBottomSmooth() {
    const el = this.scrollRef.value;
    if (!el) return;
    this.stickToBottom = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  /**
   * 估算当前线程占用模型上下文窗口的比例，按维度拆分（参考宿主「上下文用量」浮层）。
   * 数据来自当前消息缓冲（对话内容 / 推理 / 工具调用 / 附件），系统提示词与 MCP / 技能为基线粗估。
   * 注意：这是前端基于字符数的粗估（≈ 字符/3），仅用于趋势提示，并非后端精确 token 计数。
   */
  private contextUsage(): {
    totalPct: number;
    totalTokens: number;
    window: number;
    items: {
      key: string;
      label: string;
      tokens: number;
      pct: number;
      cls: string;
    }[];
  } {
    // 分母：仅使用已知的真实窗口（服务端默认模型 → /api/state 下发；具体模型 →
    // 模型目录官方 context_length）。不再写死 128K 兜底 —— 拿不到窗口数据时
    // hideCtxRing() 已把整个圆环隐藏，本方法不会被调用。
    if (this.serverCtxWindow <= 0) {
      return { totalPct: 0, totalTokens: 0, window: 0, items: [] };
    }
    const WINDOW = this.serverCtxWindow;
    const SYS_BASE = 1400; // 系统提示词 + Agent 卡片基线
    const MCP_BASE = 60; // 连接器及 MCP 注册信息基线
    const SKILL_BASE = 80; // 技能基线
    const tok = (s?: string) => (s ? Math.ceil([...s].length / 3) : 0);
    let msgTokens = 0;
    let toolTokens = 0;
    for (const m of this.messages) {
      msgTokens += tok(m.content) + tok(m.reasoning);
      for (const a of m.attachments ?? []) msgTokens += 1200; // 每图约 1.2K token
      for (const t of m.tools ?? []) toolTokens += tok(t.args) + tok(t.result);
    }
    const items = [
      {
        key: 'sys',
        label: '系统提示词',
        tokens: SYS_BASE,
        cls: 'c-sys',
        pct: 0
      },
      {
        key: 'tools',
        label: '工具及子智能体',
        tokens: toolTokens,
        cls: 'c-tools',
        pct: 0
      },
      {
        key: 'msg',
        label: '对话消息',
        tokens: msgTokens,
        cls: 'c-msg',
        pct: 0
      },
      {
        key: 'mcp',
        label: '连接器及 MCP',
        tokens: MCP_BASE,
        cls: 'c-mcp',
        pct: 0
      },
      {
        key: 'skill',
        label: '技能',
        tokens: SKILL_BASE,
        cls: 'c-skill',
        pct: 0
      }
    ];
    const totalTokens = items.reduce((s, it) => s + it.tokens, 0);
    const totalPct = Math.min(100, (totalTokens / WINDOW) * 100);
    for (const it of items) it.pct = (it.tokens / WINDOW) * 100;
    return { totalPct, totalTokens, window: WINDOW, items };
  }

  /**
   /** 返回「上下文用量」浮层当前应展示的数据：优先用后端精确计数（llm:usage），
    * 未拿到后端数据（如 mock 模式、首屏）时回退到前端基于消息缓冲的粗估（contextUsage()）。
    * 两种来源统一成相同结构，渲染层无需关心数据出处。
    *
    * 窗口占用口径：totalTokens 取 promptTokens（仅输入，不含模型当轮输出 completion），
    * 因为下一轮上下文只由输入构成；`totalTokens`（含 output）另用于「累计消耗」展示。
    */
  private displayContextUsage(): {
    totalPct: number;
    totalTokens: number;
    window: number;
    items: {
      key: string;
      label: string;
      tokens: number;
      pct: number;
      cls: string;
    }[];
  } {
    const u = this.backendUsage;
    if (u) {
      const items = [
        {
          key: 'sys',
          label: '系统提示词',
          tokens: u.breakdown.system,
          cls: 'c-sys',
          pct: 0
        },
        {
          key: 'tools',
          label: '工具及子智能体',
          tokens: u.breakdown.tools,
          cls: 'c-tools',
          pct: 0
        },
        {
          key: 'msg',
          label: '对话消息',
          tokens: u.breakdown.messages,
          cls: 'c-msg',
          pct: 0
        },
        {
          key: 'mcp',
          label: '连接器及 MCP',
          tokens: u.breakdown.mcp,
          cls: 'c-mcp',
          pct: 0
        },
        {
          key: 'skill',
          label: '技能',
          tokens: u.breakdown.skills,
          cls: 'c-skill',
          pct: 0
        }
      ];
      // 窗口占用只算输入（promptTokens），不含当轮输出 completion。
      const totalTokens = u.promptTokens;
      const totalPct = Math.min(100, (totalTokens / u.window) * 100);
      for (const it of items) it.pct = (it.tokens / u.window) * 100;
      return { totalPct, totalTokens, window: u.window, items };
    }
    // 后端精确计数暂未到位（mock 模式 / 首屏尚未触发 LLM）时，
    // 回退到前端基于消息缓冲的粗估，避免递归调用自身导致栈溢出。
    return this.contextUsage();
  }

  /** token 数缩写：78700 → "78.7K"（hover 提示 / 弹层用）。 */
  private fmtK(n: number): string {
    return `${(n / 1000).toFixed(1)}K`;
  }

  /**
   * 上下文用量圆环（环形进度条）：置于输入框发送按钮旁。
   * - 悬停：显示「上下文已使用：xx.x% - 用量/总量」提示；
   * - 点击：切换分类占比弹层（显示逻辑与原头部按钮一致）；
   * - >80% 时进度环转警示红。
   */
  private renderCtxRing() {
    const u = this.displayContextUsage();
    const pct = Math.min(100, u.totalPct);
    const R = 15.5;
    const C = 2 * Math.PI * R;
    const offset = C * (1 - pct / 100);
    return html`
      <div class="ctx-ring-wrap">
        <button
          class="ctx-ring"
          aria-label="上下文用量"
          @click=${() => (this.showCtxUsage = !this.showCtxUsage)}
        >
          <svg viewBox="0 0 36 36" role="img" aria-hidden="true">
            <circle
              class="ring-bg"
              cx="18"
              cy="18"
              r=${R}
              stroke-width="3"
            ></circle>
            <circle
              class="ring-fg ${pct > 80 ? 'warn' : ''}"
              cx="18"
              cy="18"
              r=${R}
              stroke-width="3"
              stroke-dasharray=${C.toFixed(2)}
              stroke-dashoffset=${offset.toFixed(2)}
              transform="rotate(-90 18 18)"
            ></circle>
            <text
              class="ring-num"
              x="18"
              y="18"
              text-anchor="middle"
              dominant-baseline="central"
            >
              ${Math.round(pct)}%
            </text>
          </svg>
        </button>
        <span class="ctx-tip"
          >上下文已使用：${pct.toFixed(1)}% -
          ${this.fmtK(u.totalTokens)}/${this.fmtK(u.window)}</span
        >
        ${this.showCtxUsage
          ? html`<button
                class="ctx-scrim"
                aria-label="关闭上下文用量"
                @click=${() => (this.showCtxUsage = false)}
              ></button>
              <div class="ctx-pop">
                <div class="ctx-pop-head">
                  <span>上下文用量</span>
                  <button
                    class="ctx-pop-close"
                    title="关闭"
                    aria-label="关闭"
                    @click=${() => (this.showCtxUsage = false)}
                  >
                    ×
                  </button>
                </div>
                <div class="ctx-bar-meta">
                  <span class="ctx-bar-pct">${u.totalPct.toFixed(1)}%</span>
                  <span class="ctx-bar-total">
                    已使用 ${this.fmtK(u.totalTokens)} /
                    ${this.fmtK(u.window)}</span
                  >
                </div>
                <div class="ctx-seg">
                  ${u.items.map(
                    (it) => html`<span
                      class="ctx-seg-i ${it.cls}"
                      style="width:${it.pct}%"
                      title="${it.label} ${it.pct.toFixed(1)}%"
                    ></span>`
                  )}
                </div>
                <ul class="ctx-list">
                  ${u.items.map(
                    (it) => html`<li>
                      <span class="ctx-dot ${it.cls}"></span>
                      <span class="ctx-label">${it.label}</span>
                      <span class="ctx-val">${it.pct.toFixed(1)}%</span>
                    </li>`
                  )}
                  ${this.runCumulative
                    ? html`<li class="ctx-cum">
                        <span class="ctx-dot c-cum"></span>
                        <span class="ctx-label">本运行累计</span>
                        <span class="ctx-val"
                          >${this.fmtK(this.runCumulative.tokens)} ·
                          ${this.runCumulative.cost > 0
                            ? `$${this.runCumulative.cost.toFixed(4)}`
                            : '免费'}</span
                        >
                      </li>`
                    : nothing}
                </ul>
              </div>`
          : nothing}
      </div>
    `;
  }

  /**
   * 深度思考区流式（打字机）输出时，若内容已撑满 180px 上限，
   * 始终将视口钉在底部，保证最新推理「从下往上」逐字可见。
   * 只在思考区处于 live（流式、未折叠）时生效，思考结束后不再抢滚动，
   * 方便用户自由回看上面的推理文本。
   */
  private scrollThinkToBottom() {
    requestAnimationFrame(() => {
      const tb = this.renderRoot.querySelector(
        '.think.live .think-body'
      ) as HTMLElement | null;
      // 折叠时不跟随滚动（用户主动隐藏），展开时才自动滚到底
      if (tb && !tb.closest('.think.collapsed')) tb.scrollTop = tb.scrollHeight;
    });
  }

  /* ----------------------- 会话管理 ----------------------- */

  private async newChat() {
    // 不中止任何进行中的 run：后台 run 继续写入其所属会话缓冲，新建对话只是切换显示到空线程。
    this.activeId = '';
    this.messages = [];
    this.input = '';
    this.error = null;
    this.stickToBottom = true;
    this.showScrollDown = false;
    this.backendUsage = null;
    this.runCumulative = null;
    // 清空「上次会话」标记，刷新后进入空白新对话（与 ensureSession 新建逻辑一致）。
    this.persistActiveId('');
  }

  /** 持久化当前会话 id（跨刷新恢复用）；传入空串表示「无当前会话」。 */
  private persistActiveId(id: string) {
    try {
      if (id) localStorage.setItem('ah_active_id', id);
      else localStorage.removeItem('ah_active_id');
    } catch {
      /* ignore */
    }
  }

  private async selectSession(id: string) {
    if (id === this.activeId) return;
    this.activeId = id;
    // 加载本会话持久化的设置（交互模式/模型/agent），实现「同一对话两端对齐」。
    // 优先级：本地按会话表 > 列表项（来自服务端元数据）> 保留当前全局值（旧会话无记录时）。
    const sv = this.sessions.find((s) => s.id === id);
    const st = this.sessionSettings[id];
    if (st?.interactionMode !== undefined) this.interactionMode = st.interactionMode;
    else if (sv?.interactionMode !== undefined) this.interactionMode = sv.interactionMode;
    if (st?.model !== undefined) this.model = st.model;
    else if (sv?.model !== undefined) this.model = sv.model;
    if (st?.agentId !== undefined) this.agentId = st.agentId;
    else if (sv?.agentId !== undefined) this.agentId = sv.agentId;
    this.persistActiveId(id);
    this.sidebarOpen = false;
    this.error = null;
    this.input = '';
    // 关键修复：切换会话【不再】中止进行中的 run，也不清空其打字机缓冲 / 追踪状态。
    // 进行中的 run 仍向所属会话缓冲写内容，切回时实时恢复（见 this.threads / this.pending / this.traces）。
    // 优先用本地内存中的会话缓冲；否则向服务端拉取历史（仅当该会话从未在本会话实例中打开过，
    // 或上次恢复失败且缓冲为空 —— 空线程不缓存为「已加载」，下次进入自动重试）。
    const localBuf = this.threads[id];
    // 会话级用量快照（随历史镜像恢复）；getChatSession 不含 usage，仅 history 镜像携带。
    let recoveredUsage: MirroredUsage | null = null;
    if (!localBuf || (this.restoreFailed[id] && localBuf.length === 0)) {
      try {
        // 恢复流程带超时（加载失败 / 数据不完整 / 超时均视为异常走降级，绝不清空本地记录）。
        const s = await withTimeout(
          client.getChatSession(id),
          8000,
          '恢复会话历史'
        );
        // 服务端数据先经消毒（类型收敛 / 过滤非法条目 / 连续重复去重 / 保序）再入内存。
        const clean = sanitizeMessages(
          s.messages.map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
            reasoning: m.reasoning,
            tools: m.tools,
            trace: m.trace,
            plan: m.plan,
            planStatus: (m as any).planStatus,
            // 服务端落盘的附件（图片/文件预览）原样透传，刷新 / 切回后还原气泡内图片。
            ...(m.attachments && m.attachments.length
              ? { attachments: m.attachments }
              : {})
          }))
        );
        if (clean.length === 0) throw new Error('会话数据不完整（空历史）');
        // 先取计划进度镜像查找表；待线程按新 id 重建后再应用（见下）。
        const planStatusLookup = this.buildPlanStatusLookup(clean);
        // 本地若已有消息（如离线期间新发送的），按「最长尾首重叠」合并，防丢消息/重复。
        // 合并结果统一补发新 id（渲染以 id 为 key，不能缺省）。
        const merged =
          localBuf && localBuf.length
            ? mergeThreadHistories(clean, sanitizeMessages(localBuf))
            : clean;
        this.threads[id] = merged.map((m) => ({
          ...m,
          // 恢复源附件为 {name,type,url?,serverUrl?} 形状，渲染需 UploadedFile（dataUrl）。
          ...(m.attachments && m.attachments.length
            ? {
                attachments: m.attachments.map((a) => ({
                  name: a.name,
                  size: 0,
                  type: a.type,
                  dataUrl: a.url || '',
                  ...(a.serverUrl ? { serverUrl: a.serverUrl } : {})
                }))
              }
            : {}),
          id: this.nextId++
        })) as ChatMsg[];
        // 线程已按新 id 重建：把服务端镜像里的计划进度还原到 planExec（新消息 id 对齐）。
        this.applyPlanStatusLookup(id, planStatusLookup);
        this.restoreFailed[id] = false;
      } catch {
        // 恢复失败：绝不清空 / 覆盖本地已有记录。降级阶梯：
        //   历史镜像接口（服务端 SQLite / 进程内兜底） → 空线程 + 失败标记（下次重试）+ 非阻断警示。
        const mirrored = await loadThread(id);
        if (mirrored && mirrored.msgs.length) {
          recoveredUsage = mirrored.usage;
          this.threads[id] = mirrored.msgs.map((m) => ({
            ...(m as Omit<ChatMsg, 'id'>),
            // 恢复源附件为 {name,type,url?,serverUrl?} 形状，渲染需 UploadedFile（dataUrl）。
            ...(m.attachments && m.attachments.length
              ? {
                  attachments: m.attachments.map((a) => ({
                    name: a.name,
                    size: 0,
                    type: a.type,
                    dataUrl: a.url || '',
                    ...(a.serverUrl ? { serverUrl: a.serverUrl } : {})
                  }))
                }
              : {}),
            id: this.nextId++
          })) as ChatMsg[];
          this.error =
            '⚠️ 服务端历史拉取失败，已从历史镜像恢复（可能非最新）。';
        } else {
          this.threads[id] = localBuf ?? [];
          this.restoreFailed[id] = true;
          this.error =
            '⚠️ 历史记录恢复失败（服务端不可达且无本地缓存），已保留当前内容；再次进入将自动重试。';
        }
      }
    }
    // 恢复历史后补全调用链路中 assistant 消息的内容（修复旧 trace 中 assistant 为空）。
    this.restoreTraceMessages(id);
    this.messages = this.threads[id];
    // 切换会话：回到该会话最新消息底部，并恢复「钉底」跟随。
    this.stickToBottom = true;
    this.showScrollDown = false;
    // 用量快照从会话镜像回填（若有），避免刷新/切换后上下文用量归零或回退粗估；
    // 无快照则保持 null，由后续 llm:usage 事件或回退估算补充。
    this.backendUsage = recoveredUsage?.backendUsage ?? null;
    this.runCumulative = recoveredUsage?.runCumulative ?? null;
  }

  /**
   * 从镜像消息构建「计划 goal → 执行进度镜像」查找表。
   * 消息 id 在恢复时重新分配，不能按 id 对齐；goal 是计划卡片的稳定业务键。
   */
  private buildPlanStatusLookup(
    msgs: Array<{ plan?: unknown; planStatus?: PlanExecMirror }>
  ): Map<string, PlanExecMirror> {
    const out = new Map<string, PlanExecMirror>();
    for (const m of msgs) {
      const plan = m.plan as { goal?: unknown } | undefined;
      if (!plan || typeof plan.goal !== 'string' || !m.planStatus) continue;
      if (!out.has(plan.goal)) out.set(plan.goal, m.planStatus);
    }
    return out;
  }

  /**
   * 把镜像里的计划进度应用到恢复后的线程（按 goal 对齐新消息 id）。
   * 仅当内存中没有该消息的状态时写入，不覆盖本实例正在进行的执行状态；
   * 镜像里的 running 态说明上次执行被中断（刷新/断连），收敛为 failed ——
   * 卡片出现「从失败任务继续」，等用户指令后再续跑，绝不静默自动重放。
   */
  private applyPlanStatusLookup(
    sid: string,
    lookup: Map<string, PlanExecMirror>
  ) {
    if (!lookup.size) return;
    for (const m of this.threads[sid] ?? []) {
      if (!m.plan || this.planExec[m.id]) continue;
      const ps = lookup.get(m.plan.goal);
      if (!ps) continue;
      const doneMap: Record<string, boolean> = {};
      for (const tid of ps.done ?? []) doneMap[tid] = true;
      // running = 上次执行中断：保留已完成集合，但置 failed 等待用户显式继续。
      const interrupted = ps.status === 'running';
      this.planExec = {
        ...this.planExec,
        [m.id]: {
          status: interrupted ? 'failed' : ps.status,
          currentTaskId: interrupted ? ps.currentTaskId : undefined,
          failedTaskId: interrupted ? ps.currentTaskId : ps.failedTaskId,
          done: doneMap
        }
      };
    }
  }

  private async renameSession(id: string) {
    const cur = this.sessions.find((s) => s.id === id);
    // 统一弹框（components/ah-modal）：替代原生 window.prompt，主题/无障碍一致。
    const title = await AhModal.prompt({
      title: '重命名会话',
      inputValue: cur?.title ?? '',
      inputPlaceholder: '输入新的会话名称',
      confirmText: '保存'
    });
    if (!title || !title.trim()) return;
    try {
      await client.renameChatSession(id, title.trim());
      this.sessions = this.sessions.map((s) =>
        s.id === id ? { ...s, title: title.trim() } : s
      );
      // 同步本地镜像索引标题（下次离线兜底渲染时名称一致）。
      const t = this.threads[id];
      if (t && t.length) this.saveHistory(id);
    } catch (e: any) {
      this.error = String(e?.message ?? e);
    }
  }

  private async deleteSession(id: string) {
    // 统一弹框：警告变体 + 破坏性红色确认按钮，替代原生 window.confirm。
    // maskClosable=false 防误触（危险操作需明确点击「删除」或「取消」）。
    const ok = await AhModal.confirm({
      variant: 'warning',
      danger: true,
      title: '删除会话',
      message: '删除该会话及其全部消息？此操作不可恢复。',
      confirmText: '删除',
      cancelText: '取消',
      maskClosable: false
    });
    if (!ok) return;
    try {
      await client.deleteChatSession(id);
      // 同步清理历史镜像与索引（进程内 + 服务端），避免「服务端已删、本地幽灵会话」复活。
      await purgeSessionMirror(id);
      this.sessions = this.sessions.filter((s) => s.id !== id);
      if (this.activeId === id) this.newChat();
    } catch (e: any) {
      this.error = String(e?.message ?? e);
    }
  }

  /* ----------------------- 发送 / 流式 ----------------------- */

  private async ensureSession(): Promise<string> {
    if (this.activeId) {
      this.persistActiveId(this.activeId);
      return this.activeId;
    }
    const s = await client.createChatSession('新对话', {
      interactionMode: this.interactionMode,
      model: this.model,
      agentId: this.agentId
    });
    this.activeId = s.id;
    this.persistActiveId(s.id);
    // 新建会话即带上当前默认设置，确保它端首次见到该会话时已对齐。
    this.sessionSettings = {
      ...this.sessionSettings,
      [s.id]: { interactionMode: s.interactionMode, model: s.model, agentId: s.agentId }
    };
    this.sessions = [
      {
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        interactionMode: s.interactionMode,
        model: s.model,
        agentId: s.agentId
      },
      ...this.sessions
    ];
    return s.id;
  }

  /**
   * 当前选中模型的自定义端点配置（若有）：从后端 SQLite 的自定义模型清单里
   * 查出 baseUrl / apiKey，作为 run 请求的 modelBaseUrl / modelApiKey 字段。
   * 未配置或非自定义模型返回空对象（不透传任何字段）。
   */
  private async customModelEndpoint(): Promise<{
    modelBaseUrl?: string;
    modelApiKey?: string;
  }> {
    if (!this.model) return {};
    try {
      const res = await authedFetch('/api/custom-models');
      if (!res.ok) return {};
      const rows = (await res.json()) as Array<{
        id: string;
        baseUrl?: string;
        apiKey?: string;
      }>;
      const row = rows.find((r) => r.id === this.model);
      if (!row) return {};
      const out: { modelBaseUrl?: string; modelApiKey?: string } = {};
      if (typeof row.baseUrl === 'string' && row.baseUrl.trim())
        out.modelBaseUrl = row.baseUrl.trim();
      if (typeof row.apiKey === 'string' && row.apiKey.trim())
        out.modelApiKey = row.apiKey.trim();
      return out;
    } catch {
      return {};
    }
  }

  private async send() {
    const prompt = this.input.trim();
    // 仅阻止「同一会话正在流式时重复发送」；其它会话（含后台进行中的 run）不受影响，可并发。
    if (!prompt && this.attachments.length === 0) return;
    this.error = null;

    const sessionId = await this.ensureSession();

    // 构造用户消息内容：只发送纯文本提示词给 LLM。
    // 图片附件通过 m.attachments 传给前端单独渲染，同时通过 attachments 字段传给服务端。
    const content = prompt;

    // 在清空 this.attachments 之前保留完整附件副本（含 dataUrl），
    // 用于回显到 user 气泡；否则消息写入时附件已被清空，气泡里图片不显示。
    const rawAttachments = [...this.attachments];

    // 为每个图片构建结构化附件信息。
    // 关键修复：直接把本地 dataUrl（完整 data: URI）作为图片内容发给模型，
    // 而非依赖服务端返回的 serverUrl（相对路径 /api/uploads/*，模型提供方无法 fetch）。
    // 这样即使服务端上传失败、或部署在 localhost，模型也能直接解码看到图片。
    const imageAttachments = rawAttachments
      .filter((f) => f.type.startsWith('image/'))
      .map((f) => ({
        url: f.dataUrl || f.serverUrl || '',
        name: f.name,
        type: f.type
      }))
      .filter((f) => f.url);

    this.input = '';
    this.attachments = [];
    await this.dispatchPrompt(sessionId, content, imageAttachments, {
      attachments: rawAttachments
    });
  }

  /**
   * 派发一次 run（send 与计划模式逐任务执行的公共管线）。
   * 返回 'ok' | 'stopped'（用户手动停止）| 'error'（彻底断连/失败），
   * 供计划执行循环决定是否继续派发后续任务。
   */
  private async dispatchPrompt(
    sessionId: string,
    content: string,
    imageAttachments: Array<{ url: string; name: string; type: string }> = [],
    opts: { planTask?: boolean; attachments?: UploadedFile[] } = {}
  ): Promise<'ok' | 'stopped' | 'error'> {
    // 当前会话消息缓冲：追加 user + assistant(空)，并记录流式下标。
    const t = this.threadFor(sessionId);
    t.push({
      id: this.nextId++,
      role: 'user',
      content,
      attachments: opts.attachments
        ? [...opts.attachments]
        : [...this.attachments]
    });
    t.push({ id: this.nextId++, role: 'assistant', content: '' });
    this.streamIdx[sessionId] = t.length - 1;
    this.threads[sessionId] = t;
    // 重置该会话的流式状态（防御上轮残留的缓冲 / 定时器泄漏到本轮）。
    this.received[sessionId] = false;
    this.pending[sessionId] = { content: '', reasoning: '' };
    this.finalBy[sessionId] = '';
    // 断线恢复簿记归零：新一轮 run 重新记录 jobId / seq 游标 / 终结标记 / 错误标记。
    this.finishedBy[sessionId] = false;
    this.jobBy[sessionId] = '';
    this.lastSeqBy[sessionId] = -1;
    this.erroredBy[sessionId] = false;
    this.setConn(sessionId, 'connected');
    this.resetTrace(sessionId);
    this.stopTypewriter();
    this.setStreaming(sessionId, true);
    if (this.activeId === sessionId) this.messages = t;
    // 发送新消息：强制钉底并滚到最新内容（即便用户此前向上翻阅历史）。
    this.stickToBottom = true;
    this.showScrollDown = false;
    this.showCtxUsage = false;
    // 注意：不在发送时清空 backendUsage —— 它是「会话级累计窗口占用」，跨 run 持续累加
    // （由 llm:usage 累加、run 开始不清零），仅新会话 newChat 才重置。
    // 仅清空「本运行累计」（本次 run 的真实消耗，run:cost 会重新赋值）。
    this.runCumulative = null;
    // 容错持久化：用户消息一入缓冲立即镜像落盘（独立于 run 结果 —— 即便后续流式中断/出错也已保存）。
    this.saveHistory(sessionId);

    const endpoint = await this.customModelEndpoint();
    const input: Record<string, unknown> = {
      mode: this.mode,
      prompt: content,
      model: this.model || undefined,
      // 所选模型的官方上下文窗口：随请求下发，服务端 llm:usage 用它做「上下文用量」分母。
      ctxWindow: this.serverCtxWindow > 0 ? this.serverCtxWindow : undefined,
      // 自定义模型若配置了专属接口地址 / API Key，随请求透传给服务端
      // （服务端用其构造直连端点的 LLM；未配置则走服务端默认 OpenRouter）。
      ...endpoint,
      agentId: this.agentId || undefined,
      sessionId,
      chatSessionId: sessionId,
      attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
      // 联网搜索开关（Request 4）：仅在用户显式开启 web 时透传 true，关闭时缺省不触发任何出网检索。
      web: this.web || undefined,
      // 交互模式（P0 计划模式）：仅用户手动选择 plan 且非任务执行派发时进入 propose 阶段。
      // 计划任务的逐步执行（confirmPlan）必须按普通问答派发 —— 若仍带 planPhase:'propose'，
      // 服务端会把每个任务 run 都当作一次新的计划提案，模型把旧计划原样再提一遍，
      // 生成第二张「待确认」卡片，点执行又从第一步重来（交互死循环根因）。
      interactionMode:
        this.interactionMode === 'plan' && !opts.planTask ? 'plan' : undefined,
      planPhase:
        this.interactionMode === 'plan' && !opts.planTask
          ? 'propose'
          : undefined,
      // 设备指纹：服务端跨设备广播据此区分本端回声与他端消息，前端按 origin 去重。
      origin: MY_ORIGIN
    };
    // 断连后「重新连接」按钮需要原始入参（服务端 job 过期时无法仅凭 jobId 恢复）。
    this.lastInputBy[sessionId] = input;

    const ac = new AbortController();
    this.abortBy[sessionId] = ac;
    try {
      await this.runWithReconnect(sessionId, input, ac);
      // 流正常关闭 ≠ 运行成功：服务端在模型/运行异常时先发 error 事件再补发
      // run:end 正常收尾。此处必须检查本轮是否收到过 error，收到则按失败返回，
      // 让计划执行循环立即中止后续任务派发（而不是把失败当成功继续跑下一步）。
      if (this.erroredBy[sessionId]) {
        return 'error';
      }
      return 'ok';
    } catch (e: any) {
      if ((e as any)?.name === 'UserStoppedRun') {
        // 用户主动停止：保留已揭示内容，不标错误（原有体验不变）。
        return 'stopped';
      } else {
        // 彻底断连（重试耗尽 / job 已被服务端淘汰）：标记断开 + 错误提示，
        // 顶部横幅出现「重新连接」手动入口。
        this.setConn(sessionId, 'lost');
        this.patchSession(sessionId, {
          error: true,
          content:
            (this.curSession(sessionId)?.content ?? '') ||
            `⚠️ ${e?.message ?? e}`
        });
        return 'error';
      }
    } finally {
      // 先停掉 interval 定时器，再按打字节奏把剩余缓冲揭示完（drain），
      // 避免 run:end 的 final 文本一次性覆盖掉打字机效果；被手动中止时则立即落盘。
      this.stopTypewriter();
      if (ac.signal.aborted) {
        this.flushTypewriter(sessionId);
      } else {
        await this.drainTypewriter(sessionId);
      }
      const c = this.curSession(sessionId);
      if (c && !c.content && this.finalBy[sessionId]) {
        this.patchSession(sessionId, { content: this.finalBy[sessionId] });
      }
      // 兜底：非流式回退路径内容不经 llm:token 到达，run 收尾时再尝试折叠一次。
      this.autoCollapseThink(sessionId);
      // 运行收尾：用完整消息内容重建调用链路 LLM 节点的 messages 上下文，
      // 避免打字机缓冲未完全揭示导致 trace 中 assistant 内容丢失，再落盘历史。
      this.rebuildTraceMessages(sessionId);
      const tc = this.traces[sessionId];
      if (tc?.root) {
        this.patchSession(sessionId, { trace: [tc.root] });
      }
      this.setStreaming(sessionId, false);
      this.abortBy[sessionId] = undefined as any;
      if (this.activeId === sessionId) this.messages = this.threads[sessionId];
      // 容错持久化：run 收尾（正常完成 / 出错 / 手动中止均会走到 finally）把最终消息镜像落盘，
      // 写入独立于恢复流程结果，保证任何错误场景下历史都已可靠保存。
      this.saveHistory(sessionId);
    }
  }

  /** 手动停止当前显示会话的 run（仅中止该会话，不影响其它后台 run）。 */
  private stop() {
    const ac = this.abortBy[this.activeId];
    ac?.abort();
  }

  /* ---------------------------- 断线恢复引擎 ---------------------------- */

  /**
   * 消费一次 run 的 SSE 事件流，并在意外断连时自动重连续传。
   *
   * - 首次以完整入参提交；断连后凭 jobId + since(seq 游标) 重订阅，
   *   服务端只重放缺失事件 —— 内容不重复、不丢失，进行中的操作照常推进；
   * - 用户手动 stop() 不重连（抛 UserStoppedRun）；看门狗 / 切回标签页触发的
   *   keepalive 中止视为断连，照常进入恢复流程；
   * - 重试指数退避（1s→2s→4s→8s 封顶），最多 6 次（总窗口 ≈ 30s+）；
   * - 彻底失败向上抛错：send()/resumeLost 标记 lost 并给出手动重试入口。
   */
  private async runWithReconnect(
    sid: string,
    input: Record<string, unknown>,
    ac: AbortController
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
              jobId: this.jobBy[sid],
              since: this.lastSeqBy[sid] ?? -1
            };
        first = false;
        for await (const ev of client.streamRun(payload as any, {
          signal: ac.signal
        })) {
          // 首个事件到达即视为链路恢复，清除「重连中」横幅。
          if (this.connState[sid] !== 'connected')
            this.setConn(sid, 'connected');
          this.ingest(ev as StreamEvent, sid);
        }
        // 流正常关闭：无论是否经历过断连，横幅一律复位。否则「重连后服务端只回放
        // 末尾终结事件即关流」的场景下，无人再清 connState，横幅会永久残留。
        if (this.connState[sid] !== 'connected') this.setConn(sid, 'connected');
        return; // 服务端正常关流（_done 后 end / job 已终结的重放完毕）
      } catch (rawErr: any) {
        const aborted = ac.signal.aborted;
        const wasKeepAlive = this.keepAliveAbort[sid] === true;
        this.keepAliveAbort[sid] = false;
        if (aborted && !wasKeepAlive) {
          // 用户手动停止：包装标记后上抛，调用方静默处理。
          // 停止即退出恢复循环：先清掉「重连中」横幅再抛，避免停止后残留。
          if (this.connState[sid] !== 'connected')
            this.setConn(sid, 'connected');
          throw Object.assign(
            rawErr instanceof Error ? rawErr : new Error(String(rawErr)),
            {
              name: 'UserStoppedRun'
            }
          );
        }
        // 断连前已收到最终答复：内容完整，无需恢复。
        if (this.finishedBy[sid]) return;
        attempts += 1;
        const jobGone =
          rawErr instanceof ApiError &&
          rawErr.status >= 400 &&
          rawErr.status < 500;
        if (jobGone || !this.jobBy[sid] || attempts > MAX_ATTEMPTS) {
          throw rawErr;
        }
        const delay = Math.min(8000, 1000 * 2 ** (attempts - 1));
        this.setConn(sid, 'reconnecting');
        await this.sleep(delay, ac.signal);
        // 等待期间被用户停止 → 静默退出；keepalive 唤醒则立即重试。
        if (ac.signal.aborted && !this.keepAliveAbort[sid]) {
          // 停止即退出：先复位横幅再抛，避免停止后「重连中」残留。
          if (this.connState[sid] !== 'connected')
            this.setConn(sid, 'connected');
          throw Object.assign(new Error('user stopped during reconnect'), {
            name: 'UserStoppedRun'
          });
        }
      }
    }
  }

  /** 可被 AbortSignal 提前打断的 sleep（用户停止时立即结束退避等待）。 */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
   * 手动重试入口（顶部断连横幅按钮）：对仍持有 jobId 的会话发起恢复。
   * 复用 runWithReconnect 的续传逻辑；成功则流继续、横幅消失，失败保持 lost。
   */
  private async resumeLost(sid: string) {
    if (!sid || this.streaming[sid] || this.finishedBy[sid]) return;
    if (!this.jobBy[sid]) {
      // jobId 已不可用（服务端重启淘汰）：只能整段重发，提示用户重新发送消息。
      this.patchSession(sid, { error: true });
      return;
    }
    const input = this.lastInputBy[sid] ?? {};
    const ac = new AbortController();
    this.abortBy[sid] = ac;
    this.received[sid] = false;
    this.pending[sid] = { content: '', reasoning: '' };
    this.setStreaming(sid, true);
    this.setConn(sid, 'reconnecting');
    try {
      await this.runWithReconnect(sid, input, ac);
    } catch (e: any) {
      if ((e as any)?.name !== 'UserStoppedRun') {
        this.setConn(sid, 'lost');
        this.patchSession(sid, {
          error: true,
          content:
            (this.curSession(sid)?.content ?? '') ||
            `⚠️ 重连失败：${e?.message ?? e}（请重新发送消息）`
        });
      }
    } finally {
      this.stopTypewriter();
      if (ac.signal.aborted) {
        this.flushTypewriter(sid);
      } else {
        await this.drainTypewriter(sid);
      }
      const c = this.curSession(sid);
      if (c && !c.content && this.finalBy[sid]) {
        this.patchSession(sid, { content: this.finalBy[sid] });
      }
      // 兜底：断线恢复路径同样在 run 收尾时尝试折叠思考面板。
      this.autoCollapseThink(sid);
      // 断线恢复收尾：同样重建调用链路 messages，避免 assistant 内容丢失后落盘。
      this.rebuildTraceMessages(sid);
      const tc2 = this.traces[sid];
      if (tc2?.root) {
        this.patchSession(sid, { trace: [tc2.root] });
      }
      this.setStreaming(sid, false);
      this.abortBy[sid] = undefined as any;
      if (this.activeId === sid) this.messages = this.threads[sid];
      this.saveHistory(sid);
    }
  }

  private ingest(ev: StreamEvent, sid: string) {
    // 每次都从最新 this.threads[sid] 读取当前消息：patch 会整体替换数组与对象，
    // 早期捕获的引用是「旧快照」，直接用它做增量拼接会丢内容 / 看不到已落下的工具卡。
    const cur = (): ChatMsg | null => this.curSession(sid);
    const patch = (p: Partial<ChatMsg>) => this.patchSession(sid, p);
    // 终结事件（最终答复已到达 / 流结束 / 运行出错）：立即解除该会话的「流式」状态。
    // 用不可变重赋值触发 Lit 重渲染，避免 run 结束后 UI 仍卡在「模型正在回复…」、输入框被禁用。
    // 即便 SSE 连接因故迟迟未关闭，UI 也会在最终答复到达时即时解锁；send() 的 finally 为二次兜底。
    const et = (ev as any).type;
    if (et === 'run:end' || et === '_done' || et === 'error') {
      this.setStreaming(sid, false);
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
      // 运行已终结：链路无论此前是否断连过都视为恢复，立即摘掉「连接中断」横幅，
      // 防止「重连补收末尾终结事件 → 流关闭」时横幅无人清理而永久残留。
      if (this.connState[sid] !== 'connected') this.setConn(sid, 'connected');
    }
    // 把事件汇入调用链路追踪树（独立于内容/工具卡，结构化记录 LLM↔工具↔检索 过程）。
    this.traceHandle(ev, sid);
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
        // 若本会话更早的消息里存在「目标一致且任务数一致」且状态为 running/done 的计划，
        // 则本条继承其执行状态（不产生第二张可点「确认执行」的卡片），避免重复从头执行。
        const dupSrc = [...(this.threads[sid] ?? [])]
          .reverse()
          .find(
            (p) =>
              p.id !== c.id &&
              p.plan &&
              p.plan.goal === plan.goal &&
              p.plan.tasks.length === plan.tasks.length &&
              ['running', 'done'].includes(
                this.planExec[p.id]?.status ?? 'pending'
              )
          );
        patch({
          plan,
          // 计划卡片消息的内容占位：propose 阶段服务端抑制全部内容事件（防 JSON 外泄）、
          // 合成 run:end 的摘要又因已挂卡片被跳过 —— 若不在此补一句摘要，
          // 该消息 content 永远为空，回答区会永久停留在「等待响应…」。
          ...(c.content?.trim()
            ? {}
            : {
                content: `已生成执行计划（共 ${plan.tasks.length} 个任务）：${plan.goal}。确认后将按依赖顺序逐任务执行。`
              })
        });
        this.planExec = {
          ...this.planExec,
          [c.id]: dupSrc
            ? {
                ...(this.planExec[dupSrc.id] ?? { status: 'pending', done: {} })
              }
            : { status: 'pending', done: {} }
        };
        break;
      }
      case 'llm:token': {
        const c = cur();
        if (c) {
          this.received[sid] = true;
          // 不再直接 patch 到 content：整段塞进单 delta 时会「一帧跳全文」。
          // 改为进 pending 缓冲，由打字机定时器按节奏逐字揭示。
          this.pending[sid].content += String((ev as any).delta ?? '');
          // 首个回答 token 到达 = 思考阶段结束：自动折叠本轮思考面板。
          if (!c.content) this.autoCollapseThink(sid);
          this.ensureTypewriter();
        }
        break;
      }
      case 'llm:reasoning': {
        const c = cur();
        if (c) {
          this.pending[sid].reasoning += String((ev as any).delta ?? '');
          this.ensureTypewriter();
        }
        break;
      }
      case 'llm:response': {
        // 关键修复：如果已经通过 llm:token 增量构建了内容，不再用 llm:response 覆盖
        // （harness 在 token 流结束后总会发一次 llm:response 携带整段 content，
        //   多轮工具调用时中间轮的 content='' 会把已累积文本清空）。
        // 仅在未收到任何 token 时（非流式回退路径）才用 response content 赋值。
        const c = cur();
        if (c && !this.received[sid]) {
          const respContent = String((ev as any).content ?? '');
          if (respContent) patch({ content: respContent });
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
        // 注意：必须要求 evName 存在（否则 undefined===undefined 会误匹配到任意空卡），
        // 且用 result === undefined 区分「未回填」与「已回填空串」，避免重复覆盖。
        if (evName !== undefined) {
          for (let i = tools.length - 1; i >= 0; i--) {
            if (tools[i].name === evName && tools[i].result === undefined) {
              tools[i] = {
                ...tools[i],
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
          // 窗口取值优先级：① 前端已知的官方 context_length（选中模型时由
          // model-change 写入，随请求 ctxWindow 下发）→ ② 服务端 llm:usage 回传值 →
          // ③ 0（无数据，hideCtxRing 隐藏展示）。绝不接受回传的猜测基线覆盖官方值。
          const win =
            this.serverCtxWindow > 0
              ? this.serverCtxWindow
              : Number.isFinite(Number(u.window)) && Number(u.window) > 0
              ? Number(u.window)
              : 0;
          // 会话级累计窗口占用：跨 run 累加每次 LLM 调用的 prompt/completion，
          // 而非用「最后一次调用」覆盖（旧逻辑会让顶部数字随 step 跳变、且永远只是单次输入）。
          // 窗口口径（win）变化时（切换模型）重新初始化，避免不同窗口分母的累计错配。
          const prev = this.backendUsage;
          if (prev && prev.window === win && prev.breakdown && u.breakdown) {
            this.backendUsage = {
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
            };
          } else {
            this.backendUsage = {
              window: win,
              promptTokens: u.promptTokens,
              completionTokens: u.completionTokens,
              totalTokens: u.totalTokens,
              breakdown: u.breakdown
            };
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
          // 用量更新后立即镜像落盘：否则发送时已落过一次 null，run 完成后再不落盘，
          // 重新进入会话就会读到 null → 回退前端粗估（表现为「丢失/回退」）。
          this.saveHistory(sid);
        }
        break;
      }
      case 'run:end': {
        const finalStr = String((ev as any).final ?? '');
        this.finalBy[sid] = finalStr;
        // 若已通过 llm:token 走打字机揭示：不在这里用 final 覆盖 content（否则整段秒显，打字机失效）。
        // 让打字机按节奏自然揭示到 final 文本；仅在完全没有 token 增量时（非流式回退）才直接赋值。
        // 计划模式：消息已挂计划卡片时跳过 raw final 覆盖（防原始 JSON 外泄），但若 content
        // 仍为空则兜底填入摘要占位 —— 避免 run 结束后回答区永久停留在「等待响应…」。
        if (!this.received[sid] && finalStr) {
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
            // 保留已有内容；内容为空时才填错误占位 —— 否则「等待响应…」会被
            // 错误文本替换后仍因 content 非空判断而显示异常。
            content:
              c.content || `⚠️ ${escapeHtml(String((ev as any).message ?? ev))}`
          });
        break;
      }
      default:
        break;
    }
  }

  /* ----------------------- 调用链路追踪构建 ----------------------- */

  /** 确保追踪树根节点（run）存在并返回（按会话独立）。 */
  private ensureTraceRoot(sid: string): TraceNode {
    const tc = this.traceCtx(sid);
    if (!tc.root) {
      tc.root = {
        id: 't0',
        kind: 'run',
        label: '运行',
        status: 'ok',
        children: []
      };
      tc.parent = tc.root;
    }
    return tc.root;
  }

  /**
   * 把一条流式事件汇入调用链路追踪树（瞬态构建，结果写入当前会话 assistant 消息的 trace 字段）。
   * 树形：run → step → llm → tool/retrieval/cost，外加 root 级的 verify/guardrail/budget/error。
   * 外部调用（工具/检索）因此被整合进对话上下文，可结构化复盘。追踪按会话隔离，支持并发流式。
   */
  private traceHandle(ev: any, sid: string) {
    const tc = this.traceCtx(sid);
    const mk = (
      parent: TraceNode,
      kind: TraceKind,
      label: string,
      status: TraceNode['status'] = 'ok',
      extra: Partial<TraceNode> = {}
    ): TraceNode => {
      const n: TraceNode = {
        id: `t${++tc.seq}`,
        kind,
        label,
        status,
        children: [],
        ...extra
      };
      parent.children.push(n);
      return n;
    };
    switch (ev?.type) {
      case 'run:meta': {
        const r = this.ensureTraceRoot(sid);
        r.meta = {
          ...(r.meta ?? {}),
          ...(ev.model ? { model: String(ev.model) } : {}),
          ...(ev.agentId ? { agent: String(ev.agentId) } : {}),
          ...(ev.mode ? { mode: String(ev.mode) } : {})
        };
        r.label = ev.model ? `运行 · ${ev.model}` : '运行';
        break;
      }
      case 'step:start': {
        const r = this.ensureTraceRoot(sid);
        tc.parent = r;
        const step = mk(r, 'step', `第 ${ev.step} 步`, 'ok', {
          meta: { step: `第 ${ev.step} 步 / 共 ${ev.maxSteps ?? '?'} 步` }
        });
        tc.parent = step;
        tc.llm = null;
        tc.lastTool = null;
        break;
      }
      case 'llm:call': {
        this.ensureTraceRoot(sid);
        const parent = tc.parent ?? tc.root!;
        // 纯前端：把「截至此次调用的会话消息上下文」挂到节点，点击「消息 N」可就地展开回看。
        // 注意这里实时读取 this.threads（而非一次性按 ev.messageCount 截断），
        // 助手回复生成后会自动补入，避免「调用链路里助手消息丢失」；
        // 末尾尚未产出的空 assistant 占位不计入，计数与下方「共 M 条」保持一致。
        const messages = this.snapshotTraceMessages(sid);
        tc.llm = mk(parent, 'llm', 'LLM 调用', 'ok', {
          meta: {
            messages: `消息 ${messages.length || '?'}`
            // 不再写入 tools：上游 toolCount 是「注入模型的可用工具数」(schema 量级，如25)，
            // 并非「本次实际执行的工具调用数」。真实执行数应派生自下方实际挂载的子节点，
            // 由 chat-trace.ts 的 LLM 分支从 n.children.length 计算，避免「工具25 却无节点」的误导。
          },
          ...(messages.length ? { messages } : {})
        });
        tc.lastTool = null;
        break;
      }
      case 'llm:reasoning': {
        if (tc.llm && typeof ev.delta === 'string') {
          const n =
            (tc.llm.meta?.reasoningChars
              ? Number(tc.llm.meta.reasoningChars)
              : 0) + ev.delta.length;
          tc.llm.meta = { ...(tc.llm.meta ?? {}), reasoningChars: String(n) };
          this.refreshLlmTraceMessages(sid, tc);
        }
        break;
      }
      case 'llm:token': {
        if (tc.llm && typeof ev.delta === 'string') {
          const n =
            (tc.llm.meta?.tokenChars ? Number(tc.llm.meta.tokenChars) : 0) +
            ev.delta.length;
          tc.llm.meta = { ...(tc.llm.meta ?? {}), tokenChars: String(n) };
          this.refreshLlmTraceMessages(sid, tc);
        }
        break;
      }
      case 'tool:start': {
        if (!tc.llm || !ev.call) break;
        const name = String(ev.call.name ?? 'tool');
        const retrieval = isRetrievalTool(name);
        tc.lastTool = mk(
          tc.llm,
          retrieval ? 'retrieval' : 'tool',
          retrieval ? `检索 · ${name}` : name,
          'pending',
          {
            detail:
              typeof ev.call.arguments === 'string'
                ? ev.call.arguments
                : JSON.stringify(ev.call.arguments ?? {})
          }
        );
        break;
      }
      case 'tool:deduped': {
        // 加固：工具调用去重命中。复用首次结果，记为「复用缓存」节点（仍挂在当前 LLM 调用下，
        // 便于在调用链里看出哪些请求被去重），但 buildInsights 的「工具调用」计数会排除此类节点。
        if (!tc.llm || !ev.call) break;
        const name = String(ev.call.name ?? 'tool');
        const retrieval = isRetrievalTool(name);
        tc.lastTool = mk(
          tc.llm,
          retrieval ? 'retrieval' : 'tool',
          retrieval ? `检索 · ${name}` : name,
          ev.errored ? 'error' : 'ok',
          {
            detail:
              typeof ev.call.arguments === 'string'
                ? ev.call.arguments
                : JSON.stringify(ev.call.arguments ?? {}),
            meta: { reused: '复用缓存（去重）' }
          }
        );
        if (tc.lastTool) {
          tc.lastTool.result =
            typeof ev.result === 'string'
              ? ev.result
              : JSON.stringify(ev.result ?? {});
        }
        break;
      }
      case 'tool:result': {
        if (tc.lastTool) {
          tc.lastTool.result =
            typeof ev.result === 'string'
              ? ev.result
              : JSON.stringify(ev.result ?? {});
          tc.lastTool.status = ev.errored ? 'error' : 'ok';
          tc.lastTool.meta = {
            ...(tc.lastTool.meta ?? {}),
            status: ev.errored ? '失败' : '成功'
          };
        }
        break;
      }
      case 'run:cost': {
        this.ensureTraceRoot(sid);
        const parent = tc.parent ?? tc.root!;
        // 本运行累计 token 消耗（所有 step 之和）：供「上下文用量」弹层的「累计消耗」行展示，
        // 与单轮窗口占用（llm:usage.promptTokens）区分，避免混淆。
        if ((ev as any).cumulativeTokens != null) {
          this.runCumulative = {
            tokens: Number((ev as any).cumulativeTokens),
            cost:
              (ev as any).cumulativeCost != null
                ? Number((ev as any).cumulativeCost)
                : 0
          };
          // 累计消耗更新后立即落盘，与 llm:usage 对称，避免重新进入会话后「本运行累计」丢失。
          this.saveHistory(sid);
        }
        // Token 拆解四项（系统/工具/历史/输出）：与 access/server 的 traceHandle 保持
        // 完全一致的键名与格式 —— 此前前端分支丢弃了 ev.estTokens，导致「Token 拆解」
        // 仅在服务端落盘后的恢复视图中出现、实时流视图中消失（时有时无的根因）。
        const est = (ev as any).estTokens as
          | {
              system: number;
              tools: number;
              history: number;
              completion: number;
            }
          | undefined;
        const estTotal = est
          ? est.system + est.tools + est.history + est.completion
          : 0;
        mk(parent, 'cost', '成本 / 用量', 'ok', {
          meta: {
            tokens: String(
              ev.cumulativeTokens ?? ev.usage?.total_tokens ?? '?'
            ),
            cost:
              ev.cumulativeCost != null
                ? `$${Number(ev.cumulativeCost).toFixed(4)}`
                : '?',
            priced: ev.priced ? 'true' : 'false',
            ...(ev.model ? { model: String(ev.model) } : {}),
            ...(est
              ? {
                  系统: String(est.system),
                  工具: `${est.tools}${
                    estTotal
                      ? ` (${((est.tools / estTotal) * 100).toFixed(0)}%)`
                      : ''
                  }`,
                  历史: `${est.history}${
                    estTotal
                      ? ` (${((est.history / estTotal) * 100).toFixed(0)}%)`
                      : ''
                  }`,
                  输出: String(est.completion)
                }
              : {})
          }
        });
        break;
      }
      case 'run:token-cache': {
        this.ensureTraceRoot(sid);
        const parent = tc.parent ?? tc.root!;
        const tcHitPct = (Number(ev.hitRate) * 100).toFixed(1);
        const tcByModel = Object.entries<{
          queries: number;
          hits: number;
          hitRate: number;
        }>(ev.byModel ?? {})
          .map(
            ([m, st]) =>
              `${m}: ${(Number(st.hitRate) * 100).toFixed(0)}% (${st.hits}/${
                st.queries
              })`
          )
          .join(' · ');
        mk(parent, 'tokencache', 'Token 缓存命中率', 'ok', {
          meta: {
            命中率: `${tcHitPct}%`,
            命中: `${ev.hits}/${ev.queries}`,
            接口: String(ev.interface ?? 'prompt-cache'),
            ...(ev.model ? { 模型: String(ev.model) } : {}),
            ...(tcByModel ? { 分模型: tcByModel } : {})
          },
          detail: `采集点：LLM 调用返回 usage.prompt_tokens_details.cached_tokens；计算逻辑：命中次数(${
            ev.hits
          }) ÷ 总查询次数(${ev.queries}) = ${tcHitPct}%。关联服务/接口：${
            ev.model ?? '?'
          } · ${ev.interface ?? 'prompt-cache'}。`
        });
        break;
      }
      case 'verify:result': {
        this.ensureTraceRoot(sid);
        mk(tc.root!, 'verify', '自检', ev.passed ? 'ok' : 'error', {
          meta: {
            score: String(ev.score ?? '?'),
            passed: ev.passed ? '通过' : '未通过'
          },
          result: (ev.reasons ?? []).join('\n')
        });
        break;
      }
      case 'guardrail:blocked': {
        this.ensureTraceRoot(sid);
        mk(tc.root!, 'guardrail', `护栏拦截 · ${ev.phase ?? ''}`, 'error', {
          detail: String(ev.reason ?? '')
        });
        break;
      }
      case 'budget:exceeded': {
        this.ensureTraceRoot(sid);
        mk(tc.root!, 'budget', `预算超限 · ${ev.kind ?? ''}`, 'error', {
          meta: { used: String(ev.used ?? '?'), limit: String(ev.limit ?? '?') }
        });
        break;
      }
      case 'error': {
        this.ensureTraceRoot(sid);
        mk(tc.root!, 'error', '运行错误', 'error', {
          detail: String(ev.message ?? '')
        });
        break;
      }
      default:
        break;
    }
    // 结构型事件才回写消息（token/reasoning 高频且仅更新 meta，避免无谓重渲染）。
    if (
      tc.root &&
      this.streamIdx[sid] >= 0 &&
      ev.type !== 'llm:token' &&
      ev.type !== 'llm:reasoning'
    ) {
      this.patchSession(sid, { trace: [tc.root] });
    }
  }

  /* ----------------------- 打字机缓冲 ----------------------- */

  /**
   * 计算本 tick 应揭示的字符数：自适应速度。
   * 缓冲越大揭示越快（保证长文在 ~1.5s 内揭示完），但最小 2 字/tick 保留打字质感，
   * 最大 28 字/tick 防止对超长文本揭示过慢。真流式（小 delta 频繁到达）时缓冲始终很小，
   * 故以最小速度揭示，呈现自然打字节奏。
   */
  private typeStep(n: number): number {
    if (n <= 0) return 0;
    return Math.min(28, Math.max(2, Math.ceil(n / 70)));
  }

  /** 启动打字机定时器（已运行则跳过）。 */
  private ensureTypewriter() {
    if (this.typedTimer) return;
    this.typedTimer = setInterval(() => this.tickTypewriter(), 24);
  }

  /** 停止打字机定时器并清空缓冲状态。 */
  private stopTypewriter() {
    if (this.typedTimer) {
      clearInterval(this.typedTimer);
      this.typedTimer = null;
    }
  }

  /** 把某会话缓冲中的待揭示文本一次性落到 content / reasoning（运行结束时调用，避免文本滞留）。 */
  private flushTypewriter(sid: string) {
    const buf = this.pending[sid];
    if (!buf) return;
    const c = this.curSession(sid);
    if (c) {
      if (buf.content)
        this.patchSession(sid, { content: c.content + buf.content });
      if (buf.reasoning)
        this.patchSession(sid, {
          reasoning: (c.reasoning ?? '') + buf.reasoning
        });
    }
    buf.content = '';
    buf.reasoning = '';
    if (!this.anyStreaming) this.stopTypewriter();
  }

  /**
   * 运行结束后，接替 interval 把剩余缓冲按打字节奏（与 tick 一致的步长/间隔）逐步揭示，
   * 直到缓冲清空再 resolve。这样即使后端把整段塞进单个 token，用户也能看到逐字打字效果，
   * 而不是 run:end 的 final 文本一次性覆盖。
   */
  private drainTypewriter(sid: string): Promise<void> {
    return new Promise((resolve) => {
      const step = () => {
        const buf = this.pending[sid];
        if (!buf || (!buf.content.length && !buf.reasoning.length)) {
          if (!this.anyStreaming) this.stopTypewriter();
          resolve();
          return;
        }
        this.tickSession(sid);
        setTimeout(step, 24);
      };
      step();
    });
  }

  /** 单个定时器 tick：遍历所有会话缓冲，逐步揭示；无缓冲且均无流式时停定时器。 */
  private tickTypewriter() {
    let any = false;
    for (const sid in this.pending) {
      const buf = this.pending[sid];
      if (!buf || (!buf.content.length && !buf.reasoning.length)) continue;
      this.tickSession(sid);
      any = true;
    }
    if (!any && !this.anyStreaming) this.stopTypewriter();
  }

  /** 揭示某会话的一小段缓冲到可见文本。 */
  private tickSession(sid: string) {
    const buf = this.pending[sid];
    if (!buf) return;
    const c = this.curSession(sid);
    if (!c) return;
    if (buf.content.length) {
      const step = this.typeStep(buf.content.length);
      const move = buf.content.slice(0, step);
      buf.content = buf.content.slice(step);
      this.patchSession(sid, { content: c.content + move });
    }
    if (buf.reasoning.length) {
      const step = this.typeStep(buf.reasoning.length);
      const move = buf.reasoning.slice(0, step);
      buf.reasoning = buf.reasoning.slice(step);
      this.patchSession(sid, { reasoning: (c.reasoning ?? '') + move });
    }
  }

  /* ----------------------- 渲染辅助 ----------------------- */

  /** 复制消息原文到剪贴板，成功后短暂显示「已复制 ✓」回执。 */
  private async copyMsgText(msgId: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板 API 不可用 / 被拒绝时的兜底：execCommand。
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* ignore */
      }
      ta.remove();
    }
    this.copiedMsgId = msgId;
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => {
      this.copiedMsgId = -1;
      this.copiedTimer = null;
    }, 1500);
  }

  /** 进入用户消息编辑态：气泡原位替换为输入框并自动聚焦。 */
  private startEdit(msgId: number, content: string) {
    this.editingMsgId = msgId;
    this.editingDraft = content;
    this.hoverUserMsgId = -1;
  }

  /** 退出编辑态，丢弃草稿。 */
  private cancelEdit() {
    this.editingMsgId = -1;
    this.editingDraft = '';
  }

  /**
   * 编辑后重新发送：把新内容作为一条新消息派发（历史保留原对话上下文，
   * 与主流聊天应用一致 —— 不回滚已生成的回复，只追加一轮新问答）。
   */
  private async sendEdit(_msgId: number) {
    const draft = this.editingDraft.trim();
    if (!draft || this.streaming[this.activeId] === true) return;
    this.cancelEdit();
    const sessionId = await this.ensureSession();
    this.input = draft;
    await this.send();
  }

  private onInput(e: Event) {
    this.input = (e.target as HTMLTextAreaElement).value;
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.send();
    }
  }

  /** 处理文件选择。读取本地预览并上传到服务端。 */
  private async onFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;
    const maxBytes = 10 * 1024 * 1024; // 10MB 上限
    const newFiles: UploadedFile[] = [];

    for (const f of Array.from(input.files)) {
      // 前置校验
      if (f.size > maxBytes) {
        this.error = `文件过大：${f.name}（上限 10MB）`;
        continue;
      }
      const allowedTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/bmp',
        'image/svg+xml',
        'text/plain',
        'text/markdown',
        'text/csv',
        'application/json'
      ];
      if (
        !f.type.startsWith('image/') &&
        !f.type.startsWith('text/') &&
        !f.type.includes('json') &&
        !['.txt', '.md', '.csv', '.json'].includes(
          f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
        )
      ) {
        this.error = `不支持的文件类型：${f.name}`;
        continue;
      }

      // 本地预览 DataURL
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(f);
      });

      const key = `${f.name}_${Date.now()}`;
      const file: UploadedFile = {
        name: f.name,
        size: f.size,
        type: f.type,
        dataUrl,
        uploadStatus: 'uploading'
      };
      this.uploadingFiles.set(key, { status: 'uploading' });

      // 立即加入 attachments 显示预览
      newFiles.push(file);
      this.attachments = [...this.attachments, file];

      // 上传到服务端
      try {
        const formData = new FormData();
        formData.append('file', f, f.name);
        const resp = await authedFetch('/api/upload', {
          method: 'POST',
          body: formData
        });
        const json = await resp.json();
        if (json.ok && json.meta?.url) {
          // 不可变更新：Lit @state() 仅在重新赋值时触发重渲染，
          // 原地修改数组元素的字段不会刷新 UI（⏳ 会一直卡住）。
          this.attachments = this.attachments.map((a) =>
            a === file
              ? { ...a, serverUrl: json.meta.url, uploadStatus: 'done' }
              : a
          );
          this.uploadingFiles.set(key, { status: 'done' });
        } else {
          throw new Error(json.error || '上传失败');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '上传失败';
        this.attachments = this.attachments.map((a) =>
          a === file ? { ...a, uploadStatus: 'error', uploadError: msg } : a
        );
        this.uploadingFiles.set(key, {
          status: 'error',
          error: msg
        });
        this.error = `上传失败：${f.name} — ${msg}`;
      }
    }

    input.value = '';
  }

  /** 移除已选附件。 */
  private removeAttachment(i: number) {
    const newAttachments = this.attachments.filter((_, idx) => idx !== i);
    this.attachments = newAttachments;
  }

  /** 文件是否可预览（图片 MIME 或常见图片扩展名）。 */
  private isPreviewable(f: UploadedFile): boolean {
    return (
      f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|svg)$/i.test(f.name)
    );
  }

  /** 打开图片附件的全屏预览。 */
  private openPreview(f: UploadedFile) {
    if (!this.isPreviewable(f)) return;
    this.previewFile = f;
  }

  private closePreview() {
    this.previewFile = null;
  }

  // ── 移动端长按输入框 → 全屏编辑器 ──────────────────────────────

  /** 长按计时器句柄；600ms 触发全屏编辑。 */
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;

  /** 长按起点坐标；移动距离超过该阈值视为滚动，取消长按。 */
  private longPressStart: { x: number; y: number } | null = null;

  private static readonly LONG_PRESS_MS = 600;
  private static readonly LONG_PRESS_MOVE_TOLERANCE = 15; // px

  private onComposerPointerDown(e: PointerEvent) {
    // 仅在用户消息编辑态可用；流式进行中不响应。
    if (this.editingMsgId < 0 || this.streaming[this.activeId] === true) return;
    // 触屏与鼠标均允许长按（鼠标路径便于桌面端验证同一交互）。
    this.longPressStart = { x: e.clientX, y: e.clientY };
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      this.fullscreenEditOpen = true;
      // 打开后自动聚焦，直接弹键盘可输入。
      void this.updateComplete.then(() => {
        this.renderRoot
          .querySelector<HTMLTextAreaElement>('.fe-input')
          ?.focus();
      });
    }, AhChat.LONG_PRESS_MS);
  }

  private onComposerPointerMove(e: PointerEvent) {
    if (!this.longPressTimer || !this.longPressStart) return;
    const dx = e.clientX - this.longPressStart.x;
    const dy = e.clientY - this.longPressStart.y;
    if (dx * dx + dy * dy > AhChat.LONG_PRESS_MOVE_TOLERANCE ** 2) {
      this.cancelComposerLongPress(); // 手指滑动（滚动文本）→ 取消
    }
  }

  private cancelComposerLongPress() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.longPressStart = null;
  }

  private async closeFullscreenEdit() {
    this.fullscreenEditOpen = false;
    // 焦点还给气泡内的编辑输入框，继续原位编辑。
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLTextAreaElement>('.edit-input')?.focus();
  }

  /** Esc 关闭预览 / 上下文用量弹层（window 级监听，无需聚焦）。 */
  private onPreviewKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (this.fullscreenEditOpen) this.closeFullscreenEdit();
      else if (this.previewFile) this.closePreview();
      else if (this.showCtxUsage) this.showCtxUsage = false;
    }
  };

  /** 折叠 / 展开某条消息的深度思考区（思考中不可折叠，保证实时推理可见）。 */
  private toggleThink(id: number) {
    const k = String(id);
    const c = this.messages.find((m) => m.id === id);
    const sIdx = this.streamIdx[this.activeId] ?? -1;
    const isThinking =
      this.streaming[this.activeId] &&
      sIdx >= 0 &&
      this.messages[sIdx]?.id === id &&
      !c?.content;
    if (isThinking) return;
    this.thinkCollapsed = {
      ...this.thinkCollapsed,
      [k]: !this.thinkCollapsed[k]
    };
  }

  /**
   * 深度思考结束自动折叠本轮思考面板：
   * 在首个回答 token 到达时调用（非流式回退路径由 run 收尾兜底再调一次，已折叠则跳过）。
   * 仅当本轮确实产出过推理内容（思考面板实际展示）才折叠；用户此前手动折叠过则保持不动。
   */
  private autoCollapseThink(sid: string) {
    const sIdx = this.streamIdx[sid] ?? -1;
    const m = sIdx >= 0 ? (this.threads[sid] ?? [])[sIdx] : undefined;
    if (!m?.reasoning) return;
    const k = String(m.id);
    if (this.thinkCollapsed[k]) return;
    this.thinkCollapsed = { ...this.thinkCollapsed, [k]: true };
  }

  /** 切换交互模式（问答/计划）并按当前会话持久化 + 广播。 */
  private setInteractionMode(m: 'qa' | 'plan') {
    this.interactionMode = m;
    // 保留全局偏好（跨刷新记忆），同时按当前会话记录，供跨设备对齐。
    try {
      localStorage.setItem('ah_interaction_mode', m);
    } catch {
      /* ignore */
    }
    this.persistSessionSettings({ interactionMode: m });
  }

  /**
   * 把当前会话的某项设置写入本地表 + 同步到服务端（其它端经 session:meta 实时收到）。
   * @param partial 仅需更新的字段（交互模式 / 模型 / agent 之一或多个）。
   */
  private async persistSessionSettings(
    partial: {
      interactionMode?: 'qa' | 'plan';
      model?: string;
      agentId?: string;
    }
  ) {
    const sid = this.activeId;
    if (!sid) return;
    // 合并进按会话本地表（先取已记录的，再覆盖本次更新项）。
    const prev = this.sessionSettings[sid] || {};
    const next = { ...prev, ...partial };
    this.sessionSettings = { ...this.sessionSettings, [sid]: next };
    // 更新左侧栏列表项（切回/刷新时一致）。
    this.sessions = this.sessions.map((s) =>
      s.id === sid
        ? {
            ...s,
            interactionMode: next.interactionMode,
            model: next.model,
            agentId: next.agentId
          }
        : s
    );
    // 服务端落库 + 广播（title 沿用当前列表项标题，meta 仅带本次变更字段）。
    const cur = this.sessions.find((s) => s.id === sid);
    try {
      await client.renameChatSession(
        sid,
        cur?.title || '新对话',
        {
          interactionMode: next.interactionMode,
          model: next.model,
          agentId: next.agentId
        }
      );
    } catch {
      /* 同步失败不致命：本地已乐观更新，下次列表刷新会重试 */
    }
  }

  /** 切换移动端侧栏抽屉（≤900px 生效）。 */
  private toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
    if (this.sidebarOpen) {
      // 防止打开瞬间触发 scrim 点击导致立即关闭
      this._sidebarJustOpened = true;
      setTimeout(() => {
        this._sidebarJustOpened = false;
      }, 300);
    }
  }

  /** 切换 PC 端侧栏折叠态（展开/收起）。 */
  private toggleSidebarCollapse() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
  }

  /**
   * 跳转到指定功能面板（自检 / 环境等）：经 ah-goto 事件冒泡到顶层 ah-app
   * 的 Tab 路由。这些入口已从侧边菜单收纳为聊天页顶栏的快捷按钮。
   */
  private gotoPanel(tab: string) {
    this.dispatchEvent(
      new CustomEvent('ah-goto', { detail: tab, bubbles: true, composed: true })
    );
  }

  /** 渲染附件预览（图片缩略图 / 文件图标）。 */
  private renderAttachments(files: UploadedFile[]): TemplateResult {
    const hasImages = files.some((f) => f.type.startsWith('image/'));
    const images = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    return html`
      <div class="attachments ${hasImages ? 'has-images' : ''}">
        ${images.map(
          (f) =>
            html`<div
              class="attach-img is-previewable"
              title="点击预览"
              @click=${() => this.openPreview(f)}
            >
              <img src=${f.dataUrl} alt=${escapeHtml(f.name)} loading="lazy" />
            </div>`
        )}
        ${others.map(
          (f) =>
            html`<div class="attach-file">
              ${this.fileIcon(f)} ${escapeHtml(f.name)}
              (${this.formatSize(f.size)})
            </div>`
        )}
      </div>
    `;
  }

  private fileIcon(f: UploadedFile): string {
    if (f.type.startsWith('image/')) return '🖼';
    if (f.type.includes('pdf')) return '📄';
    if (
      f.type.includes('csv') ||
      f.type.includes('json') ||
      f.type.includes('text')
    )
      return '📝';
    return '📎';
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** 断连恢复横幅：reconnecting 显示自动恢复中提示；lost 给出「重新连接」手动入口。 */
  private renderConnBanner() {
    const st = this.connState[this.activeId];
    if (!st || st === 'connected') return nothing;
    if (st === 'reconnecting') {
      return html`<div class="conn-banner warn">
        ⚠️ 连接中断，正在自动恢复会话…
      </div>`;
    }
    return html`<div class="conn-banner lost">
      <span
        >⚠️
        与服务器的连接已断开${this.jobBy[this.activeId]
          ? ''
          : '，本次运行已丢失'}</span
      >
      ${this.jobBy[this.activeId]
        ? html`<button
            class="conn-retry"
            @click=${() => this.resumeLost(this.activeId)}
          >
            重新连接
          </button>`
        : nothing}
    </div>`;
  }

  private renderMessage(m: ChatMsg) {
    // 用户消息：渲染气泡文本 + 附件预览。
    if (m.role === 'user') {
      const hasAttachments = m.attachments && m.attachments.length > 0;
      // 编辑态：气泡原位替换为编辑框（草稿 + 取消/发送），不再展示原文。
      if (this.editingMsgId === m.id) {
        return html`
          <div class="msg user">
            <div class="avatar">你</div>
            <div class="bubble editing">
              <textarea
                class="edit-input"
                .value=${this.editingDraft}
                @input=${(e: Event) =>
                  (this.editingDraft = (e.target as HTMLTextAreaElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void this.sendEdit(m.id);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.cancelEdit();
                  }
                }}
                @pointerdown=${this.onComposerPointerDown}
                @pointermove=${this.onComposerPointerMove}
                @pointerup=${() => this.cancelComposerLongPress()}
                @contextmenu=${(e: Event) => {
                  // 长按待触发期间抑制系统右键/Android 长按菜单，否则菜单抢走手势。
                  if (this.longPressTimer) e.preventDefault();
                }}
              ></textarea>
              <div class="edit-actions">
                <button
                  type="button"
                  class="edit-btn"
                  title="取消编辑 (Esc)"
                  @click=${() => this.cancelEdit()}
                >
                  取消
                </button>
                <button
                  type="button"
                  class="edit-btn primary"
                  title="发送 (Enter)"
                  ?disabled=${!this.editingDraft.trim() ||
                  this.streaming[this.activeId] === true}
                  @click=${() => void this.sendEdit(m.id)}
                >
                  发送 ↑
                </button>
              </div>
            </div>
          </div>
        `;
      }
      return html`
        <div class="msg user">
          <div class="avatar">你</div>
          <div class="user-col">
            <div class="bubble">
              ${hasAttachments
                ? this.renderAttachments(m.attachments!)
                : nothing}
              <div class="msg-text">${unsafeHTML(toRichHtml(m.content))}</div>
            </div>
            ${m.content?.trim()
              ? html`<div
                  class="msg-actions ${this.hoverUserMsgId === m.id
                    ? 'show'
                    : ''}"
                >
                  <button
                    type="button"
                    class="msg-action"
                    title=${this.copiedMsgId === m.id ? '已复制' : '复制'}
                    @click=${() => this.copyMsgText(m.id, m.content)}
                  >
                    ${this.copiedMsgId === m.id
                      ? html`<svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2.2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>`
                      : html`<svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <rect
                            width="14"
                            height="14"
                            x="8"
                            y="8"
                            rx="2"
                            ry="2"
                          />
                          <path
                            d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
                          />
                        </svg>`}
                  </button>
                  <button
                    type="button"
                    class="msg-action"
                    title="编辑"
                    ?disabled=${this.streaming[this.activeId] === true}
                    @click=${() => this.startEdit(m.id, m.content)}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path
                        d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"
                      />
                      <path d="m15 5 4 4" />
                    </svg>
                  </button>
                </div>`
              : nothing}
          </div>
        </div>
      `;
    }

    // 助手消息：合并视图 —— 深度思考（实时流式）在上，最终回答（分隔后）在下；
    // 模型仍在处理时于对应区域显示「思考中 / 模型正在回复…」文字动效。
    // 流式判定基于「当前显示会话是否正在流式、且本消息即其流式消息」。
    const sIdx = this.streamIdx[this.activeId] ?? -1;
    const isStreamingAssistant =
      this.streaming[this.activeId] === true &&
      sIdx >= 0 &&
      this.messages[sIdx]?.id === m.id &&
      m.role === 'assistant';
    // 是否展示思考区：仅当模型确实返回了推理内容（流式首 token 到达即出现）。
    const showThinking = !!m.reasoning;
    // 阶段判定：尚未开始生成回答 → 处于「思考中」；否则「回答中」。
    const isThinking = isStreamingAssistant && !m.content;
    const isAnswering = isStreamingAssistant && !!m.content;

    // 复制按钮：仅在回答已产出内容且非流式进行中时显示。
    const showCopy = !!m.content?.trim() && !isStreamingAssistant;

    return html`
      <div class="msg assistant ${m.error ? 'error' : ''}">
        <div class="avatar">A</div>
        ${showCopy
          ? html`<button
              type="button"
              class="assistant-copy ${this.copiedMsgId === m.id ? 'done' : ''}"
              title=${this.copiedMsgId === m.id ? '已复制' : '复制'}
              @click=${() => this.copyMsgText(m.id, m.content)}
            >
              ${this.copiedMsgId === m.id
                ? html`<svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>`
                : html`<svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                    <path
                      d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
                    />
                  </svg>`}
            </button>`
          : nothing}
        <div class="bubble">
          ${showThinking && this.deepThink
            ? this.renderThinking(m, isThinking)
            : nothing}
          ${showThinking &&
          this.deepThink &&
          (m.content || isStreamingAssistant)
            ? html`<div class="sep"><span>回答</span></div>`
            : nothing}
          ${this.renderAnswer(m, isAnswering, isStreamingAssistant)}
          ${m.plan ? this.renderPlanCard(m) : nothing}
          ${this.renderExtras(m, isStreamingAssistant)}
        </div>
      </div>
    `;
  }

  /**
   * 渲染「深度思考」区（合并视图·顶部）：
   * 展示模型实际返回的推理内容（m.reasoning），随 llm:reasoning 增量经打字机逐字显现。
   * 流式推理进行中时，标题显示「思考中…」动效、正文末尾显示闪烁光标。
   */
  private renderThinking(m: ChatMsg, isThinking: boolean): TemplateResult {
    const parsed =
      m.reasoning && m.reasoning.trim() ? parseDeepThinking(m.reasoning) : null;
    const collapsed = !!this.thinkCollapsed[String(m.id)];
    return html`
      <div
        class="think ${isThinking ? 'live' : ''} ${collapsed
          ? 'collapsed'
          : ''}"
      >
        <div
          class="think-head"
          @click=${() => this.toggleThink(m.id)}
          title="点击折叠 / 展开"
        >
          <svg
            class="think-ico"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M9 18h6M10 21h4" />
            <path
              d="M12 3a6 6 0 0 0-3.8 10.7c.6.5.8 1.2.8 2.3h6c0-1.1.2-1.8.8-2.3A6 6 0 0 0 12 3z"
            />
          </svg>
          <span class="think-title">深度思考</span>
          ${isThinking
            ? html`<span class="think-status"
                >思考中<span class="dots"><i></i><i></i><i></i></span
              ></span>`
            : nothing}
          ${collapsed && m.reasoning
            ? html`<span class="think-count">${m.reasoning.length} 字</span>`
            : nothing}
          <svg
            class="think-chev"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
        <div class="think-body">
          ${parsed
            ? html` ${parsed.vars.length
                  ? html`<div class="dvars">
                      <div class="dvars-title">关键变量</div>
                      <div class="dvars-grid">
                        ${parsed.vars.map(
                          ([k, v]) => html`<div class="dvar">
                            <span class="dvar-k">${escapeHtml(k)}</span>
                            <span class="dvar-v">${escapeHtml(v)}</span>
                          </div>`
                        )}
                      </div>
                    </div>`
                  : nothing}
                <div class="think-text">
                  ${parsed.text
                    ? unsafeHTML(toRichHtml(parsed.text))
                    : html`<span class="muted">（暂无推理内容）</span>`}
                </div>`
            : html`<div class="think-text muted">
                ${isThinking ? '模型正在思考…' : '（模型未返回推理内容）'}
              </div>`}
          ${isThinking ? html`<span class="caret"></span>` : nothing}
        </div>
      </div>
    `;
  }

  /** 渲染最终回答区（合并视图·底部）：随 llm:token 增量逐字显现；流式进行中显示「模型正在回复…」动效。 */
  private renderAnswer(
    m: ChatMsg,
    isAnswering: boolean,
    isStreaming: boolean
  ): TemplateResult {
    return html`
      <div class="answer">
        ${m.content && m.content.trim()
          ? html`<div class="msg-text">
              ${unsafeHTML(toRichHtml(m.content))}
            </div>`
          : nothing}
        ${isAnswering ? html`<span class="caret"></span>` : nothing}
        ${isStreaming
          ? html`<div class="replying">
              模型正在回复<span class="dots"><i></i><i></i><i></i></span>
            </div>`
          : nothing}
        ${!m.content && !isStreaming
          ? html`<div class="msg-text placeholder">等待响应…</div>`
          : nothing}
      </div>
    `;
  }

  /**
   * 渲染计划卡片（P0 计划模式）：任务拆解 / 步骤 / 依赖 / 预期产出 + 状态标记。
   * pending 态显示「确认执行 / 取消」；running 显示当前任务；done/cancelled 只读。
   */
  private renderPlanCard(m: ChatMsg): TemplateResult {
    const plan = m.plan;
    if (!plan) return html``;
    const st = this.planExec[m.id] ?? { status: 'pending' as const, done: {} };
    const statusLabel =
      st.status === 'pending'
        ? '待确认'
        : st.status === 'running'
        ? `执行中 · ${st.currentTaskId ?? ''}`
        : st.status === 'done'
        ? '已完成'
        : st.status === 'failed'
        ? `执行失败 · ${st.failedTaskId ?? ''}`
        : '已取消';
    return html`<div class="plan-card">
      <div class="plan-head">
        <span class="plan-title">📋 执行计划</span>
        <span class="plan-goal">${escapeHtml(plan.goal)}</span>
      </div>
      <ol class="plan-tasks">
        ${plan.tasks.map((t, i) => {
          const done = !!st.done[t.id];
          const active = st.status === 'running' && st.currentTaskId === t.id;
          const failed = st.status === 'failed' && st.failedTaskId === t.id;
          return html`<li
            class="plan-task ${done ? 'done' : ''} ${active
              ? 'active'
              : ''} ${failed ? 'failed' : ''}"
          >
            <div class="pt-head">
              <span class="pt-mark"
                >${done ? '✓' : active ? '⏳' : failed ? '✗' : i + 1}</span
              >
              <b>${escapeHtml(t.title)}</b>
            </div>
            ${t.steps.length
              ? html`<ol class="pt-steps">
                  ${t.steps.map((s) => html`<li>${escapeHtml(s)}</li>`)}
                </ol>`
              : nothing}
            <div class="pt-meta">
              依赖：${t.dependsOn.length ? t.dependsOn.join('、') : '无'} ·
              预期产出：${escapeHtml(t.expectedOutput || '—')}
            </div>
          </li>`;
        })}
      </ol>
      ${
        /* 状态 + 操作：置于卡片右下角一行，状态在操作按钮之前。 */
        html`<div class="plan-actions">
          <span class="pill ${st.status}">${statusLabel}</span>
          <div class="plan-action-btns">
            ${st.status === 'pending'
              ? html`<button
                    class="plan-btn"
                    @click=${() => this.confirmPlan(m)}
                  >
                    确认执行
                  </button>
                  <button
                    class="plan-btn ghost"
                    @click=${() => this.cancelPlan(m.id)}
                  >
                    取消
                  </button>`
              : nothing}
            ${st.status === 'failed'
              ? html`<button
                  class="plan-btn"
                  @click=${() => this.confirmPlan(m)}
                >
                  从失败任务继续
                </button>`
              : nothing}
          </div>
        </div>`
      }
    </div>`;
  }

  /** 确认/恢复计划：按拓扑序（parsePlanOutput 已保证）逐任务派发；任一任务失败或用户停止即立即中止，等待用户指令后再继续。 */
  private async confirmPlan(m: ChatMsg) {
    const sid = this.activeId;
    if (!sid || !m.plan) return;
    const st = this.planExec[m.id];
    // pending=首次确认；failed=失败后从失败节点恢复。running/done/cancelled 不再进入。
    if (!st || (st.status !== 'pending' && st.status !== 'failed')) return;
    this.planExec = { ...this.planExec, [m.id]: { ...st, status: 'running' } };
    for (const task of m.plan.tasks) {
      // 已完成的任务（上次成功跑完的）直接跳过：恢复执行只重跑失败节点及其后续。
      if (st.done[task.id]) continue;
      // 每个任务派发前刷新当前任务标记（驱动卡片 ⏳ 状态）。
      this.planExec = {
        ...this.planExec,
        [m.id]: {
          ...this.planExec[m.id],
          status: 'running',
          currentTaskId: task.id
        }
      };
      const parts = [`【计划任务 ${task.id}】${task.title}`];
      if (task.steps.length) {
        parts.push('步骤：', ...task.steps.map((s, i) => `${i + 1}. ${s}`));
      }
      parts.push(`预期产出：${task.expectedOutput || '—（按任务目标交付）'}`);
      const result = await this.dispatchPrompt(sid, parts.join('\n'), [], {
        planTask: true
      });
      if (result !== 'ok') {
        if (result === 'error') {
          // 任务执行失败（模型报错 / 断连）：立即中止后续所有任务派发，
          // 记录失败节点并置 failed 态 —— 卡片出现「从失败任务继续」按钮，
          // 等待用户给出指令（重试 / 调整）后从该节点拉起继续执行。
          this.planExec = {
            ...this.planExec,
            [m.id]: {
              ...this.planExec[m.id],
              status: 'failed',
              failedTaskId: task.id,
              currentTaskId: undefined
            }
          };
        } else {
          // 用户手动停止：中止剩余任务并标记取消，已完成任务的产出保留在会话中。
          this.planExec = {
            ...this.planExec,
            [m.id]: {
              ...this.planExec[m.id],
              status: 'cancelled',
              currentTaskId: undefined
            }
          };
        }
        return;
      }
      this.planExec = {
        ...this.planExec,
        [m.id]: {
          ...this.planExec[m.id],
          done: { ...this.planExec[m.id].done, [task.id]: true },
          failedTaskId: undefined
        }
      };
    }
    this.planExec = {
      ...this.planExec,
      [m.id]: {
        ...this.planExec[m.id],
        status: 'done',
        currentTaskId: undefined,
        failedTaskId: undefined
      }
    };
  }

  /** 取消计划：不再执行任何任务。 */
  private cancelPlan(msgId: number) {
    const st = this.planExec[msgId];
    if (!st || st.status !== 'pending') return;
    this.planExec = {
      ...this.planExec,
      [msgId]: { ...st, status: 'cancelled' }
    };
  }

  /**
   * 渲染 Agent 回复下方的「调用链路 / 关键信息」入口按钮。
   * 原内联折叠块已改为：点按钮 → <ah-drawer> 侧滑抽屉展示（不占用主阅读流、移动端更友好）。
   * 两个分区各一个按钮；点击分别打开抽屉并定位到对应分区。流式进行中给调用链路按钮加动效点。
   */
  private renderExtras(m: ChatMsg, isStreaming: boolean): TemplateResult {
    const hasTrace = !!(m.trace && m.trace.length > 0);
    const insights = hasTrace ? buildInsights(m.trace!) : null;
    if (!hasTrace && !insights) return html``;
    const traceIcon = html`<svg
      class="ticon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="6" r="2.4" />
      <circle cx="12" cy="18" r="2.4" />
      <path d="M7.6 7.6 11 16M16.4 7.6 13 16M8 6h8" />
    </svg>`;
    return html`
      <div class="extras">
        ${hasTrace
          ? html`<button
              type="button"
              class="extra-btn ${this.traceDrawerMsg === m &&
              this.traceDrawerSection === 'trace'
                ? 'active'
                : ''}"
              @click=${() => {
                this.traceDrawerMsg = m;
                this.traceDrawerSection = 'trace';
              }}
            >
              ${traceIcon}<span>调用链路</span
              ><span class="tcount">${countTraceNodes(m.trace!)} 节点</span>
              ${isStreaming
                ? html`<span class="dots"><i></i><i></i><i></i></span>`
                : nothing}
            </button>`
          : nothing}
        ${insights
          ? html`<button
              type="button"
              class="extra-btn alt ${this.traceDrawerMsg === m &&
              this.traceDrawerSection === 'insights'
                ? 'active'
                : ''}"
              @click=${() => {
                this.traceDrawerMsg = m;
                this.traceDrawerSection = 'insights';
              }}
            >
              <span>关键信息</span>
            </button>`
          : nothing}
      </div>
    `;
  }

  /** 调用链路 / 关键信息 抽屉：展示当前选中消息的追踪树与洞察摘要。
   *  始终渲染 <ah-drawer>（open 绑定到是否有选中消息），关闭时由组件自放离场动画，
   *  父级仅在 close 事件后才清空 traceDrawerMsg，保证滑出动画完整可见。 */
  private renderTraceDrawer(): TemplateResult {
    const m = this.traceDrawerMsg;
    const title = this.traceDrawerSection === 'trace' ? '调用链路' : '关键信息';
    return html`
      <ah-drawer
        ?open=${m !== null}
        placement="right"
        title=${title}
        size="500px"
        @close=${() => (this.traceDrawerMsg = null)}
      >
        ${m && m.trace && m.trace.length > 0
          ? html`<div class="trace-drawer">
              ${this.traceDrawerSection === 'trace'
                ? html`<div class="trace-body">
                    ${m.trace.map((n) =>
                      renderTraceNode(n, undefined, () => this.requestUpdate())
                    )}
                  </div>`
                : html`<div class="insights">
                    ${renderInsights(buildInsights(m.trace))}
                  </div>`}
            </div>`
          : nothing}
      </ah-drawer>
    `;
  }

  render() {
    const active = this.sessions.find((s) => s.id === this.activeId);
    return html`
      <div
        class="sidebar ${this.sidebarOpen ? 'open' : ''} ${this.sidebarCollapsed
          ? 'collapsed'
          : ''}"
      >
        <div class="side-head">
          <button
            class="collapse-btn"
            title=${this.sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            @click=${() => this.toggleSidebarCollapse()}
          >
            ${this.sidebarCollapsed ? '›' : '‹'}
          </button>
          <button class="primary new-btn" @click=${() => this.newChat()}>
            ＋ 新对话
          </button>
        </div>
        <div class="session-list">
          ${this.sessions.length === 0
            ? html`<p class="muted">暂无会话，发送消息即自动创建。</p>`
            : this.sessions.map(
                (s) => html`
                  <div
                    class="session ${s.id === this.activeId ? 'active' : ''}"
                    @click=${() => this.selectSession(s.id)}
                  >
                    <span class="dot"></span>
                    <span class="title">${escapeHtml(s.title)}</span>
                    <span class="acts">
                      <button
                        class="icon-btn"
                        title="重命名"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          this.renameSession(s.id);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        class="icon-btn"
                        title="删除"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          this.deleteSession(s.id);
                        }}
                      >
                        🗑
                      </button>
                    </span>
                  </div>
                `
              )}
        </div>
      </div>

      <div class="main">
        <div class="chat-head">
          <button
            class="menu-btn"
            @click=${() => this.toggleSidebar()}
            title="会话列表"
            aria-label="会话列表"
          >
            <!-- 对话气泡 + 文字行图标：与外层外壳的导航汉堡 ☰ 区分，语义为「会话/历史列表」 -->
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
              />
              <path d="M8 9h8M8 13h5" />
            </svg>
          </button>
          <span class="title"
            >${active ? escapeHtml(active.title) : '新对话'}</span
          >
          <span class="spacer"></span>
          <!-- 深度思考 / 联网搜索 快捷开关（激活态 accent 高亮，会话内可切换，刷新默认开） -->
          <button
            class="tool-toggle ${this.deepThink ? 'on' : ''}"
            title="深度思考"
            aria-pressed="${this.deepThink}"
            @click=${() => {
              this.deepThink = !this.deepThink;
              try {
                localStorage.setItem(
                  'ah_deep_think',
                  this.deepThink ? '1' : '0'
                );
              } catch {
                /* ignore */
              }
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M9 18h6M10 22h4" />
              <path
                d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"
              />
            </svg>
          </button>
          <button
            class="tool-toggle ${this.web ? 'on' : ''}"
            title="联网搜索"
            aria-pressed="${this.web}"
            @click=${() => {
              this.web = !this.web;
              try {
                localStorage.setItem('ah_web', this.web ? '1' : '0');
              } catch {
                /* ignore */
              }
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20" />
              <path
                d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
              />
            </svg>
          </button>
          <!-- 自检 / 环境：跳转到原「验证」「环境」面板（菜单已收纳，经 ah-goto 路由） -->
          <button
            class="toggle"
            title="自检 / 验证"
            aria-label="自检 / 验证"
            @click=${() => this.gotoPanel('verify')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </button>
          <button
            class="toggle"
            title="临时 / 预览环境"
            aria-label="临时 / 预览环境"
            @click=${() => this.gotoPanel('env')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"
              />
              <path
                d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"
              />
              <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
              <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
            </svg>
          </button>
        </div>

        <div class="scroll-region">
          <div class="scroll" ${ref(this.scrollRef)} @scroll=${this.onScroll}>
            ${this.messages.length === 0
              ? html`
                  <div class="empty">
                    <h1>有什么可以帮你的？</h1>
                    <p>
                      基于 agent-harness
                      的多会话对话。下方输入即可开始，右侧可新建 / 切换会话。
                    </p>
                  </div>
                `
              : html`<div class="thread">
                  ${this.renderConnBanner()}
                  ${this.messages.map((m) => this.renderMessage(m))}
                </div>`}
          </div>
          ${this.showScrollDown
            ? html`<button
                class="scroll-down"
                title="回到底部"
                aria-label="回到底部"
                @click=${() => this.scrollToBottomSmooth()}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 5v14M19 12l-7 7-7-7" />
                </svg>
              </button>`
            : nothing}
        </div>

        <div class="composer-wrap">
          <div class="composer">
            ${this.attachments.length > 0
              ? html`<div class="attachments-preview">
                  ${this.attachments.map(
                    (f, i) => html`
                      <div
                        class="attach-preview-item ${f.uploadStatus === 'error'
                          ? 'error'
                          : ''} ${this.isPreviewable(f) ? 'is-image' : ''}"
                        @click=${() => this.openPreview(f)}
                      >
                        ${f.type.startsWith('image/')
                          ? html`<img
                              src=${f.dataUrl}
                              alt=${escapeHtml(f.name)}
                              class="attach-thumb"
                            />`
                          : html`<span class="attach-icon"
                              >${this.fileIcon(f)}</span
                            >`}
                        <span class="attach-name" title=${f.name}
                          >${escapeHtml(f.name)}</span
                        >
                        ${f.uploadStatus === 'uploading'
                          ? html`<span
                              class="attach-status uploading"
                              title="上传中"
                              >⏳</span
                            >`
                          : f.uploadStatus === 'done'
                          ? html`<span class="attach-status done" title="已上传"
                              >✓</span
                            >`
                          : f.uploadStatus === 'error'
                          ? html`<span
                              class="attach-err"
                              title=${f.uploadError || '上传失败'}
                            ></span>`
                          : nothing}
                        <button
                          type="button"
                          class="attach-rm"
                          title="移除"
                          @click=${(e: Event) => {
                            // 阻止冒泡到外层卡片的 openPreview（点删除不应触发预览）。
                            e.stopPropagation();
                            this.removeAttachment(i);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    `
                  )}
                </div>`
              : nothing}
            <div class="composer-body">
              <textarea
                rows="1"
                placeholder="给 Agent 发送消息…（Enter 发送，Shift+Enter 换行）"
                .value=${this.input}
                ?disabled=${this.streaming[this.activeId] === true}
                @input=${this.onInput}
                @keydown=${this.onKey}
              ></textarea>
            </div>
            <div class="composer-footer">
              <div class="composer-footer-left">
                <label class="attach-btn" title="上传附件">
                  <input
                    type="file"
                    multiple
                    accept="image/*,.txt,.md,.csv,.json"
                    style="display:none"
                    @change=${this.onFileSelect}
                  />
                  +
                </label>
                <ah-agent-picker
                  .agents=${this.agents}
                  .value=${this.agentId}
                  @agent-change=${(e: Event) => {
                    const v = (e as CustomEvent<{ value: string }>).detail.value;
                    this.agentId = v;
                    this.persistSessionSettings({ agentId: v });
                  }}
                ></ah-agent-picker>
                <ah-mode-picker
                  .mode=${this.interactionMode}
                  @mode-change=${(e: Event) =>
                    this.setInteractionMode(
                      (e as CustomEvent<{ value: 'qa' | 'plan' }>).detail.value
                    )}
                ></ah-mode-picker>
              </div>
              <div class="composer-footer-right">
                <ah-model-picker
                  .model=${this.model}
                  .deepThink=${this.deepThink}
                  .web=${this.web}
                  @model-change=${(e: Event) => {
                    const d = (
                      e as CustomEvent<{ model: string; ctx?: number }>
                    ).detail;
                    this.model = d.model;
                    // 仅当选中模型带官方上下文窗口时更新分母；否则清零 ——
                    // 默认模型 / 自定义模型的窗口未知，hideCtxRing 据此隐藏用量展示。
                    // （不再回填 defaultCtxWindow，避免 128K 兜底伪装成真实数据。）
                    this.serverCtxWindow = d.ctx && d.ctx > 0 ? d.ctx : 0;
                    try {
                      localStorage.setItem('ah_model', this.model);
                    } catch {
                      /* ignore */
                    }
                    this.persistSessionSettings({ model: d.model });
                  }}
                  @think-change=${(e: Event) => {
                    this.deepThink = (
                      e as CustomEvent<{ value: boolean }>
                    ).detail.value;
                    try {
                      localStorage.setItem(
                        'ah_deep_think',
                        this.deepThink ? '1' : '0'
                      );
                    } catch {
                      /* ignore */
                    }
                  }}
                  @web-change=${(e: Event) => {
                    this.web = (
                      e as CustomEvent<{ value: boolean }>
                    ).detail.value;
                    try {
                      localStorage.setItem('ah_web', this.web ? '1' : '0');
                    } catch {
                      /* ignore */
                    }
                  }}
                  @ctx-change=${(e: Event) => {
                    const d = (e as CustomEvent<{ ctx: number }>).detail;
                    // 模型目录回抛的官方上下文窗口：有则显示用量圆环，无则隐藏。
                    this.serverCtxWindow = d.ctx && d.ctx > 0 ? d.ctx : 0;
                  }}
                ></ah-model-picker>
                ${this.hideCtxRing() ? nothing : this.renderCtxRing()}
                ${this.streaming[this.activeId] === true
                  ? html`<button
                      class="send"
                      title="停止"
                      @click=${() => this.stop()}
                    >
                      ■
                    </button>`
                  : html`<button
                      class="send"
                      title="发送"
                      ?disabled=${!this.input.trim()}
                      @click=${() => this.send()}
                    >
                      ↑
                    </button>`}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        class="scrim ${this.sidebarOpen ? 'show' : ''}"
        @click=${() => {
          if (this._sidebarJustOpened) return;
          this.sidebarOpen = false;
        }}
      ></div>
      ${this.fullscreenEditOpen
        ? html`<div
            class="fullscreen-edit"
            @contextmenu=${(e: Event) => e.stopPropagation()}
          >
            <div class="fe-head">
              <span class="fe-title">编辑消息</span>
              <!-- 收起按钮：CSS 边框画 chevron（旋转 L 形边框）。
                   SVG 在真机上曾隐形、纯文字方案观感差 —— 盒模型渲染两者兼顾。 -->
              <button
                type="button"
                class="fe-collapse"
                title="收起"
                aria-label="收起全屏编辑"
                @click=${() => this.closeFullscreenEdit()}
              >
                <svg
                  class="chev"
                  viewBox="0 0 10 6"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M1 1l4 4 4-4"></path>
                </svg>
              </button>
            </div>
            <textarea
              class="fe-input"
              placeholder="输入消息…"
              .value=${this.editingDraft}
              @input=${(e: Event) =>
                (this.editingDraft = (e.target as HTMLTextAreaElement).value)}
            ></textarea>
          </div>`
        : nothing}
      ${this.previewFile
        ? html`<div class="lightbox" @click=${() => this.closePreview()}>
            <button
              class="lightbox-close"
              title="关闭 (Esc)"
              @click=${(e: Event) => {
                e.stopPropagation();
                this.closePreview();
              }}
            >
              ×
            </button>
            <img
              src=${this.previewFile.dataUrl}
              alt=${escapeHtml(this.previewFile.name)}
              @click=${(e: Event) => e.stopPropagation()}
            />
            <div class="lightbox-info">
              ${escapeHtml(this.previewFile.name)} ·
              ${this.formatSize(this.previewFile.size)}
            </div>
          </div>`
        : nothing}
      ${this.renderTraceDrawer()}
    `;
  }
}
