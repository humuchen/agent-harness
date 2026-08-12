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
  ApprovalStatus,
  ApprovalTicket,
  EvalResult,
  EnvEvent,
  EnvHandle,
  EnvInput,
  McpPreset,
  McpServerMeta,
  Recipe,
  RunEvent,
  RunInput,
  RunMode,
  ServerState,
  VerifyEvent,
} from './types.js';

export interface AgentClientOptions {
  /** 服务端基址，如 https://harness.example.com（自动去除尾部斜杠）。 */
  baseUrl: string;
  /** Bearer 令牌；也可后续 setToken 动态设置。 */
  token?: string;
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
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AgentClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    const f = opts.fetchImpl ?? (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!f) throw new Error('global fetch unavailable; pass fetchImpl explicitly');
    this.fetchImpl = f;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
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
}

export type { RunMode, EnvHandle };
