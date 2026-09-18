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
import './components/ah-swipe-item';
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
  buildPlanStatusLookup,
  derivePlanExecFromMessages,
  applyPlanWfEvent,
  applyPlanThinking,
  derivePlanWfId,
  compactPlanWfSnapshot,
  isPlanDagEnabled,
  buildPlanArtifactSection,
  type PlanWfEvent,
  type PlanWfRunSnapshot
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
  renderPlanWfReplayDrawer,
  normalizeClarifyQuestions,
  type ChatRenderCtx
} from './chat-message-render';

// 滚动跟随簇（已抽离到 chat-scroll.ts，作为轻量控制器由 AhChat 持有为 this.scrollCtl）。
import { ChatScroll } from './chat-scroll';

// 富文本块折叠的判定逻辑（已抽离到 chat-block-fold.ts，组件侧只负责 DOM 读写）。
import {
  effectiveBlockFolded,
  foldButtonLabel,
  foldKey,
  toggledBlockFolded
} from './chat-block-fold';

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
  PlanWfReplayState,
  PlanWfRunMirror,
  ChatMsg,
  SessionView,
  TraceCtx,
  ClarifyDraftState
} from './chat-types';

// 会话列表分页模型（左侧历史列表「滚动加载」的纯逻辑：步长 / 跨页合并 / 视图映射）。
import {
  SESSION_PAGE_SIZE,
  initialSessionPageCursor,
  mergeSessionPage,
  mirrorMetaToSessionView,
  shouldPrefetchSessions,
  toSessionView,
  type SessionPageCursor
} from './chat-session-page';
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
  RunMode,
  StreamEvent,
  TraceNode,
  TraceKind,
  PlanExecMirror,
  ChatMessage,
  WorkflowRun
} from '@agent-harness/client';
import { agentContext, type UploadedFile } from './agent-context';
import { notifyError } from './utils/errors';
import { notify } from './components/ah-notification';
import { compressImage, compressDataUrl } from './utils/compress-image';
import {
  buildAttachmentDigest,
  compressAttachmentText,
  dataUrlToText,
  isTextLike,
  resolveAttachmentBudget
} from './utils/compress-text';

// Slash Command 框架
import {
  handleSlashCommand,
  registerBuiltinCommands,
  type CommandContext
} from './chat-commands';
import './components/file-upload';
import './components/model-picker';
// 副作用导入：注册 <ah-composer-plus>（输入框「+」统一入口：文件 / 模式 / 专家）。
// 注：原 ah-mode-picker / ah-agent-picker 的能力已并入该面板，故不再单独引入
// （组件文件保留在 components/ 下，未被引用即不会注册、不进包）。
import './components/composer-plus';

// 副作用导入：注册 <ah-command-suggestions> 自定义元素。
// 不能写成 `import { AhCommandSuggestions }` —— 该类在 chat.ts 里只作为类型
// 注解（private suggestEl?: AhCommandSuggestions）使用，Vite/esbuild 会把它当作
// 纯类型导入而整条丢弃，导致 customElements.define 永不执行、元素不升级、联想面板
// 永远弹不出来（同时 onKey 转发 handleKey 时会报 “is not a function”）。
import './components/ah-command-suggestions';
import type { AhCommandSuggestions } from './components/ah-command-suggestions';

/**
 * 附件约束（导出以便单测与 UI 文案复用，避免两处写死不一致）。
 * 拖拽遮罩的提示文案与该强制校验共用同一常量。
 */
export const MAX_ATTACHMENTS = 15;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 单个 10MB

/**
 * 附件预览条折叠时最多直接展示的条目数。
 *
 * 预览条位于输入框上方、高度固定为一行；条目一多就会把最后一项硬裁在
 * 容器右缘（既看不出被裁了，也不知道总共几个）。超过本阈值后余量收进
 * 「+N」按钮，点开再以多行网格展开。
 */
export const ATTACH_COLLAPSE_LIMIT = 6;

/**
 * 批量上传的并发度。
 * 串行会导致首张慢请求堵死整批；无上限并发则一次拖 15 张会瞬间打出 15 个请求。
 * 取 4 是两者的折中：显著快于串行，又不至于压垮服务端 / 占满浏览器连接池。
 */
export const UPLOAD_CONCURRENCY = 4;

/** 已通过校验、待上传的条目：本地预览元信息 + 原始 File + 实际上传 File + 追踪 key。 */
export interface PendingUpload {
  meta: UploadedFile;
  raw: File;
  /** 实际上传的文件；图片可能经过压缩。 */
  uploadFile: File;
  key: string;
}

/** 允许上传的扩展名（MIME 为空时的兜底判定）。 */
const ALLOWED_EXTS = ['.txt', '.md', '.csv', '.json'];

/** 文件是否属于允许上传的类型（图片 / 文本 / JSON）。 */
export function isAllowedAttachment(f: File): boolean {
  if (f.type) {
    if (f.type.startsWith('image/') || f.type.startsWith('text/')) return true;
    if (f.type.includes('json')) return true;
  }
  // MIME 缺失时按扩展名兜底（部分来源拖入的文件 type 为空字符串）。
  const dot = f.name.lastIndexOf('.');
  return dot >= 0 && ALLOWED_EXTS.includes(f.name.slice(dot).toLowerCase());
}

/** 读取文件为 DataURL，用于本地预览。 */
export function readAsDataUrl(f: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(f);
  });
}

/**
 * 以固定并发度执行一组任务。
 *
 * 契约：任务自身必须已捕获异常 —— 本函数不兜 reject，
 * 某任务若抛错会经 Promise.all 冒泡（调用方应保证任务不抛）。
 * 任务全部执行完才 resolve；并发度会被裁剪到任务数，不会空转。
 */
export async function runWithConcurrency(
  tasks: ReadonlyArray<() => Promise<void>>,
  limit = UPLOAD_CONCURRENCY
): Promise<void> {
  if (!tasks.length || limit <= 0) return;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      while (cursor < tasks.length) {
        const i = cursor++;
        const task = tasks[i];
        if (!task) break;
        await task();
      }
    }
  );
  await Promise.all(workers);
}

/**
 * 按折叠状态解算附件预览条的展示切片。
 *
 * 纯函数，供渲染与单测共用 —— 保证「按钮上显示的数字」与「实际渲染的
 * 条目数」永远一致，不会出现文案说有 N 个、列表却渲染了别的数量。
 *
 * @param list     完整附件列表
 * @param expanded 是否已展开
 * @param limit    折叠时的最大展示条数
 * @returns `visible` 本次要渲染的条目；`collapsedCount` 被折叠的条目数
 *          （为 0 表示无需渲染「+N」按钮）
 */
export function resolveAttachmentView<T>(
  list: readonly T[],
  expanded: boolean,
  limit: number = ATTACH_COLLAPSE_LIMIT
): { visible: T[]; collapsedCount: number } {
  const collapsedCount = Math.max(0, list.length - limit);
  const visible = expanded ? list.slice() : list.slice(0, limit);
  return { visible, collapsedCount };
}

/* ------------------------------ Chat ------------------------------ */

@customElement('ah-chat')
export class AhChat extends LitElement {
  static styles = [sharedStyles, chatStyles];

  @state() sessions: SessionView[] = [];
  @state() activeId = '';

  /**
   * 会话列表「还有下一页」——驱动列表底部的加载更多 / 没有更多了提示。
   * 首屏一次只取 SESSION_PAGE_SIZE 条，滚动到底部再增量拉取（见 loadSessionPage）。
   */
  @state() private sessionsHasMore = false;

  /** 正在拉取会话列表（首屏或下一页）；为 true 时列表底部显示加载中并防重入。 */
  @state() private sessionsLoadingMore = false;

  /** 拉取下一页失败（显示可点重试）；首屏失败走既有降级链路，不置此标志。 */
  @state() private sessionsMoreError = false;

  // ────────── 会话列表下拉刷新（移动端触屏手势）──────────
  /** 下拉刷新进行中（防重入 + 抑制手势）；非响应式，不触发渲染。 */
  private pullRefreshing = false;
  /** 手势起始触摸 Y（仅 scrollTop<=0 时记录）。 */
  private pullStartY = 0;
  /** 当前已下拉位移（px，含阻尼）；非响应式，手势中直接操作 DOM，不触发渲染。 */
  private pullDist = 0;
  /** 是否处于「可下拉」手势中（手指压在顶部且向下拖）。 */
  private pullPulling = false;
  /** 下拉阻尼系数：可视位移 = 实际拖动 × 系数，越拉越「重」。 */
  private readonly pullDamping = 0.5;
  /** 下拉可视位移上限（px），超过不再继续拉长。 */
  private readonly pullMax = 88;
  /** 触发刷新的下拉阈值（px）。 */
  private readonly pullThreshold = 60;

  /**
   * 历史会话内容加载中（骨架屏开关）。
   * 点击左侧会话后、服务端历史返回前为 true，内容区渲染骨架屏占位，
   * 避免出现「长时间空白」或「残留上一会话内容」的中间态。
   * 仅内存中已有该会话缓冲（本地即时可用）时不置位，切换零等待。
   */
  @state() private sessionLoading = false;

  @state() messages: ChatMsg[] = [];
  @state() input = '';
  @state() model = '';
  @state() mode: RunMode = 'mock';

  /** 交互模式（P0）：qa=问答（直接回答）；plan=计划（先出计划→确认→逐任务执行）。
   *  localStorage 持久化跨刷新记忆。模式语义仅存在于前端，服务端只按字段透传。 */
  @state() interactionMode: 'qa' | 'plan' = 'qa';

  /** 计划执行状态（key 为携带计划的消息 id）。 */
  @state() private planExec: Record<number, PlanExecState> = {};
  /** 计划模式（P0）：目标澄清卡中用户的补充/确认输入（key=消息 id）。 */
  /** 计划模式（P0）：澄清卡用户输入状态（key=消息 id：逐题点选/自定义 + 整体补充）。 */
  @state() private clarifyDraft: Record<number, ClarifyDraftState> = {};
  /** 计划模式（P0）：已确认过的澄清卡（key=消息 id），防止重复提交。 */
  @state() private clarifyAnswered: Record<number, boolean> = {};
  /** P3（多 agent DAG 计划执行）：当前正在跑的 plan workflow 中止句柄。
   * 非空时「停止」按钮中止 DAG 流（置 running 为 cancelled），否则走 runRt.stop()。 */
  @state() private planWfAbort: AbortController | null = null;
  @state() deepThink = true;
  @state() web = true;
  /** 深度思考收起偏好（由父级经设置-外观下发并持久化）：开启时深度思考默认折叠。默认 true（收起）。 */
  @property({ type: Boolean }) deepThinkCollapsed = true;

  /** 每条助手消息的深度思考折叠态（key 为 message id），用于手动收起思考区。 */
  @state() thinkCollapsed: Record<string, boolean> = {};

  /**
   * 富文本块（超长代码块 / 表格）的折叠态覆盖表，key 为 `${scope}/${blockKey}`。
   *
   * 为什么必须放在组件状态，而不是点击时直接改 DOM 上的 class：
   * `.msg-text` 经 unsafeHTML 注入，lit 无法 diff 其内部 —— 任何一次组件更新
   * （hover、其他消息追加、流式 token 到达）都会重建整段 DOM，写在 DOM 上的状态
   * 必然被抹掉，「点开又自己合上」。
   * 同理也不能把用户的选择写进渲染产物字符串：产物是按文本内容缓存的纯函数结果，
   * 把交互态混进去会让缓存命中率归零，且流式中每帧都会弹回默认值。
   * 缺省（key 不存在）= 可折叠块默认折叠，见 applyFolds。
   */
  @state() mdFolded: Record<string, boolean> = {};

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

  /**
   * 附件预览条是否处于展开态。
   * 折叠时最多渲染 ATTACH_COLLAPSE_LIMIT 条，余量收进「+N」按钮。
   */
  @state() private attachmentsExpanded = false;

  /**
   * 是否有文件正被拖到整个 chat 区域上方（驱动整屏拖拽遮罩）。
   * 仅认 `Files` 类型的拖拽（dataTransfer.types 含 'Files'），
   * 因此拖选文字/链接经过时不会误触发遮罩。
   */
  @state() private dragActive = false;

  /**
   * 拖拽进入/离开的嵌套计数（非响应式，无需触发渲染）。
   * 光标在 chat 内部子元素之间移动时 dragenter/dragleave 会成对触发，
   * 只有计数归零才判定为「真正离开组件」。
   */
  private dragDepth = 0;

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

  /** P2（轨迹回放）：计划「执行详情」抽屉——当前打开的计划消息（null=未开）+ 各消息的快照瞬态。 */
  @state() private planWfReplayMsg: ChatMsg | null = null;
  @state() private planWfReplay: Record<number, PlanWfReplayState> = {};

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

  /** 进入编辑态时原始消息内容，用于判断用户是否做过实质改动。 */
  private editingOriginalContent = '';

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

  /**
   * P5 静默计划执行（串行回退路径）：quiet run 进行中的思考面板 sink（携带计划的消息 id）。
   * confirmPlan 逐任务派发前置位、循环结束（含失败/取消）复位；onPlanThinking 据此路由。
   */
  private quietPlanSink: { msgId: number } | null = null;

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

  /**
   * 会话切换请求序号（非响应式，无需触发渲染）。
   * 每次 selectSession 自增并快照，异步拉取结束后比对：只有「最新一次切换」才允许
   * 回写 this.messages / 滚动位置 / 用量快照，并负责关闭骨架屏标志。
   * 由此避免连点多个会话时，先发起但后返回的慢响应覆盖当前会话内容（竞态）。
   */
  private sessionLoadSeq = 0;

  /**
   * 外部入口（工作台「最近会话」）请求打开的会话 id 缓存。
   * 事件到达时若本面板仍处隐藏态，先暂存于此，待 refresh()（面板转可见后由
   * app.ts activatePanel 触发）执行到末尾时消费，保证点击不丢。
   */
  private pendingSelectId = '';

  /**
   * 会话列表分页游标（非响应式）。
   * offset / hasMore / serverIds 三者必须同步推进，故打包成一个状态对象整体替换，
   * 避免出现「offset 已加、serverIds 未加」这类半更新态。驱动渲染的是
   * this.sessions / this.sessionsHasMore，本字段仅作内部记账。
   */
  private sessionPage: SessionPageCursor = initialSessionPageCursor();

  /**
   * 首屏重载请求序号（非响应式）。
   * SSE 的 `session:list` 后台重载可能与首屏加载并发，只有最新一次允许写回列表与游标，
   * 否则先发起但后返回的响应会覆盖更新的列表。
   */
  private sessionsReloadSeq = 0;

  /**
   * 「填充视口」补拉的重入保护（非响应式）。
   * 首屏一页不足以撑出滚动条时（超长视口 / 会话较少），scroll 事件永远不会触发，
   * 需要主动续拉；该标志防止 updateComplete → 补拉 → updateComplete 形成无限循环。
   */
  private sessionAutoFillBusy = false;

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
      historyMaxBytes: this.historyMaxBytes,
      // 计划进度写穿：本端是「计划整体完成」的唯一知情方（见 PersistHistoryOpts.planExec）。
      planExec: this.planExec
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

