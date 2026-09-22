/**
 * chat-render-utils：聊天界面中可独立抽取的纯渲染 / 格式化工具。
 *
 * 从 AhChat 单体内抽离，降低耦合与体积。所有导出均为纯函数或仅依赖显式入参，
 * 不读取组件 this.* 状态，便于独立测试与跨渲染方法复用。
 */
import { html, nothing, type TemplateResult } from 'lit';
import { escapeHtml } from './utils/markdown';
import type { UploadedFile } from './agent-context';
import type { PlanExecMirror, StepTraceNode } from '@agent-harness/client';
import type {
  ChatMsg,
  ExecutionPlanView,
  PlanExecState,
  PlanWfRunMirror
} from './chat-types';

/** 按文件类型返回展示图标（emoji）。 */
export function fileIcon(f: UploadedFile): string {
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

/** 人类可读的文件大小（B / KB / MB）。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 从线程消息里提取「计划进度镜像查找表」：按 plan.goal 对齐 PlanExecMirror。
 * 消息 id 在恢复时重新分配，不能按 id 对齐；goal 是计划卡片的稳定业务键。纯计算。
 */
export function buildPlanStatusLookup(
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
 * P5 刷新恢复：过滤计划会话里的「单步任务」消息对。串行回退路径曾把每个任务的
 * 派发提示（user：`【计划任务 <id>】…`）与产出（紧随其后的 assistant）写进会话存储，
 * 刷新后以其为权威源会复现为单步气泡。此处丢弃「派发提示 + 紧随其产出」这对，
 * 仅保留用户原始需求、计划卡片与最终摘要（或回收的最终结果）。纯函数。
 */
export function filterPlanSingleStep(msgs: ChatMsg[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    const isDispatch =
      m.role === 'user' &&
      typeof m.content === 'string' &&
      /^【计划任务/.test(m.content);
    if (isDispatch) continue; // 丢弃单步派发提示
    const prev = msgs[i - 1];
    const prevWasDispatch =
      !!prev &&
      prev.role === 'user' &&
      typeof prev.content === 'string' &&
      /^【计划任务/.test(prev.content);
    if (m.role === 'assistant' && prevWasDispatch) continue; // 丢弃对应任务产出
    out.push(m);
  }
  return out;
}

/**
 * P5 刷新恢复（兜底）：镜像缺摘要的已完成串行会话，从服务端原始存储回收最后一条
 * 任务产出作为「最终结果」追加展示（与摘要「取拓扑序末位成功任务产出」语义一致）。
 * 若 base 已含摘要则原样返回。纯函数。
 */
export function recoverPlanFinalResult(
  base: ChatMsg[],
  clean: Array<{
    role: string;
    content?: unknown;
    plan?: unknown;
    clarify?: unknown;
  }>
): ChatMsg[] {
  const hasSummary = base.some(
    (m) =>
      typeof m.content === 'string' && m.content.startsWith('📋 计划执行摘要')
  );
  if (hasSummary) return base;
  let lastOut = '';
  for (const m of clean) {
    if (
      m.role === 'assistant' &&
      !m.plan &&
      !m.clarify &&
      typeof m.content === 'string' &&
      !m.content.startsWith('📋 计划执行摘要')
    ) {
      lastOut = m.content;
    }
  }
  if (!lastOut.trim()) return base;
  return [
    ...base,
    {
      id: -1,
      role: 'assistant',
      content: `—— 最终结果 ——\n${lastOut}`
    } as ChatMsg
  ];
}

/**
 * 计划任务派发消息的前缀：`【计划任务 tX】任务标题`。
 * 必须与 chat.ts confirmPlan 的派发格式、以及服务端 run:start 的进度镜像识别保持一致
 * （宽匹配任务 id：planner 生成的 id 并不总是 tN，见 derivePlanExecFromMessages 注释）。
 */
export const PLAN_TASK_DISPATCH_RE = /^【计划任务\s*([^】]+)】/;

/* ------------------------------------------------------------------ */
/* P3 多 agent DAG 计划执行：wf:* 事件 → 计划卡片状态（纯函数）        */
/* ------------------------------------------------------------------ */

/**
 * 计划卡片 DAG 路径消费的 wf:* 事件最小形态（只含状态机用到的字段；
 * 与 @agent-harness/client 的 WorkflowEvent 结构兼容，此处不 import 以避免
 * 状态机纯函数耦合 client 包，便于独立测试与复用）。
 */
export interface PlanWfEvent {
  type: string;
  /** wf:step:* 携带的 step id（= 计划 task id，planToWorkflowDef 按 task.id 建 step）。 */
  stepId?: string;
  workflowId?: string;
  /** P3：wf:awaiting-approval 携带的待审批 step id 列表。 */
  stepIds?: string[];
  /** wf:failed 时携带的完整 run（step 终态快照，用于定位失败 task）。 */
  run?: {
    state?: string;
    steps?: Record<string, { state?: string; id?: string }>;
  };
}

/**
 * 把一条 wf:* 事件叠加到计划卡片的执行状态上（P3 DAG 路径，纯函数，零副作用）。
 *
 * 只处理「本计划已知 task 的 step 事件」（stepId ∈ knownTaskIds），其它 step /
 * 无关事件原样返回 prev（同引用，便于调用方以 `next !== prev` 判重渲染）。
 *
 * 语义（对齐 design/plan-mode-multiagent.md §6 + R8 引擎 all-or-nothing 现状）：
 * - wf:step:start  → running + currentTaskId；
 * - wf:step:done   → done[stepId] = true（状态保持 running，直至 wf:done）；
 * - wf:step:failed → failed + failedTaskId（引擎该波次中止，独立分支可能被放弃）；
 * - wf:done        → 整体 done，清 current/failed；
 * - wf:failed      → 整体 failed；failedTaskId 取 run.steps 中首个 failed step；
 * - 其它（harness 嵌套事件 / wf:compensate:* / wf:start）→ 不变更（同引用返回）。
 */
export function applyPlanWfEvent(
  prev: PlanExecState,
  ev: PlanWfEvent,
  knownTaskIds: ReadonlySet<string>
): PlanExecState {
  if (!ev || typeof ev.type !== 'string') return prev;
  switch (ev.type) {
    case 'wf:step:start': {
      if (!ev.stepId || !knownTaskIds.has(ev.stepId)) return prev;
      // P3：审批放行后重新进入 running —— 清掉 awaiting 标记。
      // P5 静默执行：每个任务开始时重置思考面板（新任务 → 新的空思考流）。
      // 并行（2026-09-20）：runningTaskIds 聚合在跑任务（串行时长度恒 1，语义不变）；
      // thinkingByTask 为该任务建独立空槽（已有槽位重置为空 —— start 即重新执行）。
      const running = new Set(prev.runningTaskIds ?? []);
      running.delete(ev.stepId);
      running.add(ev.stepId);
      return {
        ...prev,
        status: 'running',
        currentTaskId: ev.stepId,
        awaitingTaskIds: undefined,
        runningTaskIds: [...running],
        thinking: { taskId: ev.stepId, text: '' },
        thinkingByTask: { ...(prev.thinkingByTask ?? {}), [ev.stepId]: '' }
      };
    }
    case 'wf:step:done': {
      if (!ev.stepId || !knownTaskIds.has(ev.stepId)) return prev;
      // P5：任务完成即收起思考面板。P5.1 精准清槽：只清「本任务」的思考流 ——
      // 若事件乱序（done(t3) 迟到而思考面板已自愈切到 t4），不得误清新任务的思考流。
      // 并行（2026-09-20）：只把本任务移出在跑集合 / 删本任务分槽，兄弟任务不受影响。
      const thinking =
        prev.thinking && prev.thinking.taskId !== ev.stepId
          ? prev.thinking
          : undefined;
      const runningTaskIds = (prev.runningTaskIds ?? []).filter(
        (id) => id !== ev.stepId
      );
      const thinkingByTask = { ...(prev.thinkingByTask ?? {}) };
      delete thinkingByTask[ev.stepId];
      return {
        ...prev,
        status: 'running',
        done: { ...prev.done, [ev.stepId]: true },
        thinking,
        runningTaskIds,
        thinkingByTask
      };
    }
    case 'wf:step:failed': {
      if (!ev.stepId || !knownTaskIds.has(ev.stepId)) return prev;
      // 引擎 all-or-nothing：任一 step 失败整 run 收敛 failed（并行时兄弟任务在途结果
      // 由检查点记录，断点续跑可复用）。卡片整体转 failed，思考面板 / 在跑集合全清。
      return {
        ...prev,
        status: 'failed',
        failedTaskId: ev.stepId,
        currentTaskId: ev.stepId,
        thinking: undefined,
        runningTaskIds: undefined,
        thinkingByTask: undefined
      };
    }
    case 'wf:awaiting-approval': {
      // P3 审批门：引擎在波次边界暂停（run.state → awaiting）。stepIds 与本计划 task 求交集
      // （补偿 step / 非本计划的 def 演化不进入卡片状态机）。
      const ids = (ev.stepIds ?? []).filter((s) => s && knownTaskIds.has(s));
      if (!ids.length) return prev;
      return {
        ...prev,
        status: 'awaiting',
        currentTaskId: undefined,
        awaitingTaskIds: ids,
        thinking: undefined,
        runningTaskIds: undefined,
        thinkingByTask: undefined
      };
    }
    case 'wf:done':
      return {
        ...prev,
        status: 'done',
        currentTaskId: undefined,
        failedTaskId: undefined,
        awaitingTaskIds: undefined,
        thinking: undefined,
        runningTaskIds: undefined,
        thinkingByTask: undefined
      };
    case 'wf:failed': {
      // R8：引擎 all-or-nothing，run 整体失败。失败 task 定位：
      // run.steps 中首个 state==='failed' 的 step（step id = task id）。
      const firstFailed = Object.values(ev.run?.steps ?? {}).find(
        (s) => s?.state === 'failed'
      );
      return {
        ...prev,
        status: 'failed',
        failedTaskId: firstFailed?.id ?? prev.failedTaskId,
        currentTaskId: undefined,
        thinking: undefined,
        runningTaskIds: undefined,
        thinkingByTask: undefined
      };
    }
    default:
      // wf:start / wf:compensate:* / 嵌套 harness 事件 / _wf_done / wf:error（SSE 终结帧）：
      // 卡片状态机不消费（wf:error 即请求级失败，由调用方 catch 兜底回退串行路径）。
      return prev;
  }
}

/** P5 思考面板文本上限（超出截尾保新，避免超长思考流拖垮渲染与内存）。 */
export const PLAN_THINKING_MAX = 40_000;

/**
 * P5 静默执行：把一条 llm:reasoning 增量叠加到计划执行状态的思考面板。
 * - 仅 running 时消费；其它状态原样返回 prev（同引用判重）。
 * - 文本超 PLAN_THINKING_MAX 时保留尾部（最新思考），与 UI 面板「tail 展示」语义一致。
 * - 空增量 no-op（同引用返回，避免无谓重渲染）。
 *
 * P5.1 同步自愈（执行详情 vs 思考面板不同步修复）：stepId 为服务端注入的事件归属
 * （workflow-executor onEvent 第二参 → SSE 外层帧）。此前归因全靠「最近一次
 * wf:step:start 建立的槽位」——该帧丢失/乱序（断线重连 resume 不重放已完成 step 的
 * wf:step:*）时，新任务的思考流会错挂旧任务标签（「t3 已完成仍显示思考中·t3」）。
 * 现在：
 * - 带 stepId 且与当前槽位不一致 → 丢弃旧槽、以该 stepId 重建槽位（自愈切换）；
 * - 带 stepId 且无槽位（如刷新恢复后思考面板为空）→ 直接建槽，思考流不再被丢弃；
 * - 不带 stepId（旧服务端帧）→ 保持原行为（仅追加到已有槽位）。
 *
 * 并行双写（2026-09-20）：单槽 thinking 在多任务并发时会互相覆盖（A、B 交替增量导致
 * 单槽来回重建丢文本），故同时把增量累积进 **按任务分槽** 的 thinkingByTask ——
 * 渲染面按 plan.tasks 序分块展示，各任务思考互不覆盖；单槽保持原语义（最近接收
 * 增量的任务），兼容旧渲染 / 测试 / 恢复路径。stepId 缺省（旧帧）时增量同时落入
 * 单槽对应的分槽键，保证旧服务端帧也能进入分块渲染。
 */
export function applyPlanThinking(
  prev: PlanExecState,
  delta: string,
  stepId?: string
): PlanExecState {
  if (!delta || prev.status !== 'running') return prev;
  let slot = prev.thinking;
  if (stepId && (!slot || slot.taskId !== stepId)) {
    slot = { taskId: stepId, text: '' };
  }
  if (!slot) return prev;
  const key = slot.taskId;
  if (!key) return prev; // 无归属任务（理论不可达：槽位必带 taskId），防御不落脏数据
  const text = (slot.text + delta).slice(-PLAN_THINKING_MAX);
  const byTask = { ...(prev.thinkingByTask ?? {}) };
  byTask[key] = ((byTask[key] ?? '') + delta).slice(-PLAN_THINKING_MAX);
  if (slot === prev.thinking && text === prev.thinking?.text) return prev;
  return { ...prev, thinking: { ...slot, text }, thinkingByTask: byTask };
}

/** wf:done / wf:failed 携带的 run 快照最小形态（只含回挂摘要用到的字段）。 */
export interface PlanWfRunSnapshot {
  state?: string;
  steps?: Record<string, { state?: string; id?: string; output?: unknown }>;
}

/**
 * P2.6：把 WF 终态帧（wf:done / wf:failed / _wf_done）携带的 run 快照紧凑化，
 * 随 planStatus 镜像写入会话历史——检查点在服务重启 / Render free 盘清理后丢失时，
 * 「执行详情」抽屉据此回退水合（404 → 历史镜像）。
 *
 * 限幅纪律（历史信封有字节预算，PUT /api/history 超限 413）：
 * - 只保留回放用到的字段（state / 时间戳 / error / 每 step 的 output / trace），不落 def（任务标题/依赖来自 m.plan）；
 * - output 截断至 REPLAY_MIRROR_OUTPUT_MAX；trace 限 REPLAY_MIRROR_TRACE_MAX 节点、detail 200 字（服务端采集端已限 50/500，这里是二级限幅）；
 * - 纯函数（零 this / 零 DOM），可独立测试；run 为 undefined / 非对象 / 无 steps → undefined（调用方不落镜像字段）。
 */
export const REPLAY_MIRROR_OUTPUT_MAX = 2000;
export const REPLAY_MIRROR_TRACE_MAX = 30;
export const REPLAY_MIRROR_TRACE_DETAIL_MAX = 200;

export function compactPlanWfSnapshot(
  run: unknown
): PlanWfRunMirror | undefined {
  if (!run || typeof run !== 'object') return undefined;
  const r = run as {
    state?: string;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
    steps?: Record<string, unknown>;
  };
  if (!r.steps || typeof r.steps !== 'object') return undefined;
  const steps: PlanWfRunMirror['steps'] = {};
  for (const [sid, sRaw] of Object.entries(r.steps)) {
    if (!sRaw || typeof sRaw !== 'object') continue;
    const s = sRaw as {
      state?: string;
      agentId?: string;
      error?: string;
      startedAt?: number;
      finishedAt?: number;
      output?: unknown;
      trace?: StepTraceNode[];
    };
    const out: PlanWfRunMirror['steps'][string] = { state: s.state };
    if (s.agentId) out.agentId = s.agentId;
    if (typeof s.error === 'string' && s.error) {
      out.error =
        s.error.length > REPLAY_MIRROR_OUTPUT_MAX
          ? `${s.error.slice(0, REPLAY_MIRROR_OUTPUT_MAX)}…`
          : s.error;
    }
    if (typeof s.startedAt === 'number') out.startedAt = s.startedAt;
    if (typeof s.finishedAt === 'number') out.finishedAt = s.finishedAt;
    // output：非字符串先 JSON 化再截断（与 formatPlanWfOutput 一致的展示面，但这里预截断控制镜像体积）。
    if (s.output !== undefined && s.output !== null) {
      const so =
        typeof s.output === 'string' ? s.output : JSON.stringify(s.output);
      if (so)
        out.output =
          so.length > REPLAY_MIRROR_OUTPUT_MAX
            ? `${so.slice(0, REPLAY_MIRROR_OUTPUT_MAX)}…`
            : so;
    }
    // trace：只保留白名单节点形状（服务端 StepTraceNode 已白名单采集，这里做二级限幅 + 字段收敛）。
    if (Array.isArray(s.trace) && s.trace.length) {
      const nodes = s.trace.slice(0, REPLAY_MIRROR_TRACE_MAX).map((n) => {
        const t: StepTraceNode = { type: n.type, ts: n.ts };
        if (n.step !== undefined) t.step = n.step;
        if (n.label) t.label = n.label;
        if (n.detail)
          t.detail =
            n.detail.length > REPLAY_MIRROR_TRACE_DETAIL_MAX
              ? `${n.detail.slice(0, REPLAY_MIRROR_TRACE_DETAIL_MAX)}…`
              : n.detail;
        if (n.status) t.status = n.status;
        if (n.meta && Object.keys(n.meta).length) t.meta = n.meta;
        return t;
      });
      out.trace = nodes;
    }
    steps[sid] = out;
  }
  return {
    state: typeof r.state === 'string' ? r.state : 'done',
    ...(typeof r.startedAt === 'number' ? { startedAt: r.startedAt } : {}),
    ...(typeof r.finishedAt === 'number' ? { finishedAt: r.finishedAt } : {}),
    ...(typeof r.error === 'string' && r.error
      ? {
          error:
            r.error.length > REPLAY_MIRROR_OUTPUT_MAX
              ? `${r.error.slice(0, REPLAY_MIRROR_OUTPUT_MAX)}…`
              : r.error
        }
      : {}),
    steps
  };
}

/**
 * P3（多 agent DAG 计划执行）特性开关。
 * 开启后计划确认走服务端 DagEngine（拓扑波次并行 + 共享黑板），传输层失败自动回退已验证的
 * 串行路径兜底。**默认开**；localStorage 显式置 `ah_plan_dag='0'` 可关闭（回退串行）。
 * 回退链完整：unknown agent / 5xx / 断连 / wf:error → 串行路径，failed 态「从失败任务继续」
 * 亦走串行 resume（见 design/plan-mode-multiagent.md §9.3 / R8）。
 *
 * 可视化入口：「我的 → 设置 → 外观 → 对话」的开关（settings-center 读 isPlanDagEnabled 初始化，
 * 切换经 setPlanDagEnabled 写回同一 key）。chat.ts 的 confirmPlan 每次确认时实时读
 * isPlanDagEnabled()（不缓存），设置页改完即生效，无需跨组件事件总线。
 */
export const PLAN_DAG_STORAGE_KEY = 'ah_plan_dag';

export function isPlanDagEnabled(): boolean {
  try {
    // 默认开：仅当用户显式写入 '0' 时关闭。
    return localStorage.getItem(PLAN_DAG_STORAGE_KEY) !== '0';
  } catch {
    // localStorage 不可用（隐私模式 / 非浏览器 / 读取抛错）→ 取默认值「开」。
    return true;
  }
}

/**
 * 设置开关（设置中心 toggle 用）。on=true 时**移除** key（回到「默认开」语义，不留脏值）；
 * on=false 显式写 '0'。localStorage 不可用时静默忽略——此时 isPlanDagEnabled() 恒为默认「开」。
 */
export function setPlanDagEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(PLAN_DAG_STORAGE_KEY);
    else localStorage.setItem(PLAN_DAG_STORAGE_KEY, '0');
  } catch {
    /* 隐私模式 / 非浏览器：开关回落到默认「开」，与 isPlanDagEnabled 的 catch 分支一致。 */
  }
}

