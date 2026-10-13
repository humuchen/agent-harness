<script module lang="ts">
  /**
   * ah-chat：聊天面板 —— Svelte 迁移版（原 src/chat.ts + src/chat-message-render.ts
   * + chat-trace.ts 的 renderConfidence/renderTraceNode/renderInsights 合并）。
   *
   * 模块级导出（MAX_ATTACHMENTS / ATTACH_COLLAPSE_LIMIT / resolveAttachmentView /
   * UPLOAD_CONCURRENCY / runWithConcurrency 等）逐一保留，供单测与 UI 文案复用。
   * 附件上传管线（handleFilesCore / uploadOneCore / patchAttachmentCore）收在模块层，
   * 以「状态对象」参数化 —— 组件实例经 attachBridge 桥接 $state，单测直接构造最小状态驱动。
   */
  import { client, authedFetch, getUsername } from './api';
  // 跨设备实时同步：登录后建立常驻 SSE，接收本账户其它端写入的增量消息/标题/删除。
  import {
    startChatSync,
    stopChatSync,
    MY_ORIGIN,
    type ChatSyncEvent
  } from './chat-sync';
  import { AhModal } from './components/ah-modal';
  import {
    isRetrievalTool,
    safeJson,
    toolDisplayName,
    summarizeJevDecision,
    parseDeepThinking
  } from './utils/chat-utils';
  import { toRichHtml } from './utils/markdown';

  // 上下文用量聚合（圆环渲染已拆到 chat-context-usage.svelte 组件）。
  import { selectContextUsage } from './chat-context-usage';

  // 纯渲染/格式化工具。
  import {
    fileIcon,
    formatSize,
    buildPlanStatusLookup,
    mergePlanStatusLookup,
    resolveRestoredPlanExec,
    applyPlanWfEvent,
    applyPlanThinking,
    derivePlanWfId,
    compactPlanWfSnapshot,
    isPlanDagEnabled,
    buildPlanArtifactSection,
    buildPlanReportFileName,
    buildPlanFinalReport,
    planOutputsFromRun,
    planDeliverablesEnabled,
    hasPlanArtifactSection,
    PLAN_FINAL_ARTIFACT_NOTE,
    filterPlanSingleStep,
    recoverPlanFinalResult,
    planDownstreamTaskIds,
    buildPlanWfReplayRows,
    buildPlanWfTraceLines,
    planWfReplayMark,
    planWfReplayStateLabel,
    planWfTraceMetaLabel,
    planWfTraceMetaRowTitle,
    formatPlanWfDuration,
    type PlanWfEvent,
    type PlanWfRunSnapshot
  } from './chat-render-utils';

  // 富文本块折叠的判定逻辑（组件侧只负责 DOM 读写）。
  import {
    effectiveBlockFolded,
    foldButtonLabel,
    foldKey,
    toggledBlockFolded
  } from './chat-block-fold';

  // 打字机引擎（轻量控制器，回调注入）。
  import { ChatTypewriter } from './chat-typewriter';

  // 运行管线控制器（ingest / dispatchPrompt / resumeLost / stop / 看门狗 / 可见性体检）。
  import { ChatRunRuntime, type RunDeps } from './chat-run-runtime';

  // 聊天界面本地视图类型。
  import type {
    ToolView,
    ExecutionPlanView,
    PlanExecState,
    PlanWfReplayState,
    PlanWfRunMirror,
    ChatMsg,
    SessionView,
    TraceCtx,
    ClarifyDraftState,
    PlanClarifyQuestionView
  } from './chat-types';

  // 会话列表分页模型。
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

  // 历史持久化。
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
  import type { UploadedFile } from './agent-context';
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
  import { APP_EVENTS } from './app-events';

  // 调用链追踪：纯函数部分（渲染部分已内联为本组件 snippet）。
  import {
    countTraceNodes,
    collapseEntireTrace,
    buildInsights,
    buildConfidence,
    type Insights
  } from './chat-trace';
  import { renderJsonHtml } from './utils/json-view';

  // 副作用导入：注册 <plan-elapsed>（propose 阶段实时计时器，模板中使用）。
  import './plan-elapsed';

  /** 从索引签名事件里安全取对象字段（unknown → Record | undefined）。 */
  function asObj(v: unknown): Record<string, unknown> | undefined {
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  }

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

  /**
   * 串行派发计划任务时，注入派发 prompt 的单条上游产出字符上限。
   * 超长产出（如整章文档）截断保头并标注「已截断」，防止下游整合任务的
   * 上下文被单个上游产出撑爆（多个依赖叠加时按 6k × 依赖数渐进增长，可接受）。
   */
  const PLAN_UPSTREAM_OUTPUT_MAX = 6000;

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

  /**
   * 计划模式（P0）：归一化澄清问题列表 —— 兼容历史落盘的 string[] 与新契约 [{q, options}]，
   * 供渲染与确认拼装两处共用（历史消息不落盘时无法在入口归一化）。
   */
  export function normalizeClarifyQuestions(
    raw: unknown
  ): PlanClarifyQuestionView[] {
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[])
      .map((item) => {
        if (typeof item === 'string') {
          const q = item.trim();
          return q ? { q } : null;
        }
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          const q = typeof o.q === 'string' ? o.q.trim() : '';
          if (!q) return null;
          const options = Array.isArray(o.options)
            ? (o.options as unknown[]).map((x) => String(x)).filter(Boolean).slice(0, 4)
            : undefined;
          return options && options.length ? { q, options } : { q };
        }
        return null;
      })
      .filter((x): x is PlanClarifyQuestionView => x !== null)
      .slice(0, 5);
  }

  /** 附件上传/预览管线所操作的最小状态（组件实例经桥接对象注入 $state；单测直接构造普通对象）。 */
  export interface AttachState {
    attachments: UploadedFile[];
    uploadingFiles: Map<
      string,
      { status: 'uploading' | 'done' | 'error'; error?: string }
    >;
  }

  /**
   * 按对象**引用**就地更新某个附件字段。
   * 用引用而非下标 —— 上传期间用户可能移除其它附件，下标会错位打到别的文件上。
   */
  export function patchAttachmentCore(
    st: AttachState,
    target: UploadedFile,
    patch: Partial<UploadedFile>
  ) {
    st.attachments = st.attachments.map((a) =>
      a === target ? { ...a, ...patch } : a
    );
  }

  /**
   * 上传单个附件并就地更新其状态。
   * 失败只标记该文件为 error，绝不影响同批其它文件。
   */
  export async function uploadOneCore(p: PendingUpload, st: AttachState): Promise<void> {
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
      // 不可变更新：重新赋值触发响应式重渲染。
      patchAttachmentCore(st, p.meta, {
        serverUrl: json.meta.url,
        uploadStatus: 'done'
      });
      st.uploadingFiles.set(p.key, { status: 'done' });
    } catch (err) {
      let msg = err instanceof Error ? err.message : '上传失败';
      // 后端 raw body 超过阈值时返回该文案；转换为更友好的提示。
      if (/request body too large/i.test(msg)) {
        msg = `图片体积过大，上传被服务端拒绝：${p.raw.name}`;
      }
      patchAttachmentCore(st, p.meta, {
        uploadStatus: 'error',
        uploadError: msg
      });
      st.uploadingFiles.set(p.key, { status: 'error', error: msg });
      notifyError(new Error(msg), {
        title: '附件上传',
        fallback: `上传失败：${p.raw.name}`,
        key: 'chat-upload'
      });
    }
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
   */
  export async function handleFilesCore(st: AttachState, picked: File[]): Promise<void> {
    if (!picked.length) return;

    // 数量上限：拖拽遮罩的提示文案（MAX_ATTACHMENTS）在这里才真正生效。
    const room = MAX_ATTACHMENTS - st.attachments.length;
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

      let dataUrl: string;
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
    st.attachments = [...st.attachments, ...pending.map((p) => p.meta)];
    for (const p of pending) {
      st.uploadingFiles.set(p.key, { status: 'uploading' });
    }

    // ---- 阶段三：受限并发上传 ----
    await runWithConcurrency(
      pending.map((p) => () => uploadOneCore(p, st)),
      UPLOAD_CONCURRENCY
    );
  }

  /** 同步原生 `<details>` toggle 事件到节点的 expanded 字段（受控重渲染）。 */
  function syncDetailsToggle(
    n: TraceNode,
    e: Event,
    onToggle?: () => void
  ): void {
    n.expanded = (e.target as HTMLDetailsElement).open;
    onToggle?.();
  }

  /** 环形量表几何常量（r=36，viewBox 88×88）。 */
  const GAUGE_R = 36;
  const GAUGE_C = 2 * Math.PI * GAUGE_R;

  /** 「关键信息」统计行的展示序列（renderInsights 的数据整形，供 snippet map）。 */
  function buildInsightStats(
    ins: Insights
  ): Array<[string, string, string?]> {
    const stats: Array<[string, string, string?]> = [];
    const push = (k: string, v: string | undefined, badge?: string) => {
      if (v != null) stats.push([k, v, badge]);
    };
    push('模型', ins.model);
    push('Agent', ins.agent);
    push('模式', ins.mode);
    push('步骤', ins.steps ? String(ins.steps) : undefined);
    push('工具调用', ins.toolCount ? String(ins.toolCount) : undefined);
    // Jev 是子系统旁路调用（jev:call 独立统计），其 token 不计入下方 Token（主链路
    // provider 实测累计）——加「另计」徽标避免两笔账被混读。
    push('Jev 调用', ins.jevCalls, ins.jevCalls ? '另计' : undefined);
    push('Token', ins.costTokens);
    push('缓存命中率', ins.cacheHitRate);
    // cost=0 时区分「已定价的免费模型」与「未定价模型」，避免 UI 上 $0.0000 看起来像 bug。
    const costRaw = ins.costValue ?? '';
    const priced = ins.costPriced === 'true';
    const isZero =
      costRaw === '$0.0000' || costRaw === '$0.00' || costRaw === '$0';
    push(
      '成本',
      costRaw ? (isZero ? (priced ? '免费' : '未定价') : costRaw) : undefined
    );
    return stats;
  }

  /**
   * Token 拆解区的口径说明（两处标题共用）。
   * 必须如实描述实现：四项是本地启发式估算并按步累加，占比分母是四项之和；
   * 面板上的 Token 来自 provider 的 usage（实测），两者不是同一基准。
   */
  const BREAKDOWN_TIP =
    '四项为本地启发式估算（按字符/词折算，工具项含完整 JSON schema，图片按视觉 token），已跨步累加为整轮发送与产出的估算构成；占比分母是四项之和，与上方 Token（provider 实测累计）不是同一基准，概览用而非账单。';

  /** 「另计」徽标悬浮提示：旁路统计项（如 Jev）与面板 Token 主数值的关系。 */
  const EXTRA_BADGE_TIP =
    '该项为独立统计的旁路消耗（如 Jev 子系统直连调用），不计入上方 Token（主链路 provider 实测累计）';
</script>

