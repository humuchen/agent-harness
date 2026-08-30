/**
 * agent-harness /api/v1 共享类型（客户端视图）。
 * 与 access/server/src/server.ts 的实际响应形状保持一致；SSE 事件采用
 * 「已知形状 + 泛型兜底」策略，避免对 harness 内部事件做过度约束。
 */

export type RunMode = 'mock' | 'real' | 'real-mcp';

/** 任意 SSE 事件：以 type 区分，其余字段透传。 */
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/* ----------------------------- 运行 (run) ----------------------------- */

export interface RunInput {
  mode?: RunMode;
  prompt?: string;
  model?: string;
  /** 自定义模型专属接口地址（OpenAI 兼容端点 base URL）。透传给 runner 构造直连 LLM。 */
  modelBaseUrl?: string;
  /** 自定义模型专属 API Key。与 modelBaseUrl 搭配使用；缺省走服务端默认凭证。 */
  modelApiKey?: string;
  /** 所选模型的官方上下文窗口上限（token）：来自模型目录 context_length，供 llm:usage 作分母。 */
  ctxWindow?: number;
  maxSteps?: number;
  sessionId?: string;
  /** 多会话 Chat App：客户端分配的聊天会话 id，服务端据此把消息写入会话存储。 */
  chatSessionId?: string;
  /** 定向业务 agent（agentId）。不传则走默认通用 agent。Web 端用于把对话路由到具体插件 agent。 */
  agentId?: string;
  /** 断线重连：携带已知 jobId 直接订阅事件重放，不重复提交。 */
  jobId?: string;
  /** 断线续传游标：已收到的最大事件 seq；服务端重放时跳过 seq ≤ since 的事件，恢复不重复。 */
  since?: number;
  /** 审批工单号：敏感动作获批后随请求重投。 */
  approvalTicket?: string;
  /** 图片附件列表（含 serverUrl），服务端将其转为 ContentBlock[] 传给 LLM。 */
  attachments?: Array<{ url: string; name: string; type: string }>;
  /** 联网搜索开关：true 时服务端注册 web_fetch 工具与「联网检索」技能；否则不触发任何出网检索。 */
  web?: boolean;
  /** 交互模式（P0）：qa=问答（默认，缺省即现状）；plan=计划模式。 */
  interactionMode?: 'qa' | 'plan';
  /** 计划阶段（interactionMode='plan' 时有效）：propose=生成计划（缺省）；execute=执行已确认任务。 */
  planPhase?: 'propose' | 'execute';
}

/* ------------------------- 聊天历史镜像（接口层） ------------------------- */

/** 单会话历史镜像元信息（GET /api/history 列表项）。 */
export interface HistoryThreadMeta {
  sid: string;
  title: string;
  /** 会话最近更新时间（毫秒，客户端上报）。 */
  updatedAt: number;
  /** 镜像落盘时间（毫秒）。 */
  savedAt: number;
}

/** 历史信封：GET /api/history/:sid 返回结构（msgs 为服务端存储的原始消息数组）。 */
export interface HistoryEnvelope extends HistoryThreadMeta {
  v: number;
  msgs: unknown[];
  /** 会话级用量快照（前端在保存历史时一并写入，恢复时回填上下文用量浮层）。
   * 不含于 msgs，作为信封并行字段，向后兼容旧版（缺失时为 undefined）。 */
  usage?: {
    backendUsage: {
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
      };
    } | null;
    runCumulative: { tokens: number; cost: number } | null;
  } | null;
}

/** 历史写入入参：PUT /api/history/:sid。 */
export interface HistoryPutInput {
  title?: string;
  updatedAt?: number;
  msgs: unknown[];
  /** 会话级用量快照（可选，向后兼容）。 */
  usage?: HistoryEnvelope['usage'];
}

/* ----------------------------- 多会话 Chat App ----------------------------- */