/**
 * P1（断点续跑）：由（会话 id，计划结构）推导**确定性**工作流检查点键。
 *
 * 对计划「结构键」做 FNV-1a 32 位哈希：goal + 各 task id + 依赖边（dependsOn）。
 * **不含**任务文本内容（title / steps / expectedOutput）——用户调整任务文案后结构键
 * 不变，仍能定位原检查点续跑（已完成任务保留产出，未完成任务按当前文本重执行）。
 * 结果形如 `plan-<8位hex>`：纯 ASCII 字母数字/连字符，经服务端 sanitizeKey
 * （仅保留 [a-zA-Z0-9._-]）后原样不变，可安全作 FileWorkflowStore 检查点文件名；
 * 前缀与旧随机键 `plan:<ts>-<rand>` 区分（旧 run 无法被确定性定位 → resume 404 →
 * 前端自动回退串行路径，行为安全）。
 *
 * 同输入恒同输出 → 刷新 / 重启后可重算（sessionId 稳定、计划随镜像持久化），
 * 无需把 wfId 写入持久化镜像。
 */
export function derivePlanWfId(
  sessionId: string,
  plan: ExecutionPlanView
): string {
  const s = [
    sessionId,
    plan?.goal ?? '',
    (plan?.tasks ?? [])
      .map(
        (t) =>
          `${t.id}:${(t.dependsOn ?? []).join(',')}${
            t.requireApproval === true ? ':A' : ''
          }`
      )
      .join('|')
  ].join('\u0000');
  // FNV-1a（32 位）：输入为 ASCII（会话 id / task id），charCodeAt & 0xff 等价逐字节。
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `plan-${h.toString(16).padStart(8, '0')}`;
}

