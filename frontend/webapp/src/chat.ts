import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state, query, property } from 'lit/decorators.js';
import { ref } from 'lit/directives/ref.js';
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
import { isRetrievalTool, safeJson } from './utils/chat-utils';
import { escapeHtml } from './utils/markdown';

// 上下文用量圆环（已抽离到 chat-context-usage.ts，降低 chat.ts 单体规模）。
import { renderCtxRing, selectContextUsage } from './chat-context-usage';

// 纯渲染/格式化工具（已抽离到 chat-render-utils.ts）。
import {
  fileIcon,
  formatSize,
  buildPlanStatusLookup
} from './chat-render-utils';

// 消息渲染簇（已抽离到 chat-message-render.ts，交互态经 ChatRenderCtx 数据+回调 opts 传参，行为不变）。
import {
  renderConnBanner,
  renderMessage,
  renderThinking,
  renderAnswer,
  renderExtras,
  renderTraceDrawer,
  renderPlanCard,
  type ChatRenderCtx
} from './chat-message-render';

// 滚动跟随簇（已抽离到 chat-scroll.ts，作为轻量控制器由 AhChat 持有为 this.scrollCtl）。
import { ChatScroll } from './chat-scroll';

// 打字机引擎（已抽离到 chat-typewriter.ts，作为轻量控制器由 AhChat 持有为 this.typewriter）。
import { ChatTypewriter } from './chat-typewriter';

// 运行管线控制器（已抽离到 chat-run-runtime.ts：ingest / dispatchPrompt / resumeLost / stop /
// 看门狗 / 可见性体检 + 断连重连续传引擎；AhChat 经 RunDeps 桥接领域数据 / 行为方法）。
import { ChatRunRuntime, type RunDeps } from './chat-run-runtime';

// 聊天界面本地视图类型（已拆出到 chat-types.ts，降低 chat.ts 单体规模）。
import type {
  ToolView,
  ExecutionPlanView,
  PlanExecState,
  ChatMsg,
  SessionView,
  TraceCtx
} from './chat-types';
import {
  sanitizeMessages,
  mergeThreadHistories,
  loadThread,
  purgeSessionMirror,
  loadIndex,
  withTimeout,
  type MirroredUsage
} from './chat-history';

// 历史持久化（已抽离到 chat-persist.ts，降低 chat.ts 单体规模）。
import { persistHistory } from './chat-persist';
import type {
  ChatSession,
  RunMode,
  StreamEvent,
  TraceNode,
  TraceKind,
  PlanExecMirror,
  ChatMessage
} from '@agent-harness/client';
import { agentContext, type UploadedFile } from './agent-context';
import { notifyError } from './utils/errors';
import { notify } from './components/ah-notification';

// Slash Command 框架
import {
  handleSlashCommand,
  registerBuiltinCommands,
  type CommandContext
} from './chat-commands';
import './components/file-upload';
import './components/model-picker';
import './components/mode-picker';
import './components/agent-picker';