<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from 'svelte';

  // 迁移后的子组件（原自定义元素副作用导入 → Svelte 组件）。
  import AhSwipeItem from './components/ah-swipe-item.svelte';
  import AhDrawer from './components/ah-drawer.svelte';
  import AhCommandSuggestions from './components/ah-command-suggestions.svelte';
  import AhComposerPlus from './components/composer-plus.svelte';
  import ModelPicker from './components/model-picker.svelte';
  import CtxRing from './chat-context-usage.svelte';

  /**
   * 面板契约：visible 由 App 壳控制显隐（常驻挂载，不用 {#if} 销毁，保留状态）。
   * role / deepThinkCollapsed 由 app-shell 透传（deepThinkCollapsed 保留原默认 true=收起）。
   */
  let {
    visible = true,
    role = '',
    deepThinkCollapsed = true
  }: { visible?: boolean; role?: string; deepThinkCollapsed?: boolean } =
    $props();

  /* ------------------------------ 状态 ------------------------------ */

  let sessions = $state<SessionView[]>([]);
  let activeId = $state('');

  /**
   * 会话列表「还有下一页」——驱动列表底部的加载更多 / 没有更多了提示。
   */
  let sessionsHasMore = $state(false);
  /** 正在拉取会话列表（首屏或下一页）；为 true 时列表底部显示加载中并防重入。 */
  let sessionsLoadingMore = $state(false);
  /** 拉取下一页失败（显示可点重试）；首屏失败走既有降级链路，不置此标志。 */
  let sessionsMoreError = $state(false);

  // ────────── 会话列表下拉刷新（移动端触屏手势）──────────
  /** 下拉刷新进行中（防重入 + 抑制手势）；非响应式，不触发渲染。 */
  let pullRefreshing = false;
  /** 手势起始触摸 Y（仅 scrollTop<=0 时记录）。 */
  let pullStartY = 0;
  /** 手势起始触摸 X（轴向守卫用：横滑会话行时让出给 ah-swipe-item）。 */
  let pullStartX = 0;
  /** 当前已下拉位移（px，含阻尼）；手势中直接操作 DOM，不触发渲染。 */
  let pullDist = 0;
  /** 是否处于「可下拉」手势中（手指压在顶部且向下拖）。 */
  let pullPulling = false;
  /** 下拉阻尼系数：可视位移 = 实际拖动 × 系数，越拉越「重」。 */
  const pullDamping = 0.5;
  /** 下拉可视位移上限（px），超过不再继续拉长。 */
  const pullMax = 88;
  /** 触发刷新的下拉阈值（px）。 */
  const pullThreshold = 60;

  /**
   * 历史会话内容加载中（骨架屏开关）。
   */
  let sessionLoading = $state(false);

  let messages = $state<ChatMsg[]>([]);
  let input = $state('');
  let model = $state('');
  let mode = $state<RunMode>('mock');

  /** 交互模式（P0）：qa=问答（直接回答）；plan=计划（先出计划→确认→逐任务执行）。 */
  let interactionMode = $state<'qa' | 'plan'>('qa');

  /** 计划执行状态（key 为携带计划的消息 id）。 */
  let planExec = $state<Record<number, PlanExecState>>({});
  /** 计划模式（P0）：澄清卡用户输入状态（key=消息 id：逐题点选/自定义 + 整体补充）。 */
  let clarifyDraft = $state<Record<number, ClarifyDraftState>>({});
  /** 计划模式（P0）：已确认过的澄清卡（key=消息 id），防止重复提交。 */
  let clarifyAnswered = $state<Record<number, boolean>>({});
  /** P3（多 agent DAG 计划执行）：当前正在跑的 plan workflow 中止句柄（非渲染态，非响应式）。 */
  let planWfAbort: AbortController | null = null;
  let deepThink = $state(true);
  let web = $state(true);

  /** 每条助手消息的深度思考折叠态（key 为 message id），用于手动收起思考区。 */
  let thinkCollapsed = $state<Record<string, boolean>>({});

  /**
   * 富文本块（超长代码块 / 表格）的折叠态覆盖表，key 为 `${scope}/${blockKey}`。
   * 缺省（key 不存在）= 可折叠块默认折叠，见 applyFolds。
   */
  let mdFolded = $state<Record<string, boolean>>({});

  /** 移动端侧栏抽屉开合态（≤900px 生效）。 */
  let sidebarOpen = $state(false);
  /** PC 端侧栏折叠态（默认展开）。 */
  let sidebarCollapsed = $state(false);

  /** 可选的定向业务 agent：为空则走默认通用 Agent。 */
  let agents = $state<{ id: string; name: string; domain?: string }[]>([]);
  let agentId = $state('');

  /** 待发送附件（本地预览用，不在 server 上传时以 DataURL 嵌入消息）。 */
  let attachments = $state<UploadedFile[]>([]);

  /**
   * 附件预览条是否处于展开态。
   * 折叠时最多渲染 ATTACH_COLLAPSE_LIMIT 条，余量收进「+N」按钮。
   */
  let attachmentsExpanded = $state(false);

  /**
   * 是否有文件正被拖到整个 chat 区域上方（驱动整屏拖拽遮罩）。
   */
  let dragActive = $state(false);

  /**
   * 拖拽进入/离开的嵌套计数（非响应式）。
   * 只有计数归零才判定为「真正离开组件」。
   */
  let dragDepth = 0;

  /** 当前全屏预览的附件；null 表示未打开预览。 */
  let previewFile = $state<UploadedFile | null>(null);

  /**
   * 长按用户消息的编辑输入框（edit-input）弹出的全屏编辑器是否打开。
   */
  let fullscreenEditOpen = $state(false);

  /**
   * 调用链路 / 关键信息 抽屉：当前正在查看的消息（存引用以便流式过程中内容实时刷新）；
   * null 表示抽屉关闭。
   */
  let traceDrawerMsg = $state<ChatMsg | null>(null);
  let traceDrawerSection = $state<'trace' | 'insights' | 'confidence'>('trace');

  /** P2（轨迹回放）：计划「执行详情」抽屉瞬态。 */
  let planWfReplayMsg = $state<ChatMsg | null>(null);
  let planWfReplay = $state<Record<number, PlanWfReplayState>>({});
  /**
   * P5.1 同步修复：抽屉打开期间的轮询定时器。null = 未在轮询。
   */
  let planWfReplayTimer: number | null = null;

  /**
   * P5.4 断连自愈轮询：为每个计划消息维护一个 2.5s 轮询定时器，读取检查点
   * （GET /api/workflows/:id）把卡片收敛到权威终态。键 = 计划卡片消息 id。
   */
  let planWfReconcileTimers: Record<string, number> = {};

  /**
   * P5.4 当前活动计划 run 的检查点 id。「停止」按钮据此调用
   * POST /api/workflows/:id/cancel 显式取消服务端 run。
   */
  let planWfActiveId: string | null = null;

  /** 悬停显示操作按钮的用户消息 id（复制 / 编辑）；-1 表示无。 */
  let hoverUserMsgId = $state(-1);

  /** Slash Command 框架注册标记（防重复注册）。 */
  let _commandsRegistered = false;

  /**
   * 已「胶囊化」的 slash 命令名（不含前导 `/`）；空串表示普通输入态。
   */
  let cmdName = $state('');

  /** 主输入框（用于选中命令 / 移除胶囊后回收焦点并重算高度）。 */
  let inputEl: HTMLTextAreaElement | null = null;

  /** 命令联想组件（用于把输入框的键盘事件转发给它处理）。 */
  let suggestEl: { handleKey?: (e: KeyboardEvent) => boolean } | null = null;

  /** 正在编辑的用户消息 id；-1 表示不在编辑态。 */
  let editingMsgId = $state(-1);

  /** 编辑中的草稿文本。 */
  let editingDraft = $state('');

  /** 进入编辑态时原始消息内容，用于判断用户是否做过实质改动（渲染消费，需响应式）。 */
  let editingOriginalContent = $state('');

  /** 最近一次复制成功的消息 id + 时间戳：按钮短暂变为「已复制 ✓」。 */
  let copiedMsgId = $state(-1);

  /** 复制回执定时器。 */
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  /** 上传中的文件追踪（key 为文件名+时间戳） */
  const uploadingFiles: Map<
    string,
    { status: 'uploading' | 'done' | 'error'; error?: string }
  > = new Map();

  /** 附件管线的状态桥：模块级核心函数经此读写组件 $state。 */
  const attachBridge: AttachState = {
    get attachments() {
      return attachments;
    },
    set attachments(v) {
      attachments = v;
    },
    uploadingFiles
  };

  let nextId = 1;

  /**
   * 运行控制器 requestUpdate 的响应式版本号：runRt / typewriter 调 requestUpdate
   * 时自增，消费 runRt.jobMap / stoppedMap 的模板处经 jobFor/stoppedFor 读取该值建立依赖。
   */
  let rtVersion = $state(0);

  /* ── 滚动跟随（原 ChatScroll 控制器逻辑内联，host 契约改为 bind:this + $state） ── */

  /** 消息区滚动容器。 */
  let scrollEl: HTMLElement | null = null;
  /** 是否处于「钉底」跟随状态：true 时新消息/更新自动滚到底部。 */
  let stickToBottom = $state(true);
  /** 浮动「回到底部」按钮是否可见（未钉底时显示）。 */
  let showScrollDown = $state(false);
  /** 距底阈值（px）：容忍亚像素/轻微回弹，认为已到底部则隐藏按钮、恢复跟随。 */
  const AT_BOTTOM_THRESHOLD = 24;

  /** 仅当处于钉底状态才把消息区滚到底部（渲染后调用，不触发状态变更）。 */
  function scrollToBottom() {
    const el = scrollEl;
    if (el && stickToBottom) el.scrollTop = el.scrollHeight;
  }

  /** 消息区滚动监听：计算距底距离，更新钉底状态与浮动按钮显隐。 */
  function onScrollFollow() {
    const el = scrollEl;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= AT_BOTTOM_THRESHOLD;
    stickToBottom = atBottom;
    showScrollDown = !atBottom;
  }

  /** 切到钉底并隐藏浮动按钮（新会话 / 切换会话 / 发送新消息时调用）。 */
  function resetToBottom() {
    stickToBottom = true;
    showScrollDown = false;
  }

  /** 点击浮动按钮：平滑滚回底部并重新开启钉底跟随。 */
  function scrollToBottomSmooth() {
    const el = scrollEl;
    if (!el) return;
    stickToBottom = true;
    showScrollDown = false;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  /**
   * 深度思考区流式（打字机）输出时，若内容已撑满上限，将视口钉在底部。
   * 仅当用户没有主动向上滚动（dataset.thinkStick）时才钉底。
   */
  function scrollThinkToBottom() {
    requestAnimationFrame(() => {
      const root = rootEl;
      if (!root) return;
      const targets = [
        root.querySelector('.think.live .think-body') as HTMLElement | null,
        root.querySelector('.plan-thinking .pt-think-body') as HTMLElement | null
      ].filter((x): x is HTMLElement => !!x && !x.closest('.think.collapsed'));
      for (const tb of targets) {
        bindThinkScroll(tb);
        if (tb.dataset.thinkStick !== '0') tb.scrollTop = tb.scrollHeight;
      }
    });
  }

  /**
   * 用户手动展开某个思考区后调用：把该思考区正文滚到底部，
   * 对齐 live 流式时的「钉底」视角。
   */
  function scrollThinkBlockToBottom(msgId: string) {
    requestAnimationFrame(() => {
      const root = rootEl;
      if (!root) return;
      const tb = root.querySelector(
        `.think[data-mid="${msgId}"] .think-body`
      ) as HTMLElement | null;
      if (!tb || tb.closest('.think.collapsed')) return;
      tb.dataset.thinkStick = '1';
      tb.scrollTop = tb.scrollHeight;
      setTimeout(() => {
        if (tb.isConnected && !tb.closest('.think.collapsed'))
          tb.scrollTop = tb.scrollHeight;
      }, 300);
    });
  }

  /** 给思考区正文绑 scroll 监听（每次重渲染 DOM 重建，按需重绑）。 */
  function bindThinkScroll(tb: HTMLElement) {
    if (tb.dataset.thinkScrollBound === '1') return;
    tb.dataset.thinkScrollBound = '1';
    tb.dataset.thinkStick = '1';
    tb.addEventListener('scroll', () => {
      const distance = tb.scrollHeight - tb.scrollTop - tb.clientHeight;
      tb.dataset.thinkStick = distance <= AT_BOTTOM_THRESHOLD ? '1' : '0';
    });
  }

  /* ── DOM 引用（原 @query / renderRoot.querySelector → bind:this） ── */

  /** 组件根元素（applyFolds / 思考区钉底查询用）。 */
  let rootEl: HTMLElement | null = null;
  /** 会话列表滚动容器（「是否已撑出滚动条」判定与滚动监听）。 */
  let sessionListEl: HTMLElement | null = null;
  /** 会话列表内容包裹层（下拉时整体下移，呈现橡皮筋效果）。 */
  let sessionInnerEl: HTMLElement | null = null;
  /** 顶部下拉刷新指示器。 */
  let pullIndicatorEl: HTMLElement | null = null;
  /** 下拉刷新指示器文案。 */
  let pullHintEl: HTMLElement | null = null;
  /** 全屏编辑器输入框。 */
  let feInputEl: HTMLTextAreaElement | null = null;
  /** 气泡内编辑输入框（编辑态渲染，退出编辑后为 undefined）。 */
  let editInputEl: HTMLTextAreaElement | null = null;

  /**
   * P5 静默计划执行（串行回退路径）：quiet run 进行中的思考面板 sink（携带计划的消息 id）。
   */
  let quietPlanSink: { msgId: number } | null = null;

  /** 侧栏打开瞬间标记：防止打开后立即被 scrim 点击关闭。 */
  let _sidebarJustOpened = false;

  /** 当前选中模型的上下文窗口上限（token）。0 = 无数据（圆环据此隐藏）。 */
  let serverCtxWindow = $state(0);

  /** 当前选中模型的 baseUrl；空串表示使用服务端默认配置。 */
  let modelBaseUrl = '';

  /** 是否展开「上下文用量」弹层。 */
  let showCtxUsage = $state(false);

  /**
   * 后端经 SSE `llm:usage` 下发的精确上下文用量（provider usage 为权威总量）。
   * 窗口占用口径只计「输入」(promptTokens)，不含模型当轮输出。
   */
  let backendUsage = $state<{
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
  } | null>(null);

  /** 本运行累计 token 消耗（来自 run:cost 事件的 cumulativeTokens，所有 step 之和）。 */
  let runCumulative = $state<{ tokens: number; cost: number } | null>(null);

  /**
   * 每个会话独立的流式缓冲。切换会话时，进行中的 run 仍向所属会话的缓冲写入，
   * 切回时实时恢复 —— 这是「切换会话不中断对话」的核心。
   */
  const threads: Record<string, ChatMsg[]> = {};

  /**
   * 会话恢复失败标记（容错持久化）：服务端历史拉取失败且无本地镜像时置 true，
   * 空线程不再被当作「已加载」缓存 —— 下次进入该会话自动重试恢复，直到成功。
   */
  const restoreFailed: Record<string, boolean> = {};

  /**
   * 会话切换请求序号（非响应式）。
   * 每次 selectSession 自增并快照，异步拉取结束后比对：只有「最新一次切换」才允许
   * 回写 this.messages / 滚动位置 / 用量快照，并负责关闭骨架屏标志。
   */
  let sessionLoadSeq = 0;

  /**
   * 外部入口（工作台「最近会话」）请求打开的会话 id 缓存。
   * 事件到达时若本面板仍处隐藏态，先暂存于此，待 refresh() 执行到末尾时消费。
   */
  let pendingSelectId = '';

  /**
   * 会话列表分页游标（非响应式）。
   * offset / hasMore / serverIds 三者必须同步推进，故打包成一个状态对象整体替换。
   */
  let sessionPage: SessionPageCursor = initialSessionPageCursor();

  /**
   * 首屏重载请求序号（非响应式）。
   */
  let sessionsReloadSeq = 0;

  /**
   * 「填充视口」补拉的重入保护（非响应式）。
   */
  let sessionAutoFillBusy = false;

  /** 每个会话当前正在流式的 assistant 消息下标（send 时写入，run 结束后保留，供切回识别）。 */
  let streamIdx = $state<Record<string, number>>({});

  /**
   * 按会话持久化的设置（交互模式 / 模型 / agent）。
   */
  const sessionSettings: Record<
    string,
    {
      interactionMode?: 'qa' | 'plan';
      model?: string;
      agentId?: string;
    }
  > = {};

  /**
   * 跨设备远程流式游标：标记某会话「他端发来的进行中 assistant」是否已在本地线程建了占位。
   */
  const remoteStreaming: Record<string, boolean> = {};

  /** 每会话是否正在流式（支持多个会话并发进行）。以不可变重赋值更新。 */
  let streaming = $state<Record<string, boolean>>({});

  /** 不可变更新某会话的流式状态。 */
  function setStreaming(sid: string, val: boolean) {
    streaming = { ...streaming, [sid]: val };
    // 全局运行中指示器：任意会话在流式时亮起，全部结束后熄灭。
    const any = Object.values(streaming).some(Boolean);
    window.dispatchEvent(new Event(any ? APP_EVENTS.runStart : APP_EVENTS.runStop));
  }

  /** 每会话的调用链路追踪构建上下文。 */
  const traces: Record<string, TraceCtx> = {};

  let connState = $state<
    Record<string, 'connected' | 'reconnecting' | 'lost'>
  >({});

  /** 当前登录用户是否已配置可用 LLM Key（per-user，来自 /api/state.llm.ready）。 */
  let llmReady = $state(false);
  /** 历史镜像体积上限（字节），来自 /api/state.historyMaxBytes；用于保存前主动裁剪。 */
  let historyMaxBytes = 512 * 1024;

  /** 不可变更新某会话的连接状态。 */
  function setConn(sid: string, val: 'connected' | 'reconnecting' | 'lost') {
    connState = { ...connState, [sid]: val };
  }

  /** 当前是否仍有任何会话在流式（用于打字机定时器的停启判定）。 */
  function anyStreaming(): boolean {
    for (const k in streaming) if (streaming[k]) return true;
    return false;
  }

  /** 消费 runRt 内部 job 表（经 rtVersion 建立模板依赖）。 */
  function jobFor(sid: string): string | undefined {
    void rtVersion;
    return runRt.jobMap[sid];
  }

  /** 消费 runRt 内部停止标记表（经 rtVersion 建立模板依赖）。 */
  function stoppedFor(sid: string): boolean {
    void rtVersion;
    return runRt.stoppedMap[sid] === true;
  }

  /** 取（或惰性创建）某会话的消息缓冲。 */
  function threadFor(sid: string): ChatMsg[] {
    return threads[sid] ?? (threads[sid] = []);
  }

  /**
   * 把某会话当前消息缓冲经接口层写入历史镜像（容错持久化，服务端 SQLite 存储）。
   */
  function saveHistory(sid: string) {
    persistHistory({
      sid,
      threads,
      sessions,
      backendUsage,
      runCumulative,
      historyMaxBytes,
      // 计划进度写穿：本端是「计划整体完成」的唯一知情方（见 PersistHistoryOpts.planExec）。
      planExec
    });
  }

  /** 取某会话当前流式消息。 */
  function curSession(sid: string): ChatMsg | null {
    const idx = streamIdx[sid];
    if (typeof idx !== 'number') return null;
    const t = threads[sid];
    const m = t ? t[idx] : undefined;
    return m ? m : null;
  }

  /**
   * 取「截至当前」的会话消息快照，用于调用链路 LLM 节点的「消息上下文」回看。
   */
  function snapshotTraceMessages(sid: string): ChatMessage[] {
    const t = threads[sid];
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
  function refreshLlmTraceMessages(sid: string, tc: TraceCtx) {
    if (!tc.llm) return;
    const snap = snapshotTraceMessages(sid);
    tc.llm.messages = snap;
    if (tc.llm.meta) {
      tc.llm.meta = { ...tc.llm.meta, messages: `消息 ${snap.length || '?'}` };
    }
  }

  /**
   * 用当前线程完整内容重建某会话追踪树中所有 LLM 节点的 messages 上下文。
   */
  function rebuildTraceMessages(sid: string) {
    const tc = traces[sid];
    if (!tc?.root) return;
    const t = threads[sid];
    if (!t?.length) return;
    const fullMsgs = snapshotTraceMessages(sid);
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
   */
  function restoreTraceMessages(sid: string) {
    const t = threads[sid];
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

  /** 写入某会话的流式消息（streamIdx 指向的那条），并在该会话为当前显示会话时同步 messages。 */
  function patchSession(sid: string, p: Partial<ChatMsg>) {
    const idx = streamIdx[sid];
    if (idx == null || idx < 0) return;
    const t = threads[sid];
    if (!t || !t[idx]) return;
    const nt = t.slice();
    const cur = nt[idx];
    if (cur) nt[idx] = { ...cur, ...p };
    threads[sid] = nt;
    if (sid === activeId) messages = nt;
    // 流式消息已写入会话缓冲：同步刷新调用链路 LLM 节点的「消息上下文」快照。
    const tc = traces[sid];
    if (tc && tc.llm) refreshLlmTraceMessages(sid, tc);
  }

  /** 重置某会话的调用链路追踪瞬态状态（防御上轮残留泄漏到本轮）。 */
  function resetTrace(sid: string) {
    traces[sid] = {
      root: null,
      parent: null,
      llm: null,
      lastTool: null,
      toolByCallId: {},
      seq: 0
    };
  }
  function traceCtx(sid: string): TraceCtx {
    return (
      traces[sid] ??
      (traces[sid] = {
        root: null,
        parent: null,
        llm: null,
        lastTool: null,
        toolByCallId: {},
        seq: 0
      })
    );
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  onMount(() => {
    // Slash Command 框架：注册内置命令
    if (!_commandsRegistered) {
      registerBuiltinCommands(_makeCommandContext());
      _commandsRegistered = true;
    }
    window.addEventListener('keydown', onPreviewKeydown);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    // 恢复上次选择的交互模式（问答/计划），跨刷新记忆。
    try {
      const saved = localStorage.getItem('ah_interaction_mode');
      if (saved === 'plan' || saved === 'qa') interactionMode = saved;
    } catch {
      /* ignore */
    }
    // 恢复上次的模型选择与深度思考/联网开关，跨刷新记忆。
    try {
      const m = localStorage.getItem('ah_model');
      if (m !== null) model = m;
      // 深度思考默认开启：不再从 localStorage 恢复关闭态。
      deepThink = true;
      const w = localStorage.getItem('ah_web');
      if (w !== null) web = w === '1';
    } catch {
      /* ignore */
    }
    // 断线恢复：切回标签页时立即体检所有流式会话。
    document.addEventListener('visibilitychange', runRt.onVisibilityChange);
    // 静默看门狗：可见状态下流式会话超过 60s 无任何事件，强制中止走统一重连。
    runRt.startWatchdog();

    // 首屏数据加载；隐藏态挂载时跳过请求，切到对话 Tab 时由 App 调本方法补拉。
    void refresh();

    // 插件启用/停用会改变已注册 agent 集合，监听后实时刷新下拉。
    window.addEventListener('ah-plugins-changed', onPluginsChanged);

    // 工作台/全局入口请求打开指定会话：直接选中并加载消息（window 级兼容监听）。
    window.addEventListener(APP_EVENTS.selectSession, onSelectSession as EventListener);

    // 路由变化（Tab 切换 / 浏览器后退前进）时收起对话页内的浮层。
    window.addEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);

    // 跨刷新恢复上次会话。
    try {
      const saved = localStorage.getItem('ah_active_id');
      if (saved) void selectSessionImpl(saved);
    } catch {
      /* ignore */
    }

    // 跨设备实时同步：登录后建立常驻 SSE。
    if (getUsername()) {
      window.addEventListener(APP_EVENTS.chatSync, onChatSync as EventListener);
      startChatSync(getUsername());
    }
  });

  onDestroy(() => {
    window.removeEventListener('keydown', onPreviewKeydown);
    window.removeEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('visibilitychange', runRt.onVisibilityChange);

    // 跨设备实时同步：组件卸载时停掉常驻 SSE 并移除事件监听。
    window.removeEventListener(APP_EVENTS.chatSync, onChatSync as EventListener);
    stopChatSync();
    runRt.stopWatchdog();
    cancelComposerLongPress();
    window.removeEventListener('ah-plugins-changed', onPluginsChanged);
    window.removeEventListener(APP_EVENTS.selectSession, onSelectSession as EventListener);
  });

  /**
   * 首屏数据加载：会话列表首屏、服务端状态（LLM 就绪 / 模式）、agent 列表。
   * 顶部 `if (!visible) return;` 守卫：隐藏态（非对话 Tab）时不发起请求；
   * 切到对话 Tab 时由 App 调用本方法补拉。
   */
  export async function refresh(): Promise<void> {
    if (!visible) return;
    await reloadSessions(true);
    try {
      const state = await client.getState();
      // per-user 真实 LLM 就绪：优先 llm.ready（BYOK），回退旧字段 openrouter。
      const st = state as
        | { llm?: { ready?: boolean }; openrouter?: unknown; historyMaxBytes?: number }
        | null;
      llmReady = !!st?.llm?.ready || !!st?.openrouter;
      mode = llmReady ? 'real' : 'mock';
      historyMaxBytes =
        typeof st?.historyMaxBytes === 'number'
          ? st.historyMaxBytes
          : historyMaxBytes;
    } catch {
      /* 离线/未启动：发送时按 mock 兜底 */
    }
    await refreshAgents();
    // 面板转可见后，消费此前因隐藏态没能立即执行的「打开指定会话」请求。
    consumePendingSelect();
  }

  /**
   * 外部入口（工作台「最近会话」等）请求打开指定会话 —— App 经 bind:this 调用；
   * window 事件监听（onSelectSession）作为兼容路径保留。
   */
  export function selectSession(id: string): Promise<void> {
    return selectSessionImpl(id);
  }

  /**
   * 消费 chat-sync.ts 经 window CustomEvent 派发的跨设备同步事件。
   */
  const onChatSync = (ev: Event) => {
    const e = (ev as CustomEvent<ChatSyncEvent>).detail;
    if (!e || typeof e !== 'object') return;
    switch (e.type) {
      case 'session:list':
        // 新建/批量变更：重拉列表首屏（带超时容错 + 分页游标复位）。
        void reloadSessions(false);
        break;
      case 'session:meta':
        // 标题/时间/按会话设置变更：原地更新列表项，无需重拉全量。
        patchSessionMeta(e.session, e.title, e.updatedAt, {
          interactionMode: e.interactionMode,
          model: e.model,
          agentId: e.agentId
        });
        break;
      case 'session:remove':
        removeSessionFromList(e.session);
        break;
      case 'message:append':
        // 他端写入的增量消息（含进行中流式快照）：按 origin 忽略本端回声，其余去重后合并。
        appendRemoteMessage(e.session, e.message, e.origin);
        break;
      default:
        break;
    }
  };

  /**
   * 外部入口（工作台「最近会话」等）经 window 事件请求打开指定会话（兼容路径）。
   */
  const onSelectSession = (ev: Event) => {
    const id = (ev as CustomEvent<string>).detail;
    if (typeof id !== 'string' || !id) return;
    if (!visible) {
      pendingSelectId = id;
      return;
    }
    void selectSessionImpl(id);
  };

  /** 消费隐藏态缓存的会话选择请求（面板转可见后调用）。 */
  function consumePendingSelect(): void {
    const id = pendingSelectId;
    if (!id || !visible) return;
    pendingSelectId = '';
    void selectSessionImpl(id);
  }

  /**
   * 重载会话列表首屏（offset 归零）。
   *
   * 列表被组织为**两段式**：前段恒为服务端条目、尾部恒为镜像兜底补项。
   * 这个布局是 mergeSessionPage 计算插入位置的前提，改动前请先读 chat-session-page.ts。
   *
   * @param notifyOnError 首屏失败是否弹提示。首次进入要提示；
   *   SSE 触发的后台重载沉默失败即可（下一次列表交互会自动重试）。
   */
  async function reloadSessions(notifyOnError: boolean): Promise<void> {
    // 本次重载的请求序号：只有最新一次允许把结果写回 sessions。
    const seq = ++sessionsReloadSeq;
    // 首屏重载使既有分页游标失效：先复位。
    sessionPage = initialSessionPageCursor();
    sessionsHasMore = false;
    sessionsMoreError = false;

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
    if (seq !== sessionsReloadSeq) return;

    if (!page && notifyOnError) {
      notifyError(lastErr, {
        title: '会话列表',
        fallback: '会话列表加载失败，已降级为本地缓存（可能不完整）',
        key: 'chat-sessions'
      });
    }

    if (page) {
      sessions = page.sessions;
      sessionPage = {
        offset: page.sessions.length,
        hasMore: page.hasMore,
        serverIds: new Set(page.sessions.map((s) => s.id))
      };
      sessionsHasMore = page.hasMore;
      await appendMirrorExtras();
      await tick();
      void autoFillSessionList();
      return;
    }

    // 服务端不可达：整表退回本地镜像索引（无分页语义，hasMore 恒 false）。
    const idx = await loadIndex();
    if (seq !== sessionsReloadSeq) return;
    sessions = Object.entries(idx).map(([sid, m]) =>
      mirrorMetaToSessionView(sid, m)
    );
    sessionPage = initialSessionPageCursor();
    sessionsHasMore = false;
  }

  /**
   * 用历史镜像索引补齐列表尾部（服务端列表为空 / 缺项时历史会话仍可见）。
   */
  async function appendMirrorExtras(): Promise<void> {
    const known = new Set(sessions.map((s) => s.id));
    const idx = await loadIndex();
    const extra = Object.entries(idx)
      .filter(([sid]) => !known.has(sid))
      .map(([sid, m]) => mirrorMetaToSessionView(sid, m));
    if (extra.length) sessions = [...sessions, ...extra];
  }

  /**
   * 加载下一页会话（滚动加载的增量入口）。
   * 四重短路：没有下一页 / 正在加载 / 上次失败待重试 —— 直接返回。
   */
  async function loadMoreSessions(): Promise<void> {
    if (!sessionsHasMore) return;
    if (sessionsLoadingMore) return;
    // 失败后暂停自动预取，避免请求风暴；用户点「点击重试」会清掉该标志。
    if (sessionsMoreError) return;
    sessionsLoadingMore = true;
    // 快照当前游标对象：期间若发生首屏重载，sessionPage 会被整体替换。
    const cursor = sessionPage;
    try {
      const offset = cursor.offset;
      const r = await withTimeout(
        client.listChatSessionsPage({ limit: SESSION_PAGE_SIZE, offset }),
        6000,
        '加载更多会话'
      );
      if (sessionPage === cursor) {
        const page = r.sessions.map(toSessionView);
        const merged = mergeSessionPage(sessions, page, cursor.serverIds);
        sessions = merged.list;
        // 游标按「服务端已消费条数」推进，而非实际插入条数。
        sessionPage = {
          offset: offset + page.length,
          // 服务端称还有下一页、却返回空页时按「没有更多」处理，防御性避免空转。
          hasMore: r.hasMore && page.length > 0,
          serverIds: new Set([...cursor.serverIds, ...merged.insertedIds])
        };
        sessionsHasMore = sessionPage.hasMore;
        sessionsMoreError = false;
      }
      // else：游标已被整体替换（首屏重载介入）→ 本次结果作废，不写回任何状态。
    } catch {
      // 失败不清空已有内容，仅置错误态交给用户手动重试。
      sessionsMoreError = true;
    } finally {
      sessionsLoadingMore = false;
    }
    // 收尾统一补一次「填充视口」检查。
    void autoFillSessionList();
  }

  /** 会话列表滚动：进入底部预取阈值即拉下一页。 */
  function onSessionListScroll(e: Event) {
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (!shouldPrefetchSessions(distance)) return;
    void loadMoreSessions();
  }

  // ────────── 下拉刷新手势（仅触屏、仅在列表顶部向下拖）──────────
  function onSessionListTouchStart(e: TouchEvent) {
    const el = e.currentTarget as HTMLElement | null;
    // 折叠态（64px 图标轨）没有可下拉的会话列表，跳过手势。
    if (!el || pullRefreshing || sidebarCollapsed) return;
    // 仅当列表已滚到顶时才允许下拉，避免与正常上滑滚动冲突。
    if (el.scrollTop > 0) {
      pullPulling = false;
      return;
    }
    pullPulling = true;
    const t0 = e.touches[0];
    if (!t0) return;
    pullStartX = t0.clientX;
    pullStartY = t0.clientY;
    pullDist = 0;
  }

  function onSessionListTouchMove(e: TouchEvent) {
    if (!pullPulling || pullRefreshing) return;
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return;
    const t0 = e.touches[0];
    if (!t0) return;
    // 轴向守卫：横向位移明显占优时是「会话行滑动操作」，撤销下拉态。
    if (Math.abs(t0.clientX - pullStartX) > 12) {
      if (pullDist !== 0) applyPullTransform(0);
      pullPulling = false;
      return;
    }
    const delta = t0.clientY - pullStartY;
    // 手指上移（正常向下滚动内容）或已离开顶部：取消下拉，交回原生滚动。
    if (delta <= 0 || el.scrollTop > 0) {
      if (pullDist !== 0) applyPullTransform(0);
      pullPulling = el.scrollTop <= 0 && delta > 0;
      return;
    }
    // 顶部向下拖：阻止原生回弹，呈现自定义阻尼下拉。
    e.preventDefault();
    const dist = Math.min(delta * pullDamping, pullMax);
    applyPullTransform(dist);
  }

  function onSessionListTouchEnd() {
    if (!pullPulling || pullRefreshing) {
      pullPulling = false;
      return;
    }
    pullPulling = false;
    if (pullDist >= pullThreshold) {
      void triggerPullRefresh();
    } else {
      applyPullTransform(0, true);
    }
  }

  /**
   * 把下拉位移同步到 DOM（内容下移 + 顶部指示器滑入）。
   * 直接操作 inline style，不触发重渲染，保证拖动手感顺滑。
   * @param animate 松手/收起时补一段回弹过渡。
   */
  function applyPullTransform(dist: number, animate = false) {
    pullDist = dist;
    const inner = sessionInnerEl;
    const ind = pullIndicatorEl;
    const hint = pullHintEl;
    const t = animate ? 'transform 0.25s ease' : 'none';
    if (inner) {
      inner.style.transition = t;
      inner.style.transform = dist > 0 ? `translateY(${dist}px)` : '';
    }
    if (ind) {
      ind.style.transition = t;
      ind.style.opacity = dist > 0 || pullRefreshing ? '1' : '0';
      ind.style.transform = `translateY(${
        Math.min(dist, pullMax) - 48
      }px)`;
      ind.classList.toggle(
        'armed',
        dist >= pullThreshold && !pullRefreshing
      );
    }
    if (hint)
      hint.textContent = dist >= pullThreshold ? '松开刷新' : '下拉刷新';
  }

  /** 触发下拉刷新：重拉首屏会话列表（显式用户操作，失败弹提示）。 */
  async function triggerPullRefresh() {
    pullRefreshing = true;
    const inner = sessionInnerEl;
    const ind = pullIndicatorEl;
    const hint = pullHintEl;
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
      await reloadSessions(true);
    } finally {
      pullRefreshing = false;
      pullDist = 0;
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
   * 「填充视口」补拉：首屏一页不足以撑出滚动条时，scroll 事件永远不会被触发 ——
   * 这里主动续拉，直到出现滚动条、没有更多或出错。
   * 上限 5 轮纯属死循环防御；sessionAutoFillBusy 串行化。
   */
  async function autoFillSessionList(): Promise<void> {
    if (sessionAutoFillBusy) return;
    sessionAutoFillBusy = true;
    try {
      for (let i = 0; i < 5; i++) {
        if (!sessionsHasMore || sessionsMoreError) return;
        // 有请求在飞：不空转，交给它的收尾再触发一轮。
        if (sessionsLoadingMore) return;
        const el = sessionListEl;
        if (!el) return;
        // 已可滚动 → 交回 scroll 事件驱动，不再主动填充。
        if (el.scrollHeight - el.clientHeight > 4) return;
        await loadMoreSessions();
        await tick();
      }
    } finally {
      sessionAutoFillBusy = false;
    }
  }

  /**
   * 重拉 agent 列表（写入 agents）。
   * 后端默认 agent 的 id 为 'default'（非空串）归一到 ''，保证选中态能命中。
   * 失败不影响聊天：selector 退化为仅「默认 Agent」。
   */
  async function refreshAgents() {
    try {
      const res = await client.listAgents();
      const raw = (res?.agents ?? []).map((a) => ({
        id: String(a.id),
        name: String(a.name ?? a.id),
        domain: String(a.domain ?? '')
      }));
      const hasDefault = raw.some((a) => a.id === 'default' || a.id === '');
      // viewer 角色：从列表中彻底过滤掉医美运营分析相关的 agent。
      const isViewer = role === 'viewer';
      const filtered = isViewer
        ? raw.filter((a) => a.domain !== 'medical-aesthetics')
        : raw;
      const next = hasDefault
        ? filtered.map((a) => (a.id === 'default' ? { ...a, id: '' } : a))
        : [{ id: '', name: '默认' }, ...filtered];
      agents = next;
      // 当前选中的 agent 若已随插件禁用而从注册表消失，回退到「默认」。
      if (agentId && !next.some((a) => a.id === agentId)) {
        agentId = '';
      }
      // 若当前选中的 agent 被过滤掉，自动回退到「默认」。
      if (agentId && isViewer) {
        const selected = next.find((a) => a.id === agentId);
        if (!selected) {
          agentId = '';
        }
      }
    } catch (e) {
      notifyError(e, {
        title: 'Agent 列表',
        fallback: 'Agent 列表拉取失败，已回退为「默认 Agent」',
        key: 'chat-agents'
      });
    }
  }

  /**
   * 插件启用/停用后，已注册 agent 集合变化，实时重拉下拉。
   */
  const onPluginsChanged = () => {
    void refreshAgents();
  };

  /** 跨设备：原地更新列表中某会话的标题与时间（不重排，仅刷字段）。 */
  function patchSessionMeta(
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
    sessions = sessions.map((s) => {
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
      sessions = [
        ...sessions,
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
    if (activeId === sid) {
      if (meta?.interactionMode !== undefined)
        interactionMode = meta.interactionMode;
      if (meta?.model !== undefined) model = meta.model;
      if (meta?.agentId !== undefined) agentId = meta.agentId;
    }
  }

  /** 跨设备：从列表中移除被他端删除的会话；若正打开则回退到空。 */
  function removeSessionFromList(sid: string) {
    sessions = sessions.filter((s) => s.id !== sid);
    // 维护分页不变量：被删的若是一条已消费的服务端条目，offset 同步减 1。
    if (sessionPage.serverIds.has(sid)) {
      const serverIds = new Set(sessionPage.serverIds);
      serverIds.delete(sid);
      sessionPage = {
        offset: Math.max(0, sessionPage.offset - 1),
        hasMore: sessionPage.hasMore,
        serverIds
      };
    }
    if (activeId === sid) {
      activeId = '';
      // 作废仍在飞行中的该会话切换请求。
      sessionLoadSeq++;
      sessionLoading = false;
      messages = [];
      try {
        localStorage.removeItem('ah_active_id');
      } catch {
        /* ignore */
      }
    }
    // 同时清理本地线程缓冲与镜像，避免残留。
    delete threads[sid];
    void purgeSessionMirror(sid).catch(() => {});
  }

  /**
   * 跨设备：把他端追加的消息写入对应会话线程。
   */
  function appendRemoteMessage(sid: string, raw: unknown, origin?: string) {
    if (!raw || typeof raw !== 'object') return;
    // 本端回声：发送端自己的 /api/chat/stream 也会收到 chat-bus 的 fanout，凭 origin 丢弃。
    if (origin && origin === MY_ORIGIN) return;
    const m = raw as Partial<ChatMessage> & {
      role?: string;
      content?: string;
      reasoning?: string;
      streaming?: boolean;
      final?: boolean;
    };
    const roleLocal: 'user' | 'assistant' = m.role === 'user' ? 'user' : 'assistant';
    const content = typeof m.content === 'string' ? m.content : '';
    const traceVal =
      Array.isArray(m.trace) && m.trace.length
        ? (m.trace as TraceNode[])
        : undefined;
    // 已结束/从存储恢复的消息（streaming !== true）做兜底收尾。
    const traceFinal =
      traceVal && m.streaming !== true
        ? normalizeStoredTrace(traceVal)
        : traceVal;
    const t = threadFor(sid);

    if (roleLocal === 'user') {
      // 去重：沿线程末尾回扫，若最近一条 user 消息内容完全相同则跳过。
      for (let i = t.length - 1; i >= 0; i--) {
        const c = t[i];
        if (!c || c.role !== 'user') continue;
        if ((c.content ?? '') === content && content.length > 0) return; // 重复，跳过
        break; // 只看最近一条 user，避免把「隔轮重发同文本」误判为重复
      }
      t.push({
        id: nextId++,
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
      threads[sid] = t;
      patchSessionMeta(
        sid,
        sessions.find((s) => s.id === sid)?.title ?? '',
        typeof m.ts === 'number' ? m.ts : Date.now()
      );
      if (activeId === sid) messages = t;
      return;
    }

    // assistant：用 remoteStreaming[sid] 游标区分「首帧 / 新一轮」与「后续 streaming 帧」。
    if (!remoteStreaming[sid]) {
      // 新一轮远程回复：追加新 assistant 占位，并置游标。
      const msg: ChatMsg = {
        id: nextId++,
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
      remoteStreaming[sid] = true;
    } else {
      const idx = t.length - 1;
      const cur = t[idx];
      if (!cur || cur.role !== 'assistant') {
        // 防御：游标为真却末尾非 assistant（理论上不会），补建并修正。
        const msg: ChatMsg = {
          id: nextId++,
          role: 'assistant',
          content
        };
        t.push(msg);
      } else {
        const reasoning =
          typeof m.reasoning === 'string' && m.reasoning
            ? m.reasoning
            : cur.reasoning;
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
          const finalContent = content;
          const useContent =
            finalContent.length >= (cur.content ?? '').length
              ? finalContent
              : cur.content ?? '';
          t[idx] = { ...cur, content: useContent, ...extra };
          remoteStreaming[sid] = false; // 收尾，下一轮重新追加
        }
      }
    }
    threads[sid] = t;
    patchSessionMeta(
      sid,
      sessions.find((s) => s.id === sid)?.title ?? '',
      typeof m.ts === 'number' ? m.ts : Date.now()
    );
    if (activeId === sid) messages = [...t];
  }

  /**
   * 上下文用量弹层外点关闭兜底（document 级 pointerdown）。
   */
  const onDocPointerDown = (e: PointerEvent) => {
    if (!showCtxUsage) return;
    const path = e.composedPath();
    const inside = path.some(
      (n) =>
        n instanceof Element &&
        (n.classList.contains('ctx-pop') ||
          n.classList.contains('ctx-ring-wrap'))
    );
    if (!inside) showCtxUsage = false;
  };

  /**
   * 路由变化（Tab 切换 / 浏览器后退前进）时收起对话页内所有浮层。
   */
  const onCloseOverlays = () => {
    if (previewFile) previewFile = null;
    if (fullscreenEditOpen) fullscreenEditOpen = false;
    if (showCtxUsage) showCtxUsage = false;
  };

  /* ----------------------- 会话管理 ----------------------- */

  async function newChat() {
    // 不中止任何进行中的 run：后台 run 继续写入其所属会话缓冲，新建对话只是切换显示到空线程。
    activeId = '';
    // 作废仍在飞行中的会话切换请求。
    sessionLoadSeq++;
    sessionLoading = false;
    messages = [];
    input = '';
    cmdName = '';
    resetToBottom();
    backendUsage = null;
    runCumulative = null;
    // 清空「上次会话」标记，刷新后进入空白新对话。
    persistActiveId('');
  }

  /** 持久化当前会话 id（跨刷新恢复用）；传入空串表示「无当前会话」。 */
  function persistActiveId(id: string) {
    try {
      if (id) localStorage.setItem('ah_active_id', id);
      else localStorage.removeItem('ah_active_id');
    } catch {
      /* ignore */
    }
  }

  async function selectSessionImpl(id: string) {
    if (id === activeId) return;
    activeId = id;
    // 本次切换的请求序号：进入即自增，异步返回时据此判定自己是否已过期。
    const seq = ++sessionLoadSeq;
    // 先无条件复位骨架屏：内存中已有该会话缓冲时不再置位，切换零等待直接出内容。
    sessionLoading = false;
    // 加载本会话持久化的设置（交互模式/模型/agent），实现「同一对话两端对齐」。
    const sv = sessions.find((s) => s.id === id);
    const st = sessionSettings[id];
    if (st?.interactionMode !== undefined)
      interactionMode = st.interactionMode;
    else if (sv?.interactionMode !== undefined)
      interactionMode = sv.interactionMode;
    if (st?.model !== undefined) model = st.model;
    else if (sv?.model !== undefined) model = sv.model;
    if (st?.agentId !== undefined) agentId = st.agentId;
    else if (sv?.agentId !== undefined) agentId = sv.agentId;
    persistActiveId(id);
    sidebarOpen = false;
    closeAllSessionSwipes();
    input = '';
    cmdName = '';

    // 关键修复：切换会话【不再】中止进行中的 run，也不清空其打字机缓冲 / 追踪状态。
    const localBuf = threads[id];
    const needFetch =
      !localBuf || (restoreFailed[id] && localBuf.length === 0);

    // 会话级用量快照（随历史镜像恢复）。
    let recoveredUsage: MirroredUsage | null = null;
    if (needFetch) {
      sessionLoading = true;
      try {
        // 恢复流程带超时（加载失败 / 数据不完整 / 超时均视为异常走降级）。
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
            // propose 当时的联网开关：随计划卡片透传。
            planWeb: (m as { planWeb?: unknown }).planWeb === true ? true : undefined,
            planStatus: (m as { planStatus?: unknown }).planStatus,
            // 计划模式（P0）：目标澄清结果透传。
            clarify: (m as { clarify?: unknown }).clarify,
            // 服务端落盘的附件原样透传。
            ...(m.attachments && m.attachments.length
              ? { attachments: m.attachments }
              : {})
          }))
        );

        // 计划会话恢复：优先采用干净的历史镜像，单步残留仅作防御性过滤。
        const mirrored = await loadThread(id);
        const isPlanSession =
          clean.some((m) => (m as { plan?: unknown }).plan) ||
          !!(mirrored && mirrored.msgs.some((m) => (m as { plan?: unknown }).plan));
        // 先取计划进度镜像查找表（以服务端为权威源）；待线程按新 id 重建后再应用。
        const planStatusLookup = mirrored?.msgs?.length
          ? mergePlanStatusLookup(
              buildPlanStatusLookup(clean),
              buildPlanStatusLookup(mirrored.msgs as ChatMsg[])
            )
          : buildPlanStatusLookup(clean);
        let base: ChatMsg[];
        if (isPlanSession) {
          const mirrorMsgs =
            mirrored && mirrored.msgs.length
              ? (sanitizeMessages(mirrored.msgs as ChatMsg[]) as ChatMsg[])
              : [];
          const hasSummary = mirrorMsgs.some(
            (m) =>
              typeof m.content === 'string' &&
              m.content.startsWith('📋 计划执行摘要')
          );
          if (mirrorMsgs.length && hasSummary) {
            // 镜像含摘要：干净源，直接采用并过滤任何残余单步噪声。
            base = filterPlanSingleStep(mirrorMsgs as unknown as ChatMsg[]);
            recoveredUsage = mirrored?.usage ?? null;
          } else {
            // 镜像缺失 / 无摘要：退回服务端存储，滤掉单步派发噪声并回收「最终结果」。
            base = filterPlanSingleStep(clean as unknown as ChatMsg[]);
            base = recoverPlanFinalResult(base, clean as unknown as ChatMsg[]);
          }
        } else {
          base = clean as unknown as ChatMsg[]; // MirroredMsg 与 ChatMsg 仅差 id
        }
        // 本地若已有消息（如离线期间新发送的），按「最长尾首重叠」合并。
        const merged =
          localBuf && localBuf.length
            ? mergeThreadHistories(base, sanitizeMessages(localBuf))
            : base;
        threads[id] = merged.map((m) => ({
          ...m,
          // 恢复源附件为 {name,type,url?,serverUrl?} 形状，渲染需 UploadedFile（dataUrl）。
          ...(m.attachments && m.attachments.length
            ? {
                attachments: m.attachments.map((a) => ({
                  name: a.name,
                  size: 0,
                  type: a.type,
                  dataUrl: ('url' in a ? String(a.url) : '') || '',
                  ...(a.serverUrl ? { serverUrl: a.serverUrl } : {})
                }))
              }
            : {}),
          id: nextId++
        })) as ChatMsg[];
        // 线程已按新 id 重建：把服务端镜像里的计划进度还原到 planExec（新消息 id 对齐）。
        applyPlanStatusLookup(id, planStatusLookup);
        // P4.6 恢复自愈：planExec 就位后重挂「📎 交付文件」区。
        await reattachPlanDeliverables(id);
        restoreFailed[id] = false;
      } catch (err) {
        // 恢复失败：绝不清空 / 覆盖本地已有记录。降级阶梯：
        //   历史镜像接口 → 空线程 + 失败标记（下次重试）+ 非阻断警示。
        const mirrored = await loadThread(id);
        if (mirrored && mirrored.msgs.length) {
          recoveredUsage = mirrored.usage;
          threads[id] = mirrored.msgs.map((m) => ({
            ...(m as Omit<ChatMsg, 'id'>),
            ...(m.attachments && m.attachments.length
              ? {
                  attachments: m.attachments.map((a) => ({
                    name: a.name,
                    size: 0,
                    type: a.type,
                    dataUrl: ('url' in a ? String(a.url) : '') || '',
                    ...(a.serverUrl ? { serverUrl: a.serverUrl } : {})
                  }))
                }
              : {}),
            id: nextId++
          })) as ChatMsg[];
          // 降级路径同样还原计划进度（镜像字段 + 线程反推）。
          applyPlanStatusLookup(id, buildPlanStatusLookup(mirrored.msgs));
          // 降级路径同样自愈重挂交付文件区（与主路径同语义）。
          await reattachPlanDeliverables(id);
          notify.warning(
            '服务端历史拉取失败，已从历史镜像恢复（可能非最新）。',
            {
              key: 'chat-history'
            }
          );
        } else {
          threads[id] = localBuf ?? [];
          // 降级路径（本地镜像恢复）同样还原计划进度：缺失时补种 pending。
          applyPlanStatusLookup(id, buildPlanStatusLookup(threads[id]));

          // 区分「真·服务端不可达」与「会话本就为空或不存在（404 且无镜像）」。
          const isNotFound =
            !!err &&
            typeof err === 'object' &&
            (err as { status?: number }).status === 404;
          if (!isNotFound) {
            restoreFailed[id] = true;
            notify.warning(
              '历史记录恢复失败（服务端不可达），已保留当前内容；再次进入将自动重试。',
              { key: 'chat-history' }
            );
          }
        }
      }
    }
    // 拉取流程结束（成功、降级、失败三条路径均在此汇合）：关闭骨架屏。
    // 只有最新一次切换有权操作该标志。
    if (seq === sessionLoadSeq) sessionLoading = false;

    // 恢复历史后补全调用链路中 assistant 消息的内容。
    restoreTraceMessages(id);

    // 过期请求：本次结果仅作为缓存留在 threads 中，不得回写内容与视图状态。
    if (seq !== sessionLoadSeq) return;

    messages = threads[id] ?? [];

    // 切换会话：回到该会话最新消息底部，并恢复「钉底」跟随。
    resetToBottom();

    // 用量快照从会话镜像回填（若有）。
    backendUsage = recoveredUsage?.backendUsage ?? null;
    runCumulative = recoveredUsage?.runCumulative ?? null;
  }

  /**
   * 把持久化的计划进度应用到恢复后的线程（按 goal 对齐新消息 id）。
   */
  function applyPlanStatusLookup(
    sid: string,
    lookup: Map<string, PlanExecMirror>
  ) {
    const thread = threads[sid];
    if (!thread?.length) return;
    for (const m of thread) {
      if (!m.plan || planExec[m.id]) continue;
      const ps = lookup.get(m.plan.goal);
      if (!ps) {
        // 从未确认执行的计划在镜像契约里没有对应状态：显式补种 pending 态，
        // 使按钮渲染与点击门禁对齐（语义与渲染缺省一致）。
        planExec = {
          ...planExec,
          [m.id]: resolveRestoredPlanExec(m.plan, thread)
        };
        continue;
      }
      const doneMap: Record<string, boolean> = {};
      for (const tid of ps.done ?? []) doneMap[tid] = true;
      // P3：awaiting = 合法暂停（审批门）—— 原样还原「待审批」态。
      const awaitingState = ps.status === 'awaiting';
      // running = 上次执行中断：保留已完成集合，但置 failed 等待用户显式继续。
      const interrupted = !awaitingState && ps.status === 'running';
      planExec = {
        ...planExec,
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

  async function renameSession(id: string) {
    const cur = sessions.find((s) => s.id === id);
    // 统一弹框（components/ah-modal）：替代原生 window.prompt。
    const title = await AhModal.prompt({
      title: '重命名会话',
      inputValue: cur?.title ?? '',
      inputPlaceholder: '输入新的会话名称',
      confirmText: '保存'
    });
    if (!title || !title.trim()) return;
    try {
      await client.renameChatSession(id, title.trim());
      sessions = sessions.map((s) =>
        s.id === id ? { ...s, title: title.trim() } : s
      );
      // 同步本地镜像索引标题（下次离线兜底渲染时名称一致）。
      const t = threads[id];
      if (t && t.length) saveHistory(id);
      notify.success('会话已重命名');
    } catch (e) {
      notifyError(e, { title: '重命名会话', fallback: '重命名失败' });
    }
  }

  async function deleteSession(id: string) {
    // 统一弹框：警告变体 + 破坏性红色确认按钮，替代原生 window.confirm。
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
      // 同步清理历史镜像与索引，避免「服务端已删、本地幽灵会话」复活。
      await purgeSessionMirror(id);
      sessions = sessions.filter((s) => s.id !== id);
      if (activeId === id) void newChat();
      notify.success('会话已删除');
    } catch (e) {
      notifyError(e, { title: '删除会话', fallback: '删除失败' });
    }
  }

  /* ----------------------- 发送 / 流式 ----------------------- */

  async function ensureSession(): Promise<string> {
    if (activeId) {
      persistActiveId(activeId);
      return activeId;
    }
    const s = await client.createChatSession('新对话', {
      interactionMode,
      model,
      agentId
    });
    activeId = s.id;
    persistActiveId(s.id);
    // 新建会话即带上当前默认设置，确保它端首次见到该会话时已对齐。
    sessionSettings[s.id] = {
      interactionMode: s.interactionMode,
      model: s.model,
      agentId: s.agentId
    };
    sessions = [toSessionView(s), ...sessions];
    // 维护分页不变量：新会话落在服务端列表头部，「已消费区间」整体后移一位。
    const serverIds = new Set(sessionPage.serverIds);
    serverIds.add(s.id);
    sessionPage = {
      offset: sessionPage.offset + 1,
      hasMore: sessionPage.hasMore,
      serverIds
    };
    return s.id;
  }

  /**
   * 当前选中模型的自定义端点配置（若有）：从后端 SQLite 的自定义模型清单里
   * 查出 baseUrl / apiKey，作为 run 请求的 modelBaseUrl / modelApiKey 字段。
   */
  async function customModelEndpoint(): Promise<{
    modelBaseUrl?: string;
    modelApiKey?: string;
  }> {
    if (!model) return {};
    try {
      const res = await authedFetch('/api/custom-models');
      if (!res.ok) return {};
      const rows = (await res.json()) as Array<{
        id: string;
        baseUrl?: string;
        apiKey?: string;
      }>;
      const row = rows.find((r) => r.id === model);
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
   * 构造 Slash Command 上下文：映射组件状态到 CommandContext 接口。
   */
  function _makeCommandContext(): CommandContext {
    return {
      clearMessages: () => {
        messages = [];
      },
      newConversation: async () => {
        messages = [];
        activeId = '';
        for (const k of Object.keys(threads)) delete threads[k];
        for (const k of Object.keys(streamIdx)) delete streamIdx[k];
        try {
          localStorage.removeItem('ah_conversation_id');
        } catch {}
      },
      copyFinal: async () => {
        try {
          await navigator.clipboard.writeText(
            messages
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
        web = !web;
      },
      setMode: (m) => {
        mode = m;
      },
      setInteractionMode: (m) => {
        interactionMode = m;
        localStorage.setItem('ah_interaction_mode', m);
      },
      exportRun: () => {
        // chat 不直接持有 export 能力，降级为复制最终结果
        void _makeCommandContext().copyFinal();
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
  async function buildAttachmentDispatchOpts(
    content: string,
    rawAttachments: UploadedFile[]
  ): Promise<{
    imageAttachments: Array<{ url: string; name: string; type: string }>;
    modelPrompt: string;
  }> {
    // 直接把本地 dataUrl（完整 data: URI）作为图片内容发给模型，并压缩防超请求体上限。
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
    // 仅追加到「发往模型的 prompt」；UI 消息内容仍为纯用户输入。
    const modelPrompt = attachmentDigest
      ? `${content}\n\n${attachmentDigest}`
      : content;

    return { imageAttachments, modelPrompt };
  }

  async function send() {
    // 命令胶囊 + 输入框参数拼成最终提示词（无胶囊时即普通文本）。
    const prompt = buildPrompt();
    // 仅阻止「同一会话正在流式时重复发送」；其它会话可并发。
    if (!prompt && attachments.length === 0) return;

    // BYOK 发送前 gating。
    if (mode === 'real' && !llmReady) {
      notify.warning(
        '尚未配置可用的 LLM API Key，无法发起真实对话。请到「设置 → 模型服务商」填入你的 OpenRouter Key。',
        { title: '需要 API Key', key: 'pk-required' }
      );
      window.dispatchEvent(new CustomEvent(APP_EVENTS.goto, { detail: 'settings' }));
      return;
    }

    // Slash Command 拦截：如果输入是 /command，处理后不发送到 /api/run。
    if (handleSlashCommand(prompt, _makeCommandContext())) {
      clearComposer();
      return;
    }

    // 会话创建是接口调用：失败时给出明确提示。
    let sessionId: string;
    try {
      sessionId = await ensureSession();
    } catch (e) {
      notifyError(e, { title: '新建会话', fallback: '创建会话失败，请重试' });
      return;
    }

    // 构造用户消息内容：只发送纯文本提示词给 LLM。
    const content = prompt;

    // 在清空 attachments 之前保留完整附件副本（含 dataUrl），用于回显到 user 气泡。
    const rawAttachments = [...attachments];
    const { imageAttachments, modelPrompt } =
      await buildAttachmentDispatchOpts(content, rawAttachments);

    clearComposer();
    await runRt.dispatchPrompt(sessionId, content, imageAttachments, {
      attachments: rawAttachments,
      modelPrompt
    });
  }

  /** 清空输入区：文本 + 命令胶囊 + 附件，并把输入框高度复位。 */
  function clearComposer(): void {
    input = '';
    cmdName = '';
    attachments = [];
    attachmentsExpanded = false;
    void refocusInput();
  }

  /**
   * 构造 RunDeps 桥接：把组件的领域数据 / 渲染状态 / 行为方法以箭头函数注入运行控制器。
   */
  function makeRunDeps(): RunDeps {
    return {
      /* ----- 渲染相关状态 ----- */
      getConnState: (sid) => connState[sid] ?? 'connected',
      setConn: (sid, val) => setConn(sid, val),
      getStreaming: (sid) => !!streaming[sid],
      getStreamingDict: () => streaming,
      setStreaming: (sid, val) => setStreaming(sid, val),

      /* ----- 会话领域数据 ----- */
      threadFor: (sid) => threadFor(sid),
      setStreamIdx: (sid, idx) => {
        streamIdx[sid] = idx;
      },
      setThreads: (sid, t) => {
        threads[sid] = t;
      },
      getThreads: (sid) => threads[sid],
      getActiveId: () => activeId,
      setMessages: (t) => {
        messages = t;
      },
      getTraces: (sid) => traces[sid],
      getPlanExec: () => planExec,
      setPlanExec: (v) => {
        planExec = v;
      },
      getServerCtxWindow: () => serverCtxWindow,
      getServerModelBaseUrl: () => modelBaseUrl,
      getBackendUsage: () => backendUsage,
      setBackendUsage: (v) => {
        backendUsage = v;
      },
      getMode: () => mode,
      getModel: () => model,
      getAgentId: () => {
        // 防御：viewer 角色下不得调用医美运营分析 agent。
        if (role === 'viewer' && agentId) {
          const agent = agents.find((a) => a.id === agentId);
          if (agent?.domain === 'medical-aesthetics') return '';
        }
        return agentId;
      },
      getWeb: () => web,
      getInteractionMode: () => interactionMode,
      getAttachments: () => attachments,
      setShowCtxUsage: (b) => {
        showCtxUsage = b;
      },
      setRunCumulative: (v) => {
        runCumulative = v;
      },

      /* ----- 行为方法 ----- */
      curSession: (sid) => curSession(sid),
      patchSession: (sid, p) => patchSession(sid, p),
      resetTrace: (sid) => resetTrace(sid),
      customModelEndpoint: () =>
        customModelEndpoint() as Promise<Record<string, unknown>>,
      traceHandle: (ev, sid) =>
        traceHandle(ev as { type: string; [k: string]: unknown }, sid),
      autoCollapseThink: (sid) => autoCollapseThink(sid),
      rebuildTraceMessages: (sid) => rebuildTraceMessages(sid),
      saveHistory: (sid) => saveHistory(sid),
      resetScrollToBottom: () => resetToBottom(),
      nextId: () => nextId++,
      requestUpdate: () => {
        rtVersion++;
      },

      /* ----- SSE 客户端 ----- */
      streamRun: (payload, opts) =>
        client.streamRun(payload as Parameters<typeof client.streamRun>[0], opts),

      /* ----- P5 静默计划执行：quiet run 的思考增量 → 当前计划卡思考面板 ----- */
      onPlanThinking: (sid, delta) => {
        const sink = quietPlanSink;
        if (!sink) return;
        const prev = planExec[sink.msgId];
        if (!prev || prev.status !== 'running') return;
        const next = applyPlanThinking(prev, delta);
        if (next !== prev) {
          planExec = { ...planExec, [sink.msgId]: next };
        }
      }
    };
  }

  /** 打字机引擎（回调注入，requestUpdate 以 rtVersion 自增替代）。 */
  const typewriter = new ChatTypewriter({
    patchSession: (sid, p) => patchSession(sid, p),
    curSession: (sid) => curSession(sid),
    isAnyStreaming: () => anyStreaming(),
    requestUpdate: () => {
      rtVersion++;
    }
  });

  /** 运行管线控制器。运行内部簿记状态由本控制器持有，其余经 RunDeps 桥接。 */
  const runRt = new ChatRunRuntime(makeRunDeps(), typewriter);
  /* ----------------------- 调用链路追踪构建 ----------------------- */

  /** 确保追踪树根节点（run）存在并返回（按会话独立）。 */
  function ensureTraceRoot(sid: string): TraceNode {
    const tc = traceCtx(sid);
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
   */
  function traceHandle(ev: { type: string; [k: string]: unknown }, sid: string) {
    const tc = traceCtx(sid);
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
        const r = ensureTraceRoot(sid);
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
        const r = ensureTraceRoot(sid);
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
        ensureTraceRoot(sid);
        // 兜底：把上一轮仍 pending 的工具/检索节点统一标记为成功。
        finalizePendingTools(tc);
        const parent = tc.parent ?? tc.root!;
        // 纯前端：把「截至此次调用的会话消息上下文」挂到节点。
        const messagesSnap = snapshotTraceMessages(sid);
        tc.llm = mk(parent, 'llm', 'LLM 调用', 'ok', {
          meta: {
            messages: `消息 ${messagesSnap.length || '?'}`
          },
          ...(messagesSnap.length ? { messages: messagesSnap } : {})
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
          refreshLlmTraceMessages(sid, tc);
        }
        break;
      }
      case 'llm:token': {
        if (tc.llm && typeof ev.delta === 'string') {
          const n =
            (tc.llm.meta?.tokenChars ? Number(tc.llm.meta.tokenChars) : 0) +
            ev.delta.length;
          tc.llm.meta = { ...(tc.llm.meta ?? {}), tokenChars: String(n) };
          refreshLlmTraceMessages(sid, tc);
        }
        break;
      }
      case 'tool:start': {
        const call = asObj(ev.call);
        if (!tc.llm || !call) break;
        const name = String(call.name ?? 'tool');
        const retrieval = isRetrievalTool(name);
        const node = mk(
          tc.llm,
          retrieval ? 'retrieval' : 'tool',
          retrieval ? `检索 · ${name}` : toolDisplayName(name),
          'pending',
          {
            detail:
              typeof call.arguments === 'string'
                ? call.arguments
                : JSON.stringify(call.arguments ?? {})
          }
        );
        // 按 call.id 索引，并行工具各自命中自己的节点。
        tc.lastTool = node;
        const cid = call.id;
        if (cid != null) tc.toolByCallId[String(cid)] = node;
        break;
      }
      case 'tool:deduped': {
        // 加固：工具调用去重命中。复用首次结果，记为「复用缓存」节点。
        const dedupCall = asObj(ev.call);
        if (!tc.llm || !dedupCall) break;
        const name = String(dedupCall.name ?? 'tool');
        const retrieval = isRetrievalTool(name);
        const node = mk(
          tc.llm,
          retrieval ? 'retrieval' : 'tool',
          retrieval ? `检索 · ${name}` : toolDisplayName(name),
          ev.errored ? 'error' : 'ok',
          {
            detail:
              typeof dedupCall.arguments === 'string'
                ? dedupCall.arguments
                : JSON.stringify(dedupCall.arguments ?? {}),
            meta: { reused: '复用缓存（去重）' }
          }
        );
        tc.lastTool = node;
        const cid = dedupCall.id;
        if (cid != null) tc.toolByCallId[String(cid)] = node;
        node.result =
          typeof ev.result === 'string'
            ? ev.result
            : JSON.stringify(ev.result ?? {});
        break;
      }
      case 'tool:result': {
        // 优先按 call.id 命中对应工具节点；无 id 时回退单指针 lastTool。
        const cid = (ev as { call?: { id?: unknown } }).call?.id;
        const node = cid != null ? tc.toolByCallId[String(cid)] : undefined;
        const target = node ?? tc.lastTool;
        if (target) {
          target.result =
            typeof ev.result === 'string'
              ? ev.result
              : JSON.stringify(ev.result ?? {});
          target.status = ev.errored ? 'error' : 'ok';
          // Jev 决策工具：从结构化结果中提炼一行可读摘要，直接挂在节点 meta。
          const evCallName = (ev as { call?: { name?: unknown } }).call?.name;
          const meta: Record<string, string> = {
            ...(target.meta ?? {}),
            status: ev.errored ? '失败' : '成功'
          };
          if (
            evCallName === 'builtin__jev_decide' &&
            !ev.errored &&
            typeof target.result === 'string'
          ) {
            const d = summarizeJevDecision(target.result);
            if (d) meta['决策'] = d;
          }
          target.meta = meta;
        }
        break;
      }
      case 'run:cost': {
        ensureTraceRoot(sid);
        const parent = tc.parent ?? tc.root!;
        // 本运行累计 token 消耗（所有 step 之和）。
        if (ev.cumulativeTokens != null) {
          runCumulative = {
            tokens: Number(ev.cumulativeTokens),
            cost:
              ev.cumulativeCost != null
                ? Number(ev.cumulativeCost)
                : 0
          };
          // 累计消耗更新后立即落盘，与 llm:usage 对称。
          saveHistory(sid);
        }
        // Token 拆解四项（系统/工具/历史/输出）。
        const est = ev.estTokens as
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
              ev.cumulativeTokens ??
              asObj(ev.usage)?.total_tokens ??
              '?'
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
      case 'jev:call': {
        // TypeSafe Jev 决策模型旁路上报：子系统直连调用的调用事实。
        if (ev.caller === 'tool') break;
        ensureTraceRoot(sid);
        const jParent = tc.llm ?? tc.parent ?? tc.root!;
        const jDetail =
          ev.questionSpec && typeof ev.questionSpec === 'object'
            ? JSON.stringify(ev.questionSpec, null, 2)
            : undefined;
        const jResultOk =
          ev.ok !== false && ev.answers && typeof ev.answers === 'object'
            ? JSON.stringify(ev.answers, null, 2)
            : undefined;
        mk(jParent, 'tool', `Jev 决策 · ${String(ev.caller ?? '?')}`, ev.ok === false ? 'error' : 'ok', {
          ...(ev.error ? { result: String(ev.error) } : {}),
          ...(jDetail ? { detail: jDetail } : {}),
          ...(jResultOk ? { result: jResultOk } : {}),
          meta: {
            jev: 'true',
            调用方: String(ev.caller ?? '?'),
            延迟: `${Number(ev.latencyMs ?? 0)}ms`,
            ...(ev.questions != null ? { 问题数: String(ev.questions) } : {}),
            ...(asObj(ev.tokens)
              ? {
                  tokens: `${Number(asObj(ev.tokens)?.input ?? 0)}+${Number(
                    asObj(ev.tokens)?.output ?? 0
                  )}`
                }
              : {})
          }
        });
        break;
      }
      case 'run:token-cache': {
        ensureTraceRoot(sid);
        const parent = tc.parent ?? tc.root!;
        const tcHitPct = (Number(ev.hitRate) * 100).toFixed(1);
        const tcByModel = Object.entries(
          (asObj(ev.byModel) ?? {}) as Record<
            string,
            { queries: number; hits: number; hitRate: number }
          >
        )
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
        ensureTraceRoot(sid);
        // 软性未通过（soft）只告警不阻断。
        const soft = !ev.passed && ev.soft === true;
        mk(tc.root!, 'verify', soft ? '验收告警' : '自检', ev.passed || soft ? 'ok' : 'error', {
          meta: {
            score: String(ev.score ?? '?'),
            passed: ev.passed ? '通过' : soft ? '未通过（不阻断）' : '未通过'
          },
          result: (Array.isArray(ev.reasons) ? ev.reasons : []).join('\n')
        });
        break;
      }
      case 'guardrail:blocked': {
        ensureTraceRoot(sid);
        mk(tc.root!, 'guardrail', `护栏拦截 · ${ev.phase ?? ''}`, 'error', {
          detail: String(ev.reason ?? '')
        });
        break;
      }
      case 'budget:exceeded': {
        ensureTraceRoot(sid);
        mk(tc.root!, 'budget', `预算超限 · ${ev.kind ?? ''}`, 'error', {
          meta: { used: String(ev.used ?? '?'), limit: String(ev.limit ?? '?') }
        });
        break;
      }
      case 'warn': {
        // 仅带 userHint 标记的告警以轻量 toast 呈现，按内容去重。
        if (ev.userHint !== true) break;
        const msg = String(ev.message ?? '').trim();
        if (msg) {
          notify.warning(msg, { key: `run-warn:${msg.slice(0, 64)}` });
        }
        break;
      }
      case 'error': {
        ensureTraceRoot(sid);
        mk(tc.root!, 'error', '运行错误', 'error', {
          detail: String(ev.message ?? '')
        });
        break;
      }
      case 'run:end': {
        // 运行收尾兜底：把所有残留 pending 节点收尾。
        finalizePendingTools(tc);
        break;
      }
      default:
        break;
    }
    // 结构型事件才回写消息（token/reasoning 高频且仅更新 meta，避免无谓重渲染）。
    if (
      tc.root &&
      (streamIdx[sid] ?? -1) >= 0 &&
      ev.type !== 'llm:token' &&
      ev.type !== 'llm:reasoning'
    ) {
      patchSession(sid, { trace: [tc.root] });
    }
  }

  /**
   * 兜底收尾：把 trace 树里所有仍处 pending 的工具/检索节点标记为成功（ok）。
   */
  function finalizePendingTools(tc: TraceCtx) {
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
   * 还原已结束/从存储恢复的消息时，把残留 pending 工具/检索节点收尾。
   */
  function normalizeStoredTrace(
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
  async function copyMsgText(msgId: number, text: string) {
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
    copiedMsgId = msgId;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedMsgId = -1;
      copiedTimer = null;
    }, 1500);
  }

  /** 进入用户消息编辑态：气泡原位替换为输入框并自动聚焦。 */
  function startEdit(msgId: number, content: string) {
    editingMsgId = msgId;
    editingDraft = content;
    editingOriginalContent = content;
    hoverUserMsgId = -1;
  }

  /** 退出编辑态，丢弃草稿。 */
  function cancelEdit() {
    editingMsgId = -1;
    editingDraft = '';
    editingOriginalContent = '';
  }

  /**
   * 编辑后重新发送：截断被编辑消息之后的所有消息，替换内容为新草稿并继续派发。
   */
  async function sendEdit(msgId: number) {
    if (editingMsgId < 0) return; // 非编辑态 / 本次已提交（提交锁）
    const draft = editingDraft.trim();
    if (!draft || streaming[activeId] === true) return;
    // 没有任何变动：不发送，保持编辑态让用户继续编辑。
    if (draft === editingOriginalContent.trim()) return;

    // 立即清编辑态标志作为提交锁。
    cancelEdit();
    fullscreenEditOpen = false;
    cancelComposerLongPress();

    const sessionId = await ensureSession();
    const t = threadFor(sessionId);
    const idx = t.findIndex((m) => m.id === msgId && m.role === 'user');
    if (idx < 0) {
      // 找不到原消息：降级为普通追加发送。
      input = draft;
      await send();
      return;
    }

    const editedMsg = t[idx];
    if (!editedMsg) {
      input = draft;
      await send();
      return;
    }

    // 截断被编辑消息之后的所有消息，并用新草稿替换被编辑消息内容。
    const next = t.slice(0, idx + 1);
    next[idx] = { ...editedMsg, content: draft };

    // 清理被截断消息衍生的前端状态，避免残留 plan / 回放 / 折叠态。
    for (let i = idx + 1; i < t.length; i++) {
      const removedId = t[i]?.id;
      if (removedId == null) continue;
      if (planExec[removedId]) {
        const { [removedId]: _drop1, ...rest1 } = planExec;
        planExec = rest1;
      }
      if (planWfReplay[removedId]) {
        const { [removedId]: _drop2, ...rest2 } = planWfReplay;
        planWfReplay = rest2;
      }
      if (thinkCollapsed[removedId]) {
        const { [removedId]: _drop3, ...rest3 } = thinkCollapsed;
        thinkCollapsed = rest3;
      }
    }

    // 如果当前打开的抽屉/回放属于被截断的消息，关闭它们。
    if (traceDrawerMsg && traceDrawerMsg.id > msgId) {
      traceDrawerMsg = null;
    }
    if (planWfReplayMsg && planWfReplayMsg.id > msgId) {
      planWfReplayMsg = null;
    }

    // 在截断后的线程末尾追加 assistant 占位，准备接收新回复。
    next.push({ id: nextId++, role: 'assistant', content: '' });
    threads[sessionId] = next;
    if (activeId === sessionId) {
      messages = next;
    }
    streamIdx[sessionId] = next.length - 1;
    setStreaming(sessionId, false);

    // 保留被编辑消息的附件；若原消息无附件则透空数组。
    const rawAttachments = editedMsg.attachments
      ? [...editedMsg.attachments]
      : [];
    const { imageAttachments, modelPrompt } =
      await buildAttachmentDispatchOpts(draft, rawAttachments);

    await runRt.dispatchPrompt(sessionId, draft, imageAttachments, {
      attachments: rawAttachments,
      modelPrompt,
      editFrom: { sessionId, msgId, index: idx }
    });
  }

  function onInput(e: Event) {
    input = (e.target as HTMLTextAreaElement).value;
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }

  function onKey(e: KeyboardEvent) {
    // ① 命令联想面板优先消费按键（↑↓ 移动 / Enter·Tab 选中 / Esc 关闭）。
    if (
      suggestEl &&
      typeof suggestEl.handleKey === 'function' &&
      suggestEl.handleKey(e)
    )
      return;

    // ② 输入框为空时按 Backspace → 移除命令胶囊，退回普通输入态。
    if (e.key === 'Backspace' && cmdName && !input) {
      e.preventDefault();
      onCommandRemove();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  /* ------------------- Slash Command 胶囊交互 ------------------- */

  /**
   * 命令被选中：把命令从输入框文本中剥离、固化为胶囊。
   */
  function onCommandSelect(name: string): void {
    const next = String(name ?? '')
      .trim()
      .replace(/^\//, '');
    if (!next) return;
    cmdName = next;
    input = '';
    void refocusInput();
  }

  /** 移除命令胶囊：回到普通输入态，焦点回到输入框。 */
  function onCommandRemove(): void {
    if (!cmdName) return;
    cmdName = '';
    void refocusInput();
  }

  /** 输入框重获焦点并重算自适应高度（清空文本后高度不会自动收缩）。 */
  async function refocusInput(): Promise<void> {
    await tick();
    const ta = inputEl;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
    ta.focus();
  }

  /**
   * 组装最终发送的提示词：胶囊命令 + 输入框参数。
   */
  function buildPrompt(): string {
    const arg = input.trim();
    return cmdName ? `/${cmdName}${arg ? ` ${arg}` : ''}` : arg;
  }

  /* ------------------- 整屏拖拽上传（覆盖整个 chat 区域） ------------------- */

  /** 该 drag 事件是否携带文件。 */
  function isFileDrag(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    return types ? Array.from(types).includes('Files') : false;
  }

  /** 剩余可添加的附件数（0 表示已达上限）。 */
  const attachRoom = $derived(Math.max(0, MAX_ATTACHMENTS - attachments.length));

  /** 附件预览条展示切片（渲染与「+N」文案同源）。 */
  const attachView = $derived(
    resolveAttachmentView(attachments, attachmentsExpanded)
  );

  /** 顶部标题：当前会话名；无会话时显示「新对话」。 */
  const activeTitle = $derived(
    sessions.find((s) => s.id === activeId)?.title ?? ''
  );

  /** 拖拽进入 chat 区域：亮起整屏遮罩（dragenter/dragleave 计数成对抵消）。 */
  function onDragEnter(e: DragEvent): void {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth += 1;
    if (!dragActive) dragActive = true;
  }

  /** 拖拽在内部元素间移动：持续 preventDefault，否则浏览器会拒收 drop。 */
  function onDragOver(e: DragEvent): void {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (!dragActive) dragActive = true;
  }

  function onDragLeave(e: DragEvent): void {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    // 计数归零才认为是真正离开，避免跨越子元素时遮罩闪烁。
    if (dragDepth === 0) dragActive = false;
  }

  /** 在 chat 区域内松开：接管文件并关闭遮罩。 */
  function onDrop(e: DragEvent): void {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dragActive = false;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) void handleFiles(files);
  }

  /** 处理文件选择（两条入口的汇聚点；核心逻辑见模块级 handleFilesCore）。 */
  async function handleFiles(picked: File[]): Promise<void> {
    await handleFilesCore(attachBridge, picked);
  }

  /** 移除已选附件。 */
  function removeAttachment(i: number) {
    const newAttachments = attachments.filter((_, idx) => idx !== i);
    attachments = newAttachments;
    // 移除后若已不再溢出，收起展开态。
    if (newAttachments.length <= ATTACH_COLLAPSE_LIMIT) {
      attachmentsExpanded = false;
    }
  }

  /** 展开 / 收起附件预览条的多余条目。 */
  function toggleAttachments(): void {
    attachmentsExpanded = !attachmentsExpanded;
  }

  /** 文件是否可预览（图片 MIME 或常见图片扩展名）。 */
  function isPreviewable(f: UploadedFile): boolean {
    return (
      f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|svg)$/i.test(f.name)
    );
  }

  /** 打开图片附件的全屏预览。 */
  function openPreview(f: UploadedFile) {
    if (!isPreviewable(f)) return;
    previewFile = f;
  }

  function closePreview() {
    previewFile = null;
  }

  /** 展开多图附件卡片（展开态由 .attach-card.expanded 类驱动）。 */
  function expandAttachCard(e: Event): void {
    (e.currentTarget as HTMLElement | null)?.closest('.attach-card')?.classList.add('expanded');
  }

  /** 收起多图附件卡片。 */
  function collapseAttachCard(e: Event): void {
    (e.currentTarget as HTMLElement | null)?.closest('.attach-card')?.classList.remove('expanded');
  }

  // ── 移动端长按输入框 → 全屏编辑器 ──────────────────────────────

  /** 长按计时器句柄；600ms 触发全屏编辑。 */
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  /** 长按起点坐标；移动距离超过该阈值视为滚动，取消长按。 */
  let longPressStart: { x: number; y: number } | null = null;

  const LONG_PRESS_MS = 600;
  const LONG_PRESS_MOVE_TOLERANCE = 15; // px

  function onComposerPointerDown(e: PointerEvent) {
    // 仅在用户消息编辑态可用；流式进行中不响应。
    if (editingMsgId < 0 || streaming[activeId] === true) return;
    // 触屏与鼠标均允许长按（鼠标路径便于桌面端验证同一交互）。
    longPressStart = { x: e.clientX, y: e.clientY };
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      fullscreenEditOpen = true;
      // 打开后自动聚焦，直接弹键盘可输入。
      void tick().then(() => {
        feInputEl?.focus();
      });
    }, LONG_PRESS_MS);
  }

  function onComposerPointerMove(e: PointerEvent) {
    if (!longPressTimer || !longPressStart) return;
    const dx = e.clientX - longPressStart.x;
    const dy = e.clientY - longPressStart.y;
    if (dx * dx + dy * dy > LONG_PRESS_MOVE_TOLERANCE ** 2) {
      cancelComposerLongPress(); // 手指滑动（滚动文本）→ 取消
    }
  }

  function cancelComposerLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressStart = null;
  }

  function onComposerPointerUp() {
    cancelComposerLongPress();
  }

  /** 富文本块/编辑区长按期间的右键菜单抑制。 */
  function onComposerContextMenu(e: Event) {
    if (longPressTimer) e.preventDefault();
  }

  async function closeFullscreenEdit() {
    fullscreenEditOpen = false;
    // 焦点还给气泡内的编辑输入框，继续原位编辑。
    await tick();
    editInputEl?.focus();
  }

  /** Esc 关闭预览 / 上下文用量弹层（window 级监听，无需聚焦）。 */
  const onPreviewKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (fullscreenEditOpen) void closeFullscreenEdit();
      else if (previewFile) closePreview();
      else if (showCtxUsage) showCtxUsage = false;
    }
  };

  /** 某条消息深度思考区的有效折叠态：显式覆盖优先，否则取「深度思考收起」全局偏好。 */
  function effectiveThinkCollapsed(id: number): boolean {
    const k = String(id);
    return k in thinkCollapsed
      ? !!thinkCollapsed[k]
      : deepThinkCollapsed;
  }

  /** 折叠 / 展开某条消息的深度思考区（思考中不可折叠，保证实时推理可见）。 */
  function toggleThink(id: number) {
    const k = String(id);
    const c = messages.find((m) => m.id === id);
    const sIdx = streamIdx[activeId] ?? -1;
    const isThinking =
      streaming[activeId] &&
      sIdx >= 0 &&
      messages[sIdx]?.id === id &&
      !c?.content;
    if (isThinking) return;
    // 相对「有效折叠态」取反，写入显式覆盖。
    const cur = effectiveThinkCollapsed(id);
    const next = !cur;
    thinkCollapsed = {
      ...thinkCollapsed,
      [k]: next
    };
    // 手动展开时把思考区正文滚到底部。
    if (!next) scrollThinkBlockToBottom(k);
  }

  /* ── 富文本块折叠（超长代码块 / 表格） ────────────────────────── */

  /**
   * 把 mdFolded 重放到当前 DOM。
   * 每次渲染后都会全量重放：DOM 是刚重建的，不存在「已同步」的捷径。
   */
  function applyFolds() {
    const root = rootEl;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-md-block]').forEach((el) => {
      // 块归属哪个作用域由最近的 [data-md-scope] 决定。
      const scope = el.closest<HTMLElement>('[data-md-scope]')?.dataset.mdScope;
      const block = el.dataset.mdBlock;
      if (!scope || !block) return;
      const folded = effectiveBlockFolded(
        mdFolded,
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
  function toggleFold(el: HTMLElement) {
    const scope = el.closest<HTMLElement>('[data-md-scope]')?.dataset.mdScope;
    const block = el.dataset.mdBlock;
    if (!scope || !block) return;
    mdFolded = {
      ...mdFolded,
      [foldKey(scope, block)]: toggledBlockFolded(
        el.classList.contains('is-folded')
      )
    };
  }

  /**
   * 富文本块内按钮的事件委托（复制代码 / 折叠）。
   * 这些按钮由 toRichHtml 生成、经 {@html} 注入，不参与框架事件绑定体系。
   */
  const onRichClick = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest) return;

    const foldBtn = target.closest<HTMLElement>('.md-fold');
    if (foldBtn) {
      const block = foldBtn.closest<HTMLElement>('[data-md-block]');
      if (block) toggleFold(block);
      return;
    }

    const copyBtn = target.closest<HTMLElement>('.md-copy');
    if (copyBtn) {
      // 从 DOM 取原文而非在按钮上存副本。
      const code = copyBtn
        .closest<HTMLElement>('.md-code')
        ?.querySelector('code');
      void copyCodeText(copyBtn, code?.textContent ?? '');
    }
  };

  /** 复制代码块内容：复用与消息复制一致的剪贴板兜底链路。 */
  async function copyCodeText(btn: HTMLElement, text: string) {
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // 非安全上下文 / 权限被拒：退回 execCommand。
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
   * 深度思考结束自动折叠本轮思考面板：在首个回答 token 到达时调用。
   */
  function autoCollapseThink(sid: string) {
    const sIdx = streamIdx[sid] ?? -1;
    const m = sIdx >= 0 ? (threads[sid] ?? [])[sIdx] : undefined;
    if (!m?.reasoning) return;
    const k = String(m.id);
    // 已折叠（含偏好默认）则不重复折叠；未折叠才折叠。
    if (effectiveThinkCollapsed(m.id)) return;
    thinkCollapsed = { ...thinkCollapsed, [k]: true };
  }

  /** 切换交互模式（问答/计划）并按当前会话持久化 + 广播。 */
  function setInteractionMode(m: 'qa' | 'plan') {
    interactionMode = m;
    // 保留全局偏好（跨刷新记忆），同时按当前会话记录，供跨设备对齐。
    try {
      localStorage.setItem('ah_interaction_mode', m);
    } catch {
      /* ignore */
    }
    void persistSessionSettings({ interactionMode: m });
  }

  /**
   * 把当前会话的某项设置写入本地表 + 同步到服务端。
   */
  async function persistSessionSettings(partial: {
    interactionMode?: 'qa' | 'plan';
    model?: string;
    agentId?: string;
  }) {
    const sid = activeId;
    if (!sid) return;
    // 合并进按会话本地表（先取已记录的，再覆盖本次更新项）。
    const prev = sessionSettings[sid] || {};
    const next = { ...prev, ...partial };
    sessionSettings[sid] = next;
    // 更新左侧栏列表项（切回/刷新时一致）。
    sessions = sessions.map((s) =>
      s.id === sid
        ? {
            ...s,
            interactionMode: next.interactionMode,
            model: next.model,
            agentId: next.agentId
          }
        : s
    );
    // 服务端落库 + 广播（title 沿用当前列表项标题）。
    const cur = sessions.find((s) => s.id === sid);
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
  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    if (sidebarOpen) {
      // 防止打开瞬间触发 scrim 点击导致立即关闭
      _sidebarJustOpened = true;
      setTimeout(() => {
        _sidebarJustOpened = false;
      }, 300);
    } else {
      closeAllSessionSwipes();
    }
  }

  /** 全组收起会话列表的滑动操作区。 */
  function closeAllSessionSwipes() {
    window.dispatchEvent(
      new CustomEvent(APP_EVENTS.swipeClose, { detail: { group: 'chat-sessions' } })
    );
  }

  /** 切换 PC 端侧栏折叠态（展开/收起）。 */
  function toggleSidebarCollapse() {
    sidebarCollapsed = !sidebarCollapsed;
  }
  /**
   * P2（轨迹回放）：打开计划「执行详情」抽屉。
   * 打开期间轮询刷新（2.5s），run 进入终态后自动停止。
   */
  function openPlanWfReplay(m: ChatMsg): void {
    if (!m.plan) return;
    const sid = activeId;
    if (!sid) return;
    if (planWfReplayTimer != null) {
      clearInterval(planWfReplayTimer);
      planWfReplayTimer = null;
    }
    planWfReplayMsg = m;
    planWfReplay = {
      ...planWfReplay,
      [m.id]: { loading: true, snapshot: null }
    };
    const fetchSnapshot = async (): Promise<void> => {
      const wfId = derivePlanWfId(sid, m.plan!);
      let st: PlanWfReplayState;
      try {
        const res = await client.getWorkflow(wfId);
        st = { loading: false, snapshot: res.workflow ?? null };
      } catch (e: unknown) {
        // P2.6：检查点丢失（404）→ 回退到随 planStatus 镜像持久化的紧凑 run 快照。
        const mirror =
          planExec[m.id]?.wfSnapshot ??
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
      if (planWfReplayMsg?.id !== m.id) return;
      const prev = planWfReplay[m.id];
      // P6 观测：轮询写回保留「历史执行」区状态（history/historyView 不被快照刷新覆盖）。
      planWfReplay = {
        ...planWfReplay,
        [m.id]: {
          ...st,
          history: prev?.history,
          historyView: prev?.historyView,
          historyLoading: prev?.historyLoading
        }
      };
      // P5.1：run 已终态（done/failed）→ 停止轮询（awaiting 仍需继续）。
      const state = st.snapshot?.state ?? (st.mirrorSnapshot as { state?: string } | null)?.state;
      if ((state === 'done' || state === 'failed') && planWfReplayTimer != null) {
        clearInterval(planWfReplayTimer);
        planWfReplayTimer = null;
      }
    };
    void fetchSnapshot();
    // P6 观测：打开抽屉时拉一次「历史执行」归档列表。
    const fetchHistory = async (): Promise<void> => {
      const wfId = derivePlanWfId(sid, m.plan!);
      try {
        const res = await client.getWorkflowRunTraces(wfId);
        if (planWfReplayMsg?.id !== m.id) return;
        const cur = planWfReplay[m.id];
        if (cur) {
          planWfReplay = {
            ...planWfReplay,
            [m.id]: { ...cur, history: res.traces ?? [] }
          };
        }
      } catch {
        /* 无归档：抽屉不渲染历史区（不告警，归档是增强能力非必需） */
      }
    };
    void fetchHistory();
    planWfReplayTimer = window.setInterval(() => {
      void fetchSnapshot();
    }, 2500);
  }

  /**
   * P6 方案一 A：抽屉「回滚到此点」—— 把 run 恢复到指定快照后走既有断点续跑重放。
   */
  async function planRollbackTo(m: ChatMsg, snapshotId: string): Promise<void> {
    const sid = activeId;
    if (!sid || !m.plan) return;
    const st = planExec[m.id];
    if (!st || st.status === 'running') return;
    stopPlanWfReconcile(m.id);
    const wfId = derivePlanWfId(sid, m.plan);
    if (isPlanDagEnabled()) {
      try {
        const res = await client.rollbackWorkflow(wfId, snapshotId);
        // 前端 done 集合按恢复后的 run 重建。
        const restoredDone: Record<string, boolean> = Object.fromEntries(
          Object.entries(res.run.steps ?? {})
            .filter(([, s]) => s.state === 'done')
            .map(([id]) => [id, true])
        );
        const ok = await resumePlanViaWorkflow(
          m,
          { ...st, done: restoredDone, status: 'failed', failedTaskId: undefined, currentTaskId: undefined },
          sid,
          wfId
        );
        if (ok) return;
      } catch {
        // 回滚失败（404 检查点丢失 / 409 在跑 / 未知快照）：保持现状可重试。
        return;
      }
      planExec = {
        ...planExec,
        [m.id]: { ...(planExec[m.id] ?? st), status: 'failed', currentTaskId: undefined }
      };
      saveHistory(sid);
      return;
    }
    // 串行模式：无快照链 → 退化为全量重跑（清 done 后 confirmPlan）。
    planExec = {
      ...planExec,
      [m.id]: { ...st, done: {}, status: 'failed', failedTaskId: undefined, currentTaskId: undefined }
    };
    saveHistory(sid);
    await confirmPlan(m);
  }

  /**
   * P6 观测（方案三一期）：抽屉「历史执行」回看 —— 拉取指定 run 的完整归档。
   */
  async function planWfHistoryLoad(m: ChatMsg, runId: string): Promise<void> {
    const sid = activeId;
    if (!sid || !m.plan) return;
    const cur = planWfReplay[m.id];
    if (!cur) return;
    planWfReplay = {
      ...planWfReplay,
      [m.id]: { ...cur, historyLoading: true }
    };
    try {
      const wfId = derivePlanWfId(sid, m.plan);
      const res = await client.getWorkflowRunTraces(wfId, runId);
      if (planWfReplayMsg?.id !== m.id) return;
      const now = planWfReplay[m.id];
      if (now) {
        planWfReplay = {
          ...planWfReplay,
          [m.id]: { ...now, historyView: res.trace ?? undefined, historyLoading: false }
        };
      }
    } catch {
      if (planWfReplayMsg?.id !== m.id) return;
      const now = planWfReplay[m.id];
      if (now) {
        planWfReplay = { ...planWfReplay, [m.id]: { ...now, historyLoading: false } };
      }
    }
    rtVersion++;
  }

  /** P6 观测：退出历史回看，行数据切回当前检查点快照。 */
  function planWfHistoryClose(m: ChatMsg): void {
    const cur = planWfReplay[m.id];
    if (!cur || cur.historyView === undefined) return;
    planWfReplay = {
      ...planWfReplay,
      [m.id]: { ...cur, historyView: undefined }
    };
    rtVersion++;
  }

  /** P2：关闭「执行详情」抽屉（快照缓存保留）。 */
  function closePlanWfReplay(): void {
    if (planWfReplayTimer != null) {
      clearInterval(planWfReplayTimer);
      planWfReplayTimer = null;
    }
    planWfReplayMsg = null;
  }

  /** P5.4：停止某计划消息的断连自愈轮询（终态 / 被新执行取代 / 卡片清理时调用）。 */
  function stopPlanWfReconcile(msgId: number): void {
    const t = planWfReconcileTimers[msgId];
    if (t != null) {
      clearInterval(t);
      const next = { ...planWfReconcileTimers };
      delete next[msgId];
      planWfReconcileTimers = next;
    }
  }

  /**
   * P5.4 断连自愈：SSE 流静默结束时按 2.5s 轮询 GET /api/workflows/:id，
   * 把卡片收敛到权威状态。
   */
  function reconcilePlanWfOnDisconnect(m: ChatMsg, sid: string): void {
    if (!m.plan) return;
    const wfId = derivePlanWfId(sid, m.plan);
    const cur = planExec[m.id];
    if (cur) {
      // 先置「执行中断·重连中」过渡态：区别于 failed，且不被 saveHistory 当终态固化。
      planExec = {
        ...planExec,
        [m.id]: { ...cur, status: 'running', currentTaskId: undefined, thinking: undefined }
      };
    }
    const poll = async (): Promise<void> => {
      const now = planExec[m.id];
      if (!now) return; // 已被新执行 / 清理取代
      let run: PlanWfRunSnapshot | null | undefined;
      try {
        const res = await client.getWorkflow(wfId);
        run = res.workflow;
      } catch {
        // 检查点暂不可达：保持 running 续轮询（下一轮再试），不立即判 failed。
        return;
      }
      const state = run?.state;
      if (state === 'done' || state === 'failed') {
        planExec = {
          ...planExec,
          [m.id]: {
            ...now,
            status: state,
            currentTaskId: undefined,
            ...(run ? { wfSnapshot: compactPlanWfSnapshot(run) } : {})
          }
        };
        if (state === 'done' && run) {
          const summaryMsgId = appendPlanDagSummary(sid, m, run);
          // P4.6 交付文件闭环（断连自愈收敛路径）。
          if (
            await attachPlanDeliverables(
              sid,
              m,
              summaryMsgId,
              planOutputsFromRun(run)
            )
          ) {
            saveHistory(sid);
          }
        }
        stopPlanWfReconcile(m.id);
      } else if (state === 'awaiting') {
        planExec = {
          ...planExec,
          [m.id]: { ...now, status: 'awaiting', currentTaskId: undefined }
        };
        // awaiting 仍需继续轮询（审批后引擎恢复执行）。
      } else {
        // running / 其它：保持 running，继续轮询
        planExec = {
          ...planExec,
          [m.id]: { ...now, status: 'running', currentTaskId: undefined }
        };
      }
    };
    stopPlanWfReconcile(m.id);
    void poll();
    planWfReconcileTimers = {
      ...planWfReconcileTimers,
      [m.id]: window.setInterval(() => void poll(), 2500)
    };
  }

  /** 取某条澄清卡的输入状态（惰性建卡：首次读写即落进 clarifyDraft）。 */
  function clarifyState(msgId: number): ClarifyDraftState {
    let st = clarifyDraft[msgId];
    if (!st) {
      st = { picks: {}, texts: {}, extra: '' };
      clarifyDraft[msgId] = st;
    }
    return st;
  }

  /** 点选/取消一个候选选项：重建状态对象触发重渲染以反映选中态。 */
  function toggleClarifyPick(msgId: number, qIdx: number, opt: string) {
    if (clarifyAnswered[msgId]) return;
    const prev = clarifyState(msgId);
    const key = String(qIdx);
    const cur = prev.picks[key] ?? [];
    const next = cur.includes(opt)
      ? cur.filter((x) => x !== opt)
      : [...cur, opt];
    clarifyDraft = {
      ...clarifyDraft,
      [msgId]: { ...prev, picks: { ...prev.picks, [key]: next } }
    };
  }

  /** 某题自定义补充：就地写入（Svelte 深响应代理自动传播，输入框不会失焦）。 */
  function setClarifyText(msgId: number, qIdx: number, val: string) {
    clarifyState(msgId).texts[String(qIdx)] = val;
  }

  /** 整体补充：就地写入。 */
  function setClarifyExtra(msgId: number, val: string) {
    clarifyState(msgId).extra = val;
  }

  /**
   * 计划模式（P0）：目标澄清卡「确认并继续」。把原需求 + 模型目标草稿 + 用户逐题
   * 回答 + 整体补充拼成新的 propose 输入再次派发。
   */
  async function confirmClarify(m: ChatMsg) {
    const sid = activeId;
    if (!sid || !m.clarify || clarifyAnswered[m.id]) return;
    if (streaming[sid]) return;
    clarifyAnswered = { ...clarifyAnswered, [m.id]: true };
    // 找澄清消息前面最近的一条用户消息 = 原始需求。
    const thread = threads[sid] ?? [];
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
    const st = clarifyState(m.id);
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
    await runRt.dispatchPrompt(sid, parts.join('\n\n'), [], {});
  }

  /** 确认/恢复计划：按拓扑序逐任务派发；任一任务失败或用户停止即立即中止。 */
  async function confirmPlan(m: ChatMsg) {
    const sid = activeId;
    if (!sid || !m.plan) return;
    // P5.4：用户主动重派发前，清除该计划的断连自愈轮询。
    stopPlanWfReconcile(m.id);
    const st = planExec[m.id];
    // pending=首次确认；failed=失败后从失败节点恢复。running/done/cancelled 不再进入。
    if (!st || (st.status !== 'pending' && st.status !== 'failed')) return;
    // P1（断点续跑）：确定性检查点键。
    const wfId = derivePlanWfId(sid, m.plan);
    // P3（多 agent DAG）：首次确认走服务端 DagEngine 并行执行；传输层失败整体回退串行。
    if (isPlanDagEnabled() && st.status === 'pending') {
      const ok = await confirmPlanViaWorkflow(m, st, sid, wfId);
      if (ok) return;
      // 回退：DAG 未进入终态 → 重置为可重入 pending，继续走下方串行派发。
      planExec = {
        ...planExec,
        [m.id]: { ...st, status: 'pending', currentTaskId: undefined }
      };
    }
    // P1：failed 态「从失败任务继续」优先走 DAG 检查点续跑；DAG 不可达回退串行 resume。
    if (isPlanDagEnabled() && st.status === 'failed') {
      const ok = await resumePlanViaWorkflow(m, st, sid, wfId);
      if (ok) return;
      // 回退：DAG 续跑未进入终态 → 保留 failed，继续走下方串行从失败任务重派发。
      planExec = {
        ...planExec,
        [m.id]: { ...st, status: 'failed', currentTaskId: undefined }
      };
    }
    let cur: PlanExecState = { ...st, status: 'running' };
    planExec = { ...planExec, [m.id]: cur };
    // P5 静默执行：串行路径同样不把任务消息进气泡。
    const taskOutputs: Record<string, string> = {};
    quietPlanSink = { msgId: m.id };
    try {
      for (const task of m.plan.tasks) {
        // 已完成的任务（上次成功跑完的）直接跳过：恢复执行只重跑失败节点及其后续。
        if (cur.done[task.id]) continue;
        // 每个任务派发前刷新当前任务标记 + 重置思考面板。
        cur = {
          ...cur,
          status: 'running',
          currentTaskId: task.id,
          thinking: { taskId: task.id, text: '' }
        };
        planExec = { ...planExec, [m.id]: cur };
        // 派发前落盘进度：镜像永远表达「正在执行 tX + 之前已完成」。
        saveHistory(sid);
        const parts = [`【计划任务 ${task.id}】${task.title}`];
        if (task.steps.length) {
          parts.push('步骤：', ...task.steps.map((s, i) => `${i + 1}. ${s}`));
        }
        parts.push(`预期产出：${task.expectedOutput || '—（按任务目标交付）'}`);
        // 产出自包含铁律：每个任务派发时都带上硬性执行要求。
        parts.push(
          '执行要求（硬性）：把本任务产出完整写入你的回复正文，不要只给出文件路径或摘要；',
          '禁止要求用户粘贴、搬运或补充任何上游任务产出 —— 上游产出要么已在下方注入，要么基于任务目标自行合理补全。'
        );
        // 串行路径的共享黑板：把已完成的依赖任务产出注入派发 prompt。
        const upstreamDeps = task.dependsOn ?? [];
        if (upstreamDeps.length) {
          parts.push('上游任务产出（自动注入，直接使用，勿向用户索要）：');
          for (const dep of upstreamDeps) {
            const out = (taskOutputs[dep] ?? '').trim();
            parts.push(
              out
                ? `--- ${dep} ---\n${
                    out.length > PLAN_UPSTREAM_OUTPUT_MAX
                      ? out.slice(0, PLAN_UPSTREAM_OUTPUT_MAX) + '…（已截断）'
                      : out
                  }`
                : `--- ${dep} ---（本次未留存该上游产出：请勿向用户索要，按任务目标自行补全相关内容。）`
            );
          }
        }
        const result = await runRt.dispatchPrompt(
          sid,
          parts.join('\n'),
          [],
          {
            planTask: true,
            // 联网能力对齐：任务执行继承 propose 时的联网开关（planWeb）。
            web: web || m.planWeb === true || undefined,
            // P5 静默执行：任务消息对标记 quiet（不渲染 / 不落历史镜像）。
            quiet: true
          }
        );
        if (result !== 'ok') {
          // 中断的部分产出不再展示（quiet 对移出线程）。
          stripQuietTail(sid);
          if (result === 'error') {
            // 任务执行失败：记录失败节点并置 failed 态。
            cur = {
              ...cur,
              status: 'failed',
              failedTaskId: task.id,
              currentTaskId: undefined,
              thinking: undefined
            };
          } else {
            // 用户手动停止：中止剩余任务并标记取消。
            cur = {
              ...cur,
              status: 'cancelled',
              currentTaskId: undefined,
              thinking: undefined
            };
          }
          planExec = { ...planExec, [m.id]: cur };
          // 终态必须落历史镜像。
          saveHistory(sid);
          return;
        }
        // 抽取本任务产出（隐藏 assistant 消息正文），随后把 quiet 消息对移出线程。
        const tOut = threadFor(sid);
        const outMsg = tOut[tOut.length - 1];
        taskOutputs[task.id] = typeof outMsg?.content === 'string' ? outMsg.content : '';
        stripQuietTail(sid);
        cur = {
          ...cur,
          done: { ...cur.done, [task.id]: true },
          failedTaskId: undefined,
          thinking: undefined
        };
        planExec = { ...planExec, [m.id]: cur };
      }
    } finally {
      quietPlanSink = null;
    }
    // 全部完成：回挂「摘要 + 最终结果」。
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
      const out = taskOutputs[task.id] ?? '';
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
    const tFinal = threadFor(sid);
    const summaryMsgId = nextId++;
    tFinal.push({ id: summaryMsgId, role: 'assistant', content: lines.join('\n') });
    threads[sid] = tFinal;
    if (activeId === sid) messages = [...tFinal];
    // 先置 done 再 attach：attachPlanDeliverables 仅在 planExec.status==='done' 时工作。
    cur = {
      ...cur,
      status: 'done',
      currentTaskId: undefined,
      failedTaskId: undefined,
      thinking: undefined
    };
    planExec = { ...planExec, [m.id]: cur };
    // P4.6 交付文件闭环。
    await attachPlanDeliverables(sid, m, summaryMsgId, taskOutputs);
    // P5：串行回退路径「摘要 + 最终结果」需落历史镜像。
    saveHistory(sid);
  }

  /**
   * P5 静默执行：把线程尾部连续的 quiet 消息（最多 user + assistant 两条）移出线程。
   */
  function stripQuietTail(sid: string) {
    const t = threadFor(sid);
    let removed = 0;
    while (t.length && t[t.length - 1]?.quiet && removed < 2) {
      t.pop();
      removed++;
    }
    if (removed) {
      threads[sid] = t;
      if (activeId === sid) messages = [...t];
    }
  }

  /**
   * P5.4 停止按钮统一入口：计划 DAG 执行中优先中止 DAG 流（planWfAbort），
   * 普通 run 才走 runRt.stop()。
   */
  function stopActiveRun(): void {
    if (planWfAbort) {
      const wfId = planWfActiveId;
      planWfAbort.abort();
      if (wfId) {
        void client.cancelWorkflow(wfId).catch(() => {});
      }
      return;
    }
    runRt.stop();
  }

  function cancelPlan(msgId: number) {
    const st = planExec[msgId];
    if (!st || st.status !== 'pending') return;
    planExec = {
      ...planExec,
      [msgId]: { ...st, status: 'cancelled' }
    };
  }

  /**
   * P3（人工审批门）：卡片 / 抽屉「批准并继续」入口。
   */
  async function approvePlanAction(m: ChatMsg, stepId?: string): Promise<void> {
    const sid = activeId;
    if (!sid || !m.plan) return;
    const st = planExec[m.id];
    if (!st || st.status !== 'awaiting') return;
    if (!isPlanDagEnabled()) return;
    const wfId = derivePlanWfId(sid, m.plan);
    await approvePlanViaWorkflow(m, st, sid, wfId, stepId);
  }

  /**
   * P3（多 agent DAG）：把确认后的 ExecutionPlan 发给服务端 DagEngine 并行执行。
   * @returns true = DAG 进入终态；false = 传输层失败，调用方重置 pending 并回退串行。
   */
  async function confirmPlanViaWorkflow(
    m: ChatMsg,
    st: PlanExecState,
    sid: string,
    wfId: string
  ): Promise<boolean> {
    if (!m.plan) return false;
    const taskIds = new Set(m.plan.tasks.map((t) => t.id));
    const ac = new AbortController();
    planWfAbort = ac;
    planWfActiveId = wfId;
    // 复用「流式中」标记：停止按钮亮起、发送按钮隐藏。
    streaming = { ...streaming, [sid]: true };
    planExec = { ...planExec, [m.id]: { ...st, status: 'running' } };
    let terminal: boolean;
    try {
      const byok = await planWfByok(m);
      const source: AsyncGenerator<unknown> = client.streamWorkflowFromPlan(
        m.plan,
        {
          agentRef: agentId || undefined,
          mode,
          ...byok,
          // P2-3：来源会话 id，服务端据此把 DAG 执行进度同步到 PlanStore。
          sessionId: sid,
          // P1：确定性检查点键。
          workflowId: wfId,
          signal: ac.signal
        }
      );
      terminal = await consumePlanWfStream(
        m,
        st,
        sid,
        taskIds,
        ac,
        source,
        'first'
      );
    } finally {
      planWfAbort = null;
      planWfActiveId = null;
      streaming = { ...streaming, [sid]: false };
      rtVersion++;
    }
    if (terminal) saveHistory(sid);
    return terminal;
  }

  /**
   * P1（断点续跑）：failed 态经服务端 POST /api/workflows/:id/resume 从检查点续跑。
   * @returns true = 续跑进入终态；false = 传输层异常 → 调用方回退串行 resume 兜底。
   */
  async function resumePlanViaWorkflow(
    m: ChatMsg,
    st: PlanExecState,
    sid: string,
    wfId: string
  ): Promise<boolean> {
    if (!m.plan) return false;
    const taskIds = new Set(m.plan.tasks.map((t) => t.id));
    const ac = new AbortController();
    planWfAbort = ac;
    planWfActiveId = wfId;
    streaming = { ...streaming, [sid]: true };
    planExec = { ...planExec, [m.id]: { ...st, status: 'running', thinking: undefined } };
    let terminal: boolean;
    try {
      const byok = await planWfByok(m);
      const source: AsyncGenerator<unknown> = client.streamWorkflowResume(
        wfId,
        {
          mode,
          ...byok,
          sessionId: sid,
          signal: ac.signal
        }
      );
      terminal = await consumePlanWfStream(
        m,
        st,
        sid,
        taskIds,
        ac,
        source,
        'resume'
      );
    } finally {
      planWfAbort = null;
      planWfActiveId = null;
      streaming = { ...streaming, [sid]: false };
      rtVersion++;
    }
    if (terminal) saveHistory(sid);
    return terminal;
  }

  /**
   * P3（人工审批门）：awaiting 态经服务端 POST /api/workflows/:id/approve 放行审批门。
   * 传输层异常保留 awaiting（不回退串行：串行路径无审批门）。
   */
  async function approvePlanViaWorkflow(
    m: ChatMsg,
    st: PlanExecState,
    sid: string,
    wfId: string,
    stepId?: string
  ): Promise<boolean> {
    if (!m.plan) return false;
    const taskIds = new Set(m.plan.tasks.map((t) => t.id));
    const ac = new AbortController();
    planWfAbort = ac;
    planWfActiveId = wfId;
    streaming = { ...streaming, [sid]: true };
    planExec = {
      ...planExec,
      [m.id]: { ...st, status: 'running', awaitingTaskIds: undefined, thinking: undefined }
    };
    let terminal: boolean;
    try {
      const byok = await planWfByok(m);
      const source: AsyncGenerator<unknown> = client.streamWorkflowApprove(
        wfId,
        {
          stepId,
          all: !stepId,
          mode,
          ...byok,
          sessionId: sid,
          signal: ac.signal
        }
      );
      terminal = await consumePlanWfStream(
        m,
        st,
        sid,
        taskIds,
        ac,
        source,
        'approve'
      );
    } finally {
      planWfAbort = null;
      planWfActiveId = null;
      streaming = { ...streaming, [sid]: false };
      rtVersion++;
    }
    if (terminal) saveHistory(sid);
    return terminal;
  }

  /**
   * P6（分叉重跑）：抽屉「从此步重跑」——把指定任务及其全部下游重置后重新执行。
   */
  async function planRerunFrom(m: ChatMsg, taskId: string): Promise<void> {
    const sid = activeId;
    if (!sid || !m.plan) return;
    const st = planExec[m.id];
    if (!st || st.status === 'running') return; // running 不可分叉（服务端同语义 409）
    if (!m.plan.tasks.some((t) => t.id === taskId)) return;
    stopPlanWfReconcile(m.id);
    const downstream = planDownstreamTaskIds(m.plan.tasks, taskId);
    const done = { ...st.done };
    for (const id of downstream) delete done[id];
    const wfId = derivePlanWfId(sid, m.plan);
    if (isPlanDagEnabled()) {
      try {
        await client.rerunWorkflow(wfId, taskId);
      } catch {
        // 重置失败（404 检查点丢失 / 409 在跑 / 未知 step）：保持现状可重试。
        return;
      }
      const ok = await resumePlanViaWorkflow(
        m,
        { ...st, done, status: 'failed', failedTaskId: undefined, currentTaskId: undefined },
        sid,
        wfId
      );
      if (ok) return;
      // 续跑传输层失败：卡片收敛 failed（检查点已重置，可再点「从失败任务继续」）。
      planExec = {
        ...planExec,
        [m.id]: {
          ...(planExec[m.id] ?? st),
          status: 'failed',
          currentTaskId: undefined
        }
      };
      saveHistory(sid);
      return;
    }
    // 串行模式：无检查点，退化为「清下游 done 重派发」。
    planExec = {
      ...planExec,
      [m.id]: {
        ...st,
        done,
        status: 'failed',
        failedTaskId: undefined,
        currentTaskId: undefined
      }
    };
    saveHistory(sid);
    await confirmPlan(m);
  }

  /**
   * 共享的 BYOK 载荷构造：与串行 run 载荷同构。
   */
  async function planWfByok(m?: ChatMsg): Promise<{
    model?: string;
    modelBaseUrl?: string;
    modelApiKey?: string;
    ctxWindow?: number;
    web?: boolean;
  }> {
    const endpoint = await customModelEndpoint();
    return {
      model: model || undefined,
      ctxWindow: serverCtxWindow > 0 ? serverCtxWindow : undefined,
      modelBaseUrl: endpoint.modelBaseUrl,
      modelApiKey: endpoint.modelApiKey,
      // 联网能力对齐：计划执行继承 propose 当时的开关（planWeb）。
      web: web || m?.planWeb === true || undefined
    };
  }

  /**
   * 共享事件流消费器（首跑 / 续跑 / 审批共用）。
   * @returns 是否进入终态（调用方 true 时不再走串行路径）。
   */
  async function consumePlanWfStream(
    m: ChatMsg,
    st: PlanExecState,
    sid: string,
    taskIds: Set<string>,
    ac: AbortController,
    source: AsyncGenerator<unknown>,
    kind: 'first' | 'resume' | 'approve'
  ): Promise<boolean> {
    // 此处保留初始化值（不可去掉）：catch 分支「首跑传输层异常回退串行」不赋值
    // 直接 return terminal，初始化的 false 正是兜底语义。
    let terminal = false;
    try {
      for await (const ev of source) {
        if (ac.signal.aborted) break;
        const e = ev as unknown as PlanWfEvent & {
          run?: PlanWfRunSnapshot;
          message?: string;
        };
        // wf:step:* 驱动卡片状态机。
        const prev = planExec[m.id] ?? st;
        const next = applyPlanWfEvent(prev, e, taskIds);
        if (next !== prev) {
          planExec = { ...planExec, [m.id]: next };
        }
        // P5 静默执行：嵌套 harness 事件中只消费 llm:reasoning。
        const he = (e as { event?: { type?: string; delta?: unknown } }).event;
        if (he?.type === 'llm:reasoning') {
          const heStepId = (e as { stepId?: string }).stepId;
          // 非本计划任务的思考流（补偿 step 等）不进面板。
          const sidOk = !heStepId || taskIds.has(heStepId);
          const prevT = planExec[m.id] ?? st;
          const nextT = sidOk ? applyPlanThinking(prevT, String(he.delta ?? ''), heStepId) : prevT;
          if (nextT !== prevT) {
            planExec = { ...planExec, [m.id]: nextT };
          }
        }
        if (e.type === 'wf:done' || e.type === 'wf:failed') {
          // 编排终态：回挂摘要并停止消费后续帧。
          const summaryMsgId = appendPlanDagSummary(sid, m, e.run);
          // P4.6 交付文件闭环：done 时归档汇总报告。
          if (e.type === 'wf:done') {
            await attachPlanDeliverables(
              sid,
              m,
              summaryMsgId,
              planOutputsFromRun(e.run)
            );
          }
          // P2.6：终态快照紧凑化落入 planExec。
          const snap = compactPlanWfSnapshot(e.run);
          const cur = planExec[m.id] ?? st;
          planExec = {
            ...planExec,
            [m.id]: { ...cur, ...(snap ? { wfSnapshot: snap } : {}) }
          };
          terminal = true;
          break;
        }
        if (e.type === '_wf_done') {
          // 服务端收尾帧兜底（终态帧被 SSE 解析丢失时仍能从 run 快照还原摘要）。
          const run = e.run;
          const s = planExec[m.id] ?? st;
          // P3：审批门暂停不是编排终态。
          const rs = run?.state;
          const awaitingIds =
            rs === 'awaiting'
              ? Object.values(run?.steps ?? {})
                  .filter((x) => x?.state === 'awaiting')
                  .map((x) => x.id ?? '')
                  .filter(Boolean)
              : [];
          if (run?.steps && rs !== 'awaiting') {
            const summaryMsgId2 = appendPlanDagSummary(sid, m, run);
            // P4.6：先收敛 planExec 终态再 attach。
            if (rs === 'done') {
              planExec = {
                ...planExec,
                [m.id]: { ...s, status: 'done', currentTaskId: undefined }
              };
              await attachPlanDeliverables(
                sid,
                m,
                summaryMsgId2,
                planOutputsFromRun(run)
              );
            }
          }
          // P2.6：收尾帧兜底同样落快照。
          const snap = compactPlanWfSnapshot(run);
          planExec = {
            ...planExec,
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
          // 请求级失败：首跑重置可重入 pending；续跑保留 failed；审批路径保留 awaiting。
          planExec = {
            ...planExec,
            [m.id]: {
              ...(planExec[m.id] ?? st),
              status:
                kind === 'first'
                  ? 'pending'
                  : kind === 'resume'
                  ? 'failed'
                  : 'awaiting',
              currentTaskId: undefined,
              // 终态/失败分支一律清掉思考面板残留标签。
              thinking: undefined
            }
          };
          terminal = kind !== 'resume';
          break;
        }
      }
      // 用户手动停止：保留已完成任务，标 cancelled。
      if (ac.signal.aborted) {
        stopPlanWfReconcile(m.id);
        planExec = {
          ...planExec,
          [m.id]: {
            ...(planExec[m.id] ?? st),
            status: 'cancelled',
            currentTaskId: undefined,
            thinking: undefined
          }
        };
        terminal = true;
      } else if (!terminal) {
        // 流静默结束但未收到任何终态帧：P5.4 启动检查点轮询把卡片收敛到权威终态。
        terminal = true;
        reconcilePlanWfOnDisconnect(m, sid);
      }
    } catch (e: unknown) {
      if (ac.signal.aborted) {
        // 用户手动停止（SSE 迭代在 abort 时抛 AbortError 路径）。
        stopPlanWfReconcile(m.id);
        planExec = {
          ...planExec,
          [m.id]: {
            ...(planExec[m.id] ?? st),
            status: 'cancelled',
            currentTaskId: undefined,
            thinking: undefined
          }
        };
        terminal = true;
      } else if (kind === 'approve') {
        // P3 审批路径传输层异常：保留 awaiting，可再次点「批准并继续」重试。
        planExec = {
          ...planExec,
          [m.id]: {
            ...(planExec[m.id] ?? st),
            status: 'awaiting',
            currentTaskId: undefined
          }
        };
        terminal = false;
      } else if (kind === 'resume') {
        // 续跑传输层异常：保留 failed → 调用方回退串行 resume 兜底。
        planExec = {
          ...planExec,
          [m.id]: {
            ...(planExec[m.id] ?? st),
            status: 'failed',
            currentTaskId: undefined
          }
        };
        terminal = false;
      } else {
        // 首跑传输层异常：提示 + 重置 pending，回退串行路径。
        notifyError(e, { title: '计划执行中断', key: `plan-wf-${m.id}` });
        planExec = {
          ...planExec,
          [m.id]: {
            ...(planExec[m.id] ?? st),
            status: 'pending',
            currentTaskId: undefined
          }
        };
      }
    }
    return terminal;
  }

  /**
   * P3：把计划 DAG 执行摘要回挂线程。run 快照缺失时仍给出按 task 的状态清单。
   */
  function appendPlanDagSummary(
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
    const t = threadFor(sid);
    const msgId = nextId++;
    t.push({ id: msgId, role: 'assistant', content: lines.join('\n') });
    threads[sid] = t;
    if (activeId === sid) messages = [...t];
    return msgId;
  }

  /**
   * P4.6（交付文件闭环）：plan 终态后把「可下载结果文件」接到执行摘要消息上。
   * @returns 是否修改了摘要消息（供调用方判断是否需要 saveHistory 落盘）。
   */
  async function attachPlanDeliverables(
    sid: string,
    m: ChatMsg,
    summaryMsgId: number | undefined,
    outputs: Record<string, string>
  ): Promise<boolean> {
    if (summaryMsgId == null || !m.plan) return false;
    // 仅成功完成的计划才交付文件（failed / cancelled 无「最终交付物」）。
    if (!planDeliverablesEnabled(planExec[m.id]?.status)) return false;
    const wfId = derivePlanWfId(sid, m.plan);
    const hasOutput = Object.values(outputs).some((s) => s && s.trim());
    if (hasOutput) {
      try {
        // 幂等检查：本 runId 已有汇总报告（resume 重放 / 多重接线）则跳过归档。
        let alreadyArchived = false;
        const listRes = await authedFetch(
          `/api/artifacts?runId=${encodeURIComponent(wfId)}`
        );
        if (listRes.ok) {
          const data = (await listRes.json()) as {
            items?: Array<{ note?: string }>;
          };
          alreadyArchived = (data.items ?? []).some(
            (a) => a?.note === PLAN_FINAL_ARTIFACT_NOTE
          );
        }
        if (!alreadyArchived) {
          // attach 仅在 status==='done' 时到达 → 报告状态清单全部按 done 呈现。
          const report = buildPlanFinalReport(
            m.plan.goal,
            m.plan.tasks.map((t) => ({
              id: t.id,
              title: t.title,
              state: 'done' as const
            })),
            outputs
          );
          // UTF-8 安全的 base64（btoa 仅接受 latin1，先经 TextEncoder 逐字节桥接）。
          const bytes = new TextEncoder().encode(report);
          let bin = '';
          for (const b of bytes) bin += String.fromCharCode(b);
          const postRes = await authedFetch('/api/artifacts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: buildPlanReportFileName(m.plan.goal),
              kind: 'plan-step-output',
              mimeType: 'text/markdown',
              contentBase64: btoa(bin),
              runId: wfId,
              note: PLAN_FINAL_ARTIFACT_NOTE
            })
          });
          if (!postRes.ok) {
            console.warn(
              `[plan-artifacts] 汇总报告归档失败（不阻断）：HTTP ${postRes.status}`
            );
          }
        }
      } catch (e) {
        console.warn(
          `[plan-artifacts] 汇总报告归档失败（不阻断）：${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    }
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
    const t = threadFor(sid);
    const msg = t.find((x) => x.id === summaryMsgId);
    if (!msg) return false;
    msg.content = `${msg.content}${section}`;
    threads[sid] = t;
    if (activeId === sid) messages = [...t];
    return true;
  }

  /**
   * P4.6 恢复自愈：刷新 / 切回会话后，把「📎 交付文件」区重挂到已完成计划的执行摘要上。
   */
  async function reattachPlanDeliverables(sid: string): Promise<void> {
    const t = threads[sid];
    if (!t?.length) return;
    // 先扫描需要自愈的（plan + status==='done' + content 尚无交付区）消息。
    const targets = t.filter(
      (m) =>
        !!m.plan &&
        planExec[m.id]?.status === 'done' &&
        !hasPlanArtifactSection(m.content)
    );
    if (!targets.length) return;
    let changed = false;
    for (const m of targets) {
      try {
        const wfId = derivePlanWfId(sid, m.plan!);
        const res = await authedFetch(
          `/api/artifacts?runId=${encodeURIComponent(wfId)}`
        );
        if (!res.ok) continue;
        const data = (await res.json()) as {
          items?: Array<{ id: string; name: string; sizeBytes: number }>;
        };
        const section = buildPlanArtifactSection(
          Array.isArray(data.items) ? data.items : []
        );
        if (!section) continue;
        // 双检：await 期间消息可能已被并发 attach —— 再查一次标记。
        const cur = threads[sid]?.find((x) => x.id === m.id);
        if (!cur || hasPlanArtifactSection(cur.content)) continue;
        cur.content = `${cur.content}${section}`;
        changed = true;
      } catch {
        /* 静默：镜像/接口任一环失败都不打断恢复 */
      }
    }
    if (changed) {
      // 触发重渲染（threads 数组替换引用；active 会话同步 messages）。
      threads[sid] = [...(threads[sid] ?? [])];
      if (activeId === sid) messages = threads[sid];
    }
  }

  /* ── 渲染后副作用（原 updated()）────────────────────────────── */

  // role 变化 → 重拉 agent 列表（untrack 防止 agents 状态写入造成循环触发）。
  $effect(() => {
    const r = role;
    untrack(() => {
      if (r !== undefined) void refreshAgents();
    });
  });

  // 消息/计划状态变化后：重放富文本块折叠态 + 钉底跟随（原 updated() 语义）。
  $effect(() => {
    void messages;
    void planExec;
    // 必须在滚动之前：折叠会改变内容高度，同步重排后 scrollToBottom 才取到正确值。
    applyFolds();
    scrollToBottom();
    scrollThinkToBottom();
  });

  /* ── 模板事件适配器（CustomEvent detail 解包）────────────────── */

  function onCommandSelectEv(e: Event) {
    onCommandSelect((e as CustomEvent<{ name: string }>).detail.name);
  }

  function onFilesSelectEv(e: Event) {
    void handleFiles((e as CustomEvent<{ files: File[] }>).detail.files);
  }

  function onRemoveAttachmentEv(e: Event) {
    removeAttachment((e as CustomEvent<{ index: number }>).detail.index);
  }

  function onModeChangeEv(e: Event) {
    setInteractionMode((e as CustomEvent<{ value: 'qa' | 'plan' }>).detail.value);
  }

  function onAgentChangeEv(e: Event) {
    const v = (e as CustomEvent<{ value: string }>).detail.value;
    agentId = v;
    void persistSessionSettings({ agentId: v });
  }

  function onModelChangeEv(e: Event) {
    const d = (
      e as CustomEvent<{
        model: string;
        ctx?: number;
        baseUrl?: string;
      }>
    ).detail;
    model = d.model;
    // 仅当选中模型带官方上下文窗口时更新分母；否则清零。
    serverCtxWindow = d.ctx && d.ctx > 0 ? d.ctx : 0;
    if (typeof d.baseUrl === 'string') modelBaseUrl = d.baseUrl;
    try {
      localStorage.setItem('ah_model', model);
    } catch {
      /* ignore */
    }
    void persistSessionSettings({ model: d.model });
  }

  function onThinkChangeEv(e: Event) {
    deepThink = (e as CustomEvent<{ value: boolean }>).detail.value;
    try {
      localStorage.setItem('ah_deep_think', deepThink ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  function onWebChangeEv(e: Event) {
    web = (e as CustomEvent<{ value: boolean }>).detail.value;
    try {
      localStorage.setItem('ah_web', web ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  function onCtxChangeEv(e: Event) {
    const d = (e as CustomEvent<{ ctx: number }>).detail;
    // 模型目录回抛的官方上下文窗口：有则显示用量圆环，无则隐藏。
    serverCtxWindow = d.ctx && d.ctx > 0 ? d.ctx : 0;
  }

  /** 深度思考快捷开关（chat-head）。 */
  function toggleDeepThink() {
    deepThink = !deepThink;
    try {
      localStorage.setItem('ah_deep_think', deepThink ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  /** 联网搜索快捷开关（chat-head）。 */
  function toggleWeb() {
    web = !web;
    try {
      localStorage.setItem('ah_web', web ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  /** 跳转设置（Mock 提示条 / BYOK gating）。 */
  function gotoSettings() {
    window.dispatchEvent(new CustomEvent(APP_EVENTS.goto, { detail: 'settings' }));
  }

  /** 编辑态输入框事件适配。 */
  function onEditingInputEv(e: Event) {
    editingDraft = (e.target as HTMLTextAreaElement).value;
  }

  /** 编辑态键盘事件（Enter 发送 / Esc 取消）。 */
  function onEditKeydown(e: KeyboardEvent, m: ChatMsg) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendEdit(m.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  /** 全屏编辑器输入事件适配。 */
  function onFeInputEv(e: Event) {
    editingDraft = (e.target as HTMLTextAreaElement).value;
  }

  /** 会话列表底部「加载失败重试」。 */
  function retryLoadSessions() {
    sessionsMoreError = false;
    void loadMoreSessions();
  }
</script>

<!-- 面板根元素：hidden 由 App 壳 visible 驱动（常驻挂载保留状态）。
     整屏拖拽上传事件挂在根元素上 —— 铺满 .ah-c，「拖到 chat 任意位置」都能被接住。 -->
<div
  class="ah-c chat-root"
  hidden={!visible}
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  bind:this={rootEl}
>
  <div
    class="sidebar"
    class:open={sidebarOpen}
    class:collapsed={sidebarCollapsed}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="side-head">
      <button
        class="collapse-btn"
        title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        onclick={() => toggleSidebarCollapse()}
      >
        {sidebarCollapsed ? '›' : '‹'}
      </button>
      <button class="primary new-btn" onclick={() => newChat()}>
        ＋ 新对话
      </button>
      <!-- 移动端关闭按钮：侧边栏为 fixed 抽屉，需要显式关闭入口（≤900px 显示） -->
      <button
        class="close-btn"
        title="关闭会话列表"
        aria-label="关闭会话列表"
        onclick={() => toggleSidebar()}
      >
        ✕
      </button>
    </div>
    <div
      class="session-list"
      role="list"
      aria-busy={sessionsLoadingMore ? 'true' : 'false'}
      onscroll={onSessionListScroll}
      ontouchstart={onSessionListTouchStart}
      ontouchmove={onSessionListTouchMove}
      ontouchend={onSessionListTouchEnd}
      ontouchcancel={onSessionListTouchEnd}
      bind:this={sessionListEl}
    >
      <!-- 下拉刷新指示器：触屏在列表顶部下拉时滑入；桌面端 opacity:0 不可见、不响应 -->
      <div class="pull-refresh" aria-hidden="true">
        <span class="spinner"></span>
        <span class="pull-hint">下拉刷新</span>
      </div>
      <div class="session-inner" bind:this={sessionInnerEl}>
        {#if sessions.length === 0}
          <p class="muted">暂无会话，发送消息即自动创建。</p>
        {:else}
          {#each sessions as s (s.id)}
            <!-- 通用滑动项：触屏左滑行内容露出右侧「重命名/删除」操作区。 -->
            <AhSwipeItem id={s.id} group="chat-sessions">
              <div
                class="session"
                class:active={s.id === activeId}
                role="listitem"
                onclick={() => selectSessionImpl(s.id)}
              >
                <span class="dot"></span>
                <span class="title">{s.title}</span>
                <span class="acts">
                  <button
                    class="icon-btn"
                    title="重命名"
                    onclick={(e) => {
                      e.stopPropagation();
                      void renameSession(s.id);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    class="icon-btn"
                    title="删除"
                    onclick={(e) => {
                      e.stopPropagation();
                      void deleteSession(s.id);
                    }}
                  >
                    🗑
                  </button>
                </span>
              </div>
              {#snippet actions()}
                <div>
                  <button
                    class="swipe-act"
                    title="重命名"
                    aria-label="重命名会话"
                    onclick={() => void renameSession(s.id)}
                  >
                    重命名
                  </button>
                  <button
                    class="swipe-act danger"
                    title="删除"
                    aria-label="删除会话"
                    onclick={() => void deleteSession(s.id)}
                  >
                    删除
                  </button>
                </div>
              {/snippet}
            </AhSwipeItem>
          {/each}
        {/if}
        <!-- 会话列表底部状态行：加载中 / 失败重试 / 加载更多 / 没有更多了。 -->
        {#if sessions.length > 0}
          {#if sessionsLoadingMore}
            <div class="session-more" role="status" aria-live="polite">
              <span class="spinner"></span><span>加载中…</span>
            </div>
          {:else if sessionsMoreError}
            <button class="session-more retry" onclick={retryLoadSessions}>
              加载失败，点击重试
            </button>
          {:else if sessionsHasMore}
            <button class="session-more" onclick={() => void loadMoreSessions()}>
              加载更多
            </button>
          {:else if sessions.length > SESSION_PAGE_SIZE}
            <p class="session-end">没有更多了</p>
          {/if}
        {/if}
      </div>
    </div>
  </div>

  <div class="main">
    <div class="chat-head">
      <button
        class="menu-btn"
        onclick={() => toggleSidebar()}
        title="会话列表"
        aria-label="会话列表"
      >
        <!-- 对话气泡 + 文字行图标：语义为「会话/历史列表」 -->
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
      <span class="title">{activeTitle || '新对话'}</span>
      <span class="spacer"></span>
      <!-- 新对话：仅移动端显示（≤900px）。 -->
      <button
        class="new-chat-btn"
        title="新对话"
        aria-label="新对话"
        onclick={() => newChat()}
      >
        <!-- 气泡 + 加号：语义「新开一段对话」 -->
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
        class="tool-toggle"
        class:on={deepThink}
        title="深度思考"
        aria-pressed={deepThink}
        onclick={toggleDeepThink}
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
        class="tool-toggle"
        class:on={web}
        title="联网搜索"
        aria-pressed={web}
        onclick={toggleWeb}
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
        bind:this={scrollEl}
        onscroll={onScrollFollow}
      >
        {#if sessionLoading}
          <!-- 内容区骨架屏：与真实消息共用同一套尺寸规格，加载态 → 内容态不位移。 -->
          <div
            class="thread sk-thread"
            role="status"
            aria-busy="true"
            aria-label="正在加载历史会话"
          >
            <div class="sk-msg user">
              <div class="sk-avatar"></div>
              <div class="sk-bubble">
                <div class="sk-line" style="--w:100%"></div>
                <div class="sk-line" style="--w:54%"></div>
              </div>
            </div>
            <div class="sk-msg assistant">
              <div class="sk-avatar"></div>
              <div class="sk-bubble">
                <div class="sk-line" style="--w:86%"></div>
                <div class="sk-line" style="--w:90%"></div>
                <div class="sk-line" style="--w:82%"></div>
                <div class="sk-line" style="--w:50%"></div>
              </div>
            </div>
            <div class="sk-msg user">
              <div class="sk-avatar"></div>
              <div class="sk-bubble short">
                <div class="sk-line" style="--w:100%"></div>
              </div>
            </div>
            <div class="sk-msg assistant">
              <div class="sk-avatar"></div>
              <div class="sk-bubble">
                <div class="sk-line" style="--w:88%"></div>
                <div class="sk-line" style="--w:54%"></div>
              </div>
            </div>
          </div>
        {:else if messages.length === 0}
          <div class="empty">
            <h1>有什么可以帮你的？</h1>
            <p>基于 agent-harness 的多会话对话。下方输入即可开始。</p>
          </div>
        {:else}
          <div class="thread" onclick={onRichClick}>
            <!-- 连接状态横幅：connected 不显示；reconnecting 自动恢复提示；lost 给「重新连接」。 -->
            {#if connState[activeId] === 'reconnecting'}
              <div class="conn-banner warn">
                ⚠️ 连接中断，正在自动恢复会话…
              </div>
            {:else if connState[activeId] === 'lost'}
              <div class="conn-banner lost">
                <span
                  >⚠️
                  与服务器的连接已断开{jobFor(activeId)
                    ? ''
                    : '，本次运行已丢失'}</span
                >
                {#if jobFor(activeId)}
                  <button
                    class="conn-retry"
                    onclick={() => void runRt.resumeLost(activeId)}
                  >
                    重新连接
                  </button>
                {/if}
              </div>
            {/if}
            {#if !llmReady}
              <div
                style="display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:10px 14px;border:1px solid var(--ah-warning);background:var(--ah-warning-soft);color:var(--ah-warning);border-radius:var(--ah-radius-md,10px);font-size:13px;line-height:1.4;"
              >
                <span
                  >当前使用离线 Mock 模型，配置你的 API Key 后可使用真实模型。</span
                >
                <button
                  class="btn ghost"
                  style="margin-left:auto;color:var(--ah-warning);border-color:var(--ah-warning);"
                  onclick={gotoSettings}
                >
                  去配置
                </button>
              </div>
            {/if}
            {#each messages.filter((m) => !m.quiet) as m (m.id)}
              {@render message(m)}
            {/each}
          </div>
        {/if}
      </div>
      {#if showScrollDown}
        <button
          class="scroll-down"
          title="回到底部"
          aria-label="回到底部"
          onclick={scrollToBottomSmooth}
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
        </button>
      {/if}
    </div>

    <div class="composer-wrap">
      <div class="composer">
        {#if attachments.length > 0}
          <!-- 附件预览条：折叠态只渲染前 N 条，余量交给「+N」按钮（渲染与文案同源）。 -->
          <div
            class="attachments-preview"
            class:expanded={attachmentsExpanded}
            class:collapsed={!attachmentsExpanded}
            class:has-more={attachView.collapsedCount > 0}
          >
            <div class="attach-strip">
              {#each attachView.visible as f, i}
                <div
                  class="attach-preview-item"
                  class:error={f.uploadStatus === 'error'}
                  class:is-image={isPreviewable(f)}
                  onclick={() => openPreview(f)}
                >
                  {#if f.type.startsWith('image/')}
                    <img src={f.dataUrl} alt={f.name} class="attach-thumb" />
                  {:else}
                    <span class="attach-icon">{fileIcon(f)}</span>
                  {/if}
                  <span class="attach-name" title={f.name}>{f.name}</span>
                  {#if f.uploadStatus === 'uploading'}
                    <span class="attach-status uploading" title="上传中">⏳</span>
                  {:else if f.uploadStatus === 'done'}
                    <span class="attach-status done" title="已上传">✓</span>
                  {:else if f.uploadStatus === 'error'}
                    <span class="attach-err" title={f.uploadError || '上传失败'}></span>
                  {/if}
                  <button
                    type="button"
                    class="attach-rm"
                    title="移除"
                    onclick={(e) => {
                      // 阻止冒泡到外层卡片的 openPreview（点删除不应触发预览）。
                      e.stopPropagation();
                      removeAttachment(i);
                    }}
                  >
                    ×
                  </button>
                </div>
              {/each}
            </div>
            {#if attachView.collapsedCount > 0}
              <button
                type="button"
                class="attach-more"
                title={attachmentsExpanded
                  ? '收起'
                  : `另有 ${attachView.collapsedCount} 个附件已折叠，点击展开`}
                aria-expanded={attachmentsExpanded ? 'true' : 'false'}
                onclick={toggleAttachments}
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
                {attachmentsExpanded ? '收起' : `+${attachView.collapsedCount}`}
              </button>
            {/if}
          </div>
        {/if}
        <!-- Slash Command：选中命令后固化为胶囊，联想面板绝对定位浮在整个 composer 之上。 -->
        <!-- 事件经 bubbles DOM CustomEvent 冒泡；包装层（display:contents，零布局影响）
             承接监听。Svelte 5 中 on* 落在组件标签上只是普通 prop，不会挂 DOM 监听。 -->
        <div
          class="cmd-suggest-host"
          style="display: contents"
          {...{
            'oncommand-select': onCommandSelectEv,
            'oncommand-remove': () => onCommandRemove()
          }}
        >
          <AhCommandSuggestions value={input} selected={cmdName} />
        </div>
        <div class="composer-body">
          <textarea
            class="composer-input"
            rows="1"
            placeholder={cmdName
              ? `已选命令 /${cmdName}，输入参数后 ⏎ 执行（× 或 Backspace 移除）`
              : "您正在与 Agent 聊天，输入'/'获取更多能力，如'/plan'"}
            value={input}
            disabled={streaming[activeId] === true}
            oninput={onInput}
            onkeydown={onKey}
            bind:this={inputEl}
          ></textarea>
        </div>
        <div class="composer-footer">
          <div class="composer-footer-left">
            <!-- 「+」统一入口：文件 / 模式 / 专家三类能力收口到一个按钮 + 分区面板。 -->
            <div
              class="composer-plus-host"
              style="display: contents"
              {...{
                'onfiles-select': onFilesSelectEv,
                'onremove-attachment': onRemoveAttachmentEv,
                'onmode-change': onModeChangeEv,
                'onagent-change': onAgentChangeEv
              }}
            >
              <AhComposerPlus
                agents={agents}
                agentId={agentId}
                mode={interactionMode}
                attachments={attachments}
              />
            </div>
          </div>
          <div class="composer-footer-right">
            <div
              class="model-picker-host"
              style="display: contents"
              {...{
                'onmodel-change': onModelChangeEv,
                'onthink-change': onThinkChangeEv,
                'onweb-change': onWebChangeEv,
                'onctx-change': onCtxChangeEv
              }}
            >
              <ModelPicker model={model} deepThink={deepThink} web={web} />
            </div>
            {#if serverCtxWindow > 0 && activeId !== ''}
              <CtxRing
                usage={selectContextUsage({
                  backendUsage,
                  serverCtxWindow,
                  messages
                })}
                showCtxUsage={showCtxUsage}
                runCumulative={runCumulative}
                onToggle={() => (showCtxUsage = !showCtxUsage)}
                onClose={() => (showCtxUsage = false)}
              />
            {/if}
            {#if streaming[activeId] === true}
              <button
                class="send"
                title="停止"
                onclick={() => stopActiveRun()}
              >
                ■
              </button>
            {:else}
              <button
                class="send"
                title="发送"
                disabled={!input.trim()}
                onclick={() => void send()}
              >
                ↑
              </button>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>

  <div
    class="scrim"
    class:show={sidebarOpen}
    onclick={() => {
      if (_sidebarJustOpened) return;
      sidebarOpen = false;
    }}
  ></div>
  {#if fullscreenEditOpen}
    <div
      class="fullscreen-edit"
      oncontextmenu={(e) => e.stopPropagation()}
    >
      <div class="fe-head">
        <span class="fe-title">编辑消息</span>
        <!-- 收起按钮：CSS 边框画 chevron（旋转 L 形边框）。 -->
        <button
          type="button"
          class="fe-collapse"
          title="收起"
          aria-label="收起全屏编辑"
          onclick={() => void closeFullscreenEdit()}
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
        value={editingDraft}
        oninput={onFeInputEv}
        bind:this={feInputEl}
      ></textarea>
    </div>
  {/if}
  {#if previewFile}
    <div class="lightbox" onclick={() => closePreview()}>
      <button
        class="lightbox-close"
        title="关闭 (Esc)"
        onclick={(e: Event) => {
          e.stopPropagation();
          closePreview();
        }}
      >
        ×
      </button>
      <button
        class="lightbox-close"
        title="关闭 (Esc)"
        onclick={(e) => {
          e.stopPropagation();
          closePreview();
        }}
      >
        ×
      </button>
      <img
        src={previewFile.dataUrl}
        alt={previewFile.name}
        onclick={(e) => e.stopPropagation()}
      />
      <div class="lightbox-info">
        {previewFile.name} ·
        {formatSize(previewFile.size)}
      </div>
    </div>
  {/if}
  {@render traceDrawer()}
  {@render planWfReplayDrawer()}

  <!-- 整屏拖拽遮罩：覆盖整个 chat 区域；pointer-events:none 保证不干扰 drop 命中测试。 -->
  {#if dragActive}
    <div
      class="drop-overlay"
      class:full={attachRoom === 0}
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
        <!-- 已达上限时切换为「不可再添加」提示。 -->
        {#if attachRoom === 0}
          <div class="drop-overlay-title">已达上传上限</div>
          <div class="drop-overlay-hint">
            最多支持 {MAX_ATTACHMENTS}
            个文件，请先移除部分文件再添加
          </div>
        {:else}
          <div class="drop-overlay-title">松开即可添加文件</div>
          <div class="drop-overlay-hint">
            最多支持上传 {MAX_ATTACHMENTS} 个文件（还可添加
            {attachRoom} 个），支持常见文件类型
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
{#snippet imgAttachments(files: UploadedFile[])}
  {@const images = files.filter((f) => f.type.startsWith('image/'))}
  {@const first = images[0]}
  {#if first}
    {#if images.length === 1}
      <div class="attach-img is-previewable" title="点击预览" onclick={() => openPreview(first)}>
        <img src={first.dataUrl} alt={first.name} loading="lazy" />
      </div>
    {:else}
      {@const mid = (images.length - 1) / 2}
      <div class="attach-card">
        <div class="attach-card-stack" title="点击展开全部图片" onclick={expandAttachCard}>
          {#each images as f, i}
            <div class="attach-img" style={`--i:${i};--mid:${mid}`}>
              <img src={f.dataUrl} alt={f.name} loading="lazy" />
              {#if i === images.length - 1}
                <span class="attach-card-badge">{images.length} 张</span>
              {/if}
            </div>
          {/each}
        </div>
        <div class="attach-card-expanded">
          <div class="attach-card-head">
            <span>{images.length} 张图片</span>
            <button type="button" class="attach-card-collapse" title="收起图片" onclick={collapseAttachCard}>
              收起
            </button>
          </div>
          <div class="attach-card-grid">
            {#each images as f}
              <div class="attach-img is-previewable" title="点击预览" onclick={(e) => { e.stopPropagation(); openPreview(f); }}>
                <img src={f.dataUrl} alt={f.name} loading="lazy" />
              </div>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  {/if}
{/snippet}

{#snippet attachList(files: UploadedFile[])}
  {@const others = files.filter((f) => !f.type.startsWith('image/'))}
  {#if others.length > 0}
    <div class="attachments">
      {#each others as f}
        <div class="attach-file">
          {fileIcon(f)} {f.name} ({formatSize(f.size)})
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet message(m: ChatMsg)}
  {#if m.role === 'user'}
    {@const hasAttachments = !!(m.attachments && m.attachments.length > 0)}
    {@const hasImages = !!m.attachments?.some((f) => f.type.startsWith('image/'))}
    <!-- 编辑态：气泡原位替换为编辑框（草稿 + 取消/发送），不再展示原文。 -->
    {#if editingMsgId === m.id}
      <div class="msg user">
        <div class="avatar">你</div>
        <div class="bubble editing">
          <textarea
            class="edit-input"
            value={editingDraft}
            oninput={onEditingInputEv}
            onkeydown={(e) => onEditKeydown(e, m)}
            onpointerdown={onComposerPointerDown}
            onpointermove={onComposerPointerMove}
            onpointerup={onComposerPointerUp}
            oncontextmenu={onComposerContextMenu}
            bind:this={editInputEl}
          ></textarea>
          <div class="edit-actions">
            <button
              type="button"
              class="edit-btn"
              title="取消编辑 (Esc)"
              onclick={() => cancelEdit()}
            >
              取消
            </button>
            <button
              type="button"
              class="edit-btn primary"
              title="发送 (Enter)"
              disabled={
                !editingDraft.trim() ||
                streaming[activeId] === true ||
                editingDraft.trim() === editingOriginalContent.trim()
              }
              onclick={() => void sendEdit(m.id)}
            >
              发送 ↑
            </button>
          </div>
        </div>
      </div>
    {:else}
      <div class="msg user">
        <div class="avatar">你</div>
        <div class="user-col">
          {#if hasImages}
            {@render imgAttachments(m.attachments!)}
          {/if}
          <div class="bubble">
            {#if hasAttachments}
              {@render attachList(m.attachments!)}
            {/if}
            <div class="msg-text">{@html toRichHtml(m.content)}</div>
          </div>
          {#if m.content?.trim()}
            <div class="msg-actions" class:show={hoverUserMsgId === m.id}>
              <button
                type="button"
                class="msg-action"
                title={copiedMsgId === m.id ? '已复制' : '复制'}
                onclick={() => void copyMsgText(m.id, m.content)}
              >
                {#if copiedMsgId === m.id}
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                {:else}
                  <svg
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
                  </svg>
                {/if}
              </button>
              <button
                type="button"
                class="msg-action"
                title="编辑"
                disabled={streaming[activeId] === true}
                onclick={() => startEdit(m.id, m.content)}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  <path d="m15 5 4 4" />
                </svg>
              </button>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  {:else}
    <!-- 助手消息：合并视图 —— 深度思考（实时流式）在上，最终回答（分隔后）在下。 -->
    {@const sIdx = streamIdx[activeId] ?? -1}
    {@const isStreamingAssistant =
      streaming[activeId] === true &&
      sIdx >= 0 &&
      messages[sIdx]?.id === m.id &&
      m.role === 'assistant'}
    {@const isStopped = stoppedFor(activeId)}
    {@const showThinking = !!m.reasoning}
    {@const isThinking = isStreamingAssistant && !m.content}
    {@const isAnswering = isStreamingAssistant && !!m.content}
    {@const showCopy = !!m.content?.trim() && !isStreamingAssistant}
    <div class="msg assistant" class:error={!!m.error}>
      <div class="avatar">A</div>
      {#if showCopy}
        <button
          type="button"
          class="assistant-copy"
          class:done={copiedMsgId === m.id}
          title={copiedMsgId === m.id ? '已复制' : '复制'}
          onclick={() => void copyMsgText(m.id, m.content)}
        >
          {#if copiedMsgId === m.id}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          {:else}
            <svg
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
            </svg>
          {/if}
        </button>
      {/if}
      <div class="bubble">
        {#if m.planPhase && !m.plan && !m.clarify}
          {@render planPhase(m, isStreamingAssistant)}
        {/if}
        {#if (showThinking && deepThink) || (m.planPhase && !!m.reasoning)}
          {@render think(m, isThinking, m.planPhase ? 'plan' : 'think')}
        {/if}
        {#if showThinking && deepThink && (m.content || isStreamingAssistant)}
          <div class="sep"><span>回答</span></div>
        {/if}
        {#if m.planPhase && !m.plan && !m.clarify && isStreamingAssistant && !m.content}
          <!-- 计划 propose 进行中：阶段面板已提供实时反馈，不再叠加「模型正在回复…」占位。 -->
        {:else if m.planPhase && !m.plan && !m.clarify && !isStreamingAssistant && !m.content}
          <!-- 规划中断态：流已结束但计划/回答均未产出。 -->
          <div class="answer">
            <div class="msg-text placeholder plan-aborted">
              规划未完成：连接可能已中断或处理超时，请重新发送需求重试
            </div>
          </div>
        {:else}
          {@render answer(m, isAnswering, isStreamingAssistant, isStopped)}
        {/if}
        {#if m.clarify}
          {@render clarifyCard(m)}
        {/if}
        {#if m.plan}
          {@render planCard(m)}
        {/if}
        {@render extras(m, isStreamingAssistant)}
        {#if m.compressed}
          <div
            class="msg-compressed"
            title="历史上下文已达压缩阈值，最旧对话已被自动压缩/淘汰"
          >
            已压缩
          </div>
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet think(m: ChatMsg, isThinking: boolean, mode: 'think' | 'plan')}
  {@const parsed =
    m.reasoning && m.reasoning.trim() ? parseDeepThinking(m.reasoning) : null}
  {@const collapsed = isThinking
    ? false
    : String(m.id) in thinkCollapsed
    ? !!thinkCollapsed[String(m.id)]
    : deepThinkCollapsed}
  <div
    class="think"
    class:live={isThinking}
    class:collapsed={collapsed}
    data-mid={String(m.id)}
  >
    <div
      class="think-head"
      onclick={() => toggleThink(m.id)}
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
      <span class="think-title">{mode === 'plan' ? '规划思考' : '深度思考'}</span>
      {#if isThinking}
        <span class="think-status"
          >{mode === 'plan' ? '规划中' : '思考中'}<span class="dots"
            ><i></i><i></i><i></i></span
          ></span
        >
      {/if}
      {#if collapsed && m.reasoning}
        <span class="think-count">{m.reasoning.length} 字</span>
      {/if}
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
      {#if parsed}
        {#if parsed.vars.length}
          <div class="dvars">
            <div class="dvars-title">关键变量</div>
            <div class="dvars-grid">
              {#each parsed.vars as [k, v]}
                <div class="dvar">
                  <span class="dvar-k">{k}</span>
                  <span class="dvar-v">{v}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
        <div class="think-text">
          {#if parsed.text}
            {@html toRichHtml(parsed.text)}
          {:else}
            <span class="muted">（暂无推理内容）</span>
          {/if}
        </div>
      {:else}
        <div class="think-text muted">
          {isThinking ? '模型正在思考…' : '（模型未返回推理内容）'}
        </div>
      {/if}
      {#if isThinking}<span class="caret"></span>{/if}
    </div>
  </div>
{/snippet}

{#snippet planPhase(m: ChatMsg, live: boolean)}
  {@const stages = ['理解需求', '调研中', '生成计划']}
  {@const idx = stages.indexOf(m.planPhase ?? '')}
  {@const tools = m.tools ?? []}
  {@const last = tools[tools.length - 1]}
  {@const activity =
    idx <= 0
      ? '正在理解需求、确认目标…'
      : idx === 1
      ? last && !last.result && !last.errored
        ? `正在调用 ${last.name}…`
        : last
        ? `已完成 ${tools.length} 次调研调用，正在分析结果…`
        : '正在检索相关资料…'
      : '正在汇总调研结果、生成结构化计划…'}
  <div class="plan-phase" role="status" aria-label="计划生成进度">
    <div class="pp-steps">
      {#each stages as s, i}
        <span class="pp-step" class:on={i <= idx} class:cur={i === idx && live}
          >{s}</span
        >{#if i < stages.length - 1}<span class="pp-arrow">→</span>{/if}
      {/each}
    </div>
    {#if live}
      <div class="plan-activity">
        <span class="pa-spin"></span>
        <span class="pa-text">{activity}</span>
        <plan-elapsed
          class="plan-elapsed"
          ts={String(m.planStartedAt ?? 0)}
        ></plan-elapsed>
      </div>
      {#if idx <= 0 && !m.reasoning && tools.length === 0}
        <div class="pp-hint">
          深度规划通常需要 1~2 分钟；调研与思考进展可展开下方「调用链路」查看
        </div>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet clarifyCard(m: ChatMsg)}
  {#if m.clarify}
    {@const c = m.clarify}
    {@const questions = normalizeClarifyQuestions(c.questions)}
    {@const draft = clarifyDraft[m.id] ?? { picks: {}, texts: {}, extra: '' }}
    <div class="clarify-card">
      <div class="clarify-head">❓ 需要确认目标</div>
      {#if c.goalDraft}
        <div class="clarify-goal">
          <span class="cg-label">目标草稿</span>
          <div class="cg-text">{c.goalDraft}</div>
        </div>
      {/if}
      {#if questions.length}
        <ol class="clarify-q">
          {#each questions as item, i}
            <li class="cq-item">
              <div class="cq-text">{item.q}</div>
              {#if item.options && item.options.length}
                <div class="cq-opts">
                  {#each item.options as opt}
                    <button
                      type="button"
                      class="cq-chip"
                      class:on={(draft.picks[String(i)] ?? []).includes(opt)}
                      disabled={clarifyAnswered[m.id] === true}
                      onclick={() => toggleClarifyPick(m.id, i, opt)}
                    >
                      {opt}
                    </button>
                  {/each}
                </div>
              {/if}
              <input
                class="cq-custom"
                type="text"
                placeholder="其他 / 自定义补充（可留空）"
                value={draft.texts[String(i)] ?? ''}
                disabled={clarifyAnswered[m.id] === true}
                oninput={(e) =>
                  setClarifyText(
                    m.id,
                    i,
                    (e.target as HTMLInputElement).value
                  )}
              />
            </li>
          {/each}
        </ol>
      {/if}
      {#if c.needs}
        <div class="clarify-needs">
          缺失信息：{c.needs}
        </div>
      {/if}
      <textarea
        class="clarify-input"
        placeholder="整体补充说明（可留空）"
        value={draft.extra}
        disabled={clarifyAnswered[m.id] === true}
        oninput={(e) => {
          setClarifyExtra(m.id, (e.target as HTMLTextAreaElement).value);
        }}
      ></textarea>
      <div class="clarify-actions">
        <button
          class="plan-btn"
          disabled={clarifyAnswered[m.id] === true}
          onclick={() => void confirmClarify(m)}
        >
          {clarifyAnswered[m.id] === true
            ? '已确认，正在重新生成计划…'
            : '确认并继续生成计划'}
        </button>
      </div>
    </div>
  {/if}
{/snippet}

{#snippet answer(m: ChatMsg, isAnswering: boolean, isStreaming: boolean, isStopped: boolean)}
  <div class="answer">
    {#if m.content && m.content.trim()}
      <div class="msg-text" data-md-scope="ans-{m.id}">
        {@html toRichHtml(m.content, {
          htmlBlocks: true,
          richBlocks: true,
          // 流式中不提供折叠入口：内容还在增长，中途收起会丢失阅读位置。
          finalize: !isStreaming
        })}
      </div>
    {/if}
    {#if isAnswering}<span class="caret"></span>{/if}
    {#if isStreaming}
      <div class="replying">
        模型正在回复<span class="dots"><i></i><i></i><i></i></span>
      </div>
    {/if}
    {#if !m.content && !isStreaming}
      {#if isStopped}
        <div class="msg-text placeholder stopped">已停止</div>
      {:else}
        <div class="msg-text placeholder">等待响应…</div>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet extras(m: ChatMsg, isStreaming: boolean)}
  {@const hasTrace = !!(m.trace && m.trace.length > 0)}
  {@const ins = hasTrace ? buildInsights(m.trace!) : null}
  <!-- 链路信心：仅当存在真实工具/检索执行（否则信心恒为满分的空值，无意义）。 -->
  {@const hasConfidence = !!(ins && ins.toolCount > 0)}
  {#if hasTrace || ins}
    <div class="extras">
      {#if hasTrace}
        <button
          type="button"
          class="extra-btn"
          class:active={traceDrawerMsg === m &&
            traceDrawerSection === 'trace'}
          onclick={() => {
            traceDrawerMsg = m;
            traceDrawerSection = 'trace';
          }}
        >
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
          <span>调用链路</span
          ><span class="tcount">{countTraceNodes(m.trace!)} 节点</span>
          {#if isStreaming}
            <span class="dots"><i></i><i></i><i></i></span>
          {/if}
        </button>
      {/if}
      {#if ins}
        <button
          type="button"
          class="extra-btn alt"
          class:active={traceDrawerMsg === m &&
            traceDrawerSection === 'insights'}
          onclick={() => {
            traceDrawerMsg = m;
            traceDrawerSection = 'insights';
          }}
        >
          <span>关键信息</span>
        </button>
      {/if}
      {#if hasConfidence}
        <button
          type="button"
          class="extra-btn alt"
          class:active={traceDrawerMsg === m &&
            traceDrawerSection === 'confidence'}
          onclick={() => {
            traceDrawerMsg = m;
            traceDrawerSection = 'confidence';
          }}
        >
          <span>链路信心</span>
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet traceDrawer()}
  {@const m = traceDrawerMsg}
  {@const drawerTitle =
    traceDrawerSection === 'trace'
      ? '调用链路'
      : traceDrawerSection === 'confidence'
      ? '链路信心'
      : '关键信息'}
  <!-- 始终渲染 <AhDrawer>（open 绑定到是否有选中消息），关闭时由组件自放离场动画。 -->
  <AhDrawer
    open={m !== null}
    placement="right"
    title={drawerTitle}
    size="500px"
    onclose={() => {
      traceDrawerMsg = null;
    }}
  >
    {#if m && m.trace && m.trace.length > 0}
      <div class="trace-drawer">
        {#if traceDrawerSection === 'trace'}
          <div class="trace-body">
            <div class="trace-toolbar">
              <button
                type="button"
                class="trace-collapse-all"
                title="折叠整条调用链路中所有可折叠项"
                onclick={() => {
                  collapseEntireTrace(m.trace ?? []);
                  rtVersion++;
                }}
              >
                折叠全部
              </button>
            </div>
            {#each m.trace as n}
              {@render traceNode(n, undefined, () => { rtVersion++; })}
            {/each}
          </div>
        {:else if traceDrawerSection === 'confidence'}
          <div class="confidence-wrap">
            {@render confidence(m.trace)}
          </div>
        {:else}
          <div class="insights">
            {@render insights(buildInsights(m.trace))}
          </div>
        {/if}
      </div>
    {/if}
  </AhDrawer>
{/snippet}

{#snippet planCard(m: ChatMsg)}
  {#if m.plan}
    {@const plan = m.plan}
    {@const st = planExec[m.id] ?? ({ status: 'pending', done: {} } as PlanExecState)}
    {@const statusLabel =
      st.status === 'pending'
        ? '待确认'
        : st.status === 'running'
        ? `执行中 · ${
            st.runningTaskIds?.length
              ? st.runningTaskIds.join('、')
              : st.currentTaskId ?? ''
          }`
        : st.status === 'done'
        ? '已完成'
        : st.status === 'failed'
        ? `执行失败 · ${st.failedTaskId ?? ''}`
        : st.status === 'awaiting'
        ? `待审批 · ${(st.awaitingTaskIds ?? []).join('、')}`
        : '已取消'}
    <!-- 并行（2026-09-20）：在跑任务集合（旧态/恢复缺省时以 currentTaskId 兜底，串行等价）。 -->
    {@const runningIds =
      st.runningTaskIds ?? (st.currentTaskId ? [st.currentTaskId] : [])}
    <div class="plan-card">
      <div class="plan-head">
        <span class="plan-title">📋 执行计划</span>
        <span class="plan-goal">{plan.goal}</span>
      </div>
      <ol class="plan-tasks">
        {#each plan.tasks as t, i}
          {@const done = !!st.done[t.id]}
          {@const active = st.status === 'running' && runningIds.includes(t.id)}
          {@const failed = st.status === 'failed' && st.failedTaskId === t.id}
          <!-- P3：审批门任务标记（卡片显示 🔒）。 -->
          {@const awaitingNode =
            st.status === 'awaiting' && (st.awaitingTaskIds ?? []).includes(t.id)}
          <li
            class="plan-task"
            class:done={done}
            class:active={active}
            class:failed={failed}
            class:awaiting={awaitingNode}
          >
            <div class="pt-head">
              <span class="pt-mark"
                >{done ? '✓' : active ? '⏳' : failed ? '✗' : awaitingNode ? '🔒' : i + 1}</span
              >
              <b>{t.title}</b>
              {#if (st.retryCounts?.[t.id] ?? 0) > 0}
                <span
                  class="pt-retry"
                  title={`引擎为该任务自动重试了 ${st.retryCounts?.[t.id]} 次（瞬时失败自愈）`}
                  >↻ {st.retryCounts?.[t.id]}</span
                >
              {/if}
              {#if t.requireApproval}
                <span class="pt-approval" title="执行前需人工批准">🔒 需审批</span>
              {/if}
            </div>
            {#if t.steps.length}
              <ol class="pt-steps">
                {#each t.steps as s}
                  <li>{s}</li>
                {/each}
              </ol>
            {/if}
            <div class="pt-meta">
              依赖：{t.dependsOn.length ? t.dependsOn.join('、') : '无'} ·
              预期产出：{t.expectedOutput || '—'}
            </div>
          </li>
        {/each}
      </ol>
      <!-- P5 静默执行：思考面板（llm:reasoning 增量，tail 展示最新思考）。 -->
      {#if st.status === 'running'}
        {@const slots = plan.tasks
          .map((t) => t.id)
          .filter((id) => (st.thinkingByTask?.[id] ?? '').trim())}
        {#if slots.length > 0}
          {#each slots as id}
            <div class="plan-thinking">
              <div class="pt-think-label">💭 思考中 · {id}</div>
              <div class="pt-think-body">
                <div class="pt-think-text">
                  {(st.thinkingByTask?.[id] ?? '').slice(-4000)}
                </div>
              </div>
            </div>
          {/each}
        {:else if st.thinking && st.thinking.text.trim()}
          <div class="plan-thinking">
            <div class="pt-think-label">
              💭 思考中 · {st.thinking.taskId ?? st.currentTaskId ?? ''}
            </div>
            <div class="pt-think-body">
              <div class="pt-think-text">
                {st.thinking.text.slice(-4000)}
              </div>
            </div>
          </div>
        {/if}
      {/if}
      <!-- 状态 + 操作：置于卡片右下角一行，状态在操作按钮之前。 -->
      <div class="plan-actions">
        <span class="pill {st.status}">{statusLabel}</span>
        <div class="plan-action-btns">
          {#if st.status === 'pending'}
            <button class="plan-btn" onclick={() => void confirmPlan(m)}>
              确认执行
            </button>
            <button class="plan-btn ghost" onclick={() => cancelPlan(m.id)}>
              取消
            </button>
          {/if}
          {#if st.status === 'failed'}
            <button class="plan-btn" onclick={() => void confirmPlan(m)}>
              从失败任务继续
            </button>
          {/if}
          {#if st.status === 'awaiting'}
            <button
              class="plan-btn"
              title="批准当前全部待审批节点并继续执行"
              onclick={() => void approvePlanAction(m)}
            >
              批准并继续
            </button>
          {/if}
          {#if st.status !== 'pending'}
            <button
              class="plan-btn ghost"
              title="查看各任务执行轨迹（检查点快照回放）"
              onclick={() => openPlanWfReplay(m)}
            >
              执行详情
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
{/snippet}

{#snippet planWfReplayDrawer()}
  {@const m = planWfReplayMsg}
  {#if !m || !m.plan}
    <AhDrawer open={false} placement="right" title="执行详情" size="500px" />
  {:else}
    {@const rs = planWfReplay[m.id]}
    <!-- P2.6：实时检查点缺失（404）时回退 planStatus 历史镜像快照。 -->
    {@const mirror = rs?.mirrorSnapshot ? (rs.mirrorSnapshot as unknown as WorkflowRun) : null}
    {@const historyView = rs?.historyView}
    {@const run = historyView
      ? ({ state: historyView.state, steps: historyView.steps } as unknown as WorkflowRun)
      : (rs?.snapshot ?? mirror)}
    {@const fromMirror = !rs?.snapshot && !!mirror}
    {@const rows = buildPlanWfReplayRows(m.plan, run)}
    {@const totalMs =
      run?.startedAt && run.finishedAt ? Math.max(0, run.finishedAt - run.startedAt) : undefined}
    {@const stateLabel: Record<string, string> = {
      running: '执行中',
      done: '已完成',
      failed: '失败',
      pending: '待执行',
      awaiting: '待审批'
    }}
    <!-- P3：审批门暂停 —— 顶部「批准并继续」+ 每行 awaiting 节点的单节点批准。 -->
    {@const awaitingRows = rows.filter((r) => r.state === 'awaiting')}
    <AhDrawer
      open={true}
      placement="right"
      title="执行详情"
      size="500px"
      onclose={() => closePlanWfReplay()}
    >
      <div class="wf-replay">
        {#if rs?.loading}
          <div class="wf-replay-hint">正在加载执行轨迹…</div>
        {/if}
        {#if !rs?.loading && !run}
          <div class="wf-replay-hint">
            {#if rs?.error}
              暂无可回放的执行轨迹：{rs.error}。<br />
              检查点可能尚未落盘或已被清理（服务重启 / 磁盘重置）。<br />
              可点卡片上的「从失败任务继续 / 确认执行」重新拉起 DAG 执行。
            {:else}
              该计划暂无执行记录（尚未开始，或为串行路径执行——串行 run 不落检查点）。
            {/if}
          </div>
        {/if}
        {#if fromMirror}
          <div class="wf-replay-mirror-hint">
            检查点已过期，以下为执行时保留的历史镜像快照（节点状态 / 耗时 / 产出 / 调用链路）。
          </div>
        {/if}
        {#if run}
          <div class="wf-replay-head">
            <span class="pill {run.state}">{stateLabel[run.state] ?? run.state}</span>
            <span class="wf-replay-total"
              >共 {rows.length} 步{#if totalMs !== undefined} · {formatPlanWfDuration(totalMs)}{/if}</span
            >
            {#if run.error}
              <span class="wf-replay-err">{run.error}</span>
            {/if}
          </div>
          <!-- P6 观测：「历史执行」区 —— 回看态显示退出条，否则列归档列表。 -->
          {#if historyView}
            <div class="wf-replay-history-bar">
              <span class="wf-replay-history-hint">
                ↩ 回看历史执行 · {new Date(historyView.ts).toLocaleString()} ·
                {planWfReplayStateLabel(historyView.state)}
              </span>
              <button class="plan-btn ghost" onclick={() => planWfHistoryClose(m)}>
                返回当前
              </button>
            </div>
          {:else if rs?.history && rs.history.length > 0}
            <details class="wf-replay-history">
              <summary>历史执行 · {rs.history.length} 次</summary>
              <ul class="wf-history-list">
                {#each rs.history as h}
                  <li>
                    <button
                      class="wf-history-item"
                      onclick={() => void planWfHistoryLoad(m, h.runId)}
                    >
                      <span>{planWfReplayStateLabel(h.state)}</span>
                      <span class="wf-history-ts">{new Date(h.ts).toLocaleString()}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            </details>
          {/if}
          {#if run.state === 'awaiting' && !fromMirror}
            <div class="wf-replay-approve">
              <button class="plan-btn" onclick={() => void approvePlanAction(m)}>
                批准并继续
              </button>
              <span class="wf-replay-approve-hint">
                将放行 {awaitingRows.length}
                个待审批节点后继续执行（检查点已记录，刷新 / 重启后仍可审批）
              </span>
            </div>
          {/if}
          <!-- P6 方案一 A：「状态快照」区 —— time travel 回放锚点列表。 -->
          {#if !historyView && !fromMirror}
            {@const snaps = run.snapshots}
            {#if snaps && snaps.length > 0}
              <details class="wf-replay-history">
                <summary>状态快照 · {snaps.length} 个（可回滚）</summary>
                <ul class="wf-history-list">
                  {#each snaps.slice().reverse() as s}
                    <li class="wf-snapshot-item">
                      <span class="wf-snapshot-meta"
                        >#{s.wave} · {s.action} · {new Date(s.ts).toLocaleTimeString()}</span
                      >
                      <button
                        class="plan-btn ghost"
                        title="把 run 恢复到该时点后重新执行（上游 done 产出复用）"
                        onclick={() => void planRollbackTo(m, s.id)}
                      >
                        回滚到此点
                      </button>
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
          {/if}
          <ol class="wf-replay-timeline">
            {#each rows as r}
              {@const lines = buildPlanWfTraceLines(r.trace)}
              <li class="wf-replay-row {r.state}">
                <div class="wf-replay-row-head">
                  <span class="wf-replay-mark">{planWfReplayMark(r.state)}</span>
                  <b>{r.spawned ? '↳ ' + r.title : r.title}</b>
                  {#if (r.attempts ?? 0) > 0}
                    <span
                      class="wf-replay-retry"
                      title={`引擎为该节点自动重试了 ${r.attempts} 次（瞬时失败自愈）`}
                      >↻ 重试 {r.attempts}</span
                    >
                  {/if}
                  <span class="wf-replay-agent">{r.agentId ? r.agentId : '—'}</span>
                  <span class="wf-replay-state"
                    >{planWfReplayStateLabel(r.state)} · {formatPlanWfDuration(r.durationMs)}</span
                  >
                </div>
                {#if r.state === 'awaiting' && !fromMirror}
                  <div class="wf-replay-approve">
                    <button
                      class="plan-btn ghost"
                      onclick={() => void approvePlanAction(m, r.id)}
                    >
                      批准此节点
                    </button>
                  </div>
                {/if}
                {#if !fromMirror &&
                !historyView &&
                run.state !== 'running' &&
                (r.state === 'done' || r.state === 'failed' || r.state === 'skipped')}
                  <div class="wf-replay-approve">
                    <button
                      class="plan-btn ghost"
                      title="重置该节点及其下游并从此重新执行（上游已完成产出复用）"
                      onclick={() => void planRerunFrom(m, r.id)}
                    >
                      从此步重跑
                    </button>
                  </div>
                {/if}
                {#if r.detail}
                  <details class="wf-replay-detail">
                    <summary>产出 / 错误</summary>
                    <div class="wf-detail-body">{@html renderJsonHtml(r.detail)}</div>
                  </details>
                {/if}
                {#if lines.length > 0}
                  <!-- P2.5 调用链路：该 step 运行过程中的关键事件（来自检查点 StepRun.trace）。 -->
                  <details class="wf-replay-trace">
                    <summary>调用链路 · {lines.length} 步</summary>
                    <ol class="wf-trace-lines">
                      {#each lines as l}
                        <li class="wf-trace-line {l.status ?? 'ok'}">
                          <details class="wf-trace-item">
                            <summary class="wf-trace-item-head">
                              <span class="wf-trace-icon">{l.icon}</span>
                              <span class="wf-trace-label">{l.label}</span>
                              {#if l.at}
                                <span class="wf-trace-at">+{l.at}</span>
                              {/if}
                              <span class="wf-trace-caret" aria-hidden="true"></span>
                            </summary>
                            {#if l.meta && l.meta.length}
                              <details class="wf-trace-sub">
                                <summary class="wf-trace-sub-head">
                                  {planWfTraceMetaRowTitle(l.meta)}
                                  <span class="wf-trace-sub-caret" aria-hidden="true"></span>
                                </summary>
                                <div class="wf-trace-meta">
                                  {#each l.meta as [k, v]}
                                    <span
                                      class="wf-trace-meta-chip"
                                      title={`${planWfTraceMetaLabel(k)}: ${v}`}
                                      ><b>{planWfTraceMetaLabel(k)}</b>
                                      {v}</span
                                    >
                                  {/each}
                                </div>
                              </details>
                            {/if}
                            {#if l.detail}
                              <div class="wf-trace-detail">
                                {@html renderJsonHtml(l.detail)}
                              </div>
                            {/if}
                          </details>
                        </li>
                      {/each}
                    </ol>
                  </details>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      </div>
    </AhDrawer>
  {/if}
{/snippet}

{#snippet traceNode(n: TraceNode, parentKind?: string, onToggle?: () => void)}
  {#if n.kind === 'cost'}
    <!-- 成本节点：默认折叠，点「展开」后 .tcost-body 才渲染完整分组指标。 -->
    {@const entries = n.meta ? Object.entries(n.meta) : []}
    {@const groupOf = (k: string): 'cost' | 'usage' | 'model' =>
      k === 'cost' || k === 'priced'
        ? 'cost'
        : k === 'model'
        ? 'model'
        : 'usage'}
    {@const groups = [
      ['cost', entries.filter(([k]) => groupOf(k) === 'cost')],
      ['usage', entries.filter(([k]) => groupOf(k) === 'usage')],
      ['model', entries.filter(([k]) => groupOf(k) === 'model')]
    ] as Array<['cost' | 'usage' | 'model', Array<[string, unknown]>]>}
    {@const isOpen = n.expanded === true}
    <details
      class="tnode kind-cost status-{n.status}"
      open={isOpen}
      ontoggle={(e) => syncDetailsToggle(n, e, onToggle)}
    >
      <summary class="tnode-head">
        <span class="tdot"></span>
        <span class="tlabel">成本 / 用量</span>
        <button
          type="button"
          class="tcost-toggle"
          title={isOpen ? '收起成本 / 用量详情' : '展开成本 / 用量详情'}
          onclick={(e) => {
            // 阻止冒泡到 <summary>，避免与原生 toggle 重复切换。
            e.preventDefault();
            e.stopPropagation();
            n.expanded = !isOpen;
            onToggle?.();
          }}
        >
          {isOpen ? '收起' : '展开'}
          <span class="tcost-caret" aria-hidden="true"></span>
        </button>
      </summary>
      {#if entries.length}
        <div class="tcost-body">
          <div class="tmetrics">
            {#each groups as [g, items]}
              {#if items.length}
                <div class="tgrp tgrp-{g}">
                  {#each items as [k, v]}
                    <span
                      class="tchip"
                      title={`${k} ${String(v)}`}
                      ><b>{k}</b> ~{String(v)}</span
                    >
                  {/each}
                </div>
              {/if}
            {/each}
          </div>
        </div>
      {/if}
      {#if n.children.length}
        <div class="tchildren">
          {#each n.children as c}{@render traceNode(c, n.kind, onToggle)}{/each}
        </div>
      {/if}
    </details>
  {:else if n.kind === 'tokencache'}
    <!-- Token 缓存命中率节点：默认折叠，交互语言与成本节点一致。 -->
    {@const entries = n.meta ? Object.entries(n.meta) : []}
    {@const groupOf = (k: string): 'hit' | 'info' | 'model' =>
      k === '命中率' || k === '命中'
        ? 'hit'
        : k === '接口' || k === '分模型'
        ? 'info'
        : 'model'}
    {@const groups = [
      ['hit', entries.filter(([k]) => groupOf(k) === 'hit')],
      ['info', entries.filter(([k]) => groupOf(k) === 'info')],
      ['model', entries.filter(([k]) => groupOf(k) === 'model')]
    ] as Array<['hit' | 'info' | 'model', Array<[string, unknown]>]>}
    {@const isOpen = n.expanded === true}
    <details
      class="tnode kind-tokencache status-{n.status}"
      open={isOpen}
      ontoggle={(e) => syncDetailsToggle(n, e, onToggle)}
    >
      <summary class="tnode-head tcache-head">
        <span class="tdot"></span>
        <span class="tlabel">Token 缓存命中率</span>
        <button
          type="button"
          class="tcache-toggle"
          title={isOpen
            ? '收起 Token 缓存命中率详情'
            : '展开 Token 缓存命中率详情'}
          onclick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            n.expanded = !isOpen;
            onToggle?.();
          }}
        >
          {isOpen ? '收起' : '展开'}
          <span class="tcache-caret" aria-hidden="true"></span>
        </button>
      </summary>
      {#if entries.length}
        <div class="tcache-body">
          <div class="tmetrics">
            {#each groups as [g, items]}
              {#if items.length}
                <div class="tgrp tgrp-{g}">
                  {#each items as [k, v]}
                    {#if k === '分模型'}
                      <!-- 分模型：将「 · 」拼接的多模型字符串拆为独立 chip。 -->
                      <div class="tgrp-sub">
                        {#each String(v).split(' · ') as p}
                          <span
                            class="tchip model-chip"
                            title={p}
                            >{p}</span
                          >
                        {/each}
                      </div>
                    {:else}
                      <span
                        class="tchip"
                        title={`${k} ${String(v)}`}
                        ><b>{k}</b> {String(v)}</span
                      >
                    {/if}
                  {/each}
                </div>
              {/if}
            {/each}
          </div>
        </div>
      {/if}
      {#if n.children.length}
        <div class="tchildren">
          {#each n.children as c}{@render traceNode(c, n.kind, onToggle)}{/each}
        </div>
      {/if}
    </details>
  {:else if n.kind === 'llm'}
    <!-- LLM 调用节点：受控容器（非原生 details），展开态持久化在 n.expanded 上。 -->
    {@const expanded = n.expanded !== false}
    {@const toolChildren = n.children.filter((c) => c.meta?.jev !== 'true').length}
    <div class="tnode kind-llm status-{n.status}">
      <div
        class="tnode-head tnode-head-btn"
        role="button"
        tabindex="0"
        title="点击展开 / 收起消息与工具调用"
        aria-expanded={expanded ? 'true' : 'false'}
        onclick={() => {
          n.expanded = !expanded;
          onToggle?.();
        }}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            n.expanded = !expanded;
            onToggle?.();
          }
        }}
      >
        <span class="tdot"></span>
        <span class="tlabel">{n.label}</span>
        {#if n.status === 'error'}
          <span class="tbadge err">失败</span>
        {/if}
        {#if n.status === 'pending'}
          <span class="tbadge pend">进行中</span>
        {/if}
        <span class="tchips"
          >{#if n.meta}
            {#each Object.entries(n.meta).filter(([k]) => k !== 'tools') as [k, v]}
              <span class="tchip"
                ><b>{k}</b> {v}</span
              >
            {/each}
          {/if}{#if toolChildren}
            <span class="tchip"
              ><b>工具</b> {toolChildren}</span
            >
          {/if}</span
        >
      </div>
      <div class="tllm-body" hidden={!expanded}>
        {#if n.messages?.length}
          <div class="tmsg-list">
            <div class="tmsg-head">
              <span class="tmsg-head-title"
                >消息上下文 · 共 {n.messages.length} 条</span
              >
            </div>
            {#each n.messages as tm}
              {@const raw = tm.content ?? ''}
              {@const flat = raw.replace(/\s+/g, ' ').trim()}
              {@const preview = flat.length > 48 ? flat.slice(0, 48) + '…' : flat}
              {@const previewCount = raw ? ` · ${[...raw].length}字` : ''}
              <details
                class="tmsg-item role-{tm.role}"
                open={tm.expanded === true}
                ontoggle={(e) => {
                  tm.expanded = (e.target as HTMLDetailsElement).open;
                  onToggle?.();
                }}
              >
                <summary class="tmsg-sum">
                  <span class="tmsg-role"
                    >{tm.role === 'user'
                      ? '用户'
                      : tm.role === 'assistant'
                      ? '助手'
                      : '系统'}</span
                  >
                  <span class="tmsg-preview">{preview}{previewCount}</span>
                  <span class="tmsg-caret"></span>
                </summary>
                <div class="tmsg-body">
                  {#if tm.content}
                    {tm.content}
                  {:else}
                    <span class="tmsg-empty">（空内容）</span>
                  {/if}
                </div>
                {#if tm.reasoning}
                  <div class="tmsg-reason">
                    {tm.reasoning}
                  </div>
                {/if}
              </details>
            {/each}
          </div>
        {/if}
        {#if n.children.length}
          <div class="tchildren">
            {#each n.children as c}{@render traceNode(c, n.kind, onToggle)}{/each}
          </div>
        {/if}
      </div>
    </div>
  {:else}
    {@const hasDetail = !!n.detail && n.detail.trim().length > 0}
    {@const hasResult = n.result != null && n.result.trim().length > 0}
    {@const isRetrieval = n.kind === 'retrieval'}
    <!-- 仅 run/step 默认展开；工具/检索等可折叠节点默认收起。 -->
    {@const defaultOpen = n.kind === 'run' || n.kind === 'step'}
    {@const isOpen =
      n.expanded === true ? true : n.expanded === false ? false : defaultOpen}
    <details
      class="tnode kind-{n.kind} status-{n.status}"
      open={isOpen}
      ontoggle={(e) => syncDetailsToggle(n, e, onToggle)}
    >
      <summary class="tnode-head">
        <span class="tdot"></span>
        <span class="tlabel">{n.label}</span>
        {#if n.status === 'error'}
          <span class="tbadge err">失败</span>
        {/if}
        {#if n.status === 'pending'}
          <span class="tbadge pend">进行中</span>
        {/if}
        {#if n.meta}
          <span class="tchips"
            >{#each Object.entries(n.meta).filter(([k]) => !(n.kind === 'run' && k === 'model')) as [k, v]}
              <span class="tchip"
                ><b>{k}</b> {v}</span
              >
            {/each}</span
          >
        {/if}
        <span class="tcaret" aria-hidden="true"></span>
      </summary>
      {#if hasDetail}
        <pre class="tdetail">{@html renderJsonHtml(n.detail!)}</pre>
      {/if}
      {#if hasResult}
        {#if isRetrieval}
          <details
            class="tresult retrieval tres-fold"
            open={n.result!.length <= 240}
          >
            <summary title="点击展开 / 收起">
              <span class="tres-title">检索内容</span>
              <span class="tres-meta">{n.result!.length} 字</span>
            </summary>
            <div class="tres-body">{@html renderJsonHtml(n.result!)}</div>
          </details>
        {:else}
          <div class="tresult">{@html renderJsonHtml(n.result!)}</div>
        {/if}
      {/if}
      {#if n.children.length}
        <div class="tchildren">
          {#each n.children as c}{@render traceNode(c, n.kind, onToggle)}{/each}
        </div>
      {/if}
    </details>
  {/if}
{/snippet}

{#snippet confidence(trace: TraceNode[])}
  {@const c = buildConfidence(trace)}
  {@const successRate =
    c.toolTotal > 0
      ? Math.round(((c.toolTotal - c.toolErrors) / c.toolTotal) * 100)
      : 100}
  {@const cachePct = c.cacheHitRate
    ? Math.min(100, Number(String(c.cacheHitRate).replace(/[^\d.]/g, '')) || 0)
    : 0}
  {@const offset = GAUGE_C * (1 - c.score / 100)}
  <div class="confidence level-{c.level}">
    <div class="conf-head">
      <div class="conf-gauge" title={`综合信心分 ${c.score} / 100`}>
        <svg class="conf-gauge-svg" viewBox="0 0 88 88" aria-hidden="true">
          <circle
            class="conf-gauge-bg"
            cx="44"
            cy="44"
            r={GAUGE_R}
          ></circle>
          <circle
            class="conf-gauge-fg"
            cx="44"
            cy="44"
            r={GAUGE_R}
            style={`stroke-dasharray:${GAUGE_C.toFixed(
              2
            )};stroke-dashoffset:${offset.toFixed(2)}`}
          ></circle>
        </svg>
        <div class="conf-gauge-num">
          <span class="conf-num">{String(c.score)}</span>
          <span class="conf-unit">分</span>
        </div>
      </div>
      <div class="conf-meta">
        <span class="conf-level">信心 {c.levelLabel}</span>
        {#if c.hasVerify}
          <span class="conf-badge" class:ok={c.verifyPassed} class:err={!c.verifyPassed}
            >自检 {c.verifyPassed ? '通过' : '未通过'}</span
          >
        {:else}
          <span class="conf-badge synth">合成</span>
        {/if}
      </div>
    </div>
    <div class="conf-bars">
      <div class="conf-row">
        <span class="conf-name">工具成功率</span>
        <div class="conf-track">
          <div class="conf-fill ok" style={`width:${successRate}%`}></div>
        </div>
        <span class="conf-val">{successRate}%</span>
      </div>
      <div class="conf-row">
        <span class="conf-name">缓存命中率</span>
        <div class="conf-track">
          <div class="conf-fill info" style={`width:${cachePct}%`}></div>
        </div>
        <span class="conf-val">{c.cacheHitRate ?? '—'}</span>
      </div>
      <div class="conf-row">
        <span class="conf-name">错误节点</span>
        <div class="conf-track">
          <div
            class="conf-fill warn"
            style={`width:${Math.min(100, c.errorNodes * 20)}%`}
          ></div>
        </div>
        <span class="conf-val">{c.errorNodes}</span>
      </div>
    </div>
    {#if c.hasVerify && c.verifyReasons}
      <details class="conf-reasons">
        <summary>自检依据</summary>
        <pre>{c.verifyReasons}</pre>
      </details>
    {/if}
    {#if !c.hasVerify}
      <div class="conf-note">
        <svg
          class="conf-note-ico"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.2"></circle>
          <path d="M8 7.3v3.2" stroke-linecap="round"></path>
          <circle
            cx="8"
            cy="5"
            r="0.95"
            fill="currentColor"
            stroke="none"
          ></circle>
        </svg>
        <span
          >本次未启用自检（AGENT_AUTO_VERIFY），以下为基于调用链的合成信心。</span
        >
      </div>
    {/if}
  </div>
{/snippet}

{#snippet insights(ins: Insights)}
  {@const stats = buildInsightStats(ins)}
  <div class="insights-title">关键信息</div>
  <div class="ins-grid">
    {#each stats as [k, v, badge]}
      <div class="ins-item">
        <span class="ins-k">{k}{#if badge}
            <span class="ins-extra" title={EXTRA_BADGE_TIP}
              >{badge}</span
            >{/if}</span
        ><span class="ins-v">{v}</span>
      </div>
    {/each}
  </div>
  {#if ins.costBreakdown}
    <div class="ins-breakdown">
      <div class="ins-bd-title" title={BREAKDOWN_TIP}>
        Token 拆解 <span class="ins-bd-est">估算</span>
        {#if ins.steps > 1}
          <span class="ins-bd-est">{ins.steps} 步累计</span>
        {/if}
      </div>
      <div class="ins-bd-bars">
        {#each ins.costBreakdown as b}
          <div class="ins-bd-row">
            <div class="ins-bd-head">
              <span class="ins-bd-name">{b.label}</span>
              <span class="ins-bd-val"
                >{String(b.tokens)} tok ·
                {String(b.pct)}%</span
              >
            </div>
            <div class="ins-bd-track">
              <div
                class="ins-bd-fill"
                style={`width:${Math.max(2, b.pct)}%`}
              ></div>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {:else if ins.costTokens}
    <!-- 稳定降级：已有 Token 总量但分项缺失时，展示占位说明而非静默消失。 -->
    <div class="ins-breakdown">
      <div class="ins-bd-title" title={BREAKDOWN_TIP}>
        Token 拆解 <span class="ins-bd-est">估算</span>
        {#if ins.steps > 1}
          <span class="ins-bd-est">{ins.steps} 步累计</span>
        {/if}
      </div>
      <div class="ins-bd-bars">
        <div class="ins-bd-empty">
          暂无分项数据（本次运行未返回拆解明细）
        </div>
      </div>
    </div>
  {/if}
  {#if ins.retrievals.length}
    <div class="ins-retrieval">
      <div class="ins-ret-title">检索内容</div>
      {#each ins.retrievals as r}
        <details class="ins-ret-card ins-ret-fold" open={false}>
          <summary title="点击展开 / 收起">
            <span class="ins-ret-name">{r.label}</span>
            <span class="ins-ret-meta">{r.result.length} 字</span>
          </summary>
          <pre class="ins-ret-body">{@html renderJsonHtml(r.result)}</pre>
        </details>
      {/each}
    </div>
  {/if}
{/snippet}