/* ────────────────────────────────────────────────────────────────────
 * P2（轨迹回放）：把服务端检查点快照（WorkflowRun）收敛为「步骤级时间线行」，
 * 供计划卡片「执行详情」抽屉渲染。纯函数（零 this / 零 DOM），可独立测试。
 * 快照本身即轨迹：每 step 带 agentId / state / 时间戳 / output / error，
 * 由引擎在每次状态迁移后落 WorkflowStore（见 engine.ts 的 store.save 节奏），
 * 前端刷新 / 重启后经 GET /api/workflows/:id（client.getWorkflow）可完整重建。
 * ──────────────────────────────────────────────────────────────────── */

/** 时间线一行：某 task（step）的执行者 / 终态 / 耗时 / 可折叠正文（产出或错误）。 */
export interface PlanWfReplayRow {
  /** task id（= step id，= ExecutionPlanView.tasks[].id）。 */
  id: string;
  title: string;
  agentId?: string;
  state: string;
  /** 耗时（ms）：startedAt/finishedAt 缺失时 undefined（抽屉端显示「—」）。 */
  durationMs?: number;
  /** 折叠正文：done/skipped 展示产出（若为空则说明无产出），failed/compensated 展示错误。 */
  detail?: string;
  /**
   * P2.5 调用链路：本 step 执行期间捕获的关键事件序列（LLM 调用 / 工具 / 护栏 / 校验 / 收尾）。
   * 来自服务端检查点 StepRun.trace（StepTraceCollector 采集、引擎按上限合并）；
   * 旧快照 / 无链路捕获时为 undefined（抽屉不渲染「调用链路」区，零回归）。
   */
  trace?: StepTraceNode[];
}