    // 首屏数据加载（会话列表 / 状态 / agent 列表）抽到 refresh()，便于
    // 隐藏态挂载时跳过请求、并在切到对话 Tab 时由 app.ts 的 activatePanel 补拉。
    // 注意：本组件的监听注册、看门狗、SSE 等副作用仍在上方无条件初始化，不受影响。
    void this.refresh();

    // 插件启用/停用会改变已注册 agent 集合，监听后实时刷新下拉（使已禁用插件的 agent 即时隐藏）。
    window.addEventListener(
      'ah-plugins-changed',
      this.onPluginsChanged as EventListener
    );

    // 工作台/全局入口请求打开指定会话：直接选中并加载消息。
    this.addEventListener(
      'ah-select-session',
      this.onSelectSession as EventListener
    );

    // 路由变化（Tab 切换 / 浏览器后退前进）时收起对话页内的浮层（上下文用量面板等）。
    // 本组件随应用壳常驻，切 Tab 只是被父级 hidden 而非销毁，若不主动收起，
    // 移动端侧滑返回后再次进入对话页会看到上次遗留的展开面板。
    // 统一约定见 ah-app.closeAllOverlays（各 ah-* 覆盖层同样订阅该事件）。
    window.addEventListener('ah:close-overlays', this.onCloseOverlays);

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

  /**
   * 首屏数据加载：会话列表首屏、服务端状态（LLM 就绪 / 模式）、agent 列表。
   * 顶部 `if (this.hidden) return;` 守卫：本面板随应用壳一起挂载，但隐藏态
   * （非对话 Tab）时不发起请求；切到对话 Tab 时由 app.ts 调用本方法补拉。
   */
  async refresh() {
    if (this.hidden) return;
    await this.reloadSessions(true);
    try {
      const state = await client.getState();
      // per-user 真实 LLM 就绪：优先 llm.ready（BYOK），回退旧字段 openrouter。
      this.llmReady =
        !!(state as any)?.llm?.ready || !!(state as any)?.openrouter;
      this.mode = this.llmReady ? 'real' : 'mock';
      this.historyMaxBytes =
        typeof (state as any)?.historyMaxBytes === 'number'
          ? (state as any).historyMaxBytes
          : this.historyMaxBytes;
      // /api/state 的 contextWindow 只是服务端兜底基线（无官方数据时 128K），
      // 不作为「默认模型」的真实窗口 —— 默认模型同样隐藏用量展示。
    } catch {
      /* 离线/未启动：发送时按 mock 兜底 */
    }
    await this.refreshAgents();
    // 面板转可见后（由 app.ts activatePanel 触发本方法），消费此前因隐藏态
    // 没能立即执行的「打开指定会话」请求，保证外部入口点击不丢。
    this.consumePendingSelect();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onPreviewKeydown);
    window.removeEventListener('ah:close-overlays', this.onCloseOverlays);
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
    this.removeEventListener(
      'ah-select-session',
      this.onSelectSession as EventListener
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
        // 新建/批量变更：重拉列表首屏（带超时容错 + 分页游标复位）。
        // 后台重载不弹错提示：失败时下一次列表交互会自动重试。
        void this.reloadSessions(false);
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

  /**
   * 外部入口（工作台「最近会话」等）请求打开指定会话。
   * app.ts 在切到对话 Tab 并完成一次渲染后派发 `ah-select-session`，
   * 此处直接复用 selectSession（选中 + 拉取历史消息 + 滚动到底）。
   * 若组件尚处隐藏态（异步时序兜底），先缓存 id，待可见时再消费。
   */
  private onSelectSession = (ev: Event) => {
    const id = (ev as CustomEvent<string>).detail;
    if (typeof id !== 'string' || !id) return;
    if (this.hidden) {
      this.pendingSelectId = id;
      return;
    }
    void this.selectSession(id);
  };

  /** 消费隐藏态缓存的会话选择请求（面板转可见后调用）。 */
  private consumePendingSelect(): void {
    const id = this.pendingSelectId;
    if (!id || this.hidden) return;
    this.pendingSelectId = '';
    void this.selectSession(id);
  }

  /**
   * 重载会话列表首屏（offset 归零）。
   *
   * 与改造前（一次性全量）的两点差异：
   * - 只取第一页（SESSION_PAGE_SIZE 条），其余由滚动加载按需补齐；
   * - 列表被组织为**两段式**：前段恒为服务端条目、尾部恒为镜像兜底补项。
   *   这个布局是 mergeSessionPage 计算插入位置的前提，改动前请先读 chat-session-page.ts。
   *
   * @param notifyOnError 首屏失败是否弹提示。首次进入（connectedCallback）要提示；
   *   SSE 触发的后台重载沉默失败即可（下一次列表交互会自动重试）。
   */
  private async reloadSessions(notifyOnError: boolean): Promise<void> {
    // 本次重载的请求序号：SSE 触发的后台重载可能与首屏加载并发，只有最新一次
    // 允许把结果写回 this.sessions —— 否则过期响应会覆盖更新的列表与游标。
    const seq = ++this.sessionsReloadSeq;
    // 首屏重载使既有分页游标失效：先复位，失败时也不会残留「还有下一页」的假象。
    this.sessionPage = initialSessionPageCursor();
    this.sessionsHasMore = false;
    this.sessionsMoreError = false;

    // 首屏同样带重试（超时 6s，最多 2 次），与改造前一致。
    let page: { sessions: SessionView[]; hasMore: boolean } | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2 && !page; attempt++) {
      try {
        const r = await withTimeout(
          client.listChatSessionsPage({
            limit: SESSION_PAGE_SIZE,
            offset: 0
          }),
          6000,
          '加载会话列表'
        );
        page = {
          sessions: r.sessions.map(toSessionView),
          hasMore: r.hasMore
        };
      } catch (e) {
        lastErr = e;
      }
    }

    // 过期响应：期间已发起更新的一次重载，本次结果（含错误提示）直接丢弃。
    if (seq !== this.sessionsReloadSeq) return;

    if (!page && notifyOnError) {
      // 重试仍失败 → 明确告知「列表可能不完整」，而不是静默吞掉、
      // 让用户以为是自己没有历史会话（随后走下方镜像索引降级）。
      notifyError(lastErr, {
        title: '会话列表',
        fallback: '会话列表加载失败，已降级为本地缓存（可能不完整）',
        key: 'chat-sessions'
      });
    }

    if (page) {
      this.sessions = page.sessions;
      this.sessionPage = {
        offset: page.sessions.length,
        hasMore: page.hasMore,
        serverIds: new Set(page.sessions.map((s) => s.id))
      };
      this.sessionsHasMore = page.hasMore;
      await this.appendMirrorExtras();
      await this.updateComplete;
      void this.autoFillSessionList();
      return;
    }

    // 服务端不可达：整表退回本地镜像索引（无分页语义，hasMore 恒 false）。
    const idx = await loadIndex();
    // loadIndex 同样是异步的：期间若又发生了一次重载，本次降级结果作废。
    if (seq !== this.sessionsReloadSeq) return;
    this.sessions = Object.entries(idx).map(([sid, m]) =>
      mirrorMetaToSessionView(sid, m)
    );
    this.sessionPage = initialSessionPageCursor();
    this.sessionsHasMore = false;
  }

  /**
   * 用历史镜像索引补齐列表尾部（服务端列表为空 / 缺项时历史会话仍可见）。
   * 典型场景：服务端重启后 chat-sessions 内存态清空（无 CHAT_SESSIONS_FILE），
   * 但 history 镜像仍落 SQLite；此处兜底从 /api/history 索引补全。
   * 补项恒排在服务端条目之后 —— 该顺序被 mergeSessionPage 依赖。
   */
  private async appendMirrorExtras(): Promise<void> {
    const known = new Set(this.sessions.map((s) => s.id));
    const idx = await loadIndex();
    const extra = Object.entries(idx)
      .filter(([sid]) => !known.has(sid))
      .map(([sid, m]) => mirrorMetaToSessionView(sid, m));
    if (extra.length) this.sessions = [...this.sessions, ...extra];
  }

  /**
   * 加载下一页会话（滚动加载的增量入口）。
   * 四重短路：没有下一页 / 正在加载 / 上次失败待重试 / 已卸载 —— 直接返回，
   * 使 scroll 事件即使高频触发也不会重复发请求。
   */
  private async loadMoreSessions(): Promise<void> {
    if (!this.sessionsHasMore) return;
    if (this.sessionsLoadingMore) return;
    // 失败后暂停自动预取，避免「本来就停在底部 → 又触发 → 再失败」的请求风暴；
    // 用户点「点击重试」会清掉该标志。
    if (this.sessionsMoreError) return;
    this.sessionsLoadingMore = true;
    // 快照当前游标对象：期间若发生首屏重载（SSE 新建会话），sessionPage 会被整体替换，
    // 届时本次结果必须作废 —— 否则会用过期游标覆盖新状态，导致后续分页跳条。
    const cursor = this.sessionPage;
    try {
      const offset = cursor.offset;
      const r = await withTimeout(
        client.listChatSessionsPage({ limit: SESSION_PAGE_SIZE, offset }),
        6000,
        '加载更多会话'
      );
      if (this.sessionPage === cursor) {
        const page = r.sessions.map(toSessionView);
        const merged = mergeSessionPage(this.sessions, page, cursor.serverIds);
        this.sessions = merged.list;
        // 游标按「服务端已消费条数」推进，而非实际插入条数：被去重跳过的条目同样占用了
        // 服务端的分页区间，按插入数推进会重复取到同一页。
        this.sessionPage = {
          offset: offset + page.length,
          // 服务端称还有下一页、却返回空页时按「没有更多」处理，防御性避免空转。
          hasMore: r.hasMore && page.length > 0,
          serverIds: new Set([...cursor.serverIds, ...merged.insertedIds])
        };
        this.sessionsHasMore = this.sessionPage.hasMore;
        this.sessionsMoreError = false;
      }
      // else：游标已被整体替换（首屏重载介入）→ 本次结果作废，不写回任何状态。
    } catch {
      // 失败不清空已有内容，仅置错误态交给用户手动重试。
      this.sessionsMoreError = true;
    } finally {
      this.sessionsLoadingMore = false;
    }
    // 收尾统一补一次「填充视口」检查：覆盖两类情况 ——
    // 1) 本次真正加载了一页，可能仍不足以撑出滚动条；
    // 2) 本次被判定过期，而首屏重载发起 autoFill 时本请求尚未结束、那次调用被短路了。
    void this.autoFillSessionList();
  }

  /** 会话列表滚动：进入底部预取阈值即拉下一页。 */
  private onSessionListScroll(e: Event) {
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (!shouldPrefetchSessions(distance)) return;
    void this.loadMoreSessions();
  }

  // ────────── 下拉刷新手势（仅触屏、仅在列表顶部向下拖）──────────
  /** 手势起始触摸 X（轴向守卫用：横滑会话行时让出给 ah-swipe-item，见 touchmove）。 */
  private pullStartX = 0;
  private onSessionListTouchStart = (e: TouchEvent) => {
    const el = e.currentTarget as HTMLElement | null;
    // 折叠态（64px 图标轨）没有可下拉的会话列表，跳过手势。
    if (!el || this.pullRefreshing || this.sidebarCollapsed) return;
    // 仅当列表已滚到顶时才允许下拉，避免与正常上滑滚动冲突。
    if (el.scrollTop > 0) {
      this.pullPulling = false;
      return;
    }
    this.pullPulling = true;
    const t0 = e.touches[0];
    if (!t0) return;
    this.pullStartX = t0.clientX;
    this.pullStartY = t0.clientY;
    this.pullDist = 0;
  };

  private onSessionListTouchMove = (e: TouchEvent) => {
    if (!this.pullPulling || this.pullRefreshing) return;
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return;
    const t0 = e.touches[0];
    if (!t0) return;
    // 轴向守卫：横向位移明显占优时是「会话行滑动操作」（ah-swipe-item 的
    // touchmove 已 preventDefault，本处理器仅被动跟随），撤销下拉态防止
    // 松手误触发刷新、内容层残留位移。
    if (Math.abs(t0.clientX - this.pullStartX) > 12) {
      if (this.pullDist !== 0) this.applyPullTransform(0);
      this.pullPulling = false;
      return;
    }
    const delta = t0.clientY - this.pullStartY;
    // 手指上移（正常向下滚动内容）或已离开顶部：取消下拉，交回原生滚动。
    if (delta <= 0 || el.scrollTop > 0) {
      if (this.pullDist !== 0) this.applyPullTransform(0);
      this.pullPulling = el.scrollTop <= 0 && delta > 0;
      return;
    }
    // 顶部向下拖：阻止原生回弹，呈现自定义阻尼下拉。
    e.preventDefault();
    const dist = Math.min(delta * this.pullDamping, this.pullMax);
    this.applyPullTransform(dist);
  };

  private onSessionListTouchEnd = () => {
    if (!this.pullPulling || this.pullRefreshing) {
      this.pullPulling = false;
      return;
    }
    this.pullPulling = false;
    if (this.pullDist >= this.pullThreshold) {
      void this.triggerPullRefresh();
    } else {
      this.applyPullTransform(0, true);
    }
  };

  /**
   * 把下拉位移同步到 DOM（内容下移 + 顶部指示器滑入）。
   * 直接操作 inline style，不触发 Lit 重渲染，保证拖动手感顺滑。
   * @param animate 松手/收起时补一段回弹过渡。
   */
  private applyPullTransform(dist: number, animate = false) {
    this.pullDist = dist;
    const inner = this.sessionInnerEl;
    const ind = this.pullIndicatorEl;
    const hint = this.pullHintEl;
    const t = animate ? 'transform 0.25s ease' : 'none';
    if (inner) {
      inner.style.transition = t;
      inner.style.transform = dist > 0 ? `translateY(${dist}px)` : '';
    }
    if (ind) {
      ind.style.transition = t;
      ind.style.opacity = dist > 0 || this.pullRefreshing ? '1' : '0';
      ind.style.transform = `translateY(${
        Math.min(dist, this.pullMax) - 48
      }px)`;
      ind.classList.toggle(
        'armed',
        dist >= this.pullThreshold && !this.pullRefreshing
      );
    }
    if (hint)
      hint.textContent = dist >= this.pullThreshold ? '松开刷新' : '下拉刷新';
  }