/** 工具调用记录（跨端还原用，参数/结果均为字符串）。 */
export interface StoredTool {
  name: string;
  args?: string;
  result?: string;
  errored?: boolean;
}

/** 调用链路追踪节点类型。 */
export type TraceKind =
  | 'run'
  | 'step'
  | 'llm'
  | 'tool'
  | 'retrieval'
  | 'reasoning'
  | 'cost'
  | 'verify'
  | 'guardrail'
  | 'budget'
  | 'tokencache'
  | 'error';

/**
 * 调用链路（trace）节点：把一次 run 的「步骤 → LLM 调用 → 工具/检索/成本」以树状结构记录，
 * 用于深度思考界面中可视化智能体的外部调用过程，便于追踪与复盘。
 * detail/result 均为已格式化的可读字符串（如美化的 JSON），Children 构成调用层级。
 */
export interface TraceNode {
  id: string;
  kind: TraceKind;
  label: string;
  status: 'ok' | 'error' | 'pending';
  /** 输入/参数（已格式化字符串）。 */
  detail?: string;
  /** 输出/结果（已格式化字符串）。 */
  result?: string;
  /** 快速展示用的元数据标签，如 step、model、tokens、cost、duration。 */
  meta?: Record<string, string>;
  /** LLM 调用时携带的「截至此次调用的会话消息上下文」（来自前端 threads，纯前端展开用）。
   *  点击 LLM 节点上的「消息 N」chip 时，就地展开这 N 条消息（role + content）供回看。 */
  messages?: ChatMessage[];
  /** 纯前端 UI 态：消息上下文面板是否展开（由「消息 N」chip 切换，持久化在节点上以防重渲染丢失）。 */
  msgOpen?: boolean;
  /** 纯前端 UI 态：工具调用列表是否收起（由「工具 N」chip 切换）。 */
  toolsCollapsed?: boolean;
  /** 纯前端 UI 态：LLM 调用节点是否展开（点「LLM 调用」标题统一控制消息上下文与工具列表的显隐）。 */
  expanded?: boolean;
  children: TraceNode[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
  /** 推理过程（深度思考折叠块），仅推理模型产出。 */
  reasoning?: string;
  /** 本轮处理的工具调用列表，用于回看时还原工具卡片。 */
  tools?: StoredTool[];
  /** 调用链路追踪树，记录 LLM↔工具↔检索 的每一步，供深度思考界面可视化与复盘。 */
  trace?: TraceNode[];
  /** 计划模式：run:end 时服务端解析出的结构化执行计划（形状见 @agent-harness/core 的
   *  ExecutionPlan；client 不依赖 core，按 unknown 结构透传，由 UI 层自行收敛校验）。 */
  plan?: unknown;
  /** 计划模式：任务级执行进度镜像（服务端随派发/完成/失败事件维护），
   *  刷新 / 切回会话 / 服务重启后前端据此还原计划卡片状态并支持续跑。 */
  planStatus?: PlanExecMirror;
  /** 用户消息携带的附件（图片/文件），随会话历史持久化，供刷新 / 切回后还原气泡内预览。
   *  url 兼容「本地 dataUrl（base64）」与「服务端上传后的相对地址」两种来源；
   *  dataUrl 仅在单图体积受限内落盘，超限则不持久化（仅当次显示）。 */
  attachments?: Array<{ name: string; type: string; url?: string; serverUrl?: string }>;
}

/** 计划执行进度镜像（JSON 友好：done 用 id 数组而非对象）。 */
export interface PlanExecMirror {
  status: 'running' | 'done' | 'failed' | 'cancelled';
  currentTaskId?: string;
  failedTaskId?: string;
  done: string[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** 交互模式（问答/计划），按会话持久化，供跨设备对齐。 */
  interactionMode?: 'qa' | 'plan';
  /** 选中的模型标识，按会话持久化，供跨设备对齐。 */
  model?: string;
  /** 定向业务 agent id（空=默认通用 Agent），按会话持久化，供跨设备对齐。 */
  agentId?: string;
}

/** run 流首帧：服务端已接收并分配 jobId。 */
export interface JobAcceptedEvent extends StreamEvent {
  type: 'job:accepted';
  jobId: string;
}

/** 流终结帧。 */
export interface DoneEvent extends StreamEvent {
  type: '_done';
}

export type RunEvent = JobAcceptedEvent | DoneEvent | StreamEvent;

/* ----------------------------- 验证 (verify) ----------------------------- */

export interface VerifyEvent extends StreamEvent {
  type:
    | 'verify:start'
    | 'verify:group'
    | 'verify:assert'
    | 'verify:error'
    | 'verify:summary'
    | '_verify_done'
    | string;
}

/* ----------------------------- 环境 (env) ----------------------------- */

export type EnvStatus = 'pending' | 'running' | 'ready' | 'destroying' | 'destroyed' | 'error';

export interface EnvHandle {
  envId: string;
  envUrl?: string;
  status: EnvStatus;
  envType?: string;
  branch?: string;
  region?: string;
  owner?: string;
  ttlHours?: number;
  createdAt?: number;
  expiresAt?: number;
  error?: string;
}

export type EnvAction = 'create' | 'destroy';

export interface EnvInput {
  action: EnvAction;
  env_type?: string;
  branch?: string;
  ttl_hours?: number;
  region?: string;
  owner?: string;
  env_id?: string;
}

export interface EnvStatusEvent extends StreamEvent {
  type: 'env:status';
  env: EnvHandle;
}

export interface EnvDoneEvent extends StreamEvent {
  type: '_env_done';
  error?: boolean;
  found?: boolean;
}

export type EnvEvent = EnvStatusEvent | EnvDoneEvent | StreamEvent;

/* ----------------------------- MCP ----------------------------- */

export interface McpToolRef {
  registeredName: string;
  originalName: string;
  description?: string;
}

export interface McpServerMeta {
  name: string;
  url?: string | null;
  status: string;
  health?: string | null;
  reconnectAttempts?: number;
  toolCount: number;
  tools: McpToolRef[];
  error?: string | null;
}

export interface McpPreset {
  id: string;
  name: string;
  authType: string;
  [key: string]: unknown;
}

export interface AddMcpInput {
  name?: string;
  url?: string;
  serverUrl?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  transportType?: 'auto' | 'sse' | 'streamable-http';
  token?: string;
}

/* ----------------------------- 审批 (approvals) ----------------------------- */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalTicket {
  id: string;
  action: string;
  requestedBy?: string;
  status: ApprovalStatus;
  createdAt?: number;
  decidedBy?: string;
  decision?: string;
  note?: string;
}

/* ----------------------------- 配方 / 评估 ----------------------------- */

export interface Recipe {
  id: string;
  name: string;
  createdAt: number;
  record: unknown;
  notes?: string;
}

export interface EvalResult {
  jobId: string;
  record: unknown;
  result: { score: number; passed: boolean; [k: string]: unknown };
}

/* ----------------------------- 状态 / 运维 ----------------------------- */

export interface ServerState {
  openrouter: boolean;
  harnessKey: boolean;
  harnessDryRun: boolean;
  model: string;
  /** 当前模型的上下文窗口上限（token），按服务端模型目录解析（含 AH_CONTEXT_WINDOW 覆盖）；
   *  前端「上下文用量」粗估回退以此为分母，避免写死基线导致大窗口模型显示错误。 */
  contextWindow: number;
  /** OS 级沙箱能力快照（由 /api/sandbox 同源构建）；null = 未启用或当前平台不支持（macOS/Windows 属此类）。 */
  sandbox: {
    backend: string;
    supported: boolean;
    reason: string;
    active: { namespaces: boolean; seccomp: boolean; resourceLimits: boolean; capabilities: boolean };
    profile?: unknown;
  } | null;
  mcpServers: Array<{
    name: string;
    url: string | null;
    status: string;
    health: string | null;
    reconnectAttempts: number;
    toolCount: number;
    tools: McpToolRef[];
    error: string | null;
  }>;
  mcpPresets: Array<{ id: string; name: string; authType: string }>;
  envs: EnvHandle[];
}

/* ----------------------------- 智能体 (agents / P1.①) ----------------------------- */

export type AgentTransport = 'local' | 'mcp' | 'a2a';
export type IndustryDomain =
  | 'medical-aesthetics'
  | 'finance'
  | 'healthcare'
  | 'education'
  | 'generic'
  | (string & {});

export interface AgentCapability {
  id: string;
  version?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface AgentHealth {
  status: 'healthy' | 'degraded' | 'down';
  lastHeartbeat: number;
  load: number;
}

export interface AgentCard {
  id: string;
  name: string;
  domain: IndustryDomain;
  description?: string;
  capabilities: AgentCapability[];
  transport: AgentTransport;
  endpoint?: string;
  version: string;
  owner?: string;
  health: AgentHealth;
  sla?: { p95LatencyMs?: number; maxConcurrency?: number };
  /** 本地 agent 的装配配方：只挂这些工具/MCP/技能，而非全部。 */
  assembly?: {
    systemPrompt?: string;
    skills?: string[];
    mcpServers?: string[];
    tools?: string[];
  };
}

export interface AgentQuery {
  domain?: IndustryDomain;
  capability?: string;
}

/* ----------------------------- A2A 任务 (tasks / P1.④) ----------------------------- */

export interface TaskEnvelope {
  taskId: string;
  tenantId: string;
  traceId?: string;
  fromAgent: string;
  toAgent: string;
  input: unknown;
  inputSchema?: Record<string, unknown>;
  sla?: { timeoutMs?: number };
  callback?: string;
}

export interface TaskResult {
  taskId: string;
  status: 'success' | 'failed';
  output?: unknown;
  error?: string;
}

/** 远端 agent 提交给本平台的任务体：可携带 AgentCard 自注册（首次入驻）。 */
export interface A2ARequest {
  envelope: TaskEnvelope;
  card?: AgentCard;
}

/* ----------------------------- 工作流 (workflows / P1.⑤) ----------------------------- */

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'compensated';

export interface StepDef {
  id: string;
  /** 目标 agent（agentId 或 AgentCard）。 */
  agentRef: string;
  /** 输入映射：'input' = 工作流输入；'steps.<id>' = 某 step 的输出。 */
  inputMapping: Record<string, string>;
  dependsOn?: string[];
  /** 该 step 失败时逆序执行的补偿 step id。 */
  compensate?: string;
}

export interface WorkflowDef {
  id: string;
  steps: StepDef[];
}

export interface StepRun {
  id: string;
  state: StepState;
  output?: unknown;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowRun {
  def: WorkflowDef;
  state: 'running' | 'done' | 'failed';
  steps: Record<string, StepRun>;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/** 工作流 SSE 事件。与 harness 事件同通道：wf:* 为编排事件；harness 事件以 { type:'harness', event } 包裹。 */
export type WorkflowEvent =
  | { type: 'wf:start'; workflowId: string }
  | { type: 'wf:step:start'; workflowId: string; stepId: string; agentId?: string }
  | { type: 'wf:step:done'; workflowId: string; stepId: string; output: unknown }
  | { type: 'wf:step:failed'; workflowId: string; stepId: string; error: string }
  | { type: 'wf:compensate:start'; workflowId: string; stepId: string }
  | { type: 'wf:compensate:done'; workflowId: string; stepId: string }
  | { type: 'wf:done'; workflowId: string; run: WorkflowRun }
  | { type: 'wf:failed'; workflowId: string; run: WorkflowRun }
  | { type: 'wf:error'; workflowId: string; error: string }
  | StreamEvent;