const REPLAY_MARK: Record<string, string> = {
  done: '✅',
  failed: '❌',
  running: '⏳',
  pending: '⬜',
  skipped: '⏭',
  compensated: '♻️',
  awaiting: '🔒'
};

/** step 状态 → 展示标签（状态机外的未知值原样展示，防引擎新增状态后 UI 空白）。 */
export function planWfReplayStateLabel(state: string): string {
  const label: Record<string, string> = {
    done: '完成',
    failed: '失败',
    running: '执行中',
    pending: '待执行',
    skipped: '已跳过',
    compensated: '已补偿',
    awaiting: '待审批'
  };
  return label[state] ?? state;
}

/**
 * 折叠正文兜底上限。
 *
 * 此前 600 字截断把「执行详情」抽屉里每个任务的完整产出砍成开头一段 + 「…」，
 * 用户感知为「执行完成了但输出不完整」——而数据源（实时检查点 GET /api/workflows/:id
 * 与 wf:done 终态帧）本身就是无损全文，截断纯发生在展示层，属于白白丢数据。
 * 现展示层不破坏产出：正文渲染在 <details> 折叠区 + .wf-detail-body（max-height 220px
 * 滚动容器）内，长文本不撑爆抽屉布局。仅保留一个远超正常研报体量的兜底上限，
 * 防病态超长 JSON dump（如整个对象树 stringify）拖垮 DOM。
 *
 * 注意：历史镜像路径（compactPlanWfSnapshot → REPLAY_MIRROR_OUTPUT_MAX=2000）仍是有损的，
 * 那是 PUT /api/history 字节预算（HISTORY_MAX_BYTES，默认 512KB）下的持久化取舍，
 * 与本展示层上限语义不同，勿混淆。
 */
export const REPLAY_DETAIL_MAX = 200_000;

/** P4.6：交付文件条目（/api/artifacts 返回的 ArtifactMeta 前端所需最小面，本地镜像避免跨层 import）。 */
export interface PlanArtifactItem {
  id: string;
  name: string;
  sizeBytes: number;
}

/** markdown 链接转义：文件名里的 `[]|` 与换行会破坏链接语法，统一替换。 */
function escapeLinkLabel(s: string): string {
  return s.replace(/[\[\]|\\]/g, (c) => `\\${c}`).replace(/\n/g, ' ');
}