  /** 触发下拉刷新：重拉首屏会话列表（显式用户操作，失败弹提示）。 */
  private async triggerPullRefresh() {
    this.pullRefreshing = true;
    const inner = this.sessionInnerEl;
    const ind = this.pullIndicatorEl;
    const hint = this.pullHintEl;
    if (inner) {
      inner.style.transition = 'transform 0.2s ease';
    }
    if (ind) {
      ind.style.transition = 'transform 0.2s ease';
      ind.classList.add('refreshing');
      ind.classList.remove('armed');
      ind.style.opacity = '1';
      ind.style.transform = 'translateY(0)';
    }
    if (hint) hint.textContent = '刷新中…';
    try {
      await this.reloadSessions(true);
    } finally {
      this.pullRefreshing = false;
      this.pullDist = 0;
      if (ind) ind.classList.remove('refreshing');
      if (inner) inner.style.transform = '';
      if (ind) {
        ind.style.opacity = '0';
        ind.style.transform = 'translateY(-48px)';
      }
      if (hint) hint.textContent = '下拉刷新';
      if (inner) inner.style.transition = 'transform 0.3s ease';
    }
  }

  /**
   * 「填充视口」补拉：首屏一页不足以撑出滚动条时（超长视口 / 会话较少 / 侧栏很矮），
   * scroll 事件永远不会被触发 —— 这里主动续拉，直到出现滚动条、没有更多或出错。
   * 上限 5 轮纯属死循环防御；sessionAutoFillBusy 串行化，
   * 防止 loadMoreSessions → autoFill → loadMoreSessions 递归失控。
   */
  private async autoFillSessionList(): Promise<void> {
    if (this.sessionAutoFillBusy) return;
    this.sessionAutoFillBusy = true;
    try {
      for (let i = 0; i < 5; i++) {
        if (!this.sessionsHasMore || this.sessionsMoreError) return;
        // 有请求在飞：不空转，交给它的收尾再触发一轮（loadMoreSessions 末尾必定回调本方法）。
        if (this.sessionsLoadingMore) return;
        const el = this.sessionListEl;
        if (!el) return;
        // 已可滚动 → 交回 scroll 事件驱动，不再主动填充。
        if (el.scrollHeight - el.clientHeight > 4) return;
        await this.loadMoreSessions();
        await this.updateComplete;
      }
    } finally {
      this.sessionAutoFillBusy = false;
    }
  }

  /** 会话列表滚动容器（用于「是否已撑出滚动条」判定与滚动监听）。 */
  private get sessionListEl(): HTMLElement | null {
    return this.renderRoot?.querySelector<HTMLElement>('.session-list') ?? null;
  }

  /** 会话列表内容包裹层（下拉时整体下移，呈现橡皮筋效果）。 */
  private get sessionInnerEl(): HTMLElement | null {
    return (
      this.renderRoot?.querySelector<HTMLElement>('.session-inner') ?? null
    );
  }

  /** 顶部下拉刷新指示器。 */
  private get pullIndicatorEl(): HTMLElement | null {
    return this.renderRoot?.querySelector<HTMLElement>('.pull-refresh') ?? null;
  }

