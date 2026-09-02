/**
 * chat-types：聊天界面本地视图类型（从 chat.ts 单体拆出）。
 *
 * 收敛 AhChat 组件内部使用的视图层接口：工具调用卡片、计划模式实体、消息、会话、
 * 调用链路追踪瞬态上下文等。这些类型仅描述「前端本地渲染形态」，与 core 的领域契约
 * 解耦（core 类型从 @agent-harness/client 引入）。集中后 chat.ts 体积下降、类型单一
 * 可寻址，且便于 plan/trace 等子模块在需要时复用（见可维护性审计 P2：降低 chat.ts 单体规模）。
 */
import type { TraceNode } from '@agent-harness/client';
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
}
export interface ExecutionPlanView {
  goal: string;
  tasks: PlanTaskView[];
}
/** 计划执行状态（key 为携带计划的消息 id）。 */
export interface PlanExecState {
  status: 'pending' | 'running' | 'done' | 'cancelled' | 'failed';
  /** 正在执行的任务 id（running 时有效）。 */
  currentTaskId?: string;
  /** 失败的任务 id（failed 时有效）：恢复执行时从此任务重跑，已完成任务跳过。 */
  failedTaskId?: string;
  /** 已完成任务 id 集合。 */
  done: Record<string, boolean>;
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