/** 人类可读文件大小（B / KB / MB），交付文件区展示用。 */
export function formatPlanArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

/**
 * P4.6：生成「📎 交付文件」区 markdown 文本（计划执行摘要最下方追加）。
 * 每个文件给「打开（preview=1 inline）+ 下载（download=1 attachment）」两个链接，
 * 经既有 toRichHtml（marked gfm）渲染为可点链接。空清单返回 ''（不追加区块）。
 */
export function buildPlanArtifactSection(
  items: PlanArtifactItem[] | null | undefined
): string {
  const list = (items ?? []).filter(
    (a) => a && typeof a.id === 'string' && a.id
  );
  if (list.length === 0) return '';
  const lines: string[] = ['', `**${PLAN_ARTIFACT_SECTION_MARK}（${list.length} 个）**`];
  for (const a of list) {
    const label = escapeLinkLabel(String(a.name ?? a.id));
    lines.push(
      `- [📄 ${label}](/api/artifacts/${
        a.id
      }?preview=1)（${formatPlanArtifactSize(
        a.sizeBytes ?? 0
      )}） ｜ [下载](/api/artifacts/${a.id}?download=1)`
    );
  }
  return lines.join('\n');
}

/**
 * 「📎 交付文件」区块的单源标记（与 buildPlanArtifactSection 的标题行同源）。
 * 恢复自愈（chat.ts: reattachPlanDeliverables）据此判断摘要 content 是否已带
 * 交付区——幂等防重挂，勿在别处硬编码同文案。
 */
export const PLAN_ARTIFACT_SECTION_MARK = '📎 交付文件';

/** 摘要 content 是否已含「📎 交付文件」区块（恢复自愈的幂等检测，纯函数）。 */
export function hasPlanArtifactSection(
  content: string | undefined | null
): boolean {
  return (
    typeof content === 'string' && content.includes(PLAN_ARTIFACT_SECTION_MARK)
  );
}

/* ─────────────── P4.6 延伸：计划执行报告（汇总交付文件） ─────────────── */

/**
 * 汇总报告在 artifact-store 里的 note 标记（幂等键）：前端串行路径与
 * 服务端 DAG 归档共用该语义 —— 同一 runId 下至多一份汇总报告，
 * 重复接线（resume / 兜底帧 / 断连自愈收敛）不重复归档。
 */
export const PLAN_FINAL_ARTIFACT_NOTE = '__plan_final__';

/**
 * 汇总报告里单任务产出的字符上限。与 REPLAY_DETAIL_MAX 同数量级但语义独立：
 * 报告是落盘交付物，宁全勿缺；单个任务产出超此上限按「截断保头」处理，
 * 并在报告里标注（防止单个失控任务把整份报告撑到几十 MB）。
 */
export const PLAN_REPORT_TASK_MAX = 200_000;

