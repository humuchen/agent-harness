/**
 * agent-harness /api/v1 共享类型（客户端视图）。
 * 与 packages/server/src/server.ts 的实际响应形状保持一致；SSE 事件采用
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
  maxSteps?: number;
  sessionId?: string;
  /** 断线重连：携带已知 jobId 直接订阅事件重放，不重复提交。 */
  jobId?: string;
  /** 审批工单号：敏感动作获批后随请求重投。 */
  approvalTicket?: string;
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
  mcpUrl: string | null;
  model: string;
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
