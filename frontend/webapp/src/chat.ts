import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { ref, createRef } from 'lit/directives/ref.js';
import { client, setToken } from './api';
import { AhModal } from './components/ah-modal';
import { sharedStyles } from './styles';
import { chatStyles } from './chat-styles';
import { isRetrievalTool, safeJson, parseDeepThinking, formatToolJson } from './chat-utils';
import { buildInsights, countTraceNodes, parseCostBreakdown, renderInsights, renderTraceNode, type Insights } from './chat-trace';
import { toRichHtml, escapeHtml } from './markdown';
import {
  sanitizeMessages,
  mergeThreadHistories,
  saveThread,
  loadThread,
  purgeSessionMirror,
  loadIndex,
  withTimeout,
  type MirroredMsg
} from './chat-history';
import type {
  ChatSession,
  RunMode,
  StreamEvent,
  TraceNode,
  TraceKind
} from '@agent-harness/client';
import { ApiError } from '@agent-harness/client';
import {
  agentContext,
  useAgentContext,
  type UploadedFile
} from './agent-context';
import './components/file-upload';
import { renderJsonHtml } from './components/json-view';

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
  @state() error: string | null = null;
  /** 可选的定向业务 agent：为空则走默认通用 Agent。Web 端用它把对话路由到具体插件 agent（如医美客资）。 */
  @state() agents: { id: string; name: string }[] = [];
  @state() agentId = '';
  /** 待发送附件（本地预览用，不在 server 上传时以 DataURL 嵌入消息）。 */
  @state() attachments: UploadedFile[] = [];
  /** 当前全屏预览的附件；null 表示未打开预览。 */
  @state() private previewFile: UploadedFile | null = null;
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
  /** 服务端 /api/state 下发的当前模型上下文窗口上限（token）；0 = 未获取（回退基线）。 */
  private serverCtxWindow = 0;
  /** 是否展开「上下文用量」弹层。 */
  @state() private showCtxUsage = false;
  /** 后端经 SSE `llm:usage` 下发的精确上下文用量（provider usage 为权威总量）。
   *  为 null 时「上下文用量」浮层回退到前端基于消息缓冲的粗估。 */
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
    void saveThread(sid, { title: meta?.title ?? '新对话', updatedAt: Date.now() }, t);
  }

  /** 取某会话当前流式消息。 */
  private curSession(sid: string): ChatMsg | null {
    const idx = this.streamIdx[sid];
    const t = this.threads[sid];
    return idx >= 0 && t && t[idx] ? t[idx] : null;
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
    // 恢复上次选择的交互模式（问答/计划），跨刷新记忆。
    try {
      const saved = localStorage.getItem('ah_interaction_mode');
      if (saved === 'plan' || saved === 'qa') this.interactionMode = saved;
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
    const loadList = () => withTimeout(client.listChatSessions(), 6000, '加载会话列表');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const list = await loadList();
        this.sessions = list.map((s: ChatSession) => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt
        }));
        break;
      } catch {
        if (attempt === 1) {
          const idx = await loadIndex();
          this.sessions = Object.entries(idx).map(([sid, m]) => ({
            id: sid,
            title: m.title,
            updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : m.savedAt
          }));
        }
      }
    }
    // 服务端列表成功但缺项时（如离线期间新建的会话），用镜像索引补齐入口（不覆盖服务端条目）。
    if (this.sessions.length) {
      const known = new Set(this.sessions.map((s) => s.id));
      const idx = await loadIndex();
      const extra = Object.entries(idx)
        .filter(([sid]) => !known.has(sid))
        .map(([sid, m]) => ({
          id: sid,
          title: m.title,
          updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : m.savedAt
        }));
      if (extra.length) this.sessions = [...this.sessions, ...extra];
    }
    try {
      const state = await client.getState();
      this.mode = (state as any)?.openrouter ? 'real' : 'mock';
      // 同步模型上下文窗口：粗估回退的分母不再写死 128K（如 ox-alpha → 1M）。
      const cw = Number((state as any)?.contextWindow);
      if (Number.isFinite(cw) && cw > 0) this.serverCtxWindow = cw;
    } catch {
      /* 离线/未启动：发送时按 mock 兜底 */
    }
    // 拉取 agent 列表（失败不影响聊天，selector 退化为仅「默认 Agent」）
    try {
      const res = await client.listAgents();
      this.agents = ((res?.agents as any[]) ?? []).map((a) => ({
        id: String(a.id),
        name: String(a.name ?? a.id)
      }));
    } catch {
      /* ignore */
    }
    // 自动认证：服务端降级模式下会把统一凭证注入 <meta name="ah-api-key">，
    // 此处读取并写入 client（持久化到 localStorage），使 SPA 在需鉴权时自动带 token。
    try {
      const metaKey = document
        .querySelector('meta[name="ah-api-key"]')
        ?.getAttribute('content');
      if (metaKey) setToken(metaKey);
    } catch {
      /* ignore */
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onPreviewKeydown);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
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
    const WINDOW =
      this.serverCtxWindow > 0 ? this.serverCtxWindow : 128000; // 上下文窗口（token）：优先后端 /api/state 下发（按模型解析，如 ox-alpha→1M），未到位时落基线
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
   * 返回「上下文用量」浮层当前应展示的数据：优先用后端精确计数（llm:usage），
   * 未拿到后端数据（如 mock 模式、首屏）时回退到前端基于消息缓冲的粗估（contextUsage()）。
   * 两种来源统一成相同结构，渲染层无需关心数据出处。
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
      const totalTokens = u.totalTokens;
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
          ? html`<div class="ctx-pop">
              <div class="ctx-pop-head">
                <span>上下文用量</span>
                <span class="ctx-pop-total"
                  >${u.totalTokens.toLocaleString()} /
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
    const tb = this.renderRoot.querySelector(
      '.think.live .think-body'
    ) as HTMLElement | null;
    if (tb) tb.scrollTop = tb.scrollHeight;
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
  }

  private async selectSession(id: string) {
    if (id === this.activeId) return;
    this.activeId = id;
    this.sidebarOpen = false;
    this.error = null;
    this.input = '';
    // 关键修复：切换会话【不再】中止进行中的 run，也不清空其打字机缓冲 / 追踪状态。
    // 进行中的 run 仍向所属会话缓冲写内容，切回时实时恢复（见 this.threads / this.pending / this.traces）。
    // 优先用本地内存中的会话缓冲；否则向服务端拉取历史（仅当该会话从未在本会话实例中打开过，
    // 或上次恢复失败且缓冲为空 —— 空线程不缓存为「已加载」，下次进入自动重试）。
    const localBuf = this.threads[id];
    if (!localBuf || (this.restoreFailed[id] && localBuf.length === 0)) {
      try {
        // 恢复流程带超时（加载失败 / 数据不完整 / 超时均视为异常走降级，绝不清空本地记录）。
        const s = await withTimeout(client.getChatSession(id), 8000, '恢复会话历史');
        // 服务端数据先经消毒（类型收敛 / 过滤非法条目 / 连续重复去重 / 保序）再入内存。
        const clean = sanitizeMessages(
          s.messages.map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
            reasoning: m.reasoning,
            tools: m.tools,
            trace: m.trace,
            plan: m.plan
          }))
        );
        if (clean.length === 0) throw new Error('会话数据不完整（空历史）');
        // 本地若已有消息（如离线期间新发送的），按「最长尾首重叠」合并，防丢消息/重复。
        // 合并结果统一补发新 id（渲染以 id 为 key，不能缺省）。
        const merged =
          localBuf && localBuf.length
            ? mergeThreadHistories(clean, sanitizeMessages(localBuf))
            : clean;
        this.threads[id] = merged.map((m) => ({ ...m, id: this.nextId++ })) as ChatMsg[];
        this.restoreFailed[id] = false;
      } catch {
        // 恢复失败：绝不清空 / 覆盖本地已有记录。降级阶梯：
        //   历史镜像接口（服务端 SQLite / 进程内兜底） → 空线程 + 失败标记（下次重试）+ 非阻断警示。
        const mirrored = await loadThread(id);
        if (mirrored && mirrored.length) {
          this.threads[id] = mirrored.map((m) => ({
            ...(m as Omit<ChatMsg, 'id'>),
            id: this.nextId++
          })) as ChatMsg[];
          this.error = '⚠️ 服务端历史拉取失败，已从历史镜像恢复（可能非最新）。';
        } else {
          this.threads[id] = localBuf ?? [];
          this.restoreFailed[id] = true;
          this.error = '⚠️ 历史记录恢复失败（服务端不可达且无本地缓存），已保留当前内容；再次进入将自动重试。';
        }
      }
    }
    this.messages = this.threads[id];
    // 切换会话：回到该会话最新消息底部，并恢复「钉底」跟随。
    this.stickToBottom = true;
    this.showScrollDown = false;
    this.backendUsage = null;
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
    if (this.activeId) return this.activeId;
    const s = await client.createChatSession('新对话');
    this.activeId = s.id;
    this.sessions = [
      { id: s.id, title: s.title, updatedAt: s.updatedAt },
      ...this.sessions
    ];
    return s.id;
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

    // 为每个图片构建结构化附件信息。
    // 关键修复：直接把本地 dataUrl（完整 data: URI）作为图片内容发给模型，
    // 而非依赖服务端返回的 serverUrl（相对路径 /api/uploads/*，模型提供方无法 fetch）。
    // 这样即使服务端上传失败、或部署在 localhost，模型也能直接解码看到图片。
    const imageAttachments = this.attachments
      .filter((f) => f.type.startsWith('image/'))
      .map((f) => ({
        url: f.dataUrl || f.serverUrl || '',
        name: f.name,
        type: f.type
      }))
      .filter((f) => f.url);

    this.input = '';
    this.attachments = [];
    await this.dispatchPrompt(sessionId, content, imageAttachments);
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
    opts: { planTask?: boolean } = {}
  ): Promise<'ok' | 'stopped' | 'error'> {
    // 当前会话消息缓冲：追加 user + assistant(空)，并记录流式下标。
    const t = this.threadFor(sessionId);
    t.push({
      id: this.nextId++,
      role: 'user',
      content,
      attachments: [...this.attachments]
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
    this.backendUsage = null;
    // 容错持久化：用户消息一入缓冲立即镜像落盘（独立于 run 结果 —— 即便后续流式中断/出错也已保存）。
    this.saveHistory(sessionId);

    const input: Record<string, unknown> = {
      mode: this.mode,
      prompt: content,
      model: this.model || undefined,
      agentId: this.agentId || undefined,
      sessionId,
      chatSessionId: sessionId,
      attachments:
        imageAttachments.length > 0 ? imageAttachments : undefined,
      // 联网搜索开关（Request 4）：仅在用户显式开启 web 时透传 true，关闭时缺省不触发任何出网检索。
      web: this.web || undefined,
      // 交互模式（P0 计划模式）：仅用户手动选择 plan 且非任务执行派发时进入 propose 阶段。
      // 计划任务的逐步执行（confirmPlan）必须按普通问答派发 —— 若仍带 planPhase:'propose'，
      // 服务端会把每个任务 run 都当作一次新的计划提案，模型把旧计划原样再提一遍，
      // 生成第二张「待确认」卡片，点执行又从第一步重来（交互死循环根因）。
      interactionMode:
        this.interactionMode === 'plan' && !opts.planTask ? 'plan' : undefined,
      planPhase:
        this.interactionMode === 'plan' && !opts.planTask ? 'propose' : undefined
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
            (this.curSession(sessionId)?.content ?? '') || `⚠️ ${e?.message ?? e}`
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
          if (this.connState[sid] !== 'connected') this.setConn(sid, 'connected');
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
          throw Object.assign(rawErr instanceof Error ? rawErr : new Error(String(rawErr)), {
            name: 'UserStoppedRun'
          });
        }
        // 断连前已收到最终答复：内容完整，无需恢复。
        if (this.finishedBy[sid]) return;
        attempts += 1;
        const jobGone =
          rawErr instanceof ApiError &&
          rawErr.status >= 400 &&
          rawErr.status < 500;
        if (
          jobGone ||
          !this.jobBy[sid] ||
          attempts > MAX_ATTEMPTS
        ) {
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
      if (this.connState[sid] !== 'connected')
        this.setConn(sid, 'connected');
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
        patch({ plan });
        this.planExec = {
          ...this.planExec,
          [c.id]: dupSrc
            ? { ...(this.planExec[dupSrc.id] ?? { status: 'pending', done: {} }) }
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
          this.backendUsage = {
            window: u.window,
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
            totalTokens: u.totalTokens,
            breakdown: u.breakdown
          };
          const totalPct = Math.min(
            100,
            (Number(u.totalTokens) / Number(u.window)) * 100
          );
          agentContext.set('lastContextUsage', {
            totalPct,
            totalTokens: Number(u.totalTokens),
            window: Number(u.window),
            model: u.model,
            updatedAt: Date.now()
          });
        }
        break;
      }
      case 'run:end': {
        const finalStr = String((ev as any).final ?? '');
        this.finalBy[sid] = finalStr;
        // 若已通过 llm:token 走打字机揭示：不在这里用 final 覆盖 content（否则整段秒显，打字机失效）。
        // 让打字机按节奏自然揭示到 final 文本；仅在完全没有 token 增量时（非流式回退）才直接赋值。
        // 计划模式：消息已挂计划卡片（content=友好摘要）时，跳过任何迟到的 raw final 覆盖。
        if (!this.received[sid] && finalStr) {
          const c = cur();
          if (c && !c.plan) patch({ content: finalStr });
        }
        break;
      }
      case 'error': {
        const c = cur();
        if (c)
          patch({
            error: true,
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
        tc.llm = mk(parent, 'llm', 'LLM 调用', 'ok', {
          meta: {
            messages: `消息 ${ev.messageCount ?? '?'}`,
            tools: `工具 ${ev.toolCount ?? '?'}`
          }
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
        }
        break;
      }
      case 'llm:token': {
        if (tc.llm && typeof ev.delta === 'string') {
          const n =
            (tc.llm.meta?.tokenChars ? Number(tc.llm.meta.tokenChars) : 0) +
            ev.delta.length;
          tc.llm.meta = { ...(tc.llm.meta ?? {}), tokenChars: String(n) };
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
        // Token 拆解四项（系统/工具/历史/输出）：与 access/server 的 traceHandle 保持
        // 完全一致的键名与格式 —— 此前前端分支丢弃了 ev.estTokens，导致「Token 拆解」
        // 仅在服务端落盘后的恢复视图中出现、实时流视图中消失（时有时无的根因）。
        const est = (ev as any).estTokens as
          | { system: number; tools: number; history: number; completion: number }
          | undefined;
        const estTotal = est ? est.system + est.tools + est.history + est.completion : 0;
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
                  工具: `${est.tools}${estTotal ? ` (${((est.tools / estTotal) * 100).toFixed(0)}%)` : ''}`,
                  历史: `${est.history}${estTotal ? ` (${((est.history / estTotal) * 100).toFixed(0)}%)` : ''}`,
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
        const token =
          typeof localStorage !== 'undefined'
            ? localStorage.getItem('ah_token')
            : null;
        const resp = await fetch('/api/upload', {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
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

  /** Esc 关闭预览（window 级监听，无需聚焦 lightbox）。 */
  private onPreviewKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.previewFile) this.closePreview();
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

  /** 切换交互模式（问答/计划）并持久化。 */
  private setInteractionMode(m: 'qa' | 'plan') {
    this.interactionMode = m;
    try {
      localStorage.setItem('ah_interaction_mode', m);
    } catch {
      /* ignore */
    }
  }

  /** 切换移动端侧栏抽屉（≤900px 生效）。 */
  private toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
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
      <span>⚠️ 与服务器的连接已断开${this.jobBy[this.activeId] ? '' : '，本次运行已丢失'}</span>
      ${this.jobBy[this.activeId]
        ? html`<button class="conn-retry" @click=${() => this.resumeLost(this.activeId)}>
            重新连接
          </button>`
        : nothing}
    </div>`;
  }

  private renderMessage(m: ChatMsg) {    // 用户消息：渲染气泡文本 + 附件预览。
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
              ${hasAttachments ? this.renderAttachments(m.attachments!) : nothing}
              <div class="msg-text">${unsafeHTML(toRichHtml(m.content))}</div>
            </div>
            ${m.content?.trim()
              ? html`<div class="msg-actions ${this.hoverUserMsgId === m.id ? 'show' : ''}">
                <button
                  type="button"
                  class="msg-action"
                  title=${this.copiedMsgId === m.id ? '已复制' : '复制'}
                  @click=${() => this.copyMsgText(m.id, m.content)}
                >
                  ${this.copiedMsgId === m.id
                    ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>`
                    : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                      </svg>`}
                </button>
                <button
                  type="button"
                  class="msg-action"
                  title="编辑"
                  ?disabled=${this.streaming[this.activeId] === true}
                  @click=${() => this.startEdit(m.id, m.content)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
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
    const showCopy =
      !!m.content?.trim() && !isStreamingAssistant;

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
                ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>`
                : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
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
        <span class="pill ${st.status}">${statusLabel}</span>
        ${st.status === 'pending'
          ? html`
              <button class="plan-btn" @click=${() => this.confirmPlan(m)}>
                确认执行
              </button>
              <button class="plan-btn ghost" @click=${() => this.cancelPlan(m.id)}>
                取消
              </button>
            `
          : nothing}
        ${st.status === 'failed'
          ? html`
              <button class="plan-btn" @click=${() => this.confirmPlan(m)}>
                从失败任务继续
              </button>
            `
          : nothing}
      </div>
      <ol class="plan-tasks">
        ${plan.tasks.map((t, i) => {
          const done = !!st.done[t.id];
          const active = st.status === 'running' && st.currentTaskId === t.id;
          const failed = st.status === 'failed' && st.failedTaskId === t.id;
          return html`<li class="plan-task ${done ? 'done' : ''} ${active ? 'active' : ''} ${failed ? 'failed' : ''}">
            <div class="pt-head">
              <span class="pt-mark">${done ? '✓' : active ? '⏳' : failed ? '✗' : i + 1}</span>
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
        [m.id]: { ...this.planExec[m.id], status: 'running', currentTaskId: task.id }
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
      [m.id]: { ...this.planExec[m.id], status: 'done', currentTaskId: undefined, failedTaskId: undefined }
    };
  }

  /** 取消计划：不再执行任何任务。 */
  private cancelPlan(msgId: number) {
    const st = this.planExec[msgId];
    if (!st || st.status !== 'pending') return;
    this.planExec = { ...this.planExec, [msgId]: { ...st, status: 'cancelled' } };
  }

  /** 渲染折叠式附加信息（调用链路 / 关键信息），默认收起，不干扰主阅读流。 */
  private renderExtras(m: ChatMsg, isStreaming: boolean): TemplateResult {    const hasTrace = !!(m.trace && m.trace.length > 0);
    const insights = hasTrace ? buildInsights(m.trace!) : null;
    if (!hasTrace && !insights) return html``;
    return html`
      <div class="extras">
        ${hasTrace
          ? html`<details class="extra">
              <summary>
                <svg
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
                </svg>
                <span>调用链路</span>
                <span class="tcount"
                  >${countTraceNodes(m.trace!)} 节点</span
                >
                ${isStreaming
                  ? html`<span class="dots"><i></i><i></i><i></i></span>`
                  : nothing}
              </summary>
              <div class="trace-body">
                ${m.trace!.map((n) => renderTraceNode(n))}
              </div>
            </details>`
          : nothing}
        ${insights
          ? html`<details class="extra">
              <summary><span>关键信息</span></summary>
              <div class="insights">${renderInsights(insights)}</div>
            </details>`
          : nothing}
      </div>
    `;
  }


  render() {
    const active = this.sessions.find((s) => s.id === this.activeId);
    return html`
      <div class="sidebar ${this.sidebarOpen ? 'open' : ''}">
        <div class="side-head">
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
            title="菜单 / 会话列表"
          >
            ☰
          </button>
          <span class="title"
            >${active ? escapeHtml(active.title) : '新对话'}</span
          >
          <span class="spacer"></span>
          <input
            class="model-input"
            placeholder="模型（留空用服务端默认）"
            .value=${this.model}
            @input=${(e: Event) =>
              (this.model = (e.target as HTMLInputElement).value)}
          />
          <select
            class="agent-select"
            title="选择业务 Agent（默认走通用 Agent）"
            style="margin-left:8px;height:32px;max-width:180px;border-radius:8px;border:1px solid var(--ah-border);background:var(--ah-surface-2);color:var(--ah-text);padding:0 6px"
            .value=${this.agentId}
            @change=${(e: Event) =>
              (this.agentId = (e.target as HTMLSelectElement).value)}
          >
            ${this.agents.map(
              (a) => html`<option value=${a.id}>${escapeHtml(a.name)}</option>`
            )}
          </select>
          <button
            class="toggle ${this.deepThink ? 'on' : ''}"
            title="深度思考"
            aria-label="深度思考"
            @click=${() => (this.deepThink = !this.deepThink)}
          >
            <svg
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
          </button>
          <button
            class="toggle ${this.web ? 'on' : ''}"
            title="联网搜索"
            aria-label="联网搜索"
            @click=${() => (this.web = !this.web)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path
                d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"
              />
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
              <select
                class="mode-select"
                title="运行模式：回答=直接回答；计划=先产出结构化执行计划，确认后逐步执行"
                aria-label="运行模式"
                .value=${this.interactionMode}
                @change=${(e: Event) =>
                  this.setInteractionMode(
                    (e.target as HTMLSelectElement).value as 'qa' | 'plan'
                  )}
              >
                <option value="qa">回答</option>
                <option value="plan">计划</option>
              </select>
              </div>
              <div class="composer-footer-right">
                ${this.renderCtxRing()}
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
          <!-- <div class="hint">
            模式：${this.mode} ·
            token 级流式已开启（打字机效果）· 深度思考/联网为 UI 占位
          </div> -->
        </div>
      </div>

      <div
        class="scrim ${this.sidebarOpen ? 'show' : ''}"
        @click=${() => (this.sidebarOpen = false)}
      ></div>
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
    `;
  }
}