/** 文件名安全化：去文件系统/URL 非法字符，限长，空则回落固定名。 */
function sanitizeArtifactName(s: string, fallback: string): string {
  const safe = s
    .replace(/[\\/:*?"<>|\u0000-\u001f#%&{}$!'@+=`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return safe || fallback;
}

/** 汇总报告文件名：`计划报告-<goal 截断安全化>.md`。纯函数（便于单测）。 */
export function buildPlanReportFileName(goal: string): string {
  return `计划报告-${sanitizeArtifactName(goal, '执行结果')}.md`;
}

/**
 * 把 plan run 快照里的 step 产出提取为 { taskId → 产出全文 }：
 * - 仅提取 state==='done' 且产出非空的 step（failed/pending/空产出不进报告）；
 * - 非字符串产出按 JSON 序列化（与 appendPlanDagSummary 的兜底同语义）。
 * 纯函数，串行路径（taskOutputs 直传）与 DAG 路径（run 快照提取）共用。
 */
export function planOutputsFromRun(
  run:
    | {
        steps?: Record<
          string,
          { state?: string; output?: unknown } | null | undefined
        >;
      }
    | null
    | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  const steps = run?.steps ?? {};
  for (const [id, sr] of Object.entries(steps)) {
    if (!sr || sr.state !== 'done') continue;
    const v = sr.output;
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      if (v.trim()) out[id] = v;
    } else {
      try {
        const s = JSON.stringify(v, null, 2);
        if (s && s.trim()) out[id] = s;
      } catch {
        /* 不可序列化产出跳过 */
      }
    }
  }
  return out;
}

/**
 * 生成「计划执行报告」markdown 全文（plan 结束后归档为可下载交付文件）：
 * 标题 + 元信息 + 执行状态清单 + 逐任务产出全文。纯函数（便于单测）。
 *
 * @param goal    计划目标（报告标题）
 * @param tasks   计划任务视图（id/title + 可选状态，用于状态清单与章节排序）
 * @param outputs taskId → 产出全文（done 任务才有；缺产出任务在报告中显式标注）
 */
export function buildPlanFinalReport(
  goal: string,
  tasks: Array<{ id: string; title: string; state?: string }>,
  outputs: Record<string, string>
): string {
  const lines: string[] = [];
  const doneCount = tasks.filter((t) => (t.state ?? 'done') === 'done').length;
  lines.push(`# 计划执行报告：${goal}`);
  lines.push('');
  lines.push(
    `> 由计划模式自动归档 · 共 ${tasks.length} 个任务，完成 ${doneCount} 个`
  );
  lines.push('');
  lines.push('## 执行状态');
  lines.push('');
  for (const t of tasks) {
    const state = t.state ?? 'done';
    const mark = state === 'done' ? '✅' : state === 'failed' ? '❌' : '⏭';
    lines.push(`- ${mark} **${t.id}** ${t.title}（${state}）`);
  }
  lines.push('');
  lines.push('## 任务产出');
  for (const t of tasks) {
    const state = t.state ?? 'done';
    lines.push('');
    lines.push(`### ${t.id} · ${t.title}`);
    lines.push('');
    const out = (outputs[t.id] ?? '').trim();
    if (!out) {
      lines.push(
        state === 'done'
          ? '（该任务已完成，但未产出可归档的内容。）'
          : `（该任务状态为 ${state}，无产出。）`
      );
      continue;
    }
    if (out.length > PLAN_REPORT_TASK_MAX) {
      lines.push(
        out.slice(0, PLAN_REPORT_TASK_MAX) +
          '\n\n…（产出超长已截断，完整内容见会话中该任务的回复）'
      );
    } else {
      lines.push(out);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** 把 step 的产出 / 错误归一为可展示文本（对象 JSON 化、仅对病态超长做兜底截断、空白视为无内容）。 */
export function formatPlanWfOutput(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s: string;
  if (typeof v === 'string') s = v;
  else s = JSON.stringify(v, null, 2);
  s = s.trim();
  if (!s) return undefined;
  return s.length > REPLAY_DETAIL_MAX ? `${s.slice(0, REPLAY_DETAIL_MAX)}…` : s;
}

/**
 * 由（计划任务清单，WorkflowRun 快照）构建时间线行。
 * 行序 = 计划 tasks 序（拓扑合法的计划序即可读执行序）；快照缺失的 task 记 pending。
 * 快照 steps 里多出的 step（def 演化 / 补偿 step）不额外占行，避免与任务清单错位。
 */
export function buildPlanWfReplayRows(
  plan: ExecutionPlanView,
  run:
    | {
        steps?: Record<
          string,
          {
            state?: string;
            agentId?: string;
            output?: unknown;
            error?: string;
            startedAt?: number;
            finishedAt?: number;
            trace?: StepTraceNode[];
          }
        >;
      }
    | null
    | undefined
): PlanWfReplayRow[] {
  const steps = run?.steps ?? {};
  return (plan?.tasks ?? []).map((t): PlanWfReplayRow => {
    const sr = steps[t.id];
    const state = sr?.state ?? 'pending';
    const durationMs =
      sr?.startedAt && sr.finishedAt
        ? Math.max(0, sr.finishedAt - sr.startedAt)
        : undefined;
    let detail: string | undefined;
    if (state === 'failed' || state === 'compensated') {
      detail = formatPlanWfOutput(sr?.error);
    } else {
      // done / running / pending：展示已落盘的产出（running 时可能尚无）；
      // skipped 无产出语义 → 仅当快照显式记录了才展示。
      detail = state === 'skipped' ? undefined : formatPlanWfOutput(sr?.output);
    }
    return {
      id: t.id,
      title: t.title,
      agentId: sr?.agentId,
      state,
      durationMs,
      detail,
      // P2.5 调用链路：非终态（skipped/awaiting）无执行过程可回放，不透传。
      trace: sr?.trace && sr.trace.length ? sr.trace : undefined
    };
  });
}

/**
 * P2.5 调用链路 → 抽屉展示行（纯函数，供渲染端与测试共用）。
 * 把 StepTraceNode 序列归一为「图标 + 标签 + 时间（相对 step 起点）+ 详情 + 状态」的展示行。
 * 相对时间以序列首个节点为 0；无状态/未知的 status 默认 ok（不红色误报）。
 */
export interface PlanWfTraceLine {
  icon: string;
  label: string;
  /** 相对本 step 起点的时间（如 "+2.3s"；首节点 0s 不显示前缀）。 */
  at?: string;
  detail?: string;
  /** ok | error | blocked（渲染端按此着色；缺省 ok）。 */
  status?: string;
  /** 快速元数据（model / tokens / cost …）→ [键, 值] 对，渲染端做行内 chip 展示（此前被丢弃，用量/模型信息在抽屉里不可见）。 */
  meta?: [string, string][];
}

const TRACE_ICON: Record<string, string> = {
  'run:start': '▶️',
  'llm:call': '🧠',
  'llm:response': '💬',
  'tool:start': '🔧',
  'tool:result': '🔧',
  'guardrail:blocked': '🛡',
  'verify:result': '✅',
  'budget:exceeded': '⚠️',
  'run:cost': '📊',
  'llm:usage': '📊',
  'run:end': '🏁'
};

/** 调用链路单行详情上限（折叠正文由 <pre> 承接，超长截断避免抽屉膨胀）。 */
const TRACE_LINE_DETAIL_MAX = 400;

export function buildPlanWfTraceLines(
  trace: StepTraceNode[] | undefined
): PlanWfTraceLine[] {
  if (!trace || trace.length === 0) return [];
  const t0 = trace[0]?.ts ?? 0;
  return trace.map((n): PlanWfTraceLine => {
    const rel = n.ts - t0;
    const line: PlanWfTraceLine = {
      icon: TRACE_ICON[n.type] ?? '•',
      label: n.label || n.type,
      status: n.status
    };
    if (rel > 0) line.at = formatPlanWfDuration(rel);
    if (n.detail) {
      line.detail =
        n.detail.length > TRACE_LINE_DETAIL_MAX
          ? `${n.detail.slice(0, TRACE_LINE_DETAIL_MAX)}…`
          : n.detail;
    }
    // 元数据透传（用量 / 模型 / tokens …）：此前只取 icon/label/at/detail/status，
    // meta 被丢弃导致「LLM 调用」「用量」行的模型与用量数据在抽屉里不可见。
    const meta = n.meta
      ? (Object.entries(n.meta) as [string, string][]).filter(
          ([, v]) => v != null && String(v) !== ''
        )
      : undefined;
    if (meta && meta.length > 0) line.meta = meta;
    return line;
  });
}

/** 链路 meta 键 → 中文标签（未知键原样透出，采集端新增 meta 键后 UI 不空白）。 */
const TRACE_META_LABEL: Record<string, string> = {
  model: '模型',
  msgs: '消息',
  tools: '工具',
  tokens: 'Token',
  cost: '成本',
  priced: '定价',
  prompt: '输入',
  completion: '输出',
  window: '上下文窗口',
  partial: '截断',
  steps: '步数'
};

/** meta 对 → 展示标签（值缺失时省略）。 */
export function planWfTraceMetaLabel(k: string): string {
  return TRACE_META_LABEL[k] ?? k;
}

/** meta 键属「模型 / 用量」语义的集合（其余键归「参数」）。 */
const META_USAGE_KEYS: ReadonlySet<string> = new Set([
  'model',
  'tokens',
  'cost',
  'priced',
  'prompt',
  'completion',
  'window'
]);

/**
 * 独立 meta 行的标题：含任一用量/模型键 → 「模型 / 用量」（如 LLM 调用的 msgs/tools 行 → 「参数」）。
 * 独立行按用户标注「用量和模型信息需要单独一行展示，点击才能展开/折叠，在它的下面」实现。
 */
export function planWfTraceMetaRowTitle(meta: [string, string][]): string {
  return meta.some(([k]) => META_USAGE_KEYS.has(k)) ? '模型 / 用量' : '参数';
}

/** 时间线行 → 单行状态图标（渲染端直接用，避免与 buildPlanWfReplayRows 的 state 语义漂移）。 */
export function planWfReplayMark(state: string): string {
  return REPLAY_MARK[state] ?? '•';
}

/** 耗时（ms）→ 人类可读（<1s 显示 ms，否则秒、两位小数按需截断）。缺省（undefined）→ '—'。 */
export function formatPlanWfDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** derivePlanExecFromMessages 的只读消息形状（ChatMsg / MirroredMsg 均满足）。 */
export interface PlanDeriveMsg {
  role: 'user' | 'assistant' | string;
  content?: string;
  error?: boolean;
}

/**
 * 从线程消息中「反推」计划执行进度（持久化镜像缺失时的兜底）。
 *
 * 为什么需要：计划进度的权威来源有两处 —— 前端内存 `planExec`（刷新即失）与服务端
 * `planStatus` 镜像。当镜像缺失（旧数据未带该字段、镜像被前端整包覆盖、服务端重启后
 * 回落到不含该字段的镜像）时，卡片会退回默认的「待确认」，向用户重新暴露「确认执行 /
 * 取消」——与「计划已执行完成」的事实相反。此时唯一的证据就在线程本身：
 * confirmPlan 逐任务派发时会留下 user 消息 `【计划任务 tX】…`，其后的 assistant 回复
 * 即该任务的产出。
 *
 * 判定规则（保守，宁可不动也不误报「已完成」）：
 * - 计划任务 id 集合取自计划实体；派发消息里出现、但不属于本计划的 id（如用户手输的
 *   同形文本）一律忽略；
 * - 某任务记为已完成 ⟺ 其派发消息之后、下一条 user 消息之前存在一条非错误且正文非空的
 *   assistant 回复；
 * - 无任何派发痕迹 → 返回 null（信息不足，保持「待确认」）；
 * - 全部任务已完成 → done；否则 failed（首个未完成任务 = 失败/中断节点），
 *   与 applyPlanStatusLookup 对「running 视为上次执行被中断」的收敛语义一致，
 *   续跑仍需用户显式点击，绝不静默重放。
 */
export function derivePlanExecFromMessages(
  plan: { tasks?: Array<{ id?: unknown }> } | undefined,
  msgs: readonly PlanDeriveMsg[]
): PlanExecState | null {
  const ids = (plan?.tasks ?? [])
    .map((t) => (typeof t?.id === 'string' ? t.id.trim() : ''))
    .filter(Boolean);
  if (!ids.length) return null;

  const completed = new Set<string>();
  let dispatched = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const hit = PLAN_TASK_DISPATCH_RE.exec(m.content ?? '');
    if (!hit) continue;
    const id = (hit[1] ?? '').trim();
    if (!ids.includes(id)) continue;
    dispatched += 1;
    // 向后找该任务的产出：允许中间夹带非派发类 user 消息（如附件摘要），
    // 但以下一条「计划任务」派发消息为界，避免把后续任务的产出误记到本任务。
    for (let j = i + 1; j < msgs.length; j++) {
      const nxt = msgs[j];
      if (!nxt) continue;
      if (nxt.role === 'assistant') {
        if (!nxt.error && (nxt.content ?? '').trim()) completed.add(id);
        break;
      }
      if (nxt.role === 'user' && PLAN_TASK_DISPATCH_RE.test(nxt.content ?? ''))
        break;
    }
  }
  if (!dispatched) return null;

  const done: Record<string, boolean> = {};
  for (const id of ids) if (completed.has(id)) done[id] = true;
  if (ids.every((id) => completed.has(id))) return { status: 'done', done };
  return {
    status: 'failed',
    failedTaskId: ids.find((id) => !completed.has(id)),
    currentTaskId: undefined,
    done
  };
}

export interface RenderAttachmentsOpts {
  files: UploadedFile[];
  /** 点击图片缩略图的预览回调（原组件内 this.openPreview）。 */
  onPreview: (f: UploadedFile) => void;
}

/* ------------------------------------------------------------------ */
/* P2.7（修复）：计划数据「权威源 vs 历史镜像」对账纯函数（恢复路径用）  */
/* ------------------------------------------------------------------ */

/**
 * P2.7：planStatus 的「进度等级」——刷新 / 切回会话时权威源（getChatSession）与
 * 历史镜像（loadThread）可能不同步：DAG 路径终态此前只写镜像（前端 saveHistory
 * 落 SQLite），权威源缺 planStatus → 卡片退回「待确认」、执行摘要缺失。
 * 对账规则 = 取进度更高等级的一方（宁取更完整者，不覆盖更新鲜的 running/awaiting）：
 * done > cancelled > failed > awaiting > running > 缺失(0)。
 * 等级相同时保持权威源（调用方 merge 时不写回），避免旧镜像回退新权威。
 */
export function planStatusProgressRank(
  ps?: {
    status?: string;
  } | null
): number {
  if (!ps) return 0;
  switch (ps.status) {
    case 'done':
      return 5;
    case 'cancelled':
      return 4;
    case 'failed':
      return 3;
    case 'awaiting':
      return 2;
    case 'running':
      return 1;
    default:
      return 0;
  }
}

/**
 * P2.7：把历史镜像的 planStatus 对账进权威源查找表（按 plan.goal 对齐，
 * buildPlanStatusLookup 的同一键空间）。纯函数，零 this 依赖：
 * - 镜像等级**严格高于**权威 → 该 goal 改用镜像值（权威缺 planStatus / 落后于镜像）；
 * - 等级相同或缺失 → 保持权威（权威缺失时镜像是唯一来源，直接补上）；
 * - wfSnapshot 只进不出：选中值缺 wfSnapshot 而另一份有 → 补（「执行详情」抽屉
 *   镜像回退数据源不因对账丢失）。
 */
export function mergePlanStatusLookup(
  authoritative: Map<string, PlanExecMirror>,
  mirrored: Map<string, PlanExecMirror>
): Map<string, PlanExecMirror> {
  if (!mirrored.size) return authoritative;
  const out = new Map(authoritative);
  for (const [goal, m] of mirrored) {
    const a = out.get(goal);
    if (!a) {
      out.set(goal, m);
      continue;
    }
    const rankM = planStatusProgressRank(m);
    const rankA = planStatusProgressRank(a);
    if (rankM > rankA) {
      out.set(goal, { ...a, ...m });
    } else if (m.wfSnapshot && !a.wfSnapshot) {
      // 同级：不降级权威，仅补快照（重启 / 413 裁剪后权威可能丢 wfSnapshot）。
      out.set(goal, { ...a, wfSnapshot: m.wfSnapshot });
    }
  }
  return out;
}

/** 「📋 计划执行摘要」消息的内容前缀（与 chat.ts appendPlanDagSummary 的生成格式一致）。 */
export const PLAN_DAG_SUMMARY_PREFIX = '📋 计划执行摘要：';

/**
 * P2.7：从「计划执行摘要」消息正文提取 goal（首行 `📋 计划执行摘要：${goal}（共 N 个任务）`）。
 * 摘要缺失 / 非摘要消息返回 null；goal 提取失败（首行被截断）也返回 null（宁缺勿错，
 * 调用方不插入 → 不产生无法对齐的孤儿摘要）。
 */
export function planDagSummaryGoal(content: string): string | null {
  if (!content.startsWith(PLAN_DAG_SUMMARY_PREFIX)) return null;
  const rest = content.slice(PLAN_DAG_SUMMARY_PREFIX.length);
  const idx = rest.indexOf('（共 ');
  const goal = (idx >= 0 ? rest.slice(0, idx) : rest).trim();
  return goal || null;
}

/**
 * P2.7：找出「权威源缺失、镜像存在」的计划执行摘要消息内容（按 goal 去重）。
 *
 * 背景：DAG 路径的执行摘要由前端 appendPlanDagSummary 生成、仅落历史镜像（权威源
 * getChatSession 无此消息）——服务端重启 / 权威源落后时刷新后「执行结果」整段缺失。
 * 恢复时按 goal 判重：权威源已含同 goal 摘要（服务端 P2.7 修复后 applyPlanWfTerminal
 * 会把摘要追加进权威源，双源一致）→ 不再插入，避免双份摘要。
 *
 * @param authoritative 恢复后的线程（新 id 重建后的 ChatMsg[]）
 * @param mirrored 历史镜像消息（loadThread 消毒后的 MirroredMsg[]）
 * @returns 需补回线程的摘要内容（镜像顺序，每 goal 至多一份）
 */
export function missingPlanSummaries(
  authoritative: ReadonlyArray<{ content?: string }>,
  mirrored: ReadonlyArray<{ role?: string; content?: string }>
): string[] {
  // 权威源已覆盖的 goal（摘要消息，或 plan 消息本身已带更高进度不算——只看摘要行）。
  const covered = new Set<string>();
  for (const m of authoritative) {
    const g = planDagSummaryGoal(m.content ?? '');
    if (g) covered.add(g);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of mirrored) {
    if (m.role !== 'assistant' || !m.content) continue;
    const g = planDagSummaryGoal(m.content);
    if (!g || covered.has(g) || seen.has(g)) continue;
    seen.add(g);
    out.push(m.content);
  }
  return out;
}

/**
 * 渲染图片附件：作为独立于气泡的附件卡片（调用方负责放在气泡上方，而非气泡内）。
 * - 单张图片：直接缩略图，点击预览。
 * - 多张图片：折叠态为**交错堆叠**（错位 + 旋转层叠）+「N 张」角标，点击展开为
 *   平铺网格；展开态提供「收起」按钮恢复堆叠；展开后单张点击预览。
 */
export function renderImageAttachments(
  opts: RenderAttachmentsOpts
): TemplateResult | typeof nothing {
  const { files, onPreview } = opts;
  const images = files.filter((f) => f.type.startsWith('image/'));
  const first = images[0];
  if (!first) return nothing;

  if (images.length === 1) {
    return html`
      <div
        class="attach-img is-previewable"
        title="点击预览"
        @click=${() => onPreview(first)}
      >
        <img
          src=${first.dataUrl}
          alt=${escapeHtml(first.name)}
          loading="lazy"
        />
      </div>
    `;
  }

  // 交错堆叠的居中系数：让 --i 围绕中点对称分布（层叠左右均衡）。
  const mid = (images.length - 1) / 2;
  const expand = (e: Event) => {
    const card = (e.currentTarget as HTMLElement).closest('.attach-card');
    if (card) card.classList.add('expanded');
  };
  const collapse = (e: Event) => {
    e.stopPropagation();
    const card = (e.currentTarget as HTMLElement).closest('.attach-card');
    if (card) card.classList.remove('expanded');
  };
  const onImgClick = (e: Event, f: UploadedFile) => {
    e.stopPropagation();
    onPreview(f);
  };

  return html`
    <div class="attach-card">
      <div class="attach-card-stack" title="点击展开全部图片" @click=${expand}>
        ${images.map(
          (f, i) =>
            html`<div class="attach-img" style="--i:${i};--mid:${mid}">
              <img src=${f.dataUrl} alt=${escapeHtml(f.name)} loading="lazy" />
              ${i === images.length - 1
                ? html`<span class="attach-card-badge"
                    >${images.length} 张</span
                  >`
                : nothing}
            </div>`
        )}
      </div>
      <div class="attach-card-expanded">
        <div class="attach-card-head">
          <span>${images.length} 张图片</span>
          <button
            type="button"
            class="attach-card-collapse"
            title="收起图片"
            @click=${collapse}
          >
            收起
          </button>
        </div>
        <div class="attach-card-grid">
          ${images.map(
            (f) =>
              html`<div
                class="attach-img is-previewable"
                title="点击预览"
                @click=${(e: Event) => onImgClick(e, f)}
              >
                <img
                  src=${f.dataUrl}
                  alt=${escapeHtml(f.name)}
                  loading="lazy"
                />
              </div>`
          )}
        </div>
      </div>
    </div>
  `;
}

/**
 * 渲染非图片附件（PDF / 文本 / 表格等，走文字条目）。图片已由
 * renderImageAttachments 独立成卡片置于气泡外，此处不再处理图片。
 */
export function renderAttachments(
  opts: RenderAttachmentsOpts
): TemplateResult | typeof nothing {
  const { files } = opts;
  const others = files.filter((f) => !f.type.startsWith('image/'));
  if (others.length === 0) return nothing;
  return html`
    <div class="attachments">
      ${others.map(
        (f) =>
          html`<div class="attach-file">
            ${fileIcon(f)} ${escapeHtml(f.name)} (${formatSize(f.size)})
          </div>`
      )}
    </div>
  `;
}