// 副作用导入：注册 <ah-command-suggestions> 自定义元素。
// 不能写成 `import { AhCommandSuggestions }` —— 该类在 chat.ts 里只作为类型
// 注解（private suggestEl?: AhCommandSuggestions）使用，Vite/esbuild 会把它当作
// 纯类型导入而整条丢弃，导致 customElements.define 永不执行、元素不升级、联想面板
// 永远弹不出来（同时 onKey 转发 handleKey 时会报 “is not a function”）。
import './components/ah-command-suggestions';
import type { AhCommandSuggestions } from './components/ah-command-suggestions';

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

  /** 可选的定向业务 agent：为空则走默认通用 Agent。Web 端用它把对话路由到具体插件 agent（如医美客资）。 */
  @state() agents: { id: string; name: string; domain?: string }[] = [];
  @state() agentId = '';
  /** 当前登录用户的角色（由 app-shell 透传），用于按角色过滤业务 agent。 */
  @property({ type: String }) role = '';

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
  @state() private traceDrawerSection: 'trace' | 'insights' | 'confidence' =
    'trace';

  /** 悬停显示操作按钮的用户消息 id（复制 / 编辑）；-1 表示无。 */
  @state() private hoverUserMsgId = -1;

  /** Slash Command 框架注册标记（防重复注册）。 */
  private _commandsRegistered = false;

  /**
   * 已「胶囊化」的 slash 命令名（不含前导 `/`）；空串表示普通输入态。
   * 命令被选中后从输入框文本中剥离、固化为输入框上方的胶囊，
   * 输入框只剩参数部分；发送时再拼回 `/<cmd> <args>`。
   */
  @state() private cmdName = '';

  /** 主输入框（用于选中命令 / 移除胶囊后回收焦点并重算高度）。 */
  // 用 class 精确定位主输入框：页面里还有「全屏编辑」用的 .fe-input textarea。
  @query('textarea.composer-input')
  private inputEl?: HTMLTextAreaElement | null;

  /** 命令联想组件（用于把输入框的键盘事件转发给它处理）。 */
  @query('ah-command-suggestions')
  private suggestEl?: AhCommandSuggestions | null;

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

  /** 滚动跟随控制器（Phase 4 抽离到 chat-scroll.ts）：持有 scrollRef / 钉底状态 / 浮动按钮显隐。 */
  private scrollCtl = new ChatScroll(this);

  /** 打字机引擎（Phase 3 抽离到 chat-typewriter.ts）：持有 pending/received/finalBy 缓冲 + tick 定时器。 */
  private typewriter = new ChatTypewriter({
    patchSession: (sid, p) => this.patchSession(sid, p),
    curSession: (sid) => this.curSession(sid),
    isAnyStreaming: () => this.anyStreaming,
    requestUpdate: () => this.requestUpdate()
  });

  /** 运行管线控制器（Phase 5 余下 + Phase 6）：ingest / dispatchPrompt / resumeLost / stop /
   *  看门狗 / 可见性体检 + 断连重连续传引擎。运行内部簿记状态由本控制器持有，
   *  领域数据 / 渲染状态 / 行为方法经 RunDeps 桥接（render 与组件其余路径零改动）。 */
  private runRt = new ChatRunRuntime(this.makeRunDeps(), this.typewriter);

  /** 侧栏打开瞬间标记：防止打开后立即被 scrim 点击关闭。 */
  private _sidebarJustOpened = false;

  /** 当前选中模型的上下文窗口上限（token）。来源：模型目录官方 context_length；
   *  0 = 无数据（默认模型 / 自定义模型），「上下文用量」圆环据此隐藏。 */
  private serverCtxWindow = 0;

  /** 当前选中模型的 baseUrl（OpenRouter 模型为 openrouter.ai，自定义模型为用户填写的地址）；
   *  空串表示使用服务端默认配置。由 @model-change 事件的 detail.baseUrl 驱动。 */
  private modelBaseUrl = '';

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
    /** 自上次用量上报以来是否发生过上下文压缩（历史淘汰）。 */
    compressed?: boolean;
    breakdown: {
      system: number;
      tools: number;
      messages: number;
      mcp: number;
      skills: number;
      completion: number;
      cached?: number;
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
  private sessionSettings: Record<
    string,
    {
      interactionMode?: 'qa' | 'plan';
      model?: string;
      agentId?: string;
    }
  > = {};

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
    // 全局运行中指示器：任意会话在流式时亮起，全部结束后熄灭。
    const any = Object.values(this.streaming).some(Boolean);
    window.dispatchEvent(new Event(any ? 'ah:run:start' : 'ah:run:stop'));
  }

  /** 每会话的调用链路追踪构建上下文。 */
  private traces: Record<string, TraceCtx> = {};
  /**
   * 运行内部簿记状态（jobBy / lastSeqBy / finishedBy / erroredBy / lastEventAt /
   * keepAliveAbort / lastInputBy / abortBy / watchTimer）已抽离到 ChatRunRuntime
   * 控制器（见 chat-run-runtime.ts），经 RunDeps 桥接，本组件不再直接持有。
   */

  @state() private connState: Record<
    string,
    'connected' | 'reconnecting' | 'lost'
  > = {};

  /** 当前登录用户是否已配置可用 LLM Key（per-user，来自 /api/state.llm.ready）。
   *  驱动 Mock 提示条与发送前 gating（未配置则真实请求会被服务端 402 拒绝）。 */
  @state() private llmReady = false;
  /** 历史镜像体积上限（字节），来自 /api/state.historyMaxBytes；用于保存前主动裁剪。 */
  private historyMaxBytes = 512 * 1024;

  /** 不可变更新某会话的连接状态，确保 Lit 触发重渲染。 */
  private setConn(sid: string, val: 'connected' | 'reconnecting' | 'lost') {
    this.connState = { ...this.connState, [sid]: val };
  }

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
    persistHistory({
      sid,
      threads: this.threads,
      sessions: this.sessions,
      backendUsage: this.backendUsage,
      runCumulative: this.runCumulative,
      historyMaxBytes: this.historyMaxBytes
    });
  }

  /** 取某会话当前流式消息。 */
  private curSession(sid: string): ChatMsg | null {
    const idx = this.streamIdx[sid];
    if (typeof idx !== 'number') return null;
    const t = this.threads[sid];
    const m = t ? t[idx] : undefined;
    return m ? m : null;
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
      (() => {
        const last = msgs[msgs.length - 1];
        return !!last && last.role === 'assistant' && !(last.content ?? '');
      })()
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
    const cur = nt[idx];
    if (cur) nt[idx] = { ...cur, ...p };
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
      toolByCallId: {},
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
        toolByCallId: {},
        seq: 0
      })
    );
  }

  async connectedCallback() {
    super.connectedCallback();
    // Slash Command 框架：注册内置命令
    if (!this._commandsRegistered) {
      registerBuiltinCommands(this._makeCommandContext());
      this._commandsRegistered = true;
    }
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
    document.addEventListener(
      'visibilitychange',
      this.runRt.onVisibilityChange
    );
    // 静默看门狗：可见状态下流式会话超过 60s 无任何事件（read() 可能静默挂死），
    // 强制中止走统一重连。恢复按 seq 游标续传，误触发无副作用，仅多一次重订阅。
    this.runRt.startWatchdog();

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
      } catch (e) {
        if (attempt === 1) {
          // 重试仍失败 → 降级为本地镜像索引，并明确告诉用户「列表可能不完整」，
          // 而不是像以前那样静默吞掉、让用户以为是自己没有历史会话。
          notifyError(e, {
            title: '会话列表',
            fallback: '会话列表加载失败，已降级为本地缓存（可能不完整）',
            key: 'chat-sessions'
          });
          const idx = await loadIndex();
          this.sessions = Object.entries(idx).map(([sid, m]) => ({
            id: sid,
            title: m.title,
            updatedAt:
              typeof m.updatedAt === 'number' ? m.updatedAt : m.savedAt,
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
      // per-user 真实 LLM 就绪：优先 llm.ready（BYOK），回退旧字段 openrouter。
      this.llmReady =
        !!(state as any)?.llm?.ready || !!(state as any)?.openrouter;
      this.mode = this.llmReady ? 'real' : 'mock';
      this.historyMaxBytes = typeof (state as any)?.historyMaxBytes === 'number'
        ? (state as any).historyMaxBytes
        : this.historyMaxBytes;
      // /api/state 的 contextWindow 只是服务端兜底基线（无官方数据时 128K），
      // 不作为「默认模型」的真实窗口 —— 默认模型同样隐藏用量展示。
    } catch {
      /* 离线/未启动：发送时按 mock 兜底 */
    }

    // 拉取 agent 列表（失败不影响聊天，selector 退化为仅「默认 Agent」）。
    await this.refreshAgents();

    // 插件启用/停用会改变已注册 agent 集合，监听后实时刷新下拉（使已禁用插件的 agent 即时隐藏）。
    window.addEventListener(
      'ah-plugins-changed',
      this.onPluginsChanged as EventListener
    );

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
    document.removeEventListener(
      'visibilitychange',
      this.runRt.onVisibilityChange
    );

    // 跨设备实时同步：组件卸载时停掉常驻 SSE 并移除事件监听（避免泄漏/重复订阅）。
    window.removeEventListener(
      'ah-chat-sync',
      this.onChatSync as EventListener
    );
    stopChatSync();
    this.runRt.stopWatchdog();
    this.cancelComposerLongPress();
    window.removeEventListener(
      'ah-plugins-changed',
      this.onPluginsChanged as EventListener
    );
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
        name: String(a.name ?? a.id),
        domain: String(a.domain ?? '') as any
      }));
      const hasDefault = raw.some((a) => a.id === 'default' || a.id === '');
      // viewer 角色：从列表中彻底过滤掉医美运营分析相关的 agent，不显示、不可选、不可调用。
      const isViewer = this.role === 'viewer';
      const filtered = isViewer
        ? raw.filter((a) => a.domain !== 'medical-aesthetics')
        : raw;
      const next = hasDefault
        ? filtered.map((a) => (a.id === 'default' ? { ...a, id: '' } : a))
        : [{ id: '', name: '默认' }, ...filtered];
      this.agents = next;
      // 当前选中的 agent 若已随插件禁用而从注册表消失，回退到「默认」。
      if (this.agentId && !next.some((a) => a.id === this.agentId)) {
        this.agentId = '';
      }
      // 若当前选中的 agent 被过滤掉，自动回退到「默认」。
      if (this.agentId && isViewer) {
        const selected = next.find((a) => a.id === this.agentId);
        if (!selected) {
          this.agentId = '';
        }
      }
    } catch (e) {
      // 不阻断聊天（下拉退化为「默认」），但下拉里只剩默认项会让人困惑，给一条提示。
      notifyError(e, {
        title: 'Agent 列表',
        fallback: 'Agent 列表拉取失败，已回退为「默认 Agent」',
        key: 'chat-agents'
      });
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
        interactionMode:
          meta?.interactionMode !== undefined
            ? meta.interactionMode
            : s.interactionMode,
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
      if (meta?.interactionMode !== undefined)
        this.interactionMode = meta.interactionMode;
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
        ...(typeof m.reasoning === 'string' && m.reasoning
          ? { reasoning: m.reasoning }
          : {}),
        ...(Array.isArray(m.tools) && m.tools.length
          ? { tools: m.tools as ToolView[] }
          : {}),
        ...(Array.isArray(m.trace) && m.trace.length
          ? { trace: m.trace as TraceNode[] }
          : {})
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
          typeof m.reasoning === 'string' && m.reasoning
            ? m.reasoning
            : cur.reasoning;
        // 终态/流式帧同样携带 tools / trace（服务端完整消息含调用链路）：
        // 必须从 m 合并进来，否则他端同步后「调用链路 / 关键信息」按钮因缺 trace 而不显示。
        const extra = {
          ...(reasoning ? { reasoning } : {}),
          ...(Array.isArray(m.tools) && m.tools.length
            ? { tools: m.tools as ToolView[] }
            : {}),
          ...(Array.isArray(m.trace) && m.trace.length
            ? { trace: m.trace as TraceNode[] }
            : {})
        };
        if (m.streaming) {
          // 进行中快照：仅当新内容更长时覆盖（防乱序/重复帧把已揭示文本截断）。
          if (content.length >= (cur.content ?? '').length) {
            t[idx] = { ...cur, content, ...extra };
          }
        } else {
          // 完整 / 终态：用权威全文覆盖本端回复（含 tools/trace）。
          // 防御：若终态 content 比已流式累积的更短（个别 harness 的 run:end.final
          // 不含完整 token 流），保留更长的累积内容，避免「末尾缺一段」；
          // 工具/链路/思考始终以终态（权威）为准合并。
          const finalContent = content;
          const useContent =
            finalContent.length >= (cur.content ?? '').length
              ? finalContent
              : cur.content ?? '';
          t[idx] = { ...cur, content: useContent, ...extra };
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
   protected updated(changedProps: Map<string, unknown>) {
     super.updated(changedProps);
     if (changedProps.has('role')) {
       void this.refreshAgents();
     }
     this.scrollCtl.scrollToBottom();
     this.scrollCtl.scrollThinkToBottom();
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

  /* ----------------------- 会话管理 ----------------------- */

  private async newChat() {
    // 不中止任何进行中的 run：后台 run 继续写入其所属会话缓冲，新建对话只是切换显示到空线程。
    this.activeId = '';
    this.messages = [];
    this.input = '';
    this.cmdName = '';
    this.scrollCtl.resetToBottom();
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
    if (st?.interactionMode !== undefined)
      this.interactionMode = st.interactionMode;
    else if (sv?.interactionMode !== undefined)
      this.interactionMode = sv.interactionMode;
    if (st?.model !== undefined) this.model = st.model;
    else if (sv?.model !== undefined) this.model = sv.model;
    if (st?.agentId !== undefined) this.agentId = st.agentId;
    else if (sv?.agentId !== undefined) this.agentId = sv.agentId;
    this.persistActiveId(id);
    this.sidebarOpen = false;
    this.input = '';
    this.cmdName = '';

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

        // 空消息属正常（新建会话尚未发送任何消息，服务端返回 messages:[]）：
        // 直接按合法空会话走合并/落内存，不再当作恢复失败抛异常。
        // 先取计划进度镜像查找表；待线程按新 id 重建后再应用（见下）。
        const planStatusLookup = buildPlanStatusLookup(clean);
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
      } catch (err) {
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
          notify.warning(
            '服务端历史拉取失败，已从历史镜像恢复（可能非最新）。',
            {
              key: 'chat-history'
            }
          );
        } else {
          this.threads[id] = localBuf ?? [];

          // 区分「真·服务端不可达（网络/超时/5xx）」与「会话本就为空或不存在（404 且无镜像）」：
          // 后者无数据可恢复、也非故障，不打吓人告警、不打 restoreFailed（避免每次进入空会话都重试弹窗）；
          // 仅前者标记 restoreFailed 并提示，待服务端恢复后再次进入自动重试。
          const isNotFound =
            !!err &&
            typeof err === 'object' &&
            (err as { status?: number }).status === 404;
          if (!isNotFound) {
            this.restoreFailed[id] = true;
            notify.warning(
              '历史记录恢复失败（服务端不可达），已保留当前内容；再次进入将自动重试。',
              { key: 'chat-history' }
            );
          }
        }
      }
    }
    // 恢复历史后补全调用链路中 assistant 消息的内容（修复旧 trace 中 assistant 为空）。
    this.restoreTraceMessages(id);
    this.messages = this.threads[id] ?? [];

    // 切换会话：回到该会话最新消息底部，并恢复「钉底」跟随。
    this.scrollCtl.resetToBottom();

    // 用量快照从会话镜像回填（若有），避免刷新/切换后上下文用量归零或回退粗估；
    // 无快照则保持 null，由后续 llm:usage 事件或回退估算补充。
    this.backendUsage = recoveredUsage?.backendUsage ?? null;
    this.runCumulative = recoveredUsage?.runCumulative ?? null;
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
      notify.success('会话已重命名');
    } catch (e: any) {
      notifyError(e, { title: '重命名会话', fallback: '重命名失败' });
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
      notify.success('会话已删除');
    } catch (e: any) {
      notifyError(e, { title: '删除会话', fallback: '删除失败' });
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
      [s.id]: {
        interactionMode: s.interactionMode,
        model: s.model,
        agentId: s.agentId
      }
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

  /**
   * 构造 Slash Command 上下文：映射 chat.ts 实例状态到 CommandContext 接口。
   * 每次调用返回新对象，避免命令执行期持有 stale 引用。
   */
  private _makeCommandContext(): CommandContext {
    return {
      clearMessages: () => {
        this.messages = [];
      },
      newConversation: async () => {
        this.messages = [];
        this.activeId = '';
        this.threads = {};
        this.streamIdx = {};
        try {
          localStorage.removeItem('ah_conversation_id');
        } catch {}
      },
      copyFinal: async () => {
        try {
          await navigator.clipboard.writeText(
            this.messages
              .filter((m) => m.role === 'assistant')
              .map((m) => m.content ?? '')
              .join('\n\n') || '（暂无结果）'
          );
          notify.success('已复制助手回复到剪贴板');
        } catch {
          notify.error('复制失败：浏览器拒绝了剪贴板权限');
        }
      },
      toggleWeb: () => {
        this.web = !this.web;
      },
      setMode: (m) => {
        this.mode = m;
      },
      setInteractionMode: (m) => {
        this.interactionMode = m;
        localStorage.setItem('ah_interaction_mode', m);
      },
      exportRun: () => {
        // chat.ts 不直接持有 export 能力，降级为复制最终结果
        void this._makeCommandContext().copyFinal();
      },
      notifySuccess: (m) => notify.success(m),
      notifyWarning: (m) => notify.warning(m)
    };
  }

  private async send() {
    // 命令胶囊 + 输入框参数拼成最终提示词（无胶囊时即普通文本）。
    const prompt = this.buildPrompt();
    // 仅阻止「同一会话正在流式时重复发送」；其它会话（含后台进行中的 run）不受影响，可并发。
    if (!prompt && this.attachments.length === 0) return;

    // BYOK 发送前 gating：选中真实模式但当前账号未配置可用 Key → 拦截，
    // 引导去「设置 → 模型服务商」配置（服务端也会以 402 兜底拒绝）。
    if (this.mode === 'real' && !this.llmReady) {
      notify.warning(
        '尚未配置可用的 LLM API Key，无法发起真实对话。请到「设置 → 模型服务商」填入你的 OpenRouter Key。',
        { title: '需要 API Key', key: 'pk-required' }
      );
      this.dispatchEvent(
        new CustomEvent('ah-goto', {
          detail: 'settings',
          bubbles: true,
          composed: true
        })
      );
      return;
    }

    // Slash Command 拦截：如果输入是 /command，处理后不发送到 /api/run
    if (handleSlashCommand(prompt, this._makeCommandContext())) {
      this.clearComposer();
      return;
    }

    // 会话创建是接口调用：失败时给出明确提示，而不是静默地什么都不发生
    // （此前这里没有 try/catch，失败会变成未捕获的 Promise rejection）。
    let sessionId: string;
    try {
      sessionId = await this.ensureSession();
    } catch (e: any) {
      notifyError(e, { title: '新建会话', fallback: '创建会话失败，请重试' });
      return;
    }

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

    this.clearComposer();
    await this.runRt.dispatchPrompt(sessionId, content, imageAttachments, {
      attachments: rawAttachments
    });
  }

  /** 清空输入区：文本 + 命令胶囊 + 附件，并把输入框高度复位。 */
  private clearComposer(): void {
    this.input = '';
    this.cmdName = '';
    this.attachments = [];
    void this.refocusInput();
  }

  /**
   * 派发一次 run（send 与计划模式逐任务执行的公共管线）。
   * 返回 'ok' | 'stopped'（用户手动停止）| 'error'（彻底断连/失败），
   * 供计划执行循环决定是否继续派发后续任务。
   */
  /** 构造 RunDeps 桥接：把 AhChat 的领域数据 / 渲染状态 / 行为方法以箭头函数注入运行控制器。
   * 运行控制器（ChatRunRuntime）仅持有 run 内部簿记状态，其余一律经此桥接读写，
   * 保持 render 与组件其余路径零改动（caps/deps 范式，同 ChatTypewriter）。 */
  private makeRunDeps(): RunDeps {
    return {
      /* ----- 渲染相关状态（仍留 AhChat，render 直接消费） ----- */
      getConnState: (sid) => this.connState[sid] ?? 'connected',
      setConn: (sid, val) => this.setConn(sid, val),
      getStreaming: (sid) => !!this.streaming[sid],
      getStreamingDict: () => this.streaming,
      setStreaming: (sid, val) => this.setStreaming(sid, val),

      /* ----- 会话领域数据 ----- */
      threadFor: (sid) => this.threadFor(sid),
      setStreamIdx: (sid, idx) => {
        this.streamIdx[sid] = idx;
      },
      setThreads: (sid, t) => {
        this.threads[sid] = t;
      },
      getThreads: (sid) => this.threads[sid],
      getActiveId: () => this.activeId,
      setMessages: (t) => {
        this.messages = t;
      },
      getTraces: (sid) => this.traces[sid],
      getPlanExec: () => this.planExec,
      setPlanExec: (v) => {
        this.planExec = v;
      },
      getServerCtxWindow: () => this.serverCtxWindow,
      getServerModelBaseUrl: () => this.modelBaseUrl,
      getBackendUsage: () => this.backendUsage,
      setBackendUsage: (v) => {
        this.backendUsage = v;
      },
      getMode: () => this.mode,
      getModel: () => this.model,
      getAgentId: () => {
        // 防御：viewer 角色下不得调用医美运营分析 agent（即使 agentId 被持久化了），
        // 确保即使列表未刷新的情况下也不会泄露医美数据权限。
        if (this.role === 'viewer' && this.agentId) {
          const agent = this.agents.find((a) => a.id === this.agentId);
          if (agent?.domain === 'medical-aesthetics') return '';
        }
        return this.agentId;
      },
      getWeb: () => this.web,
      getInteractionMode: () => this.interactionMode,
      getAttachments: () => this.attachments,
      setShowCtxUsage: (b) => {
        this.showCtxUsage = b;
      },
      setRunCumulative: (v) => {
        this.runCumulative = v;
      },

      /* ----- 行为方法（留在 AhChat） ----- */
      curSession: (sid) => this.curSession(sid),
      patchSession: (sid, p) => this.patchSession(sid, p),
      resetTrace: (sid) => this.resetTrace(sid),
      customModelEndpoint: () =>
        this.customModelEndpoint() as Promise<Record<string, unknown>>,
      traceHandle: (ev, sid) => this.traceHandle(ev, sid),
      autoCollapseThink: (sid) => this.autoCollapseThink(sid),
      rebuildTraceMessages: (sid) => this.rebuildTraceMessages(sid),
      saveHistory: (sid) => this.saveHistory(sid),
      resetScrollToBottom: () => this.scrollCtl.resetToBottom(),
      nextId: () => this.nextId++,
      requestUpdate: () => this.requestUpdate(),

      /* ----- SSE 客户端 ----- */
      streamRun: (payload, opts) => client.streamRun(payload as any, opts)
    };
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
        const node = mk(
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
        // 按 call.id 索引，并行工具各自命中自己的节点，不再共用单指针 lastTool。
        tc.lastTool = node;
        const cid = (ev.call as { id?: unknown }).id;
        if (cid != null) tc.toolByCallId[String(cid)] = node;
        break;
      }
      case 'tool:deduped': {
        // 加固：工具调用去重命中。复用首次结果，记为「复用缓存」节点（仍挂在当前 LLM 调用下，
        // 便于在调用链里看出哪些请求被去重），但 buildInsights 的「工具调用」计数会排除此类节点。
        if (!tc.llm || !ev.call) break;
        const name = String(ev.call.name ?? 'tool');
        const retrieval = isRetrievalTool(name);
        const node = mk(
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
        tc.lastTool = node;
        const cid = (ev.call as { id?: unknown }).id;
        if (cid != null) tc.toolByCallId[String(cid)] = node;
        node.result =
          typeof ev.result === 'string'
            ? ev.result
            : JSON.stringify(ev.result ?? {});
        break;
      }
      case 'tool:result': {
        // 优先按 call.id 命中对应工具节点（并行工具互不串扰）；无 id 时回退单指针 lastTool。
        const cid = (ev as { call?: { id?: unknown } }).call?.id;
        const node = cid != null ? tc.toolByCallId[String(cid)] : undefined;
        const target = node ?? tc.lastTool;
        if (target) {
          target.result =
            typeof ev.result === 'string'
              ? ev.result
              : JSON.stringify(ev.result ?? {});
          target.status = ev.errored ? 'error' : 'ok';
          target.meta = {
            ...(target.meta ?? {}),
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
      (this.streamIdx[sid] ?? -1) >= 0 &&
      ev.type !== 'llm:token' &&
      ev.type !== 'llm:reasoning'
    ) {
      this.patchSession(sid, { trace: [tc.root] });
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
    // ① 命令联想面板优先消费按键（↑↓ 移动 / Enter·Tab 选中 / Esc 关闭）。
    //    焦点在 light DOM 的 textarea 上，事件不会自己进入组件的 shadow DOM，
    //    所以由宿主显式转发。
    //    防御：自定义元素在 HMR / 异步注入等场景下可能尚未升级到含 handleKey 的类，
    //    先确认方法存在再调用，避免「handleKey is not a function」类崩溃（崩溃会
    //    连带阻断后续输入/发送逻辑）。方法存在时正常转发，否则交由宿主默认处理。
    if (
      this.suggestEl &&
      typeof this.suggestEl.handleKey === 'function' &&
      this.suggestEl.handleKey(e)
    )
      return;

    // ② 输入框为空时按 Backspace → 移除命令胶囊，退回普通输入态。
    if (e.key === 'Backspace' && this.cmdName && !this.input) {
      e.preventDefault();
      this.onCommandRemove();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.send();
    }
  }

  /* ------------------- Slash Command 胶囊交互 ------------------- */

  /**
   * 命令被选中：把命令从输入框文本中剥离、固化为胶囊，
   * 输入框清空留给参数，并把焦点与光标交还给用户。
   */
  private onCommandSelect(name: string): void {
    const next = String(name ?? '')
      .trim()
      .replace(/^\//, '');
    if (!next) return;
    this.cmdName = next;
    this.input = '';
    void this.refocusInput();
  }

  /** 移除命令胶囊：回到普通输入态，焦点回到输入框。 */
  private onCommandRemove(): void {
    if (!this.cmdName) return;
    this.cmdName = '';
    void this.refocusInput();
  }

  /** 输入框重获焦点并重算自适应高度（清空文本后高度不会自动收缩）。 */
  private async refocusInput(): Promise<void> {
    await this.updateComplete;
    const ta = this.inputEl;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
    ta.focus();
  }

  /**
   * 组装最终发送的提示词：胶囊命令 + 输入框参数。
   * 命令未胶囊化时（用户手写 `/cmd args`）保持原样，交由 send() 的命令解析处理。
   */
  private buildPrompt(): string {
    const arg = this.input.trim();
    return this.cmdName ? `/${this.cmdName}${arg ? ` ${arg}` : ''}` : arg;
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
        notify.warning(`文件过大：${f.name}（上限 10MB）`, {
          key: 'chat-upload'
        });
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
        notify.warning(`不支持的文件类型：${f.name}`, { key: 'chat-upload' });
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
        notifyError(err, {
          title: '附件上传',
          fallback: `上传失败：${f.name}`,
          key: 'chat-upload'
        });
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
  private async persistSessionSettings(partial: {
    interactionMode?: 'qa' | 'plan';
    model?: string;
    agentId?: string;
  }) {
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
      await client.renameChatSession(sid, cur?.title || '新对话', {
        interactionMode: next.interactionMode,
        model: next.model,
        agentId: next.agentId
      });
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

  /** 断连恢复横幅：reconnecting 显示自动恢复中提示；lost 给出「重新连接」手动入口。 */
  private renderConnBanner() {
    return renderConnBanner(this.renderCtx());
  }

  private renderMessage(m: ChatMsg) {
    return renderMessage(this.renderCtx(), m);
  }

  private renderThinking(m: ChatMsg, isThinking: boolean): TemplateResult {
    return renderThinking(this.renderCtx(), m, isThinking);
  }

  private renderAnswer(
    m: ChatMsg,
    isAnswering: boolean,
    isStreaming: boolean
  ): TemplateResult {
    return renderAnswer(m, isAnswering, isStreaming);
  }

  private renderExtras(m: ChatMsg, isStreaming: boolean): TemplateResult {
    return renderExtras(this.renderCtx(), m, isStreaming);
  }

  private renderTraceDrawer(): TemplateResult {
    return renderTraceDrawer(this.renderCtx());
  }

  private renderPlanCard(m: ChatMsg): TemplateResult {
    return renderPlanCard(this.renderCtx(), m);
  }

  /**
   * 构造渲染簇所需的「数据 + 回调」快照（ChatRenderCtx）。
   * 把当前交互态与各交互方法的绑定一次性打包，供 chat-message-render.ts 的纯函数使用，
   * 避免渲染模块直接依赖 AhChat 的 private 成员，行为与原先 this.* 调用完全一致。
   */
  private renderCtx(): ChatRenderCtx {
    return {
      activeId: this.activeId,
      messages: this.messages,
      streaming: this.streaming,
      streamIdx: this.streamIdx,
      editingMsgId: this.editingMsgId,
      editingDraft: this.editingDraft,
      hoverUserMsgId: this.hoverUserMsgId,
      copiedMsgId: this.copiedMsgId,
      deepThink: this.deepThink,
      thinkCollapsed: this.thinkCollapsed,
      traceDrawerMsg: this.traceDrawerMsg,
      traceDrawerSection: this.traceDrawerSection,
      connState: this.connState,
      jobBy: this.runRt.jobMap,
      stopped: this.runRt.stoppedMap,
      planExec: this.planExec,
      onEditingInput: (v: string) => {
        this.editingDraft = v;
      },
      sendEdit: (id: number) => void this.sendEdit(id),
      cancelEdit: () => this.cancelEdit(),
      copyMsgText: (id: number, content: string) =>
        void this.copyMsgText(id, content),
      startEdit: (id: number, content: string) => this.startEdit(id, content),
      toggleThink: (id: number) => this.toggleThink(id),
      openPreview: (f: UploadedFile) => this.openPreview(f),
      resumeLost: (id: string) => void this.runRt.resumeLost(id),
      confirmPlan: (m: ChatMsg) => void this.confirmPlan(m),
      cancelPlan: (msgId: number) => this.cancelPlan(msgId),
      setTraceDrawer: (
        m: ChatMsg | null,
        section: 'trace' | 'insights' | 'confidence'
      ) => {
        this.traceDrawerMsg = m;
        this.traceDrawerSection = section;
      },
      requestUpdate: () => this.requestUpdate(),
      onComposerPointerDown: (e: PointerEvent) => this.onComposerPointerDown(e),
      onComposerPointerMove: (e: PointerEvent) => this.onComposerPointerMove(e),
      onComposerPointerUp: () => this.cancelComposerLongPress(),
      onContextMenu: (e: Event) => {
        if (this.longPressTimer) e.preventDefault();
      }
    };
  }
  /** 确认/恢复计划：按拓扑序（parsePlanOutput 已保证）逐任务派发；任一任务失败或用户停止即立即中止，等待用户指令后再继续。 */
  private async confirmPlan(m: ChatMsg) {
    const sid = this.activeId;
    if (!sid || !m.plan) return;
    const st = this.planExec[m.id];
    // pending=首次确认；failed=失败后从失败节点恢复。running/done/cancelled 不再进入。
    if (!st || (st.status !== 'pending' && st.status !== 'failed')) return;
    let cur: PlanExecState = { ...st, status: 'running' };
    this.planExec = { ...this.planExec, [m.id]: cur };
    for (const task of m.plan.tasks) {
      // 已完成的任务（上次成功跑完的）直接跳过：恢复执行只重跑失败节点及其后续。
      if (cur.done[task.id]) continue;
      // 每个任务派发前刷新当前任务标记（驱动卡片 ⏳ 状态）。
      cur = { ...cur, status: 'running', currentTaskId: task.id };
      this.planExec = { ...this.planExec, [m.id]: cur };
      const parts = [`【计划任务 ${task.id}】${task.title}`];
      if (task.steps.length) {
        parts.push('步骤：', ...task.steps.map((s, i) => `${i + 1}. ${s}`));
      }
      parts.push(`预期产出：${task.expectedOutput || '—（按任务目标交付）'}`);
      const result = await this.runRt.dispatchPrompt(
        sid,
        parts.join('\n'),
        [],
        {
          planTask: true
        }
      );
      if (result !== 'ok') {
        if (result === 'error') {
          // 任务执行失败（模型报错 / 断连）：立即中止后续所有任务派发，
          // 记录失败节点并置 failed 态 —— 卡片出现「从失败任务继续」按钮，
          // 等待用户给出指令（重试 / 调整）后从该节点拉起继续执行。
          cur = {
            ...cur,
            status: 'failed',
            failedTaskId: task.id,
            currentTaskId: undefined
          };
        } else {
          // 用户手动停止：中止剩余任务并标记取消，已完成任务的产出保留在会话中。
          cur = { ...cur, status: 'cancelled', currentTaskId: undefined };
        }
        this.planExec = { ...this.planExec, [m.id]: cur };
        return;
      }
      cur = {
        ...cur,
        done: { ...cur.done, [task.id]: true },
        failedTaskId: undefined
      };
      this.planExec = { ...this.planExec, [m.id]: cur };
    }
    cur = {
      ...cur,
      status: 'done',
      currentTaskId: undefined,
      failedTaskId: undefined
    };
    this.planExec = { ...this.planExec, [m.id]: cur };
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
          <div
            class="scroll"
            ${ref(this.scrollCtl.scrollRef)}
            @scroll=${() => this.scrollCtl.onScroll()}
          >
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
                  ${this.llmReady
                    ? ''
                    : html`<div
                        style="display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:10px 14px;border:1px solid var(--ah-warning);background:var(--ah-warning-soft);color:var(--ah-warning);border-radius:var(--ah-radius-md,10px);font-size:13px;line-height:1.4;"
                      >
                        <span
                          >当前使用离线 Mock 模型，配置你的 API Key
                          后可使用真实模型。</span
                        >
                        <button
                          class="btn ghost"
                          style="margin-left:auto;color:var(--ah-warning);border-color:var(--ah-warning);"
                          @click=${() =>
                            this.dispatchEvent(
                              new CustomEvent('ah-goto', {
                                detail: 'settings',
                                bubbles: true,
                                composed: true
                              })
                            )}
                        >
                          去配置
                        </button>
                      </div>`}
                  ${this.messages.map((m) => this.renderMessage(m))}
                </div>`}
          </div>
          ${this.scrollCtl.showScrollDown
            ? html`<button
                class="scroll-down"
                title="回到底部"
                aria-label="回到底部"
                @click=${() => this.scrollCtl.scrollToBottomSmooth()}
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
                              >${fileIcon(f)}</span
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
            <!-- Slash Command：选中命令后在此固化为胶囊（hover 显示 × 移除），
                 联想面板则绝对定位浮在整个 composer 之上。常驻渲染，
                 以便在输入框有焦点时接管 ↑↓ / Enter / Esc 键盘导航。 -->
            <ah-command-suggestions
              .value=${this.input}
              .selected=${this.cmdName}
              @command-select=${(e: Event) =>
                this.onCommandSelect(
                  (e as CustomEvent<{ name: string }>).detail.name
                )}
              @command-remove=${() => this.onCommandRemove()}
            ></ah-command-suggestions>
            <div class="composer-body">
              <textarea
                class="composer-input"
                rows="1"
                placeholder=${this.cmdName
                  ? `已选命令 /${this.cmdName}，输入参数后 ⏎ 执行（× 或 Backspace 移除）`
                  : "您正在与 Agent 聊天，输入'/'获取更多能力，如'/plan'，'⇧⏎'换行"}
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
                    const v = (e as CustomEvent<{ value: string }>).detail
                      .value;
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
                    if (typeof d.baseUrl === 'string')
                      this.modelBaseUrl = d.baseUrl;
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
                ${this.serverCtxWindow <= 0
                  ? nothing
                  : renderCtxRing({
                      usage: selectContextUsage({
                        backendUsage: this.backendUsage,
                        serverCtxWindow: this.serverCtxWindow,
                        messages: this.messages
                      }),
                      showCtxUsage: this.showCtxUsage,
                      runCumulative: this.runCumulative,
                      onToggle: () => (this.showCtxUsage = !this.showCtxUsage),
                      onClose: () => (this.showCtxUsage = false)
                    })}
                ${this.streaming[this.activeId] === true
                  ? html`<button
                      class="send"
                      title="停止"
                      @click=${() => this.runRt.stop()}
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
              ${formatSize(this.previewFile.size)}
            </div>
          </div>`
        : nothing}
      ${this.renderTraceDrawer()}
    `;
  }
}
