/**
 * chat-types：聊天界面本地视图类型（从 chat.ts 单体拆出）。
 *
 * 收敛 AhChat 组件内部使用的视图层接口：工具调用卡片、计划模式实体、消息、会话、
 * 调用链路追踪瞬态上下文等。这些类型仅描述「前端本地渲染形态」，与 core 的领域契约
 * 解耦（core 类型从 @agent-harness/client 引入）。集中后 chat.ts 体积下降、类型单一
 * 可寻址，且便于 plan/trace 等子模块在需要时复用（见可维护性审计 P2：降低 chat.ts 单体规模）。
 */
import type { StepTraceNode, TraceNode, WorkflowRun } from '@agent-harness/client';
import type { UploadedFile } from './agent-context';

export interface ToolView {
  name: string;
  args: string;
  result?: string;
  errored?: boolean;
}

/** 计划模式（P0）：计划任务 / 计划实体（与 core ExecutionPlan 契约一致，前端本地视图类型）。 */
export interface PlanTaskView {
  id: string;
  title: string;
  steps: string[];
  dependsOn: string[];
  expectedOutput: string;
  /** P3：执行该任务前需用户人工批准（planner 对高风险任务标记；卡片以 🔒 呈现）。 */
  requireApproval?: boolean;
}
export interface ExecutionPlanView {
  goal: string;
  tasks: PlanTaskView[];
}
/** 计划模式（P0）：澄清问题（可附候选选项供点选；历史落盘可能为纯字符串，渲染前归一化）。 */
export interface PlanClarifyQuestionView {
  q: string;
  /** 2~4 个典型候选答案，用户可点选（可多选）。 */
  options?: string[];
}

/** 计划模式（P0）：澄清卡的用户输入状态（key 为题号字符串，便于对象字面量展开）。 */
export interface ClarifyDraftState {
  /** 每题勾选的选项（题号 → 已选选项文本数组）。 */
  picks: Record<string, string[]>;
  /** 每题的自定义补充输入。 */
  texts: Record<string, string>;
  /** 底部整体补充。 */
  extra: string;
}

/** 计划模式（P0）：需求不清时的澄清结果（plan:clarify 契约，与 core PlanClarify 一致）。 */
export interface PlanClarifyView {
  clarify: true;
  /** 模型对目标的初步理解草稿，供用户确认或修正。 */
  goalDraft: string;
  /** 需要用户回答 / 确认的关键问题（可附候选选项）。 */
  questions: PlanClarifyQuestionView[];
  /** 模型判断缺失的关键信息或前置条件（可选）。 */
  needs?: string;
}
/** 计划执行状态（key 为携带计划的消息 id）。 */
export interface PlanExecState {
  status: 'pending' | 'running' | 'done' | 'cancelled' | 'failed' | 'awaiting';
  /** 正在执行的任务 id（running 时有效）。 */
  currentTaskId?: string;
  /** 失败的任务 id（failed 时有效）：恢复执行时从此任务重跑，已完成任务跳过。 */
  failedTaskId?: string;
  /** 已完成任务 id 集合。 */
  done: Record<string, boolean>;
  /** P3：当前等待人工审批的任务 id 列表（status==='awaiting' 时有效）。 */
  awaitingTaskIds?: string[];
  /**
   * P2.6：紧凑 run 快照（wf:done/wf:failed/_wf_done 帧的 run 经 compactPlanWfSnapshot 收敛）。
   * 随 planStatus 镜像落会话历史（见 chat-persist.toMirrorPlanStatus）：检查点在服务重启 /
   * Render free 盘清理后丢失时，「执行详情」抽屉按此镜像回退水合（404 → 历史快照）。
   */
  wfSnapshot?: PlanWfRunMirror;
}

/**
 * P2.6：run 快照的紧凑镜像形态（写入 planStatus 镜像随会话历史持久化）。
 * 与 WorkflowRun 形状兼容（buildPlanWfReplayRows 直接消费），但只保留回放用到的字段：
 * - output 截断（REPLAY_MIRROR_OUTPUT_MAX）/ trace 限幅（REPLAY_MIRROR_TRACE_MAX 节点、detail 200 字）
 *   —— 控制历史信封体积（PUT /api/history 有字节预算，超限 413）；
 * - 不落 def（任务标题/依赖来自 m.plan 本身）、不落凭据（StepTraceNode 服务端采集端已红线）。
 */
export interface PlanWfRunMirror {
  state: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  steps: Record<string, {
    state?: string;
    agentId?: string;
    error?: string;
    startedAt?: number;
    finishedAt?: number;
    output?: string;
    trace?: StepTraceNode[];
  }>;
}

export interface ChatMsg {
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
  /** 计划模式（P0）：propose 阶段进度（理解需求 / 调研中 / 生成计划），用于渲染阶段进度条。 */
  planPhase?: string;
  /** 计划模式（P0）：propose 开始时间戳（毫秒），驱动「已进行 Xs」实时计时器。 */
  planStartedAt?: number;
  /** 计划模式（P0）：需求不清时携带的澄清结果（plan:clarify 时写入），渲染目标确认卡。 */
  clarify?: PlanClarifyView;
  /** 本轮 run 期间是否触发过上下文压缩（最旧对话被自动压缩/淘汰），用于在该条气泡下方显示「已压缩」标识。 */
  compressed?: boolean;
}

export interface SessionView {
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
export interface TraceCtx {
  root: TraceNode | null;
  parent: TraceNode | null;
  llm: TraceNode | null;
  lastTool: TraceNode | null;
  /** 按 tool:start/tool:result 事件携带的 call.id 索引工具节点，避免并行工具结果误挂到单指针 lastTool。 */
  toolByCallId: Record<string, TraceNode>;
  seq: number;
}

/**
 * P2（轨迹回放）：计划「执行详情」抽屉的瞬态。
 * key 为携带计划的消息 id；打开时经 client.getWorkflow(derivePlanWfId) 拉取检查点快照，
 * 服务端重启 / 旧串行 run / 检查点未落盘时 snapshot 为 null（抽屉显示「不可回放」提示，
 * 并指向「断点续跑」兜底路径，见 design/plan-mode-multiagent.md §9.5）。
 */
export interface PlanWfReplayState {
  /** 正在拉取快照（抽屉已开、请求在途）。 */
  loading: boolean;
  /** 拉取失败原因（404 无检查点 / 网络错误）；成功时 undefined。 */
  error?: string;
  /** 服务端检查点快照（WorkflowRun 本身即轨迹）；缺失为 null。 */
  snapshot: WorkflowRun | null;
  /**
   * P2.6：快照来自 planStatus 历史镜像回退（compactPlanWfSnapshot 紧凑形态，检查点 404 后水合）。
   * 非镜像回退（实时检查点）时为 undefined。
   */
  mirrorSnapshot?: PlanWfRunMirror;
  /**
   * P2.6：true = 快照来自 planStatus 历史镜像回退（检查点 404 后从会话历史水合），
   * 抽屉头部标注「检查点已过期，以下为历史镜像快照」；来自实时检查点时为 undefined。
   */
  fromMirror?: boolean;
}
