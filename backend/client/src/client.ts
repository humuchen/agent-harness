/**
 * AgentClient —— agent-harness /api/v1 的零依赖强类型 HTTP 客户端。
 *
 * 设计要点：
 * - 可注入 `fetch`：浏览器/Node18+/RN(配 polyfill)/Edge 通吃，无任何硬依赖。
 * - SSE 流用 `parseSse` 异步迭代器；`run/verify/env` 三个端点共用。
 * - 建模服务端特有行为：Bearer 鉴权、敏感动作的 202 审批工单、jobId 断线重连。
 */

import { parseSse, type SseOptions } from './sse.js';
import type {
  AddMcpInput,
  AgentCard,
  AgentQuery,
  A2ARequest,
  ApprovalStatus,
  ApprovalTicket,
  ChatSession,
  EvalResult,
  EnvEvent,
  EnvHandle,
  EnvInput,
  HistoryEnvelope,
  HistoryPutInput,
  HistoryThreadMeta,
  McpPreset,
  McpServerMeta,
  Recipe,
  RunEvent,
  RunInput,
  RunMode,
  ServerState,
  TaskResult,
  VerifyEvent,
  WorkflowDef,
  WorkflowEvent,
  WorkflowRun,
} from './types.js';

export interface AgentClientOptions {
  /** 服务端基址，如 https://harness.example.com（自动去除尾部斜杠）。 */
  baseUrl: string;
  /** Bearer 令牌（非浏览器客户端兼容；浏览器优先用 cookie）。可后续 setToken 动态设置。 */
  token?: string;
  /** 当前登录用户名；浏览器鉴权为 cookie + x-ah-username 双因子校验，需随请求带上。 */
  username?: string;
  /** 401 回调：登录态失效时由调用方统一跳转登录页（幂等）。 */
  onUnauthorized?: () => void;
  /** 可注入 fetch（跨运行时 / 测试替身）。默认取全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 敏感动作需审批：POST 返回 202 + 工单，客户端据此轮询/重投。 */
export class ApprovalRequiredError extends Error {
  constructor(
    public ticketId: string,
    public poll: string,
    public action: string
  ) {
    super(`action "${action}" requires approval: ticket ${ticketId}`);
    this.name = 'ApprovalRequiredError';
  }
}

export class AgentClient {
  private readonly baseUrl: string;
  private token?: string;
  private username?: string;
  private readonly onUnauthorized?: () => void;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AgentClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.username = opts.username;
    this.onUnauthorized = opts.onUnauthorized;
    const f = opts.fetchImpl ?? (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!f) throw new Error('global fetch unavailable; pass fetchImpl explicitly');
    // 浏览器里 window.fetch 是原生方法：若直接保存为属性再以 this.fetchImpl(...) 调用，
    // this 不再是 Window 会抛 "Failed to execute 'fetch' on 'Window': Illegal invocation"。
    // 绑定到全局对象即可在浏览器 / Node 18+ / Edge 全运行时安全调用。
    this.fetchImpl = f.bind(globalThis as unknown as typeof globalThis) as typeof fetch;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  /** 设置当前登录用户名，随 cookie 一起做双因子校验。 */
  setUsername(username: string | undefined): void {
    this.username = username;
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token) h.authorization = `Bearer ${this.token}`;
    // 浏览器侧账户鉴权：服务端要求 cookie(ah_auth) + x-ah-username 双因子一致，
    // 这里把用户名带到 header（cookie 由浏览器自动附加）。非浏览器客户端也可带。
    if (this.username) h['x-ah-username'] = this.username;
    return h;
  }