  /** 下拉刷新指示器文案。 */
  private get pullHintEl(): HTMLElement | null {
    return this.renderRoot?.querySelector<HTMLElement>('.pull-hint') ?? null;
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
    // 维护分页不变量：被删的若是一条**已消费的服务端条目**，服务端列表在其之后整体
    // 前移一位 → offset 同步减 1，否则下一页会跳过一条会话。
    // 未加载过的条目（不在 serverIds 内）不影响已消费区间，无需调整。
    if (this.sessionPage.serverIds.has(sid)) {
      const serverIds = new Set(this.sessionPage.serverIds);
      serverIds.delete(sid);
      this.sessionPage = {
        offset: Math.max(0, this.sessionPage.offset - 1),
        hasMore: this.sessionPage.hasMore,
        serverIds
      };
    }
    if (this.activeId === sid) {
      this.activeId = '';
      // 作废仍在飞行中的该会话切换请求：否则其返回后会把已删除会话的历史写回
      // this.messages，视图里会重新出现一条已被删除的会话。
      this.sessionLoadSeq++;
      this.sessionLoading = false;
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
    const traceVal =
      Array.isArray(m.trace) && m.trace.length
        ? (m.trace as TraceNode[])
        : undefined;
    // 已结束/从存储恢复的消息（streaming !== true）做兜底收尾：残留 pending 工具/检索节点
    // 标记为完成。进行中的实时帧（streaming===true）绝不收尾，避免误标在途工具为完成。
    const traceFinal =
      traceVal && m.streaming !== true
        ? this.normalizeStoredTrace(traceVal)
        : traceVal;
    const t = this.threadFor(sid);

    if (role === 'user') {
      // 去重：沿线程末尾回扫（跳过流式中的 assistant 占位 / 工具卡片），
      // 若最近一条 user 消息内容完全相同则跳过。编辑重发场景下他端可能
      // 先落了 assistant、本端又收到同内容 user 回声，仅查 t[last] 会漏判。
      for (let i = t.length - 1; i >= 0; i--) {
        const c = t[i];
        if (!c || c.role !== 'user') continue;
        if ((c.content ?? '') === content && content.length > 0) return; // 重复，跳过
        break; // 只看最近一条 user，避免把「隔轮重发同文本」误判为重复
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
        ...(traceFinal ? { trace: traceFinal } : {})
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
        ...(traceFinal ? { trace: traceFinal } : {})
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
          ...(traceFinal ? { trace: traceFinal } : {})
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
    // 必须在滚动之前：折叠会改变内容高度，同步重排后 scrollToBottom 才取到正确值。
    this.applyFolds();
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

  /**
   * 路由变化（Tab 切换 / 浏览器后退前进）时收起对话页内所有浮层。
   *
   * 本页有三处自持打开态的浮层，都属「切 Tab 只是被父级 hidden、组件不销毁」
   * 的情形，必须在路由变化时主动归零，否则移动端侧滑返回后再次进入对话页
   * 会看到上次遗留的展开面板 / 全屏层：
   *   - previewFile       图片附件全屏预览（.lightbox）
   *   - fullscreenEditOpen 长按输入框打开的全屏编辑器
   *   - showCtxUsage      上下文用量弹层
   * 注意此处直接改状态位，不走 closeFullscreenEdit() —— 后者会把焦点还给
   * 气泡内的编辑框，而路由变化时该气泡已被切走，聚焦会出错。
   * 调用链路抽屉由 ah-drawer 自行关闭，撰写区的模式 / 智能体 / 模型 / 附件面板
   * 由各自组件自行关闭（统一约定见 ah-app.closeAllOverlays）。
   */
  private onCloseOverlays = () => {
    if (this.previewFile) this.previewFile = null;
    if (this.fullscreenEditOpen) this.fullscreenEditOpen = false;
    if (this.showCtxUsage) this.showCtxUsage = false;
  };

  /* ----------------------- 会话管理 ----------------------- */

  private async newChat() {
    // 不中止任何进行中的 run：后台 run 继续写入其所属会话缓冲，新建对话只是切换显示到空线程。
    this.activeId = '';
    // 作废仍在飞行中的会话切换请求（自增序号使其过期），否则其返回后会把旧会话
    // 的历史写回 this.messages —— 空白新对话里会突然冒出上一个会话的内容。
    this.sessionLoadSeq++;
    this.sessionLoading = false;
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
    // 本次切换的请求序号：进入即自增，异步返回时据此判定自己是否已过期（见方法尾部）。
    const seq = ++this.sessionLoadSeq;
    // 先无条件复位骨架屏：内存中已有该会话缓冲时下方不会再置位，切换零等待直接出内容；
    // 需要拉取历史时再由下方重新打开。这样快速连点会话时不会残留上一次请求的加载态。
    this.sessionLoading = false;
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
    this.closeAllSessionSwipes();
    this.input = '';
    this.cmdName = '';

    // 关键修复：切换会话【不再】中止进行中的 run，也不清空其打字机缓冲 / 追踪状态。
    // 进行中的 run 仍向所属会话缓冲写内容，切回时实时恢复（见 this.threads / this.pending / this.traces）。
    // 优先用本地内存中的会话缓冲；否则向服务端拉取历史（仅当该会话从未在本会话实例中打开过，
    // 或上次恢复失败且缓冲为空 —— 空线程不缓存为「已加载」，下次进入自动重试）。
    const localBuf = this.threads[id];
    // 需要向服务端拉取历史的判定：本实例从未打开过该会话，或上次恢复失败且缓冲为空。
    // 命中即先亮起骨架屏并覆盖整个 await 全程（含 8s 超时兜底），避免内容区长时间无反馈。
    const needFetch =
      !localBuf || (this.restoreFailed[id] && localBuf.length === 0);

    // 会话级用量快照（随历史镜像恢复）；getChatSession 不含 usage，仅 history 镜像携带。
    let recoveredUsage: MirroredUsage | null = null;
    if (needFetch) {
      this.sessionLoading = true;
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
            // propose 当时的联网开关：随计划卡片透传，执行（含刷新后续跑）继承。
            planWeb: (m as any).planWeb === true ? true : undefined,
            planStatus: (m as any).planStatus,
            // 计划模式（P0）：目标澄清结果透传，刷新 / 切回后还原目标确认卡。
            clarify: (m as any).clarify,
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
          // 降级路径同样还原计划进度（镜像字段 + 线程反推），否则已执行完成的计划
          // 会退回「待确认」并重新显示「确认执行 / 取消」。
          this.applyPlanStatusLookup(id, buildPlanStatusLookup(mirrored.msgs));
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
    // 拉取流程结束（成功、降级、失败三条路径均在此汇合）：关闭骨架屏。
    // 只有最新一次切换有权操作该标志 —— 过期请求不得关闭当前会话的骨架屏。
    if (seq === this.sessionLoadSeq) this.sessionLoading = false;

    // 恢复历史后补全调用链路中 assistant 消息的内容（修复旧 trace 中 assistant 为空）。
    this.restoreTraceMessages(id);

    // 过期请求（用户已切到别的会话）：本次结果仅作为缓存留在 this.threads 中，
    // 不得回写内容与视图状态，否则会覆盖新会话的消息、滚动位置与用量快照。
    if (seq !== this.sessionLoadSeq) return;

    this.messages = this.threads[id] ?? [];

    // 切换会话：回到该会话最新消息底部，并恢复「钉底」跟随。
    this.scrollCtl.resetToBottom();

    // 用量快照从会话镜像回填（若有），避免刷新/切换后上下文用量归零或回退粗估；
    // 无快照则保持 null，由后续 llm:usage 事件或回退估算补充。
    this.backendUsage = recoveredUsage?.backendUsage ?? null;
    this.runCumulative = recoveredUsage?.runCumulative ?? null;
  }

  /**
   * 把持久化的计划进度应用到恢复后的线程（按 goal 对齐新消息 id）。
   * 仅当内存中没有该消息的状态时写入，不覆盖本实例正在进行的执行状态。
   *
   * 两级来源：
   * 1. 服务端 `planStatus` 镜像（权威）—— running 态说明上次执行被中断（刷新/断连），
   *    收敛为 failed，卡片出现「从失败任务继续」，等用户指令后再续跑，绝不静默重放；
   * 2. 镜像缺失时（旧数据未带该字段 / 镜像被整包覆盖 / 服务端重启后回落）从线程反推
   *    （见 derivePlanExecFromMessages）—— 否则已执行完成的计划会退回默认的「待确认」，
   *    向用户重新暴露「确认执行 / 取消」（实测反馈的显示缺陷）。
   */
  private applyPlanStatusLookup(
    sid: string,
    lookup: Map<string, PlanExecMirror>
  ) {
    const thread = this.threads[sid];
    if (!thread?.length) return;
    for (const m of thread) {
      if (!m.plan || this.planExec[m.id]) continue;
      const ps = lookup.get(m.plan.goal);
      if (!ps) {
        const derived = derivePlanExecFromMessages(m.plan, thread);
        if (derived) this.planExec = { ...this.planExec, [m.id]: derived };
        continue;
      }
      const doneMap: Record<string, boolean> = {};
      for (const tid of ps.done ?? []) doneMap[tid] = true;
      // P3：awaiting = 合法暂停（审批门）—— 原样还原「待审批」态与待审批任务列表，
      // 刷新 / 重启后卡片仍可点「批准并继续」放行（检查点 approvals 跨重启保留）。
      const awaitingState = ps.status === 'awaiting';
      // running = 上次执行中断：保留已完成集合，但置 failed 等待用户显式继续。
      const interrupted = !awaitingState && ps.status === 'running';
      this.planExec = {
        ...this.planExec,
        [m.id]: {
          status: awaitingState
            ? 'awaiting'
            : interrupted
            ? 'failed'
            : ps.status,
          currentTaskId: interrupted ? ps.currentTaskId : undefined,
          failedTaskId: interrupted ? ps.currentTaskId : ps.failedTaskId,
          done: doneMap,
          ...(awaitingState && Array.isArray(ps.awaiting)
            ? { awaitingTaskIds: ps.awaiting }
            : {}),
          // P2.6：紧凑 run 快照（检查点丢失后「执行详情」抽屉的镜像回退数据源）。
          // 形状校验：需为含 steps 对象的结构，宁缺勿错。
          ...(ps.wfSnapshot &&
          typeof ps.wfSnapshot === 'object' &&
          (ps.wfSnapshot as { steps?: unknown }).steps &&
          typeof (ps.wfSnapshot as { steps?: unknown }).steps === 'object'
            ? { wfSnapshot: ps.wfSnapshot as PlanWfRunMirror }
            : {})
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
    this.sessions = [toSessionView(s), ...this.sessions];
    // 维护分页不变量：新会话落在服务端列表头部，相当于「已消费区间」整体后移一位。
    // 一并把 offset 加 1，下一页便不会重复取到本页末条（serverIds 记录它是服务端条目，
    // 加载更多时新页才会插在它之后、镜像补项之前）。
    const serverIds = new Set(this.sessionPage.serverIds);
    serverIds.add(s.id);
    this.sessionPage = {
      offset: this.sessionPage.offset + 1,
      hasMore: this.sessionPage.hasMore,
      serverIds
    };
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

  /**
   * 把附件列表转换成 dispatchPrompt 需要的两类内容：
   * - imageAttachments：压缩后的 dataUrl / serverUrl，直接发给模型视觉输入。
   * - modelPrompt：在原始 prompt 后追加文本附件摘要，仅用于模型请求，不影响 UI 气泡内容。
   */
  private async buildAttachmentDispatchOpts(
    content: string,
    rawAttachments: UploadedFile[]
  ): Promise<{
    imageAttachments: Array<{ url: string; name: string; type: string }>;
    modelPrompt: string;
  }> {
    // 关键修复：直接把本地 dataUrl（完整 data: URI）作为图片内容发给模型，
    // 而非依赖服务端返回的 serverUrl（相对路径 /api/uploads/*，模型提供方无法 fetch）。
    // 这样即使服务端上传失败、或部署在 localhost，模型也能直接解码看到图片。
    // 同时压缩 dataUrl，避免多张高清图撑爆 /api/run 的请求体上限。
    const imageAttachments = (
      await Promise.all(
        rawAttachments
          .filter((f) => f.type.startsWith('image/'))
          .map(async (f) => {
            const originalUrl = f.dataUrl || f.serverUrl || '';
            if (!originalUrl) return null;
            const url = originalUrl.startsWith('data:')
              ? await compressDataUrl(originalUrl)
              : originalUrl;
            return { url, name: f.name, type: f.type };
          })
      )
    ).filter(Boolean) as Array<{ url: string; name: string; type: string }>;

    // 文本附件：与图片同一套「UI 原文件 / 模型压缩副本」解耦。
    // UI 气泡仍展示上传的原始文件；发给模型的是一段「头尾保留、中间省略」的摘要。
    // 缺少这一步时，一个几 MB 的 .log / .csv 会以完整原文进入上下文，并随历史逐轮重发。
    const textFiles = rawAttachments.filter(
      (f) => !f.type.startsWith('image/') && isTextLike(f.name, f.type)
    );
    const perItemBudget = resolveAttachmentBudget(textFiles.length);
    const textDigest = textFiles
      .map((f) => {
        const raw = dataUrlToText(f.dataUrl || '');
        if (raw == null || !raw.trim()) return null;
        return compressAttachmentText(f.name, f.type, raw, {
          maxChars: perItemBudget,
          serverUrl: f.serverUrl
        });
      })
      .filter(Boolean) as Parameters<typeof buildAttachmentDigest>[0];
    const attachmentDigest = buildAttachmentDigest(textDigest);
    // 仅追加到「发往模型的 prompt」；UI 消息内容仍为纯用户输入（content 不变）。
    const modelPrompt = attachmentDigest
      ? `${content}\n\n${attachmentDigest}`
      : content;

    return { imageAttachments, modelPrompt };
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
    const content = prompt;

    // 在清空 this.attachments 之前保留完整附件副本（含 dataUrl），
    // 用于回显到 user 气泡；否则消息写入时附件已被清空，气泡里图片不显示。
    const rawAttachments = [...this.attachments];
    const { imageAttachments, modelPrompt } =
      await this.buildAttachmentDispatchOpts(content, rawAttachments);

    this.clearComposer();
    await this.runRt.dispatchPrompt(sessionId, content, imageAttachments, {
      attachments: rawAttachments,
      modelPrompt
    });
  }

  /** 清空输入区：文本 + 命令胶囊 + 附件，并把输入框高度复位。 */
  private clearComposer(): void {
    this.input = '';
    this.cmdName = '';
    this.attachments = [];
    this.attachmentsExpanded = false;
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
      streamRun: (payload, opts) => client.streamRun(payload as any, opts),

      /* ----- P5 静默计划执行：quiet run 的思考增量 → 当前计划卡思考面板 ----- */
      onPlanThinking: (sid, delta) => {
        const sink = this.quietPlanSink;
        if (!sink) return;
        const prev = this.planExec[sink.msgId];
        if (!prev || prev.status !== 'running') return;
        const next = applyPlanThinking(prev, delta);
        if (next !== prev) {
          this.planExec = { ...this.planExec, [sink.msgId]: next };
        }
      }
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
        // 兜底：把上一轮仍 pending 的工具/检索节点统一标记为成功。
        // 背景：tool:result 事件可能因 SSE 断连/重连/网络抖动而丢失（尤其 RAG 等长耗时工具
        // 期间极易发生），此时目标节点会永远停在「进行中」；但 harness 只要发起新一轮
        // llm:call，说明上一轮的工具链已实际完成（否则不会推进到下一步），所以在此处
        // 兜底把残留 pending 节点收尾，避免「调用都结束了 UI 还显示进行中」。
        this.finalizePendingTools(tc);
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
              `${m}: ~${(Number(st.hitRate) * 100).toFixed(0)}% (~${st.hits}/${
                st.queries
              })`
          )
          .join(' · ');
        mk(parent, 'tokencache', 'Token 缓存命中率', 'ok', {
          meta: {
            命中率: `~${tcHitPct}%`,
            命中: `~${ev.hits}/${ev.queries}`,
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
        // 软性未通过（soft）只告警不阻断：链路里不算失败，避免与真正被拦的产出混淆。
        const soft = !ev.passed && ev.soft === true;
        mk(tc.root!, 'verify', soft ? '验收告警' : '自检', ev.passed || soft ? 'ok' : 'error', {
          meta: {
            score: String(ev.score ?? '?'),
            passed: ev.passed ? '通过' : soft ? '未通过（不阻断）' : '未通过'
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
      case 'run:end': {
        // 运行收尾兜底：极少数情况下（如 SSE 断连后重连、或运行异常终止）最后一个
        // tool:result 事件丢失，导致工具/检索节点永远停在「进行中」。运行结束时强制
        // 把所有残留 pending 节点收尾，保证「调用都结束了 UI 不再显示进行中」。
        this.finalizePendingTools(tc);
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

  /**
   * 兜底收尾：把 trace 树里所有仍处 pending 的工具/检索节点标记为成功（ok）。
   * 仅在「新一轮 llm:call 已开始」或「run:end」时调用 —— 这两个时机都意味着上一轮
   * 工具链已实际执行完毕（harness 不会在工具未完成时推进），因此可以安全地把因
   * SSE 断连/重连/网络抖动而丢失 tool:result 的残留 pending 节点收尾，避免 UI 永久
   * 卡在「进行中」。
   */
  private finalizePendingTools(tc: TraceCtx) {
    if (!tc.root) return;
    const sweep = (n: TraceNode): void => {
      if (
        (n.kind === 'tool' || n.kind === 'retrieval') &&
        n.status === 'pending'
      ) {
        n.status = 'ok';
        n.meta = { ...(n.meta ?? {}), status: '成功（兜底）' };
      }
      n.children.forEach(sweep);
    };
    sweep(tc.root);
  }

  /**
   * 还原已结束/从存储恢复的消息时，把残留 pending 工具/检索节点收尾（与 traceHandle
   * 的兜底逻辑一致）。仅对「非流式（streaming !== true）」的消息调用 —— 进行中的实时帧
   * 绝不能收尾，否则会把真正在途的工具误标为完成。
   */
  private normalizeStoredTrace(
    trace: TraceNode[] | undefined
  ): TraceNode[] | undefined {
    if (!trace || !trace.length) return trace;
    const sweep = (n: TraceNode): void => {
      if (
        (n.kind === 'tool' || n.kind === 'retrieval') &&
        n.status === 'pending'
      ) {
        n.status = 'ok';
        n.meta = { ...(n.meta ?? {}), status: '成功（兜底·恢复）' };
      }
      n.children.forEach(sweep);
    };
    trace.forEach(sweep);
    return trace;
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
    this.editingOriginalContent = content;
    this.hoverUserMsgId = -1;
  }

  /** 退出编辑态，丢弃草稿。 */
  private cancelEdit() {
    this.editingMsgId = -1;
    this.editingDraft = '';
    this.editingOriginalContent = '';
  }

  /**
   * 编辑后重新发送：
   * 1. 草稿与原文一致时直接返回（UI 已通过 disabled 拦截，此处作兜底）。
   * 2. 截断被编辑消息之后的所有消息，替换被编辑消息内容为新草稿。
   * 3. 在末尾添加 assistant 占位并继续派发，服务端收到 editFrom 后会同步
   *    截断会话存储并清空后续记忆，确保模型基于新的上下文生成。
   *
   * 重入防御：ensureSession 是异步的，await 期间若用户连点「发送 ↑」或
   * Enter 与点击叠加，第二次调用会因 editingMsgId === -1 直接 return，仅首次生效。
   */
  private async sendEdit(msgId: number) {
    if (this.editingMsgId < 0) return; // 非编辑态 / 本次已提交（提交锁）
    const draft = this.editingDraft.trim();
    if (!draft || this.streaming[this.activeId] === true) return;
    // 没有任何变动：不发送，保持编辑态让用户继续编辑。
    if (draft === this.editingOriginalContent.trim()) return;

    // 立即清编辑态标志作为提交锁。
    this.cancelEdit();
    this.fullscreenEditOpen = false;
    this.cancelComposerLongPress();

    const sessionId = await this.ensureSession();
    const t = this.threadFor(sessionId);
    const idx = t.findIndex((m) => m.id === msgId && m.role === 'user');
    if (idx < 0) {
      // 找不到原消息：降级为普通追加发送。
      this.input = draft;
      await this.send();
      return;
    }

    const editedMsg = t[idx];
    if (!editedMsg) {
      this.input = draft;
      await this.send();
      return;
    }

    // 截断被编辑消息之后的所有消息，并用新草稿替换被编辑消息内容。
    const next = t.slice(0, idx + 1);
    next[idx] = { ...editedMsg, content: draft };

    // 清理被截断消息衍生的前端状态，避免残留 plan / 回放 / 折叠态。
    for (let i = idx + 1; i < t.length; i++) {
      const removedId = t[i]?.id;
      if (removedId == null) continue;
      if (this.planExec[removedId]) {
        const { [removedId]: _, ...rest } = this.planExec;
        this.planExec = rest;
      }
      if (this.planWfReplay[removedId]) {
        const { [removedId]: _, ...rest } = this.planWfReplay;
        this.planWfReplay = rest;
      }
      if (this.thinkCollapsed[removedId]) {
        const { [removedId]: _, ...rest } = this.thinkCollapsed;
        this.thinkCollapsed = rest;
      }
    }

    // 如果当前打开的抽屉/回放属于被截断的消息，关闭它们。
    if (this.traceDrawerMsg && this.traceDrawerMsg.id > msgId) {
      this.traceDrawerMsg = null;
    }
    if (this.planWfReplayMsg && this.planWfReplayMsg.id > msgId) {
      this.planWfReplayMsg = null;
    }

    // 在截断后的线程末尾追加 assistant 占位，准备接收新回复。
    next.push({ id: this.nextId++, role: 'assistant', content: '' });
    this.threads[sessionId] = next;
    if (this.activeId === sessionId) {
      this.messages = next;
    }
    this.streamIdx[sessionId] = next.length - 1;
    this.setStreaming(sessionId, false);

    // 保留被编辑消息的附件；若原消息无附件则透空数组。
    const rawAttachments = editedMsg.attachments
      ? [...editedMsg.attachments]
      : [];
    const { imageAttachments, modelPrompt } =
      await this.buildAttachmentDispatchOpts(draft, rawAttachments);

    await this.runRt.dispatchPrompt(sessionId, draft, imageAttachments, {
      attachments: rawAttachments,
      modelPrompt,
      editFrom: { sessionId, msgId, index: idx }
    });
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

  /* ------------------- 整屏拖拽上传（覆盖整个 chat 区域） ------------------- */

  /**
   * 该 drag 事件是否携带文件。
   * dataTransfer.types 在 dragover 阶段才可读（drop 阶段也可），
   * 用它把「拖文件」与「拖选文字 / 拖链接」区分开，避免误亮遮罩。
   */
  private isFileDrag(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    return types ? Array.from(types).includes('Files') : false;
  }

  /** 剩余可添加的附件数（0 表示已达上限）。 */
  private get attachRoom(): number {
    return Math.max(0, MAX_ATTACHMENTS - this.attachments.length);
  }

  /**
   * 拖拽进入 chat 区域：亮起整屏遮罩。
   * 用 `dragenter`/`dragleave` 计数成对抵消——拖拽过程中光标会在子元素间移动，
   * 每次都派发 dragenter+dragleave，只用布尔量会在子元素边界处闪烁。
   */
  private onDragEnter(e: DragEvent): void {
    if (!this.isFileDrag(e)) return;
    e.preventDefault();
    this.dragDepth += 1;
    if (!this.dragActive) this.dragActive = true;
  }

  /** 拖拽在内部元素间移动：持续 preventDefault，否则浏览器会拒收 drop。 */
  private onDragOver(e: DragEvent): void {
    if (!this.isFileDrag(e)) return;
    e.preventDefault();
    if (!this.dragActive) this.dragActive = true;
  }

  private onDragLeave(e: DragEvent): void {
    if (!this.isFileDrag(e)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    // 计数归零才认为是真正离开，避免跨越子元素时遮罩闪烁。
    if (this.dragDepth === 0) this.dragActive = false;
  }

  /** 在 chat 区域内松开：接管文件并关闭遮罩。 */
  private onDrop(e: DragEvent): void {
    if (!this.isFileDrag(e)) return;
    e.preventDefault();
    this.dragDepth = 0;
    this.dragActive = false;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) void this.handleFiles(files);
  }

  /**
   * 处理文件选择。读取本地预览并上传到服务端。
   *
   * 入参是 File[] 而非 Event —— 两条入口（「+」面板点击选择 / 拖拽到 chat 区域）
   * 最终都归一成 File[] 汇到这里。
   *
   * 三个阶段刻意分开：
   *   1. 逐个校验 + 读本地预览（失败只跳过该文件，绝不中断整批）；
   *   2. **整批一次性并入** attachments —— UI 立刻显示全部 N 个；
   *   3. 受限并发上传 —— 单张失败只影响自己。
   *
   * 改成分阶段前这里是「读一个 → 追加一个 → 串行 await 上传一个」的循环，
   * 两个后果：① 大图逐个慢慢冒出来，视觉上像只加进去了第一个；
   * ② 串行 await 下首张慢请求（或 FileReader 那次未被捕获的 reject）
   * 会把后面的文件全部堵死/整批抛出，实际只剩第一个落地。
   */
  private async handleFiles(picked: File[]): Promise<void> {
    if (!picked.length) return;

    // 数量上限：拖拽遮罩的提示文案（MAX_ATTACHMENTS）在这里才真正生效。
    // 提示必须同时给出「实际收了多少」和「被挡了多少」——
    // 只说「已忽略 N 个」用户无法判断到底加进去了几个。
    const room = MAX_ATTACHMENTS - this.attachments.length;
    if (room <= 0) {
      notify.warning(
        `已达上传上限（${MAX_ATTACHMENTS} 个），请先移除部分文件再添加`,
        { key: 'chat-upload' }
      );
      return;
    }
    let list = picked;
    if (list.length > room) {
      const skipped = list.length - room;
      notify.warning(
        `最多支持上传 ${MAX_ATTACHMENTS} 个文件：本次已添加 ${room} 个，另有 ${skipped} 个未添加`,
        { key: 'chat-upload' }
      );
      list = list.slice(0, room);
    }

    // ---- 阶段一：校验 + 读预览 + 图片压缩。单个文件失败只跳过它自己 ----
    const pending: PendingUpload[] = [];
    for (const f of list) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        notify.warning(
          `文件过大：${f.name}（上限 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB）`,
          { key: 'chat-upload' }
        );
        continue;
      }
      if (!isAllowedAttachment(f)) {
        notify.warning(`不支持的文件类型：${f.name}`, { key: 'chat-upload' });
        continue;
      }

      let dataUrl = '';
      try {
        dataUrl = await readAsDataUrl(f);
      } catch {
        notify.warning(`读取失败：${f.name}`, { key: 'chat-upload' });
        continue;
      }

      // 图片在上传前自动压缩，降低 multipart 请求体大小；预览仍用原图 dataUrl。
      let uploadFile = f;
      if (f.type.startsWith('image/')) {
        try {
          uploadFile = await compressImage(f);
        } catch {
          // 压缩失败不影响上传，回退原文件。
          uploadFile = f;
        }
      }

      pending.push({
        meta: {
          name: f.name,
          size: f.size,
          type: f.type,
          dataUrl,
          uploadStatus: 'uploading'
        },
        raw: f,
        uploadFile,
        // 追加序号：同名文件在同一毫秒内也能拿到互不相同的 key。
        key: `${f.name}_${Date.now()}_${pending.length}`
      });
    }
    if (!pending.length) return;

    // ---- 阶段二：整批一次性入列，UI 立即显示全部 ----
    this.attachments = [...this.attachments, ...pending.map((p) => p.meta)];
    for (const p of pending) {
      this.uploadingFiles.set(p.key, { status: 'uploading' });
    }

    // ---- 阶段三：受限并发上传 ----
    await runWithConcurrency(
      pending.map((p) => () => this.uploadOne(p)),
      UPLOAD_CONCURRENCY
    );
  }

  /**
   * 上传单个附件并就地更新其状态。
   * 失败只标记该文件为 error，绝不影响同批其它文件。
   */
  private async uploadOne(p: PendingUpload): Promise<void> {
    try {
      const formData = new FormData();
      formData.append('file', p.uploadFile, p.uploadFile.name);
      const resp = await authedFetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      const json = await resp.json();
      if (!json?.ok || !json.meta?.url) {
        throw new Error(json?.error || '上传失败');
      }
      // 不可变更新：Lit @state() 仅在重新赋值时触发重渲染，
      // 原地修改数组元素的字段不会刷新 UI（⏳ 会一直卡住）。
      this.patchAttachment(p.meta, {
        serverUrl: json.meta.url,
        uploadStatus: 'done'
      });
      this.uploadingFiles.set(p.key, { status: 'done' });
    } catch (err) {
      let msg = err instanceof Error ? err.message : '上传失败';
      // 后端 raw body 超过阈值时返回该文案；转换为更友好的提示。
      if (/request body too large/i.test(msg)) {
        msg = `图片体积过大，上传被服务端拒绝：${p.raw.name}`;
      }
      this.patchAttachment(p.meta, {
        uploadStatus: 'error',
        uploadError: msg
      });
      this.uploadingFiles.set(p.key, { status: 'error', error: msg });
      notifyError(new Error(msg), {
        title: '附件上传',
        fallback: `上传失败：${p.raw.name}`,
        key: 'chat-upload'
      });
    }
  }

  /**
   * 按对象**引用**就地更新某个附件字段。
   * 用引用而非下标 —— 上传期间用户可能移除其它附件，下标会错位打到别的文件上。
   */
  private patchAttachment(target: UploadedFile, patch: Partial<UploadedFile>) {
    this.attachments = this.attachments.map((a) =>
      a === target ? { ...a, ...patch } : a
    );
  }

  /** 移除已选附件。 */
  private removeAttachment(i: number) {
    const newAttachments = this.attachments.filter((_, idx) => idx !== i);
    this.attachments = newAttachments;
    // 移除后若已不再溢出，收起展开态 —— 否则会残留一个无意义的「收起」按钮。
    if (newAttachments.length <= ATTACH_COLLAPSE_LIMIT) {
      this.attachmentsExpanded = false;
    }
  }

  /** 展开 / 收起附件预览条的多余条目。 */
  private toggleAttachments(): void {
    this.attachmentsExpanded = !this.attachmentsExpanded;
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

  /** 某条消息深度思考区的有效折叠态：显式覆盖优先，否则取「深度思考收起」全局偏好。 */
  private effectiveThinkCollapsed(id: number): boolean {
    const k = String(id);
    return k in this.thinkCollapsed
      ? !!this.thinkCollapsed[k]
      : this.deepThinkCollapsed;
  }

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
    // 相对「有效折叠态」取反，写入显式覆盖（这样偏好切换后用户的手动选择可被反向操作解除）。
    const cur = this.effectiveThinkCollapsed(id);
    const next = !cur;
    this.thinkCollapsed = {
      ...this.thinkCollapsed,
      [k]: next
    };
    // 手动展开时把思考区正文滚到底部（对齐 live 流式时的钉底视角；
    // 默认收起偏好下展开旧思考，直接看到推理结尾而不是停在顶部）。
    if (!next) this.scrollCtl.scrollThinkBlockToBottom(k);
  }

  /* ── 富文本块折叠（超长代码块 / 表格） ──────────────────────────────────
     三处状态必须同步：容器上的 is-folded 类（驱动裁切与渐隐）、按钮文案、
     以及 aria-expanded。统一由 applyFolds 在每次渲染后按 mdFolded 重放，
     而不是在点击时改 DOM —— 后者的结果会被下一次重渲染抹掉（原因见 mdFolded 声明处）。 */

  /**
   * 把 mdFolded 重放到当前 DOM。
   * 每次 updated 都会全量重放：DOM 是刚重建的，不存在「已同步」的捷径。
   * 成本可忽略 —— 一个会话里的可折叠块数量级是十位。
   */
  private applyFolds() {
    const root = this.renderRoot;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-md-block]').forEach((el) => {
      // 块归属哪个作用域（哪条消息的哪一区）由最近的 [data-md-scope] 决定，
      // 因此渲染产物本身无需知道消息 id，缓存才能只按文本内容建立。
      const scope = el.closest<HTMLElement>('[data-md-scope]')?.dataset.mdScope;
      const block = el.dataset.mdBlock;
      if (!scope || !block) return;
      // 未超阈值（非可折叠）的块永远展开；可折叠块缺省即折叠。语义见 chat-block-fold.ts。
      const folded = effectiveBlockFolded(
        this.mdFolded,
        scope,
        block,
        el.dataset.mdFoldable === '1'
      );
      el.classList.toggle('is-folded', folded);
      const btn = el.querySelector<HTMLElement>('.md-fold');
      if (!btn) return;
      btn.textContent = foldButtonLabel(folded);
      btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
    });
  }

  /** 切换某块的折叠态：以 DOM 当前态取反，不依赖对缺省值的猜测。 */
  private toggleFold(el: HTMLElement) {
    const scope = el.closest<HTMLElement>('[data-md-scope]')?.dataset.mdScope;
    const block = el.dataset.mdBlock;
    if (!scope || !block) return;
    this.mdFolded = {
      ...this.mdFolded,
      [foldKey(scope, block)]: toggledBlockFolded(
        el.classList.contains('is-folded')
      )
    };
  }

  /**
   * 富文本块内按钮的事件委托（复制代码 / 折叠）。
   *
   * 为什么必须走委托，而不是给按钮绑 @click：
   * 这些按钮由 toRichHtml 生成为 HTML 字符串、经 unsafeHTML 注入，不参与 lit 的
   * 事件绑定体系；且每次重渲染都会重建节点，逐个 addEventListener 只会泄漏。
   * 委托挂在消息列表容器（.thread）上，靠冒泡一次覆盖全部历史与后续消息。
   * 事件顺序上先判折叠、再判复制：两者互斥且折叠判定更廉价。
   */
  private onRichClick = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest) return;

    const foldBtn = target.closest<HTMLElement>('.md-fold');
    if (foldBtn) {
      const block = foldBtn.closest<HTMLElement>('[data-md-block]');
      if (block) this.toggleFold(block);
      return;
    }

    const copyBtn = target.closest<HTMLElement>('.md-copy');
    if (copyBtn) {
      // 从 DOM 取原文而非在按钮上存副本：流式重渲染会替换节点，
      // 只有代码元素本身的 textContent 才是「此刻的完整内容」。
      const code = copyBtn
        .closest<HTMLElement>('.md-code')
        ?.querySelector('code');
      void this.copyCodeText(copyBtn, code?.textContent ?? '');
    }
  };

  /** 复制代码块内容：复用与消息复制一致的剪贴板兜底链路，成功后在按钮上就地反馈。 */
  private async copyCodeText(btn: HTMLElement, text: string) {
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // 非安全上下文 / 权限被拒：退回 execCommand，链路与 copyMsgText 相同。
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand('copy')) ok = true;
      } catch {
        /* ignore */
      }
      ta.remove();
    }
    if (!ok) return;
    btn.classList.add('is-copied');
    btn.textContent = '已复制';
    window.setTimeout(() => {
      // 按钮可能已被重渲染替换，此时操作的是游离节点，无副作用。
      btn.classList.remove('is-copied');
      btn.textContent = '复制';
    }, 1500);
  }

  /**
   * 深度思考结束自动折叠本轮思考面板：
   * 在首个回答 token 到达时调用（非流式回退路径由 run 收尾兜底再调一次，已折叠则跳过）。
   * 仅当本轮确实产出过推理内容（思考面板实际展示）才折叠；若已折叠（显式或偏好默认）则保持不动。
   */
  private autoCollapseThink(sid: string) {
    const sIdx = this.streamIdx[sid] ?? -1;
    const m = sIdx >= 0 ? (this.threads[sid] ?? [])[sIdx] : undefined;
    if (!m?.reasoning) return;
    const k = String(m.id);
    // 已折叠（含偏好默认）则不重复折叠；未折叠（含用户手动展开）才折叠。
    if (this.effectiveThinkCollapsed(m.id)) return;
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
    } else {
      this.closeAllSessionSwipes();
    }
  }

  /** 全组收起会话列表的滑动操作区（ah-swipe-item 组排他信号，不带 id）：
   * 避免「抽屉关了 / 已切会话、某行还摊开」的悬浮态，列表回到默认外观。 */
  private closeAllSessionSwipes() {
    window.dispatchEvent(
      new CustomEvent('ah:swipe-close', { detail: { group: 'chat-sessions' } })
    );
  }

  /** 切换 PC 端侧栏折叠态（展开/收起）。 */
  private toggleSidebarCollapse() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
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

  private renderPlanWfReplayDrawer(): TemplateResult {
    return renderPlanWfReplayDrawer(this.renderCtx());
  }

  /**
   * P2（轨迹回放）：打开计划「执行详情」抽屉。
   * 开抽屉即按确定性键 derivePlanWfId(activeId, plan) 拉取服务端检查点快照
   * （GET /api/workflows/:id，零引擎改动——快照本身即轨迹）；
   * 404 / 网络错误 → error 态（抽屉内友好提示并指向「断点续跑 / 重新执行」兜底）。
   */
  private openPlanWfReplay(m: ChatMsg): void {
    if (!m.plan) return;
    const sid = this.activeId;
    if (!sid) return;
    this.planWfReplayMsg = m;
    this.planWfReplay = {
      ...this.planWfReplay,
      [m.id]: { loading: true, snapshot: null }
    };
    void (async () => {
      const wfId = derivePlanWfId(sid, m.plan!);
      let st: PlanWfReplayState;
      try {
        const res = await client.getWorkflow(wfId);
        st = { loading: false, snapshot: res.workflow ?? null };
      } catch (e: unknown) {
        // P2.6：检查点丢失（服务重启 / Render free 盘清理 → 404）→ 回退到
        // 随 planStatus 镜像持久化的紧凑 run 快照（执行时捕获，applyPlanStatusLookup 恢复）。
        const mirror =
          this.planExec[m.id]?.wfSnapshot ??
          ((m as ChatMsg & { planStatus?: { wfSnapshot?: unknown } }).planStatus
            ?.wfSnapshot as PlanWfRunMirror | undefined);
        if (
          mirror &&
          typeof mirror === 'object' &&
          mirror.steps &&
          typeof mirror.steps === 'object'
        ) {
          st = {
            loading: false,
            snapshot: null,
            mirrorSnapshot: mirror,
            fromMirror: true,
            error: e instanceof Error ? e.message : String(e)
          };
        } else {
          st = {
            loading: false,
            snapshot: null,
            error: e instanceof Error ? e.message : String(e)
          };
        }
      }
      // 抽屉已关闭 / 已切到别的计划消息时不写回（防旧请求回流覆盖最新交互态）。
      if (this.planWfReplayMsg?.id === m.id) {
        this.planWfReplay = { ...this.planWfReplay, [m.id]: st };
      }
    })();
  }

  /** P2：关闭「执行详情」抽屉（快照缓存保留，重开时即时水合后仍可重拉）。 */
  private closePlanWfReplay(): void {
    this.planWfReplayMsg = null;
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
      editingOriginalContent: this.editingOriginalContent,
      hoverUserMsgId: this.hoverUserMsgId,
      copiedMsgId: this.copiedMsgId,
      deepThink: this.deepThink,
      thinkCollapsed: this.thinkCollapsed,
      deepThinkCollapsed: this.deepThinkCollapsed,
      traceDrawerMsg: this.traceDrawerMsg,
      traceDrawerSection: this.traceDrawerSection,
      connState: this.connState,
      jobBy: this.runRt.jobMap,
      stopped: this.runRt.stoppedMap,
      planExec: this.planExec,
      planWfReplay: this.planWfReplay,
      planWfReplayMsg: this.planWfReplayMsg,
      openPlanWfReplay: (m: ChatMsg) => this.openPlanWfReplay(m),
      closePlanWfReplay: () => this.closePlanWfReplay(),
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
      // 计划模式（P0）：目标澄清卡（plan:clarify）逐题点选/自定义 + 整体补充 + 确认继续。
      clarifyDraft: this.clarifyDraft,
      clarifyAnswered: this.clarifyAnswered,
      toggleClarifyPick: (msgId: number, qIdx: number, opt: string) =>
        this.toggleClarifyPick(msgId, qIdx, opt),
      setClarifyText: (msgId: number, qIdx: number, val: string) =>
        this.setClarifyText(msgId, qIdx, val),
      setClarifyExtra: (msgId: number, val: string) =>
        this.setClarifyExtra(msgId, val),
      confirmClarify: (m: ChatMsg) => void this.confirmClarify(m),
      // P3（人工审批门）：awaiting 态卡片「批准并继续」（全部未决门）/ 抽屉单节点批准。
      approvePlan: (m: ChatMsg, stepId?: string) =>
        void this.approvePlanAction(m, stepId),
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
  /** 取某条澄清卡的输入状态（惰性建卡：首次读写即落进 clarifyDraft，键为字符串题号）。 */
  private clarifyState(msgId: number): ClarifyDraftState {
    let st = this.clarifyDraft[msgId];
    if (!st) {
      st = { picks: {}, texts: {}, extra: '' };
      this.clarifyDraft[msgId] = st;
    }
    return st;
  }

  /** 点选/取消一个候选选项：重建状态对象触发重渲染以反映选中态（文本输入不受影响，值已入库）。 */
  private toggleClarifyPick(msgId: number, qIdx: number, opt: string) {
    if (this.clarifyAnswered[msgId]) return;
    const prev = this.clarifyState(msgId);
    const key = String(qIdx);
    const cur = prev.picks[key] ?? [];
    const next = cur.includes(opt)
      ? cur.filter((x) => x !== opt)
      : [...cur, opt];
    this.clarifyDraft = {
      ...this.clarifyDraft,
      [msgId]: { ...prev, picks: { ...prev.picks, [key]: next } }
    };
  }

  /** 某题自定义补充：就地写入不触发重渲染（避免输入框失焦/光标跳动）。 */
  private setClarifyText(msgId: number, qIdx: number, val: string) {
    this.clarifyState(msgId).texts[String(qIdx)] = val;
  }

  /** 整体补充：就地写入不触发重渲染。 */
  private setClarifyExtra(msgId: number, val: string) {
    this.clarifyState(msgId).extra = val;
  }

  /**
   * 计划模式（P0）：目标澄清卡「确认并继续」。把原需求 + 模型目标草稿 + 用户逐题
   * 点选/自定义回答 + 整体补充拼成新的 propose 输入再次派发（interactionMode 仍为
   * plan → 服务端走 planner 第二轮），基于已确认目标产出计划。派发期间澄清卡按钮置灰防重复提交。
   */
  private async confirmClarify(m: ChatMsg) {
    const sid = this.activeId;
    if (!sid || !m.clarify || this.clarifyAnswered[m.id]) return;
    if (this.streaming[sid]) return;
    this.clarifyAnswered = { ...this.clarifyAnswered, [m.id]: true };
    // 找澄清消息前面最近的一条用户消息 = 原始需求。
    const thread = this.threads[sid] ?? [];
    const idx = thread.findIndex((p) => p.id === m.id);
    let origNeed = '';
    for (let i = idx - 1; i >= 0; i -= 1) {
      const prev = thread[i];
      if (prev?.role === 'user') {
        origNeed = prev.content;
        break;
      }
    }
    // 逐题拼装：点选选项 + 自定义输入（任一非空才算回答，否则记「跳过」）。
    const st = this.clarifyState(m.id);
    const questions = normalizeClarifyQuestions(m.clarify.questions);
    const answerLines = questions
      .map((item, i) => {
        const picks = st.picks[String(i)] ?? [];
        const custom = (st.texts[String(i)] ?? '').trim();
        const chosen = [...picks, custom ? `其他：${custom}` : '']
          .filter(Boolean)
          .join('；');
        return chosen ? `${i + 1}. ${item.q} → ${chosen}` : null;
      })
      .filter((x): x is string => x !== null);
    const extra = st.extra.trim();
    const answered = answerLines.length > 0 || extra.length > 0;
    const parts = [
      origNeed || '（原需求见上文）',
      '—— 目标澄清回复 ——',
      m.clarify.goalDraft ? `目标草稿：${m.clarify.goalDraft}` : '',
      answerLines.length ? '用户逐题确认：' : '',
      ...answerLines,
      extra ? `用户补充：${extra}` : '',
      answered ? '' : '用户确认：按上述目标草稿继续，无需修改。'
    ].filter(Boolean);
    await this.runRt.dispatchPrompt(sid, parts.join('\n\n'), [], {});
  }
  /** 确认/恢复计划：按拓扑序（parsePlanOutput 已保证）逐任务派发；任一任务失败或用户停止即立即中止，等待用户指令后再继续。 */
  private async confirmPlan(m: ChatMsg) {
    const sid = this.activeId;
    if (!sid || !m.plan) return;
    const st = this.planExec[m.id];
    // pending=首次确认；failed=失败后从失败节点恢复。running/done/cancelled 不再进入。
    if (!st || (st.status !== 'pending' && st.status !== 'failed')) return;
    // P1（断点续跑）：确定性检查点键（sessionId + 计划结构键 → FNV-1a）。刷新 / 重启后
    // 可由同输入重算，无需把 wfId 写进持久化镜像；DAG 首跑与断点续跑共用同一键定位检查点。
    const wfId = derivePlanWfId(sid, m.plan);
    // P3（多 agent DAG）：开关开启时，首次确认（pending）走服务端 DagEngine 并行执行 + 共享黑板；
    // 传输层失败（unknown agent / 5xx / 断连 / wf:error）整体回退串行路径，保证已验证行为兜底。
    if (isPlanDagEnabled() && st.status === 'pending') {
      const ok = await this.confirmPlanViaWorkflow(m, st, sid, wfId);
      if (ok) return;
      // 回退：DAG 未进入终态 → 重置为可重入 pending，继续走下方串行派发。
      this.planExec = {
        ...this.planExec,
        [m.id]: { ...st, status: 'pending', currentTaskId: undefined }
      };
    }
    // P1（断点续跑）：failed 态「从失败任务继续」优先走 DAG 检查点续跑（保留并行 + 共享黑板，
    // 从断点仅重跑未完成任务）；DAG 不可达（404 无检查点 / 5xx / 断连 / wf:error）回退已验证的
    // 串行 resume（见 design/plan-mode-multiagent.md §9.3 / R8）。
    if (isPlanDagEnabled() && st.status === 'failed') {
      const ok = await this.resumePlanViaWorkflow(m, st, sid, wfId);
      if (ok) return;
      // 回退：DAG 续跑未进入终态 → 保留 failed（done 集合不动），继续走下方串行从失败任务重派发。
      this.planExec = {
        ...this.planExec,
        [m.id]: { ...st, status: 'failed', currentTaskId: undefined }
      };
    }
    let cur: PlanExecState = { ...st, status: 'running' };
    this.planExec = { ...this.planExec, [m.id]: cur };
    // P5 静默执行：串行路径同样不把任务消息进气泡 —— 每个任务以 quiet 消息对
    // （user 提示 + assistant 产出）在后台执行，思考增量进计划卡思考面板，
    // 产出在全部任务完成后随「摘要 + 最终结果」一次性输出。
    const taskOutputs: Record<string, string> = {};
    this.quietPlanSink = { msgId: m.id };
    try {
      for (const task of m.plan.tasks) {
        // 已完成的任务（上次成功跑完的）直接跳过：恢复执行只重跑失败节点及其后续。
        if (cur.done[task.id]) continue;
        // 每个任务派发前刷新当前任务标记 + 重置思考面板（驱动卡片 ⏳ 状态与 💭 思考流）。
        cur = {
          ...cur,
          status: 'running',
          currentTaskId: task.id,
          thinking: { taskId: task.id, text: '' }
        };
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
            planTask: true,
            // 联网能力对齐：任务执行继承 propose 时的联网开关（planWeb），
            // 避免「计划要求外部数据、执行环境无检索工具」导致验收必败。
            web: this.web || m.planWeb === true || undefined,
            // P5 静默执行：任务消息对标记 quiet（不渲染 / 不落历史镜像）。
            quiet: true
          }
        );
        if (result !== 'ok') {
          // 中断的部分产出不再展示（quiet 对移出线程）；DAG 检查点续跑为主恢复路径。
          this.stripQuietTail(sid);
          if (result === 'error') {
            // 任务执行失败（模型报错 / 断连）：立即中止后续所有任务派发，
            // 记录失败节点并置 failed 态 —— 卡片出现「从失败任务继续」按钮，
            // 等待用户给出指令（重试 / 调整）后从该节点拉起继续执行。
            cur = {
              ...cur,
              status: 'failed',
              failedTaskId: task.id,
              currentTaskId: undefined,
              thinking: undefined
            };
          } else {
            // 用户手动停止：中止剩余任务并标记取消，已完成任务的产出保留在会话中。
            cur = {
              ...cur,
              status: 'cancelled',
              currentTaskId: undefined,
              thinking: undefined
            };
          }
          this.planExec = { ...this.planExec, [m.id]: cur };
          return;
        }
        // 抽取本任务产出（隐藏 assistant 消息正文），随后把 quiet 消息对移出线程。
        const tOut = this.threadFor(sid);
        const outMsg = tOut[tOut.length - 1];
        taskOutputs[task.id] = typeof outMsg?.content === 'string' ? outMsg.content : '';
        this.stripQuietTail(sid);
        cur = {
          ...cur,
          done: { ...cur.done, [task.id]: true },
          failedTaskId: undefined,
          thinking: undefined
        };
        this.planExec = { ...this.planExec, [m.id]: cur };
      }
    } finally {
      this.quietPlanSink = null;
    }
    // 全部完成：回挂「摘要 + 最终结果」（P5：只在最后输出一次结果）。
    // 前缀与 appendPlanDagSummary 同源（PLAN_DAG_SUMMARY_PREFIX 解析器兼容）。
    const lines = [
      `📋 计划执行摘要：${m.plan.goal}（共 ${m.plan.tasks.length} 个任务）`
    ];
    let finalOut = '';
    let finalTask: { id: string; title: string } | undefined;
    for (const task of m.plan.tasks) {
      const ok = !!cur.done[task.id];
      lines.push(
        `${ok ? '✅' : '⏭'} ${task.id} ${task.title}（${ok ? 'done' : 'skipped'}）`
      );
      const out = taskOutputs[task.id];
      if (ok && out.trim()) {
        finalOut = out;
        finalTask = { id: task.id, title: task.title };
      }
    }
    if (finalTask && finalOut.trim()) {
      lines.push(
        '',
        `—— 最终结果（任务 ${finalTask.id}：${finalTask.title}）——`,
        finalOut
      );
    }
    const tFinal = this.threadFor(sid);
    tFinal.push({ id: this.nextId++, role: 'assistant', content: lines.join('\n') });
    this.threads[sid] = tFinal;
    if (this.activeId === sid) this.messages = tFinal;
    cur = {
      ...cur,
      status: 'done',
      currentTaskId: undefined,
      failedTaskId: undefined,
      thinking: undefined
    };
    this.planExec = { ...this.planExec, [m.id]: cur };
  }

  /**
   * P5 静默执行：把线程尾部连续的 quiet 消息（最多 user + assistant 两条）移出线程。
   * 串行回退路径在每个任务收尾（成功 / 失败 / 取消）调用 —— 隐藏消息对的产出已被
   * 读取进 taskOutputs（或确认丢弃），线程中不留痕迹，历史镜像也从不落 quiet 消息。
   */
  private stripQuietTail(sid: string) {
    const t = this.threadFor(sid);
    let removed = 0;
    while (t.length && t[t.length - 1]?.quiet && removed < 2) {
      t.pop();
      removed++;
    }
    if (removed) {
      this.threads[sid] = t;
      if (this.activeId === sid) this.messages = t;
    }
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
   * P3（人工审批门）：卡片 / 抽屉「批准并继续」入口。
   * awaiting 态时经确定性检查点键 locatePlanWfId 走服务端 approve 路由；
   * 非 awaiting 或 DAG 关闭时静默忽略（按钮本身仅在 awaiting 态渲染，此处是防御）。
   */
  private async approvePlanAction(m: ChatMsg, stepId?: string): Promise<void> {
    const sid = this.activeId;
    if (!sid || !m.plan) return;
    const st = this.planExec[m.id];
    if (!st || st.status !== 'awaiting') return;
    if (!isPlanDagEnabled()) return;
    const wfId = derivePlanWfId(sid, m.plan);
    await this.approvePlanViaWorkflow(m, st, sid, wfId, stepId);
  }

  /**
   * P3（多 agent DAG）：把确认后的 ExecutionPlan 发给服务端 DagEngine 并行执行，
   * 逐条消费 wf:step:* 事件驱动卡片状态机（applyPlanWfEvent），终态时把执行摘要
   * 回挂线程并落盘（产物回挂，见 design/plan-mode-multiagent.md §6 / R1）。
   *
   * @returns true = DAG 进入终态（done / failed / cancelled），调用方**不应**再走串行路径；
   *          false = 传输层失败（未知 agent / 5xx / SSE 中断 / wf:error），调用方重置 pending
   *          并回退已验证的串行路径兜底。
   */
  private async confirmPlanViaWorkflow(
    m: ChatMsg,
    st: PlanExecState,
    sid: string,
    wfId: string
  ): Promise<boolean> {
    if (!m.plan) return false;
    const taskIds = new Set(m.plan.tasks.map((t) => t.id));
    const ac = new AbortController();
    this.planWfAbort = ac;
    // 复用「流式中」标记：停止按钮亮起、发送按钮隐藏（避免计划执行中并发发起普通 run）。
    this.streaming = { ...this.streaming, [sid]: true };
    this.planExec = { ...this.planExec, [m.id]: { ...st, status: 'running' } };
    let terminal = false;
    try {
      const byok = await this.planWfByok(m);
      const source: AsyncGenerator<unknown> = client.streamWorkflowFromPlan(
        m.plan,
        {
          agentRef: this.agentId || undefined,
          mode: this.mode,
          ...byok,
          // P2-3：来源会话 id（= 计划文档落库键 plan:<sessionId>），服务端据此把
          // DAG 执行进度同步到 PlanStore 节点状态，「计划」Tab 看板实时刷新。
          sessionId: sid,
          // P1（断点续跑）：确定性检查点键 → 服务端按此 id 落检查点，
          // failed 态可经 resumePlanViaWorkflow 按同一键从断点续跑。
          workflowId: wfId,
          signal: ac.signal
        }
      );
      terminal = await this.consumePlanWfStream(
        m,
        st,
        sid,
        taskIds,
        ac,
        source,
        'first'
      );
    } finally {
      this.planWfAbort = null;
      this.streaming = { ...this.streaming, [sid]: false };
      this.requestUpdate();
    }
    if (terminal) this.saveHistory(sid);
    return terminal;
  }

  /**
   * P1（断点续跑）：failed 态经服务端 POST /api/workflows/:id/resume 从检查点续跑
   * （DagEngine.resume 跳过已完成 step，仅重跑未完成任务；BYOK 经服务端按 owner 重新解析，
   * 检查点本身不落明文凭据）。事件消费与首跑共用 consumePlanWfStream（状态机幂等——
   * 续跑流只重发未完成 step 的 wf:step:*，已完成任务保留在 prev.done）。
   *
   * @returns true = 续跑进入终态（done/failed/cancelled，或不可续跑时的 400/404）；
   *          false = 传输层异常（5xx / 断连 / fetch 抛错）→ 调用方回退串行 resume 兜底。
   */
  private async resumePlanViaWorkflow(
    m: ChatMsg,
    st: PlanExecState,
    sid: string,
    wfId: string
  ): Promise<boolean> {
    if (!m.plan) return false;
    const taskIds = new Set(m.plan.tasks.map((t) => t.id));
    const ac = new AbortController();
    this.planWfAbort = ac;
    this.streaming = { ...this.streaming, [sid]: true };
    this.planExec = { ...this.planExec, [m.id]: { ...st, status: 'running' } };
    let terminal = false;
    try {
      const byok = await this.planWfByok(m);
      const source: AsyncGenerator<unknown> = client.streamWorkflowResume(
        wfId,
        {
          mode: this.mode,
          ...byok,
          sessionId: sid,
          signal: ac.signal
        }
      );
      terminal = await this.consumePlanWfStream(
        m,
        st,
        sid,
        taskIds,
        ac,
        source,
        'resume'
      );
    } finally {
      this.planWfAbort = null;
      this.streaming = { ...this.streaming, [sid]: false };
      this.requestUpdate();
    }
    if (terminal) this.saveHistory(sid);
    return terminal;
  }

  /**
   * P3（人工审批门）：awaiting 态经服务端 POST /api/workflows/:id/approve 放行审批门。
   * 把目标 stepId（或全部未决门）写入检查点 run.approvals 后触发 DagEngine.resume，
   * 引擎跳过已放行的门继续执行；若计划还有下一道门，引擎再次暂停并下发
   * wf:awaiting-approval —— 卡片收敛回「待审批」态，用户逐门放行直至 wf:done。
   *
   * 与 resumePlanViaWorkflow 的区别：kind='approve' —— 传输层异常保留 awaiting
   * （不回退串行：串行路径无审批门，回落等于绕过用户审批决定）。
   *
   * @param stepId 指定时只放行该节点（抽屉里「批准此节点」）；缺省放行全部未决门
   *               （卡片「批准并继续」）。
   * @returns true = 审批流进入终态；false = 传输层异常，卡片保持「待审批」可重试。
   */
  private async approvePlanViaWorkflow(
    m: ChatMsg,
    st: PlanExecState,
    sid: string,
    wfId: string,
    stepId?: string
  ): Promise<boolean> {
    if (!m.plan) return false;
    const taskIds = new Set(m.plan.tasks.map((t) => t.id));
    const ac = new AbortController();
    this.planWfAbort = ac;
    this.streaming = { ...this.streaming, [sid]: true };
    this.planExec = {
      ...this.planExec,
      [m.id]: { ...st, status: 'running', awaitingTaskIds: undefined }
    };
    let terminal = false;
    try {
      const byok = await this.planWfByok(m);
      const source: AsyncGenerator<unknown> = client.streamWorkflowApprove(
        wfId,
        {
          stepId,
          all: !stepId,
          mode: this.mode,
          ...byok,
          sessionId: sid,
          signal: ac.signal
        }
      );
      terminal = await this.consumePlanWfStream(
        m,
        st,
        sid,
        taskIds,
        ac,
        source,
        'approve'
      );
    } finally {
      this.planWfAbort = null;
      this.streaming = { ...this.streaming, [sid]: false };
      this.requestUpdate();
    }
    if (terminal) this.saveHistory(sid);
    return terminal;
  }

  /**
   * 共享的 BYOK 载荷构造（t1 根因修复）：与串行 run 载荷（chat-run-runtime.ts 的 startRun）
   * 同构——model / 自定义模型端点（密钥为 DB 密文，服务端 decryptApiKey）/ 上下文窗口 / 联网开关。
   * 服务端按 (ctx.sub, model) 走 resolveRunCredential 主链路解析用户 Key；自定义模型路径
   * 才需前端带 modelBaseUrl/modelApiKey（与 /api/run 完全一致的凭据语义）。首跑与续跑复用。
   */
  private async planWfByok(m?: ChatMsg): Promise<{
    model?: string;
    modelBaseUrl?: string;
    modelApiKey?: string;
    ctxWindow?: number;
    web?: boolean;
  }> {
    const endpoint = await this.customModelEndpoint();
    return {
      model: this.model || undefined,
      ctxWindow: this.serverCtxWindow > 0 ? this.serverCtxWindow : undefined,
      modelBaseUrl: endpoint.modelBaseUrl,
      modelApiKey: endpoint.modelApiKey,
      // 联网能力对齐：计划执行继承 propose 当时的开关（planWeb）——生成计划时若已
      // 授权出网，任务执行自动带联网；当前开关与继承均无才不出网。
      web: this.web || m?.planWeb === true || undefined
    };
  }

  /**
   * 共享事件流消费器（confirmPlanViaWorkflow 首跑 / resumePlanViaWorkflow 续跑共用）：
   * 逐帧驱动卡片状态机（applyPlanWfEvent），编排终态回挂摘要，终结帧/异常按首跑 vs
   * 续跑语义收敛终态。
   *
   * @param resume true = 续跑模式：wf:error / 流静默结束保留 failed（不回 pending），
   *        调用方据返回 false 回退串行 resume；false = 首跑模式：wf:error / 传输异常
   *        重置 pending 后回退串行派发。
   * @returns 是否进入终态（调用方 true 时不再走串行路径）。
   */
  private async consumePlanWfStream(
    m: ChatMsg,
    st: PlanExecState,
    sid: string,
    taskIds: Set<string>,
    ac: AbortController,
    source: AsyncGenerator<unknown>,
    kind: 'first' | 'resume' | 'approve'
  ): Promise<boolean> {
    let terminal = false;
    // P4.6：终态交付文件拉取状态——记录已回挂摘要的 msgId 与本 run 的 wfId；
    // 只在 _wf_done（服务端归档完成后发出）时拉取，避免与归档竞态。
    let summaryMsgId: number | undefined;
    let wfIdForArtifacts: string | undefined;
    try {
      for await (const ev of source) {
        if (ac.signal.aborted) break;
        const e = ev as unknown as PlanWfEvent & {
          run?: PlanWfRunSnapshot;
          message?: string;
        };
        // wf:step:* 驱动卡片状态机（harness 嵌套事件 / wf:compensate:* 原样跳过）。
        const prev = this.planExec[m.id] ?? st;
        const next = applyPlanWfEvent(prev, e, taskIds);
        if (next !== prev) {
          this.planExec = { ...this.planExec, [m.id]: next };
        }
        // P5 静默执行：嵌套 harness 事件中只消费 llm:reasoning —— 增量叠进「当前任务
        // 思考面板」（串行模式下与 currentTaskId 一一对应）；llm:token 等其余流式内容
        // 静默丢弃（服务端 plan 桥已抑制 llm:token，此处是双保险），步骤消息不进气泡。
        const he = (e as { event?: { type?: string; delta?: unknown } }).event;
        if (he?.type === 'llm:reasoning') {
          const prevT = this.planExec[m.id] ?? st;
          const nextT = applyPlanThinking(prevT, String(he.delta ?? ''));
          if (nextT !== prevT) {
            this.planExec = { ...this.planExec, [m.id]: nextT };
          }
        }
        if (e.type === 'wf:done' || e.type === 'wf:failed') {
          // 编排终态：回挂摘要并停止消费后续帧（_wf_done 收尾帧无需再处理）。
          this.appendPlanDagSummary(sid, m, e.run);
          // P2.6：终态快照紧凑化落入 planExec（随 saveHistory 写穿到 planStatus 镜像）——
          // 检查点在服务重启 / free 盘清理后丢失时，「执行详情」抽屉据此回退水合。
          const snap = compactPlanWfSnapshot(e.run);
          const cur = this.planExec[m.id] ?? st;
          this.planExec = {
            ...this.planExec,
            [m.id]: { ...cur, ...(snap ? { wfSnapshot: snap } : {}) }
          };
          terminal = true;
          break;
        }
        if (e.type === '_wf_done') {
          // 服务端收尾帧（正常路径 wf:done/wf:failed 已先行到达并 break；
          // 此分支兜底「终态帧被 SSE 解析丢失」时仍能从 run 快照还原摘要）。
          const run = e.run;
          const s = this.planExec[m.id] ?? st;
          // P3：审批门暂停不是编排终态 —— run.state==='awaiting' 时不回挂完成摘要，
          // 卡片收敛为「待审批」态（awaitingTaskIds 取自快照中 awaiting 的 step）。
          const rs = run?.state;
          const awaitingIds =
            rs === 'awaiting'
              ? Object.values(run?.steps ?? {})
                  .filter((x) => x?.state === 'awaiting')
                  .map((x) => x.id ?? '')
                  .filter(Boolean)
              : [];
          if (run?.steps && rs !== 'awaiting')
            this.appendPlanDagSummary(sid, m, run);
          // P2.6：收尾帧兜底同样落快照（含 awaiting 暂停态的 partial 快照——审批等待中
          // 刷新后抽屉仍可回看已执行节点的轨迹）。
          const snap = compactPlanWfSnapshot(run);
          this.planExec = {
            ...this.planExec,
            [m.id]: {
              ...s,
              status:
                rs === 'done'
                  ? 'done'
                  : rs === 'awaiting'
                  ? 'awaiting'
                  : 'failed',
              currentTaskId: undefined,
              ...(rs === 'awaiting' && awaitingIds.length
                ? { awaitingTaskIds: awaitingIds }
                : {}),
              ...(snap ? { wfSnapshot: snap } : {})
            }
          };
          terminal = true;
          break;
        }
        if (e.type === 'wf:error') {
          // 请求级失败（SSE 已开后服务端报错，如 402 无 Key / 检查点 400/404）：
          // 首跑重置可重入 pending（回退串行派发）；续跑保留 failed（回退串行 resume，
          // 从失败任务重派发——done 集合不动，已完成产出保留）；
          // P3 审批路径保留 awaiting（串行路径无审批门，回落等于绕过审批——宁可原地重试）。
          this.planExec = {
            ...this.planExec,
            [m.id]: {
              ...(this.planExec[m.id] ?? st),
              status:
                kind === 'first'
                  ? 'pending'
                  : kind === 'resume'
                  ? 'failed'
                  : 'awaiting',
              currentTaskId: undefined
            }
          };
          terminal = kind !== 'resume';
          break;
        }
      }
      // 用户手动停止（停止按钮 → planWfAbort.abort()）：保留已完成任务（done 集合），
      // 标 cancelled —— 这是合法终态，不回退串行。
      if (ac.signal.aborted) {
        this.planExec = {
          ...this.planExec,
          [m.id]: {
            ...(this.planExec[m.id] ?? st),
            status: 'cancelled',
            currentTaskId: undefined
          }
        };
        terminal = true;
      } else if (!terminal) {
        // 流自然结束但未收到任何终态帧（服务端进程重启 / 网络静默断开）：
        // 保守标记 failed（而非静默 done），用户可经「从失败任务继续」重试。
        this.planExec = {
          ...this.planExec,
          [m.id]: {
            ...(this.planExec[m.id] ?? st),
            status: 'failed',
            currentTaskId: undefined
          }
        };
        terminal = true;
      }
    } catch (e: unknown) {
      if (ac.signal.aborted) {
        // 用户手动停止（SSE 迭代在 abort 时抛 AbortError 路径）：保留已完成任务，
        // 标 cancelled —— 合法终态，不回退串行（terminal=true 使调用方不再派发）。
        this.planExec = {
          ...this.planExec,
          [m.id]: {
            ...(this.planExec[m.id] ?? st),
            status: 'cancelled',
            currentTaskId: undefined
          }
        };
        terminal = true;
      } else if (kind === 'approve') {
        // P3 审批路径传输层异常（404 检查点丢失 / 5xx / 断连）：保留 awaiting（done 集合不动），
        // 不回退串行（串行无审批门，回落等于绕过审批）；terminal=false → 卡片保持「待审批」
        // 可再次点「批准并继续」重试。
        this.planExec = {
          ...this.planExec,
          [m.id]: {
            ...(this.planExec[m.id] ?? st),
            status: 'awaiting',
            currentTaskId: undefined
          }
        };
        terminal = false;
      } else if (kind === 'resume') {
        // 续跑传输层异常（404 无检查点 / 5xx / 断连）：不 toast 打扰（旧 run / 检查点
        // 丢失属可预期路径），保留 failed → 调用方回退串行 resume 兜底。
        this.planExec = {
          ...this.planExec,
          [m.id]: {
            ...(this.planExec[m.id] ?? st),
            status: 'failed',
            currentTaskId: undefined
          }
        };
        terminal = false;
      } else {
        // 首跑传输层异常（unknown agentRef / 5xx / 断连）：提示 + 重置 pending，回退串行路径。
        notifyError(e, { title: '计划执行中断', key: `plan-wf-${m.id}` });
        this.planExec = {
          ...this.planExec,
          [m.id]: {
            ...(this.planExec[m.id] ?? st),
            status: 'pending',
            currentTaskId: undefined
          }
        };
      }
    }
    return terminal;
  }

  /**
   * P3：把计划 DAG 执行摘要回挂线程（卡片级紧凑摘要，见 design R1 —— 不把每 step
   * 明细重铺进会话气泡，避免历史膨胀）。run 快照缺失时仍给出按 task 的状态清单。
   * P5 静默执行：步骤消息不再进会话气泡 —— 本消息即「最终结果」的输出位：
   * 状态清单之后追加拓扑序最后一个成功任务的**完整产出**（不截断），只在最后输出一次。
   */
  private appendPlanDagSummary(
    sid: string,
    m: ChatMsg,
    run: PlanWfRunSnapshot | undefined
  ): number | undefined {
    if (!m.plan) return undefined;
    const steps = run?.steps ?? {};
    const lines: string[] = [
      `📋 计划执行摘要：${m.plan.goal}（共 ${m.plan.tasks.length} 个任务）`
    ];
    let finalOut = '';
    let finalTask: { id: string; title: string } | undefined;
    for (const t of m.plan.tasks) {
      const sr = steps[t.id];
      const state = sr?.state ?? 'pending';
      const mark = state === 'done' ? '✅' : state === 'failed' ? '❌' : '⏭';
      lines.push(`${mark} ${t.id} ${t.title}（${state}）`);
      const out = sr?.output;
      // P5：记录拓扑序最后一个成功任务的完整产出（循环按 plan.tasks 顺序，天然取末位）。
      if (state === 'done' && typeof out === 'string' && out.trim()) {
        finalOut = out;
        finalTask = { id: t.id, title: t.title };
      } else if (state === 'done' && out != null && typeof out !== 'string') {
        try {
          finalOut = JSON.stringify(out, null, 2);
          finalTask = { id: t.id, title: t.title };
        } catch {
          /* 不可序列化产出跳过 */
        }
      }
    }
    if (finalTask && finalOut.trim()) {
      lines.push(
        '',
        `—— 最终结果（任务 ${finalTask.id}：${finalTask.title}）——`,
        finalOut
      );
    }
    const t = this.threadFor(sid);
    const msgId = this.nextId++;
    t.push({ id: msgId, role: 'assistant', content: lines.join('\n') });
    this.threads[sid] = t;
    if (this.activeId === sid) this.messages = t;
    return msgId;
  }

  /**
   * P4.6：终态后拉取本 plan run 归档的「交付文件」并追加到执行摘要消息最下方
   * （每文件 打开 /api/artifacts/<id>?preview=1 + 下载 ?download=1，markdown 渲染为可点链接）。
   * 仅全成功（planExec.status==='done'）且无失败时展示——与后端「仅 done run 归档」同语义。
   * 拉取 / 渲染失败静默降级（console.warn），绝不影响计划主流程与已 push 的摘要。
   * @returns 是否成功追加了文件区（供 saveHistory 判断是否需落盘更新）。
   */
  private async appendPlanDagArtifactSection(
    sid: string,
    m: ChatMsg,
    summaryMsgId: number | undefined,
    wfId: string | undefined
  ): Promise<boolean> {
    if (summaryMsgId == null || !wfId) return false;
    // 仅成功完成的计划才展示交付文件（后端对 failed run 不归档）。
    const status = this.planExec[m.id]?.status;
    if (status !== 'done') return false;
    let items: import('./chat-render-utils').PlanArtifactItem[];
    try {
      const res = await authedFetch(
        `/api/artifacts?runId=${encodeURIComponent(wfId)}`
      );
      if (!res.ok) return false;
      const data = (await res.json()) as {
        items?: Array<{ id: string; name: string; sizeBytes: number }>;
      };
      items = Array.isArray(data.items)
        ? data.items.map((a) => ({
            id: a.id,
            name: a.name,
            sizeBytes: a.sizeBytes
          }))
        : [];
    } catch (e) {
      console.warn(
        `[plan-artifacts] 拉取交付文件失败（不阻断）：${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return false;
    }
    const section = buildPlanArtifactSection(items);
    if (!section) return false; // 无文件 → 不追加区块
    const t = this.threadFor(sid);
    const msg = t.find((x) => x.id === summaryMsgId);
    if (!msg) return false;
    msg.content = `${msg.content}${section}`;
    this.threads[sid] = t;
    if (this.activeId === sid) this.messages = t;
    return true;
  }

  /**
   * 会话列表底部状态行（滚动加载的反馈位）：
   * 加载中 / 加载失败可重试 / 已到末尾 / 「加载更多」。
   *
   * 为何在自动滚动加载之外仍保留手动按钮：自动触发依赖滚动事件，而「首屏不足以撑出
   * 滚动条」虽有 autoFillSessionList 兜底，但该兜底有轮次上限；按钮是最终安全网，
   * 同时给键盘 / 读屏用户一条不依赖滚动的入口。
   */
  private renderSessionListFooter() {
    if (this.sessions.length === 0) return nothing;
    if (this.sessionsLoadingMore) {
      return html`<div class="session-more" role="status" aria-live="polite">
        <span class="spinner"></span><span>加载中…</span>
      </div>`;
    }
    if (this.sessionsMoreError) {
      return html`<button
        class="session-more retry"
        @click=${() => {
          this.sessionsMoreError = false;
          void this.loadMoreSessions();
        }}
      >
        加载失败，点击重试
      </button>`;
    }
    if (this.sessionsHasMore) {
      return html`<button
        class="session-more"
        @click=${() => void this.loadMoreSessions()}
      >
        加载更多
      </button>`;
    }
    // 仅一页（且无更多）时不显示「没有更多了」—— 无信息量，徒增噪音。
    if (this.sessions.length <= SESSION_PAGE_SIZE) return nothing;
    return html`<p class="session-end">没有更多了</p>`;
  }

  /**
   * 内容区骨架屏（历史会话加载占位）。
   *
   * 与真实消息共用同一套尺寸规格，保证「加载态 → 内容态」不发生位移：
   * - 结构对齐：用户消息靠右带头像、助手消息靠左带头像，气泡外壳（背景 / 边框 /
   *   圆角 / 内边距）与 .bubble 逐项相同 —— 加载完成时外壳不会「凭空出现」；
   * - 高度对齐：每个 .sk-line 是一个完整行盒（14px × 1.65 = 23.1px），可见光条由
   *   ::before 居中绘制，故气泡总高 = 24 + 23.1 × 行数，与真实气泡逐像素一致；
   * - 宽度近似：真实用户气泡宽度由内容决定（≤62%），骨架无法预知，故 2 行取 56%、
   *   单行短句取 38% 作为典型值；助手光条上限 90%，避免读作整块色带。
   * 行宽写入内联 --w，由 chat-styles 的 .sk-line::before 消费。
   */
  private renderSessionSkeleton() {
    const line = (w: string) =>
      html`<div class="sk-line" style="--w:${w}"></div>`;
    return html`
      <div
        class="thread sk-thread"
        role="status"
        aria-busy="true"
        aria-label="正在加载历史会话"
      >
        <div class="sk-msg user">
          <div class="sk-avatar"></div>
          <div class="sk-bubble">${line('100%')}${line('54%')}</div>
        </div>
        <div class="sk-msg assistant">
          <div class="sk-avatar"></div>
          <div class="sk-bubble">
            ${line('86%')}${line('90%')}${line('82%')}${line('50%')}
          </div>
        </div>
        <div class="sk-msg user">
          <div class="sk-avatar"></div>
          <div class="sk-bubble short">${line('100%')}</div>
        </div>
        <div class="sk-msg assistant">
          <div class="sk-avatar"></div>
          <div class="sk-bubble">${line('88%')}${line('54%')}</div>
        </div>
      </div>
    `;
  }

  /**
   * 内容区渲染：加载历史 → 骨架屏；无消息 → 空态引导；否则渲染消息线程。
   * 独立成方法并以提前返回表达三种状态，避免模板内出现深层嵌套三元表达式。
   */
  private renderContentArea() {
    if (this.sessionLoading) return this.renderSessionSkeleton();
    if (this.messages.length === 0) {
      return html`
        <div class="empty">
          <h1>有什么可以帮你的？</h1>
          <p>基于 agent-harness 的多会话对话。下方输入即可开始。</p>
        </div>
      `;
    }
    return html`<div class="thread" @click=${this.onRichClick}>
      ${this.renderConnBanner()}
      ${this.llmReady
        ? ''
        : html`<div
            style="display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:10px 14px;border:1px solid var(--ah-warning);background:var(--ah-warning-soft);color:var(--ah-warning);border-radius:var(--ah-radius-md,10px);font-size:13px;line-height:1.4;"
          >
            <span
              >当前使用离线 Mock 模型，配置你的 API Key 后可使用真实模型。</span
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
      ${this.messages
        .filter((m) => !m.quiet)
        .map((m) => this.renderMessage(m))}
    </div>`;
  }

  render() {
    const active = this.sessions.find((s) => s.id === this.activeId);
    // 附件预览条：折叠态只渲染前 N 条，余量交给「+N」按钮（渲染与文案同源）。
    const attachView = resolveAttachmentView(
      this.attachments,
      this.attachmentsExpanded
    );
    return html`
      <!-- 整屏拖拽上传：监听挂在 render 根 <div> 上 —— 它在 shadow DOM 内，
           铺满 :host，所以「拖到 chat 组件任意位置」都能被接住。
           三个事件必须一起绑：只 preventDefault on dragover 才会被浏览器
           认定为合法放置目标，否则 drop 永远不触发。 -->
      <div
        class="chat-root"
        @dragenter=${this.onDragEnter}
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        <div
          class="sidebar ${this.sidebarOpen ? 'open' : ''} ${this
            .sidebarCollapsed
            ? 'collapsed'
            : ''}"
          @click=${(e: Event) => e.stopPropagation()}
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
            <!-- 移动端关闭按钮：侧边栏为 fixed 抽屉，需要显式关闭入口（≤900px 显示） -->
            <button
              class="close-btn"
              title="关闭会话列表"
              aria-label="关闭会话列表"
              @click=${() => this.toggleSidebar()}
            >
              ✕
            </button>
          </div>
          <div
            class="session-list"
            role="list"
            aria-busy=${this.sessionsLoadingMore ? 'true' : 'false'}
            @scroll=${this.onSessionListScroll}
            @touchstart=${this.onSessionListTouchStart}
            @touchmove=${this.onSessionListTouchMove}
            @touchend=${this.onSessionListTouchEnd}
            @touchcancel=${this.onSessionListTouchEnd}
          >
            <!-- 下拉刷新指示器：触屏在列表顶部下拉时滑入；桌面端 opacity:0 不可见、不响应 -->
            <div class="pull-refresh" aria-hidden="true">
              <span class="spinner"></span>
              <span class="pull-hint">下拉刷新</span>
            </div>
            <div class="session-inner">
              ${this.sessions.length === 0
                ? html`<p class="muted">暂无会话，发送消息即自动创建。</p>`
                : this.sessions.map(
                    (s) => html`
                      <!-- 通用滑动项（ah-swipe-item，components/index.ts 注册）：
                         触屏左滑行内容露出右侧「重命名/删除」操作区；桌面 hover 设备
                         自动隐藏操作区，沿用行内 .acts hover 入口（见 session-swipe.ts）。 -->
                      <ah-swipe-item id=${s.id} group="chat-sessions">
                        <div
                          class="session ${s.id === this.activeId
                            ? 'active'
                            : ''}"
                          role="listitem"
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
                        <div slot="actions">
                          <button
                            class="swipe-act"
                            title="重命名"
                            aria-label="重命名会话"
                            @click=${() => this.renameSession(s.id)}
                          >
                            重命名
                          </button>
                          <button
                            class="swipe-act danger"
                            title="删除"
                            aria-label="删除会话"
                            @click=${() => this.deleteSession(s.id)}
                          >
                            删除
                          </button>
                        </div>
                      </ah-swipe-item>
                    `
                  )}
              ${this.renderSessionListFooter()}
            </div>
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
            <!-- 新对话：仅移动端显示（≤900px，见 chat-styles.ts .new-chat-btn），
                 桌面端顶部已有会话列表抽屉入口，无需重复。 -->
            <button
              class="new-chat-btn"
              title="新对话"
              aria-label="新对话"
              @click=${() => this.newChat()}
            >
              <!-- 气泡 + 加号：语义「新开一段对话」，与左侧会话列表按钮（气泡+文字行）区分 -->
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path
                  d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
                />
                <path d="M12 6v6M9 9h6" />
              </svg>
            </button>
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
          </div>

          <div class="scroll-region">
            <div
              class="scroll"
              ${ref(this.scrollCtl.scrollRef)}
              @scroll=${() => this.scrollCtl.onScroll()}
            >
              ${this.renderContentArea()}
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
                ? html`<div
                    class="attachments-preview ${this.attachmentsExpanded
                      ? 'expanded'
                      : 'collapsed'} ${attachView.collapsedCount > 0
                      ? 'has-more'
                      : ''}"
                  >
                    <div class="attach-strip">
                      ${attachView.visible.map(
                        (f, i) => html`
                          <div
                            class="attach-preview-item ${f.uploadStatus ===
                            'error'
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
                              ? html`<span
                                  class="attach-status done"
                                  title="已上传"
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
                    </div>
                    ${attachView.collapsedCount > 0
                      ? html`<button
                          type="button"
                          class="attach-more"
                          title=${this.attachmentsExpanded
                            ? '收起'
                            : `另有 ${attachView.collapsedCount} 个附件已折叠，点击展开`}
                          aria-expanded=${this.attachmentsExpanded
                            ? 'true'
                            : 'false'}
                          @click=${() => this.toggleAttachments()}
                        >
                          <svg
                            class="am-chev"
                            viewBox="0 0 10 6"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <path d="M1 1.5l4 4 4-4" />
                          </svg>
                          ${this.attachmentsExpanded
                            ? '收起'
                            : `+${attachView.collapsedCount}`}
                        </button>`
                      : nothing}
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
                    : "您正在与 Agent 聊天，输入'/'获取更多能力，如'/plan'"}
                  .value=${this.input}
                  ?disabled=${this.streaming[this.activeId] === true}
                  @input=${this.onInput}
                  @keydown=${this.onKey}
                ></textarea>
              </div>
              <div class="composer-footer">
                <div class="composer-footer-left">
                  <!-- 「+」统一入口：文件 / 模式 / 专家三类能力收口到一个按钮 + 分区面板；
                       已选的模式与专家以胶囊形式常驻在 + 右侧，点击胶囊可直达对应分区。 -->
                  <ah-composer-plus
                    .agents=${this.agents}
                    .agentId=${this.agentId}
                    .mode=${this.interactionMode}
                    .attachments=${this.attachments}
                    @files-select=${(e: Event) =>
                      this.handleFiles(
                        (e as CustomEvent<{ files: File[] }>).detail.files
                      )}
                    @remove-attachment=${(e: Event) =>
                      this.removeAttachment(
                        (e as CustomEvent<{ index: number }>).detail.index
                      )}
                    @mode-change=${(e: Event) =>
                      this.setInteractionMode(
                        (e as CustomEvent<{ value: 'qa' | 'plan' }>).detail
                          .value
                      )}
                    @agent-change=${(e: Event) => {
                      const v = (e as CustomEvent<{ value: string }>).detail
                        .value;
                      this.agentId = v;
                      this.persistSessionSettings({ agentId: v });
                    }}
                  ></ah-composer-plus>
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
                  ${this.serverCtxWindow <= 0 || this.activeId === ''
                    ? nothing
                    : renderCtxRing({
                        usage: selectContextUsage({
                          backendUsage: this.backendUsage,
                          serverCtxWindow: this.serverCtxWindow,
                          messages: this.messages
                        }),
                        showCtxUsage: this.showCtxUsage,
                        runCumulative: this.runCumulative,
                        onToggle: () =>
                          (this.showCtxUsage = !this.showCtxUsage),
                        onClose: () => (this.showCtxUsage = false)
                      })}
                  ${this.streaming[this.activeId] === true
                    ? html`<button
                        class="send"
                        title="停止"
                        @click=${() =>
                          // P3：计划 DAG 执行中优先中止 DAG 流（planWfAbort），
                          // 普通 run 才走 runRt.stop()。两者互斥（同一时刻仅一个在跑）。
                          this.planWfAbort
                            ? this.planWfAbort.abort()
                            : this.runRt.stop()}
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
        ${this.renderTraceDrawer()} ${this.renderPlanWfReplayDrawer()}

        <!-- 整屏拖拽遮罩：覆盖整个 chat 区域；pointer-events:none 保证不干扰
           drop 事件的命中测试（遮罩只是视觉层，事件仍落在 .chat-root 上）。 -->
        ${this.dragActive
          ? html`<div
              class="drop-overlay ${this.attachRoom === 0 ? 'full' : ''}"
              aria-hidden="true"
            >
              <div class="drop-overlay-card">
                <div class="drop-overlay-icons">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                    />
                  </svg>
                </div>
                <!-- 已达上限时切换为「不可再添加」提示，避免用户松开后才发现加不进去。
                   剩余额度一并展示，让「还能加几个」一目了然。 -->
                ${this.attachRoom === 0
                  ? html`<div class="drop-overlay-title">已达上传上限</div>
                      <div class="drop-overlay-hint">
                        最多支持 ${MAX_ATTACHMENTS}
                        个文件，请先移除部分文件再添加
                      </div>`
                  : html`<div class="drop-overlay-title">松开即可添加文件</div>
                      <div class="drop-overlay-hint">
                        最多支持上传 ${MAX_ATTACHMENTS} 个文件（还可添加
                        ${this.attachRoom} 个），支持常见文件类型
                      </div>`}
              </div>
            </div>`
          : nothing}
      </div>
    `;
  }
}