  private async request(
    path: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(this.authHeaders())) headers.set(k, v);
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (res.status === 401 && this.onUnauthorized) {
      this.onUnauthorized();
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg =
        (data && typeof data === 'object' && 'error' in data
          ? String((data as { error: unknown }).error)
          : res.statusText) || `HTTP ${res.status}`;
      throw new ApiError(res.status, msg, data);
    }
    return data as T;
  }

  /* ----------------------------- 健康检查 / 契约 ----------------------------- */

  getState(): Promise<ServerState> {
    return this.json<ServerState>('/api/v1/state');
  }

  getOpenApi(): Promise<unknown> {
    return this.json<unknown>('/api/v1/openapi.json');
  }

  /* ----------------------------- 运维视图 ----------------------------- */

  getMetrics(): Promise<unknown> {
    return this.json('/api/v1/metrics');
  }
  getJobs(): Promise<{ queue: unknown; jobs: unknown[] }> {
    return this.json('/api/v1/jobs');
  }
  getSessions(): Promise<{ backend: string; sessions: string[] }> {
    return this.json('/api/v1/sessions');
  }
  getRoles(): Promise<unknown> {
    return this.json('/api/v1/roles');
  }
  getRetention(): Promise<unknown> {
    return this.json('/api/v1/retention');
  }

  /* ----------------------------- 多会话 Chat App ----------------------------- */

  /**
   * 列出全部聊天会话（含消息记录），按最近更新倒序。
   * 一次性拉全量，仅适合会话很少或需要完整快照的场景；
   * 左侧列表的分页/滚动加载请用 `listChatSessionsPage()`。
   */
  listChatSessions(): Promise<ChatSession[]> {
    return this.json<{ sessions: ChatSession[] }>('/api/v1/chat/sessions').then((r) => r.sessions);
  }

  /**
   * 分页列出聊天会话，按最近更新倒序（左侧历史列表滚动加载用）。
   * 返回页内条目 + 过滤后全量总数 + 是否还有下一页。
   * 对老服务端（无分页能力、响应无 total/hasMore）做形状兜底：视为「只有这一页」。
   */
  listChatSessionsPage(opts: { limit?: number; offset?: number } = {}): Promise<{
    sessions: ChatSession[];
    total: number;
    hasMore: boolean;
  }> {
    const q: string[] = [];
    if (opts.limit !== undefined) q.push(`limit=${encodeURIComponent(String(opts.limit))}`);
    if (opts.offset !== undefined) q.push(`offset=${encodeURIComponent(String(opts.offset))}`);
    const suffix = q.length ? `?${q.join('&')}` : '';
    return this.json<{
      sessions: ChatSession[];
      total?: number;
      hasMore?: boolean;
    }>(`/api/v1/chat/sessions${suffix}`).then((r) => ({
      sessions: r.sessions,
      total: typeof r.total === 'number' ? r.total : r.sessions.length,
      hasMore: typeof r.hasMore === 'boolean' ? r.hasMore : false
    }));
  }

  /** 取单个聊天会话（含消息记录）。 */
  getChatSession(id: string): Promise<ChatSession> {
    return this.json<ChatSession>(`/api/v1/chat/sessions/${encodeURIComponent(id)}`);
  }
  /** 新建聊天会话（可指定初始标题 + 初始按会话设置）。 */
  createChatSession(
    title?: string,
    meta?: { interactionMode?: 'qa' | 'plan'; model?: string; agentId?: string }
  ): Promise<ChatSession> {
    return this.json<ChatSession>('/api/v1/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({
        ...(title ? { title } : {}),
        ...(meta ? { interactionMode: meta.interactionMode, model: meta.model, agentId: meta.agentId } : {})
      }),
    });
  }
  /** 重命名 / 更新会话元数据（标题 + 可选按会话设置）。 */
  renameChatSession(
    id: string,
    title: string,
    meta?: { interactionMode?: 'qa' | 'plan'; model?: string; agentId?: string }
  ): Promise<ChatSession> {
    return this.json<ChatSession>(`/api/v1/chat/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title,
        ...(meta ? { interactionMode: meta.interactionMode, model: meta.model, agentId: meta.agentId } : {})
      }),
    });
  }
  /** 删除聊天会话。 */
  deleteChatSession(id: string): Promise<{ ok: boolean }> {
    return this.json<{ ok: boolean }>(`/api/v1/chat/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  /* ------------------------- 聊天历史镜像（接口层） ------------------------- */

  /** 列出全部历史镜像元信息（按落盘时间倒序）。 */
  listHistoryIndex(): Promise<HistoryThreadMeta[]> {
    return this.json<{ sessions: HistoryThreadMeta[] }>('/api/v1/history').then(
      (r) => r.sessions
    );
  }
  /** 读取某会话历史信封；不存在时服务端返回 404 → 抛 ApiError。 */
  getHistoryThread(sid: string): Promise<HistoryEnvelope> {
    return this.json<HistoryEnvelope>(`/api/v1/history/${encodeURIComponent(sid)}`);
  }
  /** 写入 / 覆盖某会话历史镜像（幂等 upsert）。 */
  putHistoryThread(sid: string, input: HistoryPutInput): Promise<{ ok: boolean }> {
    return this.json<{ ok: boolean }>(`/api/v1/history/${encodeURIComponent(sid)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }
  /** 删除某会话历史镜像。 */
  deleteHistoryThread(sid: string): Promise<{ ok: boolean }> {
    return this.json<{ ok: boolean }>(`/api/v1/history/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
    });
  }

  /* ----------------------------- MCP ----------------------------- */

  getMcpServers(): Promise<{ servers: McpServerMeta[] }> {
    return this.json('/api/v1/mcp/list');
  }
  getMcpPresets(): Promise<{ presets: McpPreset[] }> {
    return this.json('/api/v1/mcp/presets');
  }
  addMcpServer(input: AddMcpInput): Promise<{ server: McpServerMeta; servers: McpServerMeta[] }> {
    return this.json('/api/v1/mcp/add', { method: 'POST', body: JSON.stringify(input) });
  }
  connectMcpPreset(id: string, token?: string): Promise<{ server: McpServerMeta; servers: McpServerMeta[] }> {
    return this.json('/api/v1/mcp/preset', {
      method: 'POST',
      body: JSON.stringify({ id, token }),
    });
  }
  reconnectMcp(name: string): Promise<{ server: McpServerMeta }> {
    return this.json('/api/v1/mcp/reconnect', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }
  removeMcp(name: string): Promise<{ ok: boolean; servers: McpServerMeta[] }> {
    return this.json('/api/v1/mcp/remove', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  /* ----------------------------- 审批 ----------------------------- */

  listApprovals(status?: ApprovalStatus): Promise<{ tickets: ApprovalTicket[] }> {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.json(`/api/v1/approvals${q}`);
  }
  getApproval(id: string): Promise<{ ticket: ApprovalTicket | null }> {
    return this.json(`/api/v1/approvals/${encodeURIComponent(id)}`);
  }
  decideApproval(id: string, decision: 'approve' | 'reject', bySub = 'client'): Promise<{ ticket: ApprovalTicket }> {
    return this.json(`/api/v1/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ decision, sub: bySub }),
    });
  }

  /**
   * 轮询某审批工单直至终态（approved/rejected），或超时/中断。
   * 返回终态工单；超时抛 Error。
   */
  async pollApproval(
    ticketId: string,
    opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<ApprovalTicket> {
    const interval = opts.intervalMs ?? 1500;
    const timeout = opts.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeout;
    while (true) {
      if (opts.signal?.aborted) throw new Error('approval poll aborted');
      if (Date.now() > deadline) throw new Error(`approval poll timed out after ${timeout}ms`);
      const { ticket } = await this.getApproval(ticketId);
      if (!ticket) throw new Error(`approval ticket ${ticketId} not found`);
      if (ticket.status === 'approved' || ticket.status === 'rejected') return ticket;
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /* ----------------------------- 配方 / 评估 ----------------------------- */

  listRecipes(): Promise<{ recipes: Recipe[] }> {
    return this.json('/api/v1/recipes');
  }
  getRecipe(id: string): Promise<{ recipe: Recipe | null }> {
    return this.json(`/api/v1/recipes/${encodeURIComponent(id)}`);
  }
  saveRecipe(input: { jobId: string; name?: string; notes?: string }): Promise<{ recipe: Recipe }> {
    return this.json('/api/v1/recipes', { method: 'POST', body: JSON.stringify(input) });
  }
  evalJob(jobId: string): Promise<EvalResult> {
    return this.json('/api/v1/eval', { method: 'POST', body: JSON.stringify({ jobId }) });
  }

  /* ----------------------------- 智能体 (agents / P1.①) ----------------------------- */

  /** 列出已注册 agent；可按要求 domain / capability 过滤。 */
  listAgents(filter?: AgentQuery): Promise<{ agents: AgentCard[] }> {
    const q: string[] = [];
    if (filter?.domain) q.push(`domain=${encodeURIComponent(filter.domain)}`);
    if (filter?.capability) q.push(`capability=${encodeURIComponent(filter.capability)}`);
    const suffix = q.length ? `?${q.join('&')}` : '';
    return this.json<{ agents: AgentCard[] }>(`/api/v1/agents${suffix}`);
  }
  /** 获取单个 agent 的能力卡片（不存在返回 { agent: null }）。 */
  getAgent(id: string): Promise<{ agent: AgentCard | null }> {
    return this.json<{ agent: AgentCard | null }>(`/api/v1/agents/${encodeURIComponent(id)}`);
  }

  /* ----------------------------- A2A 任务 (tasks / P1.④) ----------------------------- */

  /**
   * 向目标 agent 提交一个 A2A 任务。body 为 TaskEnvelope（可随 card 自注册远端 agent）。
   * 服务端仅接受 transport='local' 的本地 agent 执行，返回标准 TaskResult。
   */
  sendTask(req: A2ARequest): Promise<{ result: TaskResult }> {
    return this.json<{ result: TaskResult }>('/api/v1/a2a/tasks', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  /* ----------------------------- 记忆 ----------------------------- */

  getMemory(sessionKey: string): Promise<{ sessionKey: string; backend: string; notes: string[]; windowLen: number }> {
    return this.json(`/api/v1/memory?session=${encodeURIComponent(sessionKey)}`);
  }
  async clearMemory(sessionKey: string): Promise<{ ok: boolean; sessionKey: string }> {
    return this.json(`/api/v1/memory?session=${encodeURIComponent(sessionKey)}`, { method: 'DELETE' });
  }

  /* ----------------------------- SSE 流（基石能力） ----------------------------- */

  /**
   * 运行 agent。返回事件异步迭代器。
   * 若动作需审批，服务端回 202 而非 SSE，此时抛 ApprovalRequiredError（含 ticketId/poll）。
   */
  async *streamRun(input: RunInput, opts: SseOptions = {}): AsyncGenerator<RunEvent> {
    const res = await this.request('/api/v1/run', {
      method: 'POST',
      body: JSON.stringify(input),
      signal: opts.signal,
    });
    if (res.status === 202) {
      const data = (await res.json().catch(() => ({}))) as {
        ticketId?: string;
        poll?: string;
        message?: string;
      };
      throw new ApprovalRequiredError(
        data.ticketId ?? '',
        data.poll ?? '',
        'agent:run'
      );
    }
    if (!res.ok) {
      const data = await res.text().catch(() => '');
      throw new ApiError(res.status, data || `HTTP ${res.status}`);
    }
    for await (const ev of parseSse(res, opts)) {
      yield ev as RunEvent;
    }
  }

  async *streamVerify(opts: SseOptions = {}): AsyncGenerator<VerifyEvent> {
    const res = await this.request('/api/v1/verify', { method: 'POST', signal: opts.signal });
    if (!res.ok) {
      const data = await res.text().catch(() => '');
      throw new ApiError(res.status, data || `HTTP ${res.status}`);
    }
    for await (const ev of parseSse(res, opts)) {
      yield ev as VerifyEvent;
    }
  }

  async *streamEnv(input: EnvInput, opts: SseOptions = {}): AsyncGenerator<EnvEvent> {
    const res = await this.request('/api/v1/env', {
      method: 'POST',
      body: JSON.stringify(input),
      signal: opts.signal,
    });
    if (res.status === 202) {
      const data = (await res.json().catch(() => ({}))) as {
        ticketId?: string;
        poll?: string;
      };
      throw new ApprovalRequiredError(data.ticketId ?? '', data.poll ?? '', 'env');
    }
    if (!res.ok) {
      const data = await res.text().catch(() => '');
      throw new ApiError(res.status, data || `HTTP ${res.status}`);
    }
    for await (const ev of parseSse(res, opts)) {
      yield ev as EnvEvent;
    }
  }

  /* ----------------------------- 工作流 (workflows / P1.⑤) ----------------------------- */

  /** 获取某次工作流运行的快照（最终状态 + 各 step 状态）。 */
  getWorkflow(id: string): Promise<{ workflow: WorkflowRun }> {
    return this.json<{ workflow: WorkflowRun }>(`/api/v1/workflows/${encodeURIComponent(id)}`);
  }

  /**
   * 定义并运行一个 DAG 工作流，返回编排事件异步迭代器（与 harness 事件同通道）。
   * wf:* 为编排事件；嵌套的 harness 事件以 { type: 'harness', event } 包裹。
   */
  async *streamWorkflow(
    def: WorkflowDef,
    input?: unknown,
    opts: SseOptions = {}
  ): AsyncGenerator<WorkflowEvent> {
    const res = await this.request('/api/v1/workflows', {
      method: 'POST',
      body: JSON.stringify({ def, input }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const data = await res.text().catch(() => '');
      throw new ApiError(res.status, data || `HTTP ${res.status}`);
    }
    for await (const ev of parseSse(res, opts)) {
      yield ev as WorkflowEvent;
    }
  }

  /**
   * 以 Plan 模式的结构化执行计划（ExecutionPlan）驱动多 agent DAG 执行（P3，plan 来源）。
   * 服务端 handleWorkflow 接收 { plan, agentRef?, mode? }：经 planToWorkflowDef 生成
   * WorkflowDef 后按拓扑波次并行执行，下游 step 经共享黑板取上游真实产出
   * （见 docs/design/plan-mode-multiagent.md §4/§5/§6）。
   * 事件通道与 streamWorkflow 相同（wf:* 编排事件 + 嵌套 harness 事件 + _wf_done / wf:error 终结帧）。
   * @param plan ExecutionPlan（client 不依赖 core，按 unknown 结构透传，由服务端收敛校验）
   * @param opts.agentRef 每个 task 默认使用的 agent id（缺省服务端回落 DEFAULT_AGENT_ID）
   * @param opts.mode 运行模式（与当前聊天会话一致；缺省服务端回落 mock）
   */
  async *streamWorkflowFromPlan(
    plan: unknown,
    opts: {
      agentRef?: string;
      mode?: RunMode;
      /** BYOK 模型名（对齐 /api/run 的 model 字段）：服务端据此解析用户 provider Key。 */
      model?: string;
      /** 自定义模型专属端点 base URL（对齐 /api/run 的 modelBaseUrl）。 */
      modelBaseUrl?: string;
      /** 自定义模型专属 API Key（AES-GCM 加密传输，服务端 decryptApiKey，对齐 /api/run）。 */
      modelApiKey?: string;
      /** 所选模型官方上下文窗口（token），对齐 /api/run 的 ctxWindow。 */
      ctxWindow?: number;
      /** 联网搜索开关，对齐 /api/run 的 web（缺省 false 不出网）。 */
      web?: boolean;
      /**
       * P2-3：来源聊天会话 id（= 计划文档落库键 `plan:<sessionId>`）。
       * 携带后服务端把 DAG 执行进度同步到 PlanStore 节点状态（看板实时刷新）；
       * 缺省则服务端跳过计划同步（纯 def 工作流不受影响）。
       */
      sessionId?: string;
      /**
       * P1（断点续跑）：确定性工作流 id。前端经 derivePlanWfId(sessionId, plan) 生成
       * （FNV-1a 哈希，跨刷新稳定）→ 服务端按此 id 落检查点；「断点续跑 / 轨迹回放 /
       * 审计」在刷新与重启后仍可按同一键定位检查点。缺省服务端回落随机 `plan:<ts>-<rand>`。
       */
      workflowId?: string;
      signal?: AbortSignal;
    } = {}
  ): AsyncGenerator<WorkflowEvent> {
    const body: Record<string, unknown> = { plan };
    if (opts.agentRef) body.agentRef = opts.agentRef;
    if (opts.mode) body.mode = opts.mode;
    if (opts.workflowId) body.workflowId = opts.workflowId;
    // BYOK 透传（t1 根因修复）：DAG 路径此前不带任何模型/凭据字段，服务端 real 模式
    // 无 Key 可用 → 首 step LLM 调用即失败。现在与 /api/run 同构：服务端按 owner 解析
    // （provider Keys 主链路 / 自定义模型 / 请求自带 Key），明文仅在执行期内存中使用。
    if (opts.model) body.model = opts.model;
    if (opts.modelBaseUrl) body.modelBaseUrl = opts.modelBaseUrl;
    if (opts.modelApiKey) body.modelApiKey = opts.modelApiKey;
    if (opts.ctxWindow && opts.ctxWindow > 0) body.ctxWindow = opts.ctxWindow;
    if (opts.web) body.web = true;
    if (opts.sessionId) body.sessionId = opts.sessionId;
    const res = await this.request('/api/v1/workflows', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const data = await res.text().catch(() => '');
      throw new ApiError(res.status, data || `HTTP ${res.status}`);
    }
    for await (const ev of parseSse(res, opts)) {
      yield ev as WorkflowEvent;
    }
  }

  /**
   * 从断点续跑某次 plan/workflow 执行（P3：计划卡片「从失败任务继续」的 DAG 回退路径）。
   * 对应服务端 POST /api/workflows/:id/resume（检查点存于 WorkflowStore）。
   *
   * P1（断点续跑）：body 与 streamWorkflowFromPlan 同构（mode/BYOK 模型凭据/ctxWindow/web/
   * verify 开关/sessionId）——检查点按 P1.3 纪律不存明文凭据，续跑时服务端按登录 owner
   * 重新 resolveRunCredential；real 模式无 Key 由服务端 402 拒绝（前端 catch 回退串行路径）。
   * 不带任何字段的旧调用（空 body）行为不变：默认 mock，向后兼容。
   */
  async *streamWorkflowResume(
    id: string,
    opts: SseOptions & {
      mode?: RunMode;
      model?: string;
      modelBaseUrl?: string;
      modelApiKey?: string;
      ctxWindow?: number;
      web?: boolean;
      verify?: unknown;
      autoVerify?: boolean;
      sessionId?: string;
    } = {}
  ): AsyncGenerator<WorkflowEvent> {
    const body: Record<string, unknown> = {};
    if (opts.mode) body.mode = opts.mode;
    if (opts.model) body.model = opts.model;
    if (opts.modelBaseUrl) body.modelBaseUrl = opts.modelBaseUrl;
    if (opts.modelApiKey) body.modelApiKey = opts.modelApiKey;
    if (opts.ctxWindow && opts.ctxWindow > 0) body.ctxWindow = opts.ctxWindow;
    if (opts.web) body.web = true;
    if (opts.verify) body.verify = opts.verify;
    if (typeof opts.autoVerify === 'boolean') body.autoVerify = opts.autoVerify;
    if (opts.sessionId) body.sessionId = opts.sessionId;
    const res = await this.request(
      `/api/v1/workflows/${encodeURIComponent(id)}/resume`,
      { method: 'POST', body: JSON.stringify(body), signal: opts.signal }
    );
    if (!res.ok) {
      const data = await res.text().catch(() => '');
      throw new ApiError(res.status, data || `HTTP ${res.status}`);
    }
    for await (const ev of parseSse(res, opts)) {
      yield ev as WorkflowEvent;
    }
  }

  /**
   * P3（人工审批门）：批准放行处于 awaiting 的 plan/workflow 执行。
   * 对应服务端 POST /api/workflows/:id/approve —— 把 stepId 写入检查点 run.approvals
   * 后触发 DagEngine.resume；引擎据此跳过审批门继续执行（可能再次暂停在下一道门）。
   *
   * body：`stepId`（单节点放行）与 `all`（放行当前所有 awaiting 节点）二选一；
   * BYOK 字段与 streamWorkflowResume 同构（检查点不落明文凭据，服务端按 owner 重新解析，
   * real 模式无 Key 402 快速失败；旧客户端不带 body 时默认 mock，向后兼容）。
   */
  async *streamWorkflowApprove(
    id: string,
    opts: SseOptions & {
      /** 放行的单个 step/任务 id（= 计划 task id）。与 all 互斥。 */
      stepId?: string;
      /** 放行当前所有 awaiting 节点（等价于逐个批准）。 */
      all?: boolean;
      mode?: RunMode;
      model?: string;
      modelBaseUrl?: string;
      modelApiKey?: string;
      ctxWindow?: number;
      web?: boolean;
      verify?: unknown;
      autoVerify?: boolean;
      sessionId?: string;
    } = {}
  ): AsyncGenerator<WorkflowEvent> {
    const body: Record<string, unknown> = {};
    if (opts.stepId) body.stepId = opts.stepId;
    if (opts.all) body.all = true;
    if (opts.mode) body.mode = opts.mode;
    if (opts.model) body.model = opts.model;
    if (opts.modelBaseUrl) body.modelBaseUrl = opts.modelBaseUrl;
    if (opts.modelApiKey) body.modelApiKey = opts.modelApiKey;
    if (opts.ctxWindow && opts.ctxWindow > 0) body.ctxWindow = opts.ctxWindow;
    if (opts.web) body.web = true;
    if (opts.verify) body.verify = opts.verify;
    if (typeof opts.autoVerify === 'boolean') body.autoVerify = opts.autoVerify;
    if (opts.sessionId) body.sessionId = opts.sessionId;
    const res = await this.request(
      `/api/v1/workflows/${encodeURIComponent(id)}/approve`,
      { method: 'POST', body: JSON.stringify(body), signal: opts.signal }
    );
    if (!res.ok) {
      const data = await res.text().catch(() => '');
      throw new ApiError(res.status, data || `HTTP ${res.status}`);
    }
    for await (const ev of parseSse(res, opts)) {
      yield ev as WorkflowEvent;
    }
  }
}

export type { RunMode, EnvHandle };
