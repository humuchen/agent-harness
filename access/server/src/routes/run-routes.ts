/**
 * Run 关键路径路由（自 server.ts 外迁，P2 模块化终批，R1 收口）：
 * POST /api/run（SSE 全流程）、/api/workflows 编排（DagEngine）及 plan 任务同步簇。
 *
 * 约定（与 docs/01-architecture/server-modularization-plan.md 一致）：
 * - guard / auditAction / shuttingDown 经 deps 注入（server.ts 组合根闭包）；
 * - activeWorkflowAborts（活动 run 注册表）为本模块持有并由 server.ts 的
 *   workflows 快照/续跑/审批/取消分发器共享导入；
 * - 其余依赖（runQueue / chat-bus / plan-bus / chat-sessions / workflow-executor 等）
 *   均为可静态 import 的独立模块。
 * 本模块代码自 server.ts 原文逐字迁入（含注释），行为零变更；护航 =
 * scripts/e2e-run-flow.cjs（重构前在旧 dist 上先行跑绿）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  features,
  getAgentRegistry,
  getJevStats,
  sanitizeKey,
  structLog,
  parsePlanOutput,
  parsePlanOrClarify,
  buildPlannerPrompt,
  planToWorkflowDef,
  type ExecutionPlan,
  type AgentCard,
  type VerifyConfig,
  type WorkflowEvent,
  type WorkflowRun,
  type TaskResult,
  type PlanClarify,
  type WorkflowDef,
  DEFAULT_AGENT_ID,
  type A2ARequest
} from '@agent-harness/core';
import { defaultPromptFor, resetSessionMemory, type RunMode } from '../runner';
import { readBody, startSse, sendJson, sendJsonError, securityHeaders, corsHeaders } from '../http-helpers';
import { runQueue, sseConnectionLock, QueueBackpressureError, QueueDuplicateError } from '../run-queue';
import {
  appendChatMessage,
  peekChatSession,
  replaceAndTruncateMessages,
  applyPlanWfTerminal,
  updatePlanStatus,
  extractPlanTaskId,
  type StoredTool,
  type TraceNode,
  type ChatMessage
} from '../chat-sessions';
import { getPlanStore, type PlanDoc, type PlanNode, type PlanNodeStatus } from '../plan-store';
import { publishPlanEvent } from '../plan-bus';
import { publishChatEvent } from '../chat-bus';
import { DagEngine } from '@agent-harness/core';
import { workflowStore, createWorkflowExecutor, type WorkflowExecutorOptions } from '../workflow-executor';
import { resolvePlanVerify, parsePlanVerifyRetries } from '../plan-verify';
import { resolveRunCredential, type CredentialResult } from '../provider-keys';
import { decryptApiKey } from '../custom-models';
import { archivePlanArtifacts } from '../plan-artifacts';
import type { Action, AuthContext } from '../authz';


/** 从索引签名事件里安全取对象字段（unknown → Record | undefined）。 */
function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}
export interface RunRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action,
    body?: Record<string, unknown>
  ) => Promise<AuthContext | null>;
  auditAction: (action: string, fields: Record<string, unknown>) => void;
  isShuttingDown: () => boolean;
}

// deps 绑定（initRunRoutes 由 server.ts 组合根在 bootstrap 阶段调用一次）。
let _deps: RunRouteDeps | null = null;
export function initRunRoutes(deps: RunRouteDeps): void {
  _deps = deps;
}
function requireDeps(): RunRouteDeps {
  if (!_deps) throw new Error('run-routes 未初始化（initRunRoutes 未调用）');
  return _deps;
}

/** 活动工作流 run 注册表：POST /:id/cancel 显式取消用（终态时移除）。server.ts 快照分发器共享。 */
export const activeWorkflowAborts = new Map<string, AbortController>();


/* ==================== handleRun（POST /api/run） ==================== */


export async function handleRun(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const body = await readBody(req);
  const mode: RunMode = ['mock', 'real', 'real-mcp'].includes(body.mode)
    ? body.mode
    : 'mock';
  // 按运行模式映射为细分动作，做角色授权 + 审批判定（real / real-mcp 需审批）。
  const runAction: Action =
    mode === 'real-mcp'
      ? 'agent:run:real-mcp'
      : mode === 'real'
      ? 'agent:run:real'
      : 'agent:run:mock';
  const ctx = await requireDeps().guard(req, res, runAction, body);
  if (!ctx) return;
  // 多用户隔离：聊天历史/会话必须登录后才能写入；匿名（auth off 或未登录）直接拒。
  if (ctx.sub === 'anon') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: 'authentication required for chat history' })
    );
    return;
  }
  // 优雅停机期间不再接受新运行，避免任务在进程退出时被强杀。
  if (requireDeps().isShuttingDown()) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'server is shutting down' }));
    return;
  }
  const send = startSse(res, req);
  // 跨设备：进行中 assistant 增量的节流广播（让他端实时看到「正在回复…」而非仅最终全文）。
  // 声明置于 run 事件循环之前，确保整次 run 共享同一累积缓冲与节流游标（否则每次事件
  // 都重置 streamBuf，增量永不累积）。仅同 owner 的其他在线连接收到；发送端经下方 send(e)
  // 已收完整流，其回声由前端按 origin 忽略。计划模式 propose 阶段在下方 return 前拦截
  // token，自然不会进广播（不泄露计划 JSON）。
  const STREAM_FLUSH_MS = 200;
  let streamBuf = '';
  let streamReasoning = '';
  let lastStreamFlush = 0;
  // 同一 run 的 run:end 会被 run-queue 补发一次（不带 runId 的重复帧），用此标志保证
  // 终态 final 只广播一次，避免他端把重复帧当成「新一轮回复」而追加多余 assistant。
  let runEnded = false;
  const maybeBroadcastStream = (
    e: { type?: unknown; delta?: unknown; final?: unknown } | undefined
  ): void => {
    if (!chatSessionId || !ctx || ctx.sub === 'anon') return;
    const t = e?.type;
    if (t === 'llm:token' && typeof e?.delta === 'string') {
      streamBuf += e.delta;
    } else if (t === 'llm:reasoning' && typeof e?.delta === 'string') {
      streamReasoning += e.delta;
    } else if (t === 'run:end' && e?.final != null) {
      if (runEnded) return; // 重复 run:end 帧：跳过，只处理一次
      runEnded = true;
      // 终态全文无需此处再广播：下方 run:end 分支的 appendChatMessage 会把完整 assistant
      // 消息（含 tools/trace）经 chat-bus 广播一次，他端凭 final/streaming 游标收尾。
      // 若这里再 publish 会与 appendChatMessage 的广播形成「两次终态」，导致他端新回复重复。
      streamBuf = '';
      streamReasoning = '';
      return;
    } else {
      return;
    }
    const now = Date.now();
    if (now - lastStreamFlush < STREAM_FLUSH_MS) return;
    lastStreamFlush = now;
    if (!streamBuf && !streamReasoning) return;
    publishChatEvent(ctx.sub, {
      type: 'message:append',
      session: chatSessionId,
      message: {
        role: 'assistant',
        content: streamBuf,
        ...(streamReasoning ? { reasoning: streamReasoning } : {}),
        streaming: true,
        ts: Date.now()
      },
      origin: body.origin || ''
    });
    // flush 后清空累积缓冲，下次窗口重新累积（避免重复下发全文）。
    streamBuf = '';
    streamReasoning = '';
  };
  // 兼容前端两种字段名（chat UI 发 prompt，部分旧客户端发 input），避免落到默认示例 prompt。
  const rawPrompt = body.prompt ?? body.input;
  const prompt: string =
    (rawPrompt && String(rawPrompt).trim()) || defaultPromptFor(mode);
  const model: string | undefined = body.model
    ? String(body.model).trim()
    : undefined;
  // 自定义模型专属端点（可选）：前端「添加自定义模型」时填写的接口地址 / API Key。
  // 仅在显式提供时透传，服务端据此构造直连该端点的 LLM；缺省走默认 OpenRouter。
  const modelBaseUrl: string | undefined = body.modelBaseUrl
    ? String(body.modelBaseUrl).trim()
    : undefined;
  const modelApiKey: string | undefined = (() => {
    const raw = body.modelApiKey ? String(body.modelApiKey).trim() : '';
    if (!raw) return undefined;
    // 前端已做 AES-GCM 加密传输；服务端解密后拿到明文 key。
    try {
      return decryptApiKey(raw);
    } catch {
      return undefined;
    }
  })();
  // ── BYOK：运行期凭据解析（per-user，绝不写 process.env）──
  // 仅 real / real-mcp 需要真实 Key；mock 不需要。解析失败且非 mock → 402 引导配置。
  // 解析结果的明文 Key 不写入任务 descriptor（P1.3）：提交期仅用于 402 闸门，
  // 执行期由 run-queue.execute() 经 resolveRunCredential(owner,...) 重新解析，避免明文落盘。
  if (mode !== 'mock') {
    const cred = await resolveRunCredential(ctx.sub, {
      model,
      modelBaseUrl,
      modelApiKey
    });
    if (!cred.apiKey) {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'provider_key_required',
          hint: '当前账号未配置可用的 LLM API Key，请到「设置 → 模型服务商」填入你的 OpenRouter Key 后再发起真实对话。'
        })
      );
      return;
    }
  }
  // 所选模型的官方上下文窗口（可选）：前端从 OpenRouter 模型目录拿到 context_length
  // 后随请求下发，经 runner → harness 进入 llm:usage，作为「上下文用量」的权威分母。
  const ctxWindow: number | undefined =
    Number.isFinite(Number(body.ctxWindow)) && Number(body.ctxWindow) > 0
      ? Math.floor(Number(body.ctxWindow))
      : undefined;
  // 闭环步数上限：允许前端按任务复杂度覆盖；空/非法则回退到服务端 MAX_STEPS（默认 24）。
  const maxSteps: number | undefined =
    typeof body.maxSteps === 'number' &&
    Number.isFinite(body.maxSteps) &&
    body.maxSteps > 0
      ? Math.floor(body.maxSteps)
      : undefined;
  // 会话/租户标识（P1-9）：优先 body.sessionId，其次 x-session-id 头，默认 anonymous。
  // 记忆按此 key 在所选后端（file/sqlite）隔离持久化，实现多租户。
  // 注意：连续对话由 Web UI 在客户端生成并稳定携带 conversationId（见 webapp/run.ts），
  // 因此 web 端每条会话都带唯一 sessionId；未携带时回落 anonymous（CLI 无 --session 时）。
  const sessionKey = sanitizeKey(
    (body.sessionId && String(body.sessionId)) ||
      (req.headers['x-session-id'] && String(req.headers['x-session-id'])) ||
      'anonymous'
  );

  // 多会话 Chat App：客户端为每个聊天会话分配独立 chatSessionId（与 Memory 的 sessionKey 解耦），
  // 服务端据此把 user/assistant 消息写入会话存储，供左侧栏与跨刷新恢复。
  const chatSessionId = body.chatSessionId
    ? String(body.chatSessionId).trim()
    : '';

  // 编辑重发：截断会话存储到被编辑消息为止（替换其内容为最新草稿），并用截断后的历史
  // 重置该会话的 LLM 记忆窗口，使重新生成时仅基于「编辑消息之前」的上下文，丢弃其后的
  // 无用上下文。截断成功后置 isEditMsg=true，后续 run:start 不再重复写入 user 消息（已就位）。
  let isEditMsg = false;
  if (
    chatSessionId &&
    body.editFrom &&
    typeof body.editFrom === 'object' &&
    typeof body.editFrom.sessionId === 'string' &&
    Number.isInteger(body.editFrom.index) &&
    (body.editFrom.index as number) >= 0
  ) {
    const kept = replaceAndTruncateMessages(
      body.editFrom.sessionId,
      body.editFrom.index as number,
      prompt,
      ctx.sub
    );
    if (kept && kept.length > 0) {
      await resetSessionMemory(
        sessionKey,
        kept.map((m) => ({ role: m.role, content: m.content }))
      );
      isEditMsg = true;
    }
  }

  // 交互模式（P0 计划模式）：白名单校验，非法值回退 qa（= 现状）。
  const interactionMode: 'qa' | 'plan' =
    body.interactionMode === 'plan' ? 'plan' : 'qa';
  const planPhase: 'propose' | 'execute' =
    body.planPhase === 'execute' ? 'execute' : 'propose';
  const isPlanPropose = interactionMode === 'plan' && planPhase === 'propose';
  // P5 静默计划执行：计划任务派发（execute）的逐任务 user/assistant 消息属于「单步信息」，
  // 不应落会话存储（前端刷新/切回会以其为权威源复现单步气泡）。仅保留 planStatus 进度同步
  // （updatePlanStatus / syncPlanTaskStatus），「最终执行结果」由前端摘要/服务端 applyPlanWfTerminal 承载。
  const isPlanExecute = interactionMode === 'plan' && planPhase === 'execute';
  // 计划生成本身是一次普通 run：用 planner 提示词包装用户需求，约束模型输出计划 JSON。
  const effectivePrompt = isPlanPropose ? buildPlannerPrompt(prompt) : prompt;

  // P0.1：显式指定目标 agent（绕过路由，直达该 agent 的装配配方）。
  // 未传 → 用注册表里 seed 的 default 通用 agent（退化为今天的万能 harness）。
  // 传入但不存在 → 400 拒绝，避免静默退化到错误 agent。
  const agentId = body.agentId ? String(body.agentId).trim() : undefined;
  let agentCard: AgentCard | null = null;
  if (agentId) {
    agentCard = await getAgentRegistry().get(agentId);
    if (!agentCard) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unknown agentId: ${agentId}` }));
      return;
    }
  }

  // 断线重连：携带已知 jobId 时直接订阅该 job 的事件重放流，不再重复提交执行。
  const reconnectId = body.jobId ? String(body.jobId) : '';
  const targetId =
    reconnectId && runQueue.get(reconnectId) ? reconnectId : null;
  // 断线续传游标：客户端携带已收到的最大事件 seq，重放时跳过 seq ≤ since 的事件，
  // 避免恢复场景下（后台标签页冻结 / 网络中断后重连）内容与持久化副作用重复。
  const sinceSeq = Number.isFinite(Number(body.since))
    ? Math.max(-1, Math.floor(Number(body.since)))
    : -1;

  // P0.2/P0.3：任务路由 & 租户辅助字段。
  // - domain / workflowId / traceId：客户端显式声明（用于路由与可观测）。
  // - tenantId：P0.3 权威来源为认证身份（SSO 网关 / IdP claim 注入 ctx.tenantId），
  //   客户端声明的 body.tenantId 仅作本地/测试降级；认证身份优先，杜绝客户端伪造越界。
  const domain = body.domain ? String(body.domain).trim() : undefined;
  const declaredTenantId = body.tenantId
    ? String(body.tenantId).trim()
    : undefined;
  const effectiveTenantId = ctx.tenantId || declaredTenantId;
  const tenantId = effectiveTenantId || undefined;
  const workflowId = body.workflowId
    ? String(body.workflowId).trim()
    : undefined;
  // traceId：优先 body 声明（客户端幂等追踪），再查 X-Request-Id header，最后服务端生成。
  // 注入到 JobDescriptor 后由 run-queue.withRequestContext 自动传给所有 structLog/audit。
  const traceId = body.traceId
    ? String(body.traceId).trim()
    : resolveTraceId(req, body) || undefined;

  // P0-2：运行期自动验证门禁配置解析（优先级：body.verify 显式完整配置 > body.autoVerify 开关
  // > 服务端 AGENT_AUTO_VERIFY 默认）。验证器最终在 run-queue.execute 内按 config 装配，
  // 并以可序列化形式随 JobDescriptor 持久化，使重放/多实例领取后门禁行为一致。
  let verifyConfig: VerifyConfig | undefined;
  const envAutoVerify =
    process.env.AGENT_AUTO_VERIFY === 'true' ||
    process.env.AGENT_AUTO_VERIFY === '1';
  if (
    body.verify &&
    typeof body.verify === 'object' &&
    !Array.isArray(body.verify)
  ) {
    verifyConfig = body.verify as VerifyConfig;
  } else if (typeof body.autoVerify === 'boolean') {
    verifyConfig = body.autoVerify ? { auto: true } : undefined;
  } else if (envAutoVerify) {
    verifyConfig = { auto: true };
  }

  let jobId: string;
  if (!targetId) {
    let job;
    try {
      // submit 现为异步：共享（redis）模式下持久化是同步前置，append 失败抛
      // QueuePersistError（status 503，由主分发器映射响应），杜绝「有 jobId 无执行」。
      job = await runQueue.submit({
      mode,
      prompt: effectivePrompt,
      model,
      // P1.3：descriptor 只持久化解析「输入」（owner+model+body 透传的 baseUrl/key），
      // 不存解析后的明文 Key；执行期 execute() 经 resolveRunCredential(owner,...) 重新解析。
      // 正常流程下前端已不再在 run body 带明文 Key，故 descriptor 实际不含任何明文凭据。
      modelBaseUrl: modelBaseUrl,
      modelApiKey: modelApiKey,
      ctxWindow,
      sessionKey,
      maxSteps,
      verify: verifyConfig,
      agentId: agentCard?.id,
      domain,
      tenantId,
      workflowId,
      traceId,
      attachments: body.attachments,
      // 联网搜索开关（Request 4）：透传 UI 开关；false/未传由 run-queue 收敛为不注册出网能力。
      web: typeof body.web === 'boolean' ? body.web : undefined,
      interactionMode,
      planPhase,
      // 归属用户（权威来源 = 认证身份 ctx.sub）：执行期经 runWithUser 注入工具链路，
      // 插件（如 memo）据此把工具产生的数据绑定到登录用户。
      owner: ctx.sub,
      // 幂等键（可选）：客户端防重试/双击重复执行；同键活跃任务存在时返回既有 jobId。
      idempotencyKey:
        typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
          ? body.idempotencyKey.trim().slice(0, 128)
          : undefined
      });
    } catch (e) {
      if (e instanceof QueueBackpressureError) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '5',
          ...corsHeaders(req),
          ...securityHeaders()
        });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'run queue is full, please retry later',
            pending: e.pending,
            limit: e.limit
          })
        );
        return;
      }
      // 跨实例幂等冲突（仅共享后端）：同键活跃任务正在其它实例上执行。
      // 返回 409 + 既有 jobId——其事件经 pub/sub 事件桥对任意实例可见，客户端
      // 仍可凭该 jobId 订阅 SSE 进度。
      if (e instanceof QueueDuplicateError) {
        res.writeHead(409, {
          'content-type': 'application/json',
          ...corsHeaders(req),
          ...securityHeaders()
        });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'duplicate idempotency key: an active run already exists',
            jobId: e.existingJobId ?? null
          })
        );
        return;
      }
      throw e;
    }
    requireDeps().auditAction('agent.run', {
      mode,
      promptLen: prompt.length,
      model: model ?? null,
      jobId: job.id,
      sessionKey,
      agentId: agentCard?.id ?? null,
      role: ctx.role,
      sub: ctx.sub,
      verify: verifyConfig ? 'on' : 'off'
    });
    send({ type: 'job:accepted', jobId: job.id, sessionKey });
    jobId = job.id;
  } else {
    requireDeps().auditAction('agent.run.reconnect', {
      jobId: targetId,
      role: ctx.role,
      sub: ctx.sub
    });
    jobId = targetId;
  }

  // 订阅事件流：先重放已发生事件，再转发后续；遇到终结事件 _done 主动关闭连接。
  // 跨 run 累积的推理与工具调用缓冲，run:end 时一并落盘，确保切换会话后再切回可完整还原。
  let reasoningBuf = '';
  const toolMap = new Map<string, StoredTool>();
  // 调用链路追踪树：把 run 事件流结构化为 trace 节点，run:end 时一并落盘，
  // 供深度思考界面可视化 LLM↔工具↔检索 的每一步，便于追踪与复盘。
  const RETRIEVAL_RE =
    /retriev|search|fetch|query|lookup|wiki|web|rag|google|bing|knowledge|document|semantic/i;
  let traceRoot: TraceNode | null = null;
  let traceParent: TraceNode | null = null;
  let traceLlm: TraceNode | null = null;
  let traceLastTool: TraceNode | null = null;
  let traceSeq = 0;
  const traceEnsureRoot = (): TraceNode => {
    if (!traceRoot) {
      traceRoot = {
        id: 't0',
        kind: 'run',
        label: '运行',
        status: 'ok',
        children: []
      };
      traceParent = traceRoot;
    }
    return traceRoot;
  };
  const traceNode = (
    parent: TraceNode,
    kind: TraceNode['kind'],
    label: string,
    status: TraceNode['status'] = 'ok',
    extra: Partial<TraceNode> = {}
  ): TraceNode => {
    const n: TraceNode = {
      id: `t${++traceSeq}`,
      kind,
      label,
      status,
      children: [],
      ...extra
    };
    parent.children.push(n);
    return n;
  };
  const traceHandle = (ev: { type?: string; [k: string]: unknown }): void => {
    switch (ev?.type) {
      case 'run:meta': {
        const r = traceEnsureRoot();
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
        const r = traceEnsureRoot();
        traceParent = r;
        const step = traceNode(r, 'step', `第 ${ev.step} 步`, 'ok', {
          meta: { step: `第 ${ev.step} 步 / 共 ${ev.maxSteps ?? '?'} 步` }
        });
        traceParent = step;
        traceLlm = null;
        traceLastTool = null;
        break;
      }
      case 'llm:call': {
        traceEnsureRoot();
        const parent = traceParent ?? traceRoot!;
        // 服务端：把截至此次调用的会话消息快照挂到节点 messages 字段，
        // 与前端 traceHandle 对称（前端用内存 threads 填充，但该数据不在持久化 trace 内）。
        // 否则 getChatSession 恢复的 trace 仅含 meta 字符串「消息 N」，点开 LLM 节点后
        // 消息上下文 panel 为空，无法复盘本次调用的完整 prompt。
        const sessMsgs = chatSessionId
          ? peekChatSession(chatSessionId, ctx.sub)?.messages
          : undefined;
        const messages =
          sessMsgs && ev.messageCount
            ? sessMsgs
                .slice(
                  0,
                  Math.max(0, Number(ev.messageCount) || sessMsgs.length)
                )
                .map((m) => ({
                  role: m.role,
                  content: m.content ?? '',
                  ts:
                    typeof (m as { ts?: unknown }).ts === 'number'
                      ? (m as { ts: number }).ts
                      : Date.now(),
                  ...(m.reasoning ? { reasoning: m.reasoning } : {})
                }))
            : undefined;
        traceLlm = traceNode(parent, 'llm', 'LLM 调用', 'ok', {
          meta: {
            messages: `消息 ${ev.messageCount ?? '?'}`
            // 不写入 tools：toolCount 是「注入模型的可用工具数」，并非本次真实执行数；
            // 真实执行的工具节点会作为 children 挂载，由 chat-trace.ts 从 n.children.length 计数展示。
          },
          ...(messages && messages.length ? { messages } : {})
        });
        traceLastTool = null;
        break;
      }
      case 'llm:reasoning': {
        if (traceLlm && typeof ev.delta === 'string') {
          const n =
            (traceLlm.meta?.reasoningChars
              ? Number(traceLlm.meta.reasoningChars)
              : 0) + ev.delta.length;
          traceLlm.meta = {
            ...(traceLlm.meta ?? {}),
            reasoningChars: String(n)
          };
        }
        break;
      }
      case 'llm:token': {
        if (traceLlm && typeof ev.delta === 'string') {
          const n =
            (traceLlm.meta?.tokenChars ? Number(traceLlm.meta.tokenChars) : 0) +
            ev.delta.length;
          traceLlm.meta = { ...(traceLlm.meta ?? {}), tokenChars: String(n) };
        }
        break;
      }
      case 'tool:start': {
        const callObj = asObj(ev.call);
        if (!traceLlm || !callObj) break;
        const name = String(callObj.name ?? 'tool');
        const retrieval = RETRIEVAL_RE.test(name);
        traceLastTool = traceNode(
          traceLlm,
          retrieval ? 'retrieval' : 'tool',
          retrieval ? `检索 · ${name}` : name,
          'pending',
          {
            detail:
              typeof callObj.arguments === 'string'
                ? callObj.arguments
                : JSON.stringify(callObj.arguments ?? {})
          }
        );
        break;
      }
      case 'tool:result': {
        if (traceLastTool) {
          traceLastTool.result =
            typeof ev.result === 'string'
              ? ev.result
              : JSON.stringify(ev.result ?? {});
          traceLastTool.status = ev.errored ? 'error' : 'ok';
          traceLastTool.meta = {
            ...(traceLastTool.meta ?? {}),
            status: ev.errored ? '失败' : '成功'
          };
        }
        break;
      }
      case 'run:cost': {
        traceEnsureRoot();
        const parent = traceParent ?? traceRoot!;
        const est = asObj(ev.estTokens);
        const num = (v: unknown): number => Number(v) || 0;
        const estTotal = est
          ? num(est.system) + num(est.tools) + num(est.history) + num(est.completion)
          : 0;
        traceNode(parent, 'cost', '成本 / 用量', 'ok', {
          meta: {
            tokens: String(
              ev.cumulativeTokens ?? asObj(ev.usage)?.total_tokens ?? '?'
            ),
            cost:
              ev.cumulativeCost != null
                ? `$${Number(ev.cumulativeCost).toFixed(4)}`
                : '?',
            priced: ev.priced ? 'true' : 'false',
            ...(ev.model ? { model: String(ev.model) } : {}),
            ...(est
              ? {
                  系统: String(est.system ?? ''),
                  工具: `${num(est.tools)}${
                    estTotal
                      ? ` (${((num(est.tools) / estTotal) * 100).toFixed(0)}%)`
                      : ''
                  }`,
                  历史: `${num(est.history)}${
                    estTotal
                      ? ` (${((num(est.history) / estTotal) * 100).toFixed(0)}%)`
                      : ''
                  }`,
                  输出: `${num(est.completion)}`
                }
              : {})
          }
        });
        break;
      }
      case 'jev:call': {
        // TypeSafe Jev 决策模型旁路上报：子系统直连调用（注入门禁/上下文压缩等）的调用事实。
        // caller==='tool' 的调用已有 tool:start/tool:result 节点，不重复建节点。
        if (ev.caller === 'tool') break;
        traceEnsureRoot();
        const jParent = traceLlm ?? traceParent ?? traceRoot!;
        // 问题（输入）与输出（决策）记录：展开在调用链节点内，便于直接看清「问了什么 / 回了什么」。
        // 仅在存在时附带，失败时回落为 error 文本（与既有行为一致）。
        const jDetail =
          ev.questionSpec && typeof ev.questionSpec === 'object'
            ? JSON.stringify(ev.questionSpec, null, 2)
            : undefined;
        const jResultOk =
          ev.ok !== false && ev.answers && typeof ev.answers === 'object'
            ? JSON.stringify(ev.answers, null, 2)
            : undefined;
        const jMeta: Record<string, string> = {
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
        };
        traceNode(jParent, 'tool', `Jev 决策 · ${String(ev.caller ?? '?')}`, ev.ok === false ? 'error' : 'ok', {
          ...(ev.error ? { result: String(ev.error) } : {}),
          ...(jDetail ? { detail: jDetail } : {}),
          ...(jResultOk ? { result: jResultOk } : {}),
          meta: jMeta
        });
        break;
      }
      case 'run:token-cache': {
        traceEnsureRoot();
        const parent = traceParent ?? traceRoot!;
        const tcHitPct = (Number(ev.hitRate) * 100).toFixed(1);
        const tcByModel = Object.entries(
          (asObj(ev.byModel) ?? {}) as Record<
            string,
            { queries: number; hits: number; hitRate: number }
          >
        )
          .map(
            ([m, st]) =>
              `${m}: ${(Number(st.hitRate) * 100).toFixed(0)}% (${st.hits}/${
                st.queries
              })`
          )
          .join(' · ');
        traceNode(parent, 'tokencache', 'Token 缓存命中率', 'ok', {
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
        traceEnsureRoot();
        traceNode(traceRoot!, 'verify', '自检', ev.passed ? 'ok' : 'error', {
          meta: {
            score: String(ev.score ?? '?'),
            passed: ev.passed ? '通过' : '未通过'
          },
          result: (Array.isArray(ev.reasons) ? ev.reasons : []).join('\n')
        });
        break;
      }
      case 'guardrail:blocked': {
        traceEnsureRoot();
        const phaseLabel = ev.phase === 'output' ? '输出拦截' : ev.phase === 'input' ? '输入拦截' : ev.phase ?? '';
        traceNode(
          traceRoot!,
          'guardrail',
          `护栏拦截${phaseLabel ? ' · ' + phaseLabel : ''}`,
          'error',
          {
            detail: String(ev.reason ?? '')
          }
        );
        break;
      }
      case 'budget:exceeded': {
        traceEnsureRoot();
        traceNode(
          traceRoot!,
          'budget',
          `预算超限 · ${ev.kind ?? ''}`,
          'error',
          {
            meta: {
              used: String(ev.used ?? '?'),
              limit: String(ev.limit ?? '?')
            }
          }
        );
        break;
      }
      case 'error': {
        traceEnsureRoot();
        traceNode(traceRoot!, 'error', '运行错误', 'error', {
          detail: String(ev.message ?? '')
        });
        break;
      }
    }
  };
  // SSE 保活心跳：每 15s 写一行注释帧（`: ping\n\n`）。长时间工具执行 / 模型思考期间
  // 连接可能完全静默，中间代理（nginx/网关/NAT）会回收 idle 连接导致前端假性断连；
  // 注释帧对 SSE 解析透明（parseSse 只认 data: 帧），仅用于维持链路活跃。
  const pingTimer = setInterval(() => {
    if (closed) return;
    try {
      res.write(': ping\n\n');
    } catch {
      closed = true;
    }
  }, 15_000);
  let unsub: () => void = () => {};
  // 计划模式：本订阅内是否已处理过首条 run:end（run-queue 会补发重复 run:end，只处理一次）。
  let planEndHandled = false;
  // 计划模式 propose：阶段进度（理解需求 → 调研中 → 生成计划），仅向前推进，变化时下发 plan:phase。
  const PLAN_PHASES = ['理解需求', '调研中', '生成计划'] as const;
  let planPhaseIdx = -1;
  // 是否已见到「真实」plan:phase（两段式规划管线在真实阶段边界下发）；
  // 见到后停用事件类型启发式（避免管线阶段1 的 token 把进度误推到「生成计划」）。
  let planPhaseReal = false;
  const emitPlanPhase = (idx: number) => {
    if (idx <= planPhaseIdx) return;
    planPhaseIdx = idx;
    runQueue.emitSynthetic(jobId, {
      type: 'plan:phase',
      phase: PLAN_PHASES[idx],
      ts: Date.now()
    });
  };
  unsub = runQueue.subscribe(
    jobId,
    (rawEvent: unknown) => {
      const e = rawEvent as { type?: string; seq?: number; __synthetic?: boolean; [k: string]: unknown };
      {
    // 断线续传：重连订阅方跳过已消费的旧事件（send 与持久化副作用一并跳过，
    // 防止重放把 user/assistant 消息、trace 再次落盘造成重复）。
    const seq = (e as { seq?: number }).seq;
    if (sinceSeq >= 0 && typeof seq === 'number' && seq <= sinceSeq) return;
    if (closed) return;

    // 合成事件（plan:proposed / 友好摘要 / warn 等，由 emitSynthetic 注入）：
    // 已带新 seq 并入重放缓冲；这里只透传给 SSE，不再触发计划解析与落盘副作用。
    if ((e as { __synthetic?: boolean }).__synthetic) {
      send(e);
      return;
    }

    // 计划模式 propose（P0）：模型原始输出是计划 JSON，不应直接流入聊天 UI。
    // 在 run:end 处解析：成功 → 先补发 plan:proposed，再以友好摘要替换 final 转发，
    // 并把计划随消息落盘（刷新/切回可还原卡片）；失败 → emit warn 回退为普通回答。
    // 合成帧统一走 runQueue.emitSynthetic：附加 seq + 进重放缓冲，断线重连不丢计划卡片。
    // 注意：普通路径下 run-queue 会在 harness 的 run:end 之后补发一条重复 run:end
    //（不带 runId）；计划解析与全部副作用只处理本订阅内的第一条 run:end，
    // 避免双份 warn / 双份计划卡片；后续重复帧直接透传给通用逻辑（自带内容去重）。
    if (isPlanPropose && (e as { type?: string }).type === 'run:end') {
      if (!planEndHandled) {
        planEndHandled = true;
        const finalStr = String((e as { final?: unknown }).final ?? '');
        const parsed = parsePlanOrClarify(finalStr);
        if (parsed?.kind === 'plan') {
          const plan = parsed.plan;
          // 计划产物落库（P2-3）：以会话为键持久化 PlanDoc，供「计划」Tab 看板随时打开；
          // 重复 propose（同一会话再次生成计划）幂等覆盖为最新文档（version +1），并广播协同事件。
          if (chatSessionId) {
            void persistProposedPlan(chatSessionId, plan, ctx.sub).catch(() => {});
          }
          runQueue.emitSynthetic(jobId, { type: 'plan:proposed', plan });
          runQueue.emitSynthetic(jobId, {
            ...(e as object),
            __synthetic: true,
            final: `已生成执行计划（共 ${plan.tasks.length} 个任务）：${plan.goal}。确认后将按依赖顺序逐任务执行。`
          });
          if (chatSessionId) {
            traceHandle(e);
            appendChatMessage(
              chatSessionId,
              {
                role: 'assistant',
                content: `📋 ${plan.goal}`,
                ts: Date.now(),
                plan
              },
              ctx.sub,
              body.origin || ''
            );
          }
          return;
        }
        if (parsed?.kind === 'clarify') {
          const clarify = parsed.clarify as PlanClarify;
          // 澄清分支：不落 PlanDoc（尚非计划），仅把「目标确认」问题下发，等用户回答后再次 propose。
          runQueue.emitSynthetic(jobId, { type: 'plan:clarify', clarify });
          runQueue.emitSynthetic(jobId, {
            ...(e as object),
            __synthetic: true,
            final: `已提出需确认的目标问题${clarify.goalDraft ? `（目标草稿：${clarify.goalDraft}）` : ''}。请回答后继续生成计划。`
          });
          if (chatSessionId) {
            traceHandle(e);
            appendChatMessage(
              chatSessionId,
              {
                role: 'assistant',
                content: `❓ 需要确认目标：${clarify.goalDraft || '请确认以下要点'}`,
                ts: Date.now(),
                clarify
              },
              ctx.sub,
              body.origin || ''
            );
          }
          return;
        }
        runQueue.emitSynthetic(jobId, {
          type: 'warn',
          message: '计划生成失败（模型未返回有效计划 JSON），已回退为普通回答'
        });
        // 落入下方通用逻辑：按普通 run:end 处理。
      } else {
        // 已处理过首条 run:end：这是 run-queue 补发的重复帧（final 仍是原始计划 JSON）。
        // 必须整帧抑制——若放行到通用逻辑，前端会用 raw JSON 覆盖刚下发的友好摘要，
        // 且历史落盘去重失败会把原始 JSON 追加为第二条 assistant 消息。
        return;
      }
    }

    // 计划模式 propose：仅抑制原始 JSON 的 token/response 流（避免计划 JSON 打字机外泄），
    // 放行 llm:reasoning（规划思考）、tool:*（调研过程）与 plan:phase。
    // 阶段进度：默认走两段式规划管线（run-queue）在真实阶段边界下发 plan:phase —— 见到
    // 真实事件后启发式全部停用；仅当走旧 harness 回退路径（无真实 plan:phase）时，
    // 才按事件类型启发式猜阶段。最终内容由 run:end 以友好摘要替换。
    if (isPlanPropose) {
      const et = (e as { type?: string }).type;
      if (et === 'plan:phase') planPhaseReal = true;
      if (et === 'llm:token' || et === 'llm:response') {
        if (!planPhaseReal) emitPlanPhase(2);
        return; // 抑制原始 JSON 流
      }
      if (!planPhaseReal) {
        if (et === 'run:start') emitPlanPhase(0);
        else if (et === 'tool:start') emitPlanPhase(1);
        else if (et === 'llm:reasoning') {
          if (planPhaseIdx < 0) emitPlanPhase(0);
        }
      }
      // 其余事件（含 plan:phase / llm:reasoning / tool:*）照常下发。
    }
    send(e);
    // 跨设备广播（进行中增量 / 终态全文）：与 send(e) 并列，仅影响其他连接。
    maybeBroadcastStream(e);
    // 结构化为调用链路追踪树（供深度思考界面可视化 / 复盘）。
    if (chatSessionId) traceHandle(e);
    // 多会话 Chat App：把 run 的首尾事件落盘到会话存储（user 提问 + assistant 回答），
    // 并在过程中累积推理与工具调用，run 结束时一并写入，保证切换会话后再切回可完整还原。
    if (chatSessionId) {
      const ev = e as {
        type?: string;
        input?: unknown;
        final?: unknown;
        delta?: unknown;
        call?: Record<string, unknown>;
        [k: string]: unknown;
      };
      const a = ev;
      if (ev.type === 'llm:reasoning' && typeof a.delta === 'string') {
        reasoningBuf += a.delta;
      } else if (ev.type === 'tool:start' && a.call) {
        const c = a.call;
        toolMap.set(String(c.id), {
          name: String(c.name ?? 'tool'),
          args:
            typeof c.arguments === 'string'
              ? c.arguments
              : JSON.stringify(c.arguments ?? {})
        });
      } else if (ev.type === 'tool:result' && a.call) {
        const c = a.call;
        const t = toolMap.get(String(c.id)) ?? {
          name: String(c.name ?? 'tool')
        };
        t.result =
          typeof a.result === 'string'
            ? a.result
            : JSON.stringify(a.result ?? {});
        t.errored = !!a.errored;
        toolMap.set(String(c.id), t);
      } else if (
        ev.type === 'run:start' &&
        ev.input != null &&
        !isEditMsg &&
        !isPlanExecute
      ) {
        appendChatMessage(
          chatSessionId,
          {
            role: 'user',
            // 计划模式下落盘用户的原始需求（ev.input 是 planner 包装后的提示词）。
            content: isPlanPropose ? prompt : String(ev.input),
            ts: Date.now(),
            // 把用户消息携带的图片/文件附件一并落盘（url 兼容本地 dataUrl 或服务端
            // 上传地址），否则 getChatSession 恢复时气泡内图片丢失。单图体积超限时
            // 不持久化（仅当次显示），避免历史被超大 base64 撑爆。
            ...(body.attachments && body.attachments.length
              ? {
                  attachments: body.attachments
                    .filter(
                      (a: { url?: string; name?: string; type?: string }) =>
                        a && (a.url || '').length <= 5_000_000
                    )
                    .map(
                      (a: {
                        url?: string;
                        name?: string;
                        type?: string;
                        serverUrl?: string;
                      }) => ({
                        name: a.name ?? 'file',
                        type: a.type ?? 'application/octet-stream',
                        ...(a.url ? { url: a.url } : {}),
                        ...(a.serverUrl ? { serverUrl: a.serverUrl } : {})
                      })
                    )
                }
              : {})
          },
          ctx.sub,
          body.origin || ''
        );
        // 计划模式任务派发镜像：confirmPlan 按普通问答派发每个任务，run:start 的
        // input 是「【计划任务 <id>】标题」形状 —— 据此把 currentTaskId 写入进度镜像。
        const taskId = extractPlanTaskId(ev.input);
        if (!isPlanPropose && taskId) {
          // 串行执行路径的计划节点同步（P2-3）：看板节点 → doing（与 DAG 路径的
          // createPlanTaskSync 语义一致）。落库失败仅告警，不影响聊天链路。
          if (chatSessionId) syncPlanTaskStatus(chatSessionId, taskId, 'doing', ctx.sub);
          updatePlanStatus(
            chatSessionId,
            (prev) => ({
              ...prev,
              status: 'running',
              currentTaskId: taskId,
              failedTaskId: undefined
            }),
            ctx.sub
          );
        }
      } else if (ev.type === 'error') {
        // 计划任务执行失败：进度镜像标记 failed + 失败节点，前端恢复时据此续跑。
        if (!isPlanPropose) {
          // 看板节点同步：失败任务 → blocked（与 DAG 路径 createPlanTaskSync 语义一致）。
          const prevFailedTaskId = peekPlanCurrentTaskId(chatSessionId);
          if (chatSessionId && prevFailedTaskId) {
            syncPlanTaskStatus(chatSessionId, prevFailedTaskId, 'blocked', ctx.sub);
          }
          updatePlanStatus(
            chatSessionId,
            (prev) => ({
              ...prev,
              status: 'failed',
              failedTaskId: prev.currentTaskId,
              currentTaskId: undefined
            }),
            ctx.sub
          );
        }
      } else if (ev.type === 'run:end' && ev.final != null) {
        // 去重：run-queue 会在 harness 的 run:end 之后再补发一个不带 runId 的 run:end
        // （两者 final 相同），避免历史里出现两条重复的 assistant 消息。仅当会话最后一条
        // 还不是相同内容的 assistant 时才落盘。
        const finalStr = String(ev.final);
        const last = peekChatSession(chatSessionId, ctx.sub)?.messages.at(-1);
        if (traceRoot) traceRoot.status = 'ok';
        // 补全调用链路中 LLM 节点的「消息上下文」：llm:call 发生时 assistant 尚未落盘，
        // 导致 trace 节点 messages 只有用户消息、meta 却显示「消息 N」，重新进入历史后
        // 点开调用链路看不到 agent 助理内容。run:end 时 assistant 内容已完整，用当前
        // 会话消息 + 本次回答重建每个 LLM 节点的 messages。
        if (traceRoot && chatSessionId) {
          const sess = peekChatSession(chatSessionId, ctx.sub);
          if (sess) {
            const fullMsgs: ChatMessage[] = [
              ...sess.messages,
              {
                role: 'assistant',
                content: finalStr,
                ts: Date.now(),
                ...(reasoningBuf ? { reasoning: reasoningBuf } : {})
              }
            ];
            const countFromMeta = (meta?: Record<string, string>) => {
              const raw = meta?.messages ?? '';
              const m = raw.match(/(\d+)/);
              return m ? Number(m[1]) : 0;
            };
            const rebuildMessages = (node: TraceNode) => {
              if (node.kind === 'llm' && node.messages) {
                const want = countFromMeta(node.meta);
                if (want > 0) {
                  node.messages = fullMsgs
                    .slice(0, Math.min(want, fullMsgs.length))
                    .map((m) => ({
                      role: m.role,
                      content: m.content ?? '',
                      ts: m.ts,
                      ...(m.reasoning ? { reasoning: m.reasoning } : {})
                    }));
                }
              }
              node.children.forEach(rebuildMessages);
            };
            rebuildMessages(traceRoot);
          }
        }
        // 计划任务完成镜像：把刚跑完的 currentTaskId 标记为 done；全部任务完成则置 done 态。
        if (!isPlanPropose) {
          // 看板节点同步：刚完成的任务 → done（updatePlanStatus 先于同步执行以清空 currentTaskId，
          // 故取「即将被标记 done 的那个 id」= mutate 前的 currentTaskId）。
          const completedTaskId = peekPlanCurrentTaskId(chatSessionId ?? '');
          updatePlanStatus(
            chatSessionId,
            (prev) => {
              if (!prev.currentTaskId || prev.done.includes(prev.currentTaskId))
                return prev;
              const done = [...prev.done, prev.currentTaskId];
              return {
                ...prev,
                status: 'running',
                done,
                currentTaskId: undefined
              };
            },
            ctx.sub
          );
          if (chatSessionId && completedTaskId) {
            syncPlanTaskStatus(chatSessionId, completedTaskId, 'done', ctx.sub);
          }
        }
        if (
          !(last && last.role === 'assistant' && last.content === finalStr) &&
          !isPlanExecute
        ) {
          appendChatMessage(
            chatSessionId,
            {
              role: 'assistant',
              content: finalStr,
              ts: Date.now(),
              reasoning: reasoningBuf || undefined,
              tools: toolMap.size ? [...toolMap.values()] : undefined,
              trace: traceRoot ? [traceRoot] : undefined
            },
            ctx.sub,
            body.origin || ''
          );
        }
      }
    }
    if ((e as { type?: string }).type === '_done') {
      try {
        res.end();
      } catch {
        /* 连接可能已关闭 */
      }
    }
      }
    }
  );
  // res.on('close') 已在上方把 closed 置真；这里显式解绑，避免长尾 job 持有已断开订阅者。
  // P1-1：客户端断连时立即中止 in-flight job（用户关浏览器后 agent 继续烧 token 最多 5 分钟 → 改为立即 abort）。
  // 仅当该 job 无其他活跃订阅者时才 abort（允许多客户端同时订阅同一 job）。
  res.on('close', async () => {
    closed = true;
    clearInterval(pingTimer);
    unsub();
    const remainingSubs = [...(runQueue.get(jobId)?.subscribers ?? [])];
    if (remainingSubs.length <= 1) {
      // 这是最后一个订阅者，立即中止在飞任务
      try {
        runQueue.get(jobId)?.controller?.abort('client disconnected');
      } catch {
        /* 忽略 */
      }
    }
  });
  return;
}


/* ==================== plan 任务同步簇 ==================== */


/**
 * 计划产物落库（P2-3 补全）：把 plan:proposed 解析出的 ExecutionPlan 持久化为 PlanDoc。
 *
 * - id 语义：`plan:<sessionId>` —— 同一会话再次 propose 时幂等覆盖为最新文档
 *   （version +1），会话与计划文档一一对应，看板按会话即可定位；
 * - nodes 由 PlanTask 直接映射（id/title/dependsOn 透传，steps + expectedOutput 入 note）；
 * - 落库后经 publishPlanEvent 广播协同事件，已打开的看板实时刷新；
 * - 落库失败仅告警，不阻断计划卡片下发（计划主流程 = 会话消息落盘，已先行完成）。
 */
export async function persistProposedPlan(
  sessionId: string,
  plan: ExecutionPlan,
  sub: string
): Promise<void> {
  const doc: PlanDoc = {
    id: `plan:${sessionId}`,
    title: plan.goal || '计划',
    nodes: plan.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: 'todo' as const,
      dependsOn: t.dependsOn,
      ...(t.expectedOutput ? { note: t.expectedOutput } : {})
    })),
    version: 0,
    updatedBy: sub,
    updatedAt: new Date().toISOString(),
    sessionId
  };
  const store = getPlanStore();
  const saved = await store.save(doc);
  publishPlanEvent(saved.id, sub, { type: 'plan:update', patch: saved });
  requireDeps().auditAction('plan.persist', {
    planId: saved.id,
    sessionId,
    taskCount: plan.tasks.length,
    sub
  });
}

/** PlanTaskSync：plan 来源 DAG 执行的节点状态同步器契约（见 createPlanTaskSync）。 */
interface PlanTaskSync {
  sync(e: WorkflowEvent): void;
}

/**
 * P2-3 补全：plan 来源的 DAG 执行进度同步器。
 *
 * 把 wf:step:* / wf:done / wf:failed 事件映射到 PlanDoc 节点状态并落库：
 * - step 开始 → doing；完成 → done；失败 → blocked；
 * - 失败时把该 task 的所有未决下游（传递依赖）一并置 blocked；
 * - run 终态（wf:done / wf:failed）→ 全节点收敛终态。
 *
 * 定位 PlanDoc：`plan:<sessionId>`（与 persistProposedPlan 同键）；无 sessionId 或文档
 * 不存在（该计划从未 propose 落库）时静默跳过，不影响执行链路。
 * 同步失败仅告警——看板是旁路视图，不能反过来阻断 DAG 执行。
 *
 * P2.7（修复）：终态帧（wf:done / wf:failed）额外把执行结果写入**会话权威源**
 * （applyPlanWfTerminal：planStatus 固化 + 执行摘要消息追加）。此前 DAG 路径只写
 * 看板旁路视图，权威源缺 planStatus/摘要 → 前端刷新（getChatSession 内存命中）
 * 计划卡片退回「待确认」、执行结果「消失」。权威源写入独立于 PlanDoc（文档缺失
 * 不阻断；仅依赖会话的 plan 消息存在，owner 不符时静默跳过）。
 */
export function createPlanTaskSync(sessionId: string | undefined, sub: string): PlanTaskSync | null {
  if (!sessionId) return null;
  const planId = `plan:${sessionId}`;
  // 幂等节流：同一步骤状态连续重复事件（resume 重放等）不重复落库。
  let lastState = '';
  const store = getPlanStore();
  const log = (msg: string) => {
    console.warn(`[plan-store] 节点状态同步失败（${planId}）：${msg}`);
  };

  return {
    sync(e: WorkflowEvent): void {
      // P2.7：终态写权威源（独立 IIFE——PlanDoc 缺失时仍须执行；幂等由
      // appendChatMessage 紧邻同内容去重 + planStatus 单调收敛保证，resume 重放不重复落库）。
      if (e.type === 'wf:done' || e.type === 'wf:failed') {
        void applyPlanWfTerminal(sessionId, e, sub).catch(
          (err) => log(`权威源终态写入失败：${err?.message ?? String(err)}`)
        );
      }
      void (async () => {
        const doc = await store.read(planId);
        if (!doc) return; // 计划文档不存在（非 plan 来源 / 未 propose），跳过。
        const stepStates: Record<string, PlanNodeStatus> = {};
        switch (e.type) {
          case 'wf:step:start':
            stepStates[e.stepId] = 'doing';
            break;
          case 'wf:step:done':
            stepStates[e.stepId] = 'done';
            break;
          case 'wf:step:failed':
            stepStates[e.stepId] = 'blocked';
            // 失败传播：该 task 的未决下游（传递依赖）一并置 blocked。
            for (const n of doc.nodes) {
              if (n.id === e.stepId) continue;
              if (transitivelyBlocked(n.id, e.stepId, doc.nodes)) stepStates[n.id] = 'blocked';
            }
            break;
          case 'wf:done':
          case 'wf:failed': {
            const failed = e.type === 'wf:failed';
            for (const [id, s] of Object.entries(e.run?.steps ?? {})) {
              if (s.state === 'done') stepStates[id] = 'done';
              else if (s.state === 'failed') stepStates[id] = 'blocked';
              else if (failed) stepStates[id] = 'blocked';
            }
            break;
          }
          default:
            return;
        }
        if (!Object.keys(stepStates).length) return;
        // 幂等节流：状态集合不变时跳过落库。
        const key = Object.entries(stepStates)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        if (key === lastState) return;
        lastState = key;
        const nodes: PlanNode[] = doc.nodes.map((n) => {
          const s = stepStates[n.id];
          return s ? { ...n, status: s } : n;
        });
        await store.save({ ...doc, nodes });
        publishPlanEvent(planId, sub, {
          type: 'plan:update',
          patch: { nodes, version: doc.version + 1 }
        });
      })().catch((err) => log(err?.message ?? String(err)));
    }
  };
}

/** 某节点是否因 failedId 失败而被阻塞（沿 dependsOn 传递闭包判定）。 */
function transitivelyBlocked(nodeId: string, failedId: string, nodes: PlanNode[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stack = [nodeId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === failedId) return true;
    const deps = byId.get(id)?.dependsOn;
    if (deps) stack.push(...deps);
  }
  return false;
}

/**
 * P2-3 补全：读会话最近一条计划消息的进度镜像中 currentTaskId（任务级状态机当前节点）。
 * 供 error 事件时把「正在跑的那个任务」同步为 blocked；无计划消息 / 无镜像 / 已清空
 * currentTaskId 时返回 null（调用方跳过同步）。
 */
function peekPlanCurrentTaskId(sessionId: string): string | null {
  const s = peekChatSession(sessionId);
  if (!s) return null;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (!m || m.role !== 'assistant' || !m.plan) continue;
    return m.planStatus?.currentTaskId ?? null;
  }
  return null;
}

/**
 * P2-3 补全：串行执行路径的计划节点同步（与 createPlanTaskSync 的 DAG 路径语义一致）。
 *
 * 调用点：
 * - run:start 计划任务派发 → doing；
 * - error 事件 → blocked；
 * - run:end 任务完成 → done。
 * 定位 PlanDoc：`plan:<sessionId>`；文档不存在（该会话从未 propose 落库）时静默跳过。
 * 落库失败仅告警，不影响聊天链路。
 */
export function syncPlanTaskStatus(
  sessionId: string,
  taskId: string,
  status: PlanNodeStatus,
  sub: string
): void {
  const planId = `plan:${sessionId}`;
  void (async () => {
    const store = getPlanStore();
    const doc = await store.read(planId);
    if (!doc) return;
    const nodes: PlanNode[] = doc.nodes.map((n) =>
      n.id === taskId ? { ...n, status } : n
    );
    const saved = await store.save({ ...doc, nodes });
    publishPlanEvent(planId, sub, { type: 'plan:update', patch: saved });
  })().catch((err) => {
    console.warn(`[plan-store] 节点状态同步失败（${planId}）：${err?.message ?? String(err)}`);
  });
}

/**
 * P1-⑤ 工作流编排入口：定义并运行一个 DAG 工作流，SSE 直播每 step 进度与最终快照。
 * body: { def: WorkflowDef, input?: unknown }。def 含 steps（agentRef / dependsOn / compensate）。
 * 每个 step 经 createWorkflowExecutor 复用 /api/run 同一套 assembleAgent + harness 装配。
 */

/**
 * 工作流 SSE 事件的节点级审计（P3 可观测补强，配 WORKFLOW_STORE_DIR 检查点落盘）：
 * - wf:step:failed → `workflow.step.failed`（stepId + 错误摘要，500 字符截断防超大堆栈刷屏）；
 * - wf:done / wf:failed → `workflow.done` / `workflow.failed`（run 快照：各节点状态分布 +
 *   根因 error + 总耗时 durationMs，来自 run.startedAt/finishedAt）。
 * wf:step:start / wf:step:done / wf:compensate:* 与嵌套 harness 事件**不**进 stdout 审计——
 * 逐节点全量 input/output/error/时间戳已在 FileWorkflowStore 检查点（WORKFLOW_STORE_DIR）里，
 * stdout 审计只记「哪步失败 / 结果与耗时」，供 Render 服务日志事后回溯（对应 audit 面板查不到
 * 节点级明细的缺口）。审计不依赖连接是否已关：即便 SSE 客户端先断（!closed），也照记。
 */
export function auditWfEvent(e: WorkflowEvent, ctx: AuthContext): void {
  if (e.type === 'wf:step:failed') {
    requireDeps().auditAction('workflow.step.failed', {
      workflowId: e.workflowId,
      stepId: e.stepId,
      role: ctx.role,
      sub: ctx.sub,
      error: String(e.error).slice(0, 500)
    });
    return;
  }
  if (e.type === 'wf:awaiting-approval') {
    // P3（人工审批门）：run 在波次边界暂停等待人工批准。审计暂停点与待批节点集合，
    // 供 Render 服务日志回溯「哪个计划卡在哪个门、已等待多久」。
    requireDeps().auditAction('workflow.awaiting-approval', {
      workflowId: e.workflowId,
      runId: e.runId,
      stepIds: e.stepIds,
      role: ctx.role,
      sub: ctx.sub
    });
    return;
  }
  if (e.type === 'wf:done' || e.type === 'wf:failed') {
    const run = e.run;
    const stepStates = Object.entries(run?.steps ?? {})
      .map(([id, s]) => `${id}=${s.state}`)
      .join(' ');
    const durationMs =
      run?.startedAt && run?.finishedAt ? run.finishedAt - run.startedAt : undefined;
    requireDeps().auditAction(e.type === 'wf:done' ? 'workflow.done' : 'workflow.failed', {
      workflowId: e.workflowId,
      runId: e.runId,
      state: run?.state,
      stepStates,
      durationMs,
      ...(run?.error ? { error: String(run.error).slice(0, 500) } : {}),
      role: ctx.role,
      sub: ctx.sub
    });
  }
}

/**
 * P1（断点续跑）：/api/workflows 执行路径（handleWorkflow + POST /:id/resume + /:id/approve）
 * 共享的执行器选项解析——BYOK 凭据 + 校验门禁 + 与 /api/run 完全同款语义收敛。
 *
 * 抽出 helper 的原因：resume/approve 路由此前不带任何模型/凭据参数（executor 默认 mock、
 * 无 Key）→ real 模式部署下「断点续跑」会复现 t1 同款故障（首 step LLM 调用 401/无 Key）。
 * 检查点按 P1.3 纪律不存明文凭据，执行期一律按登录 owner 重新 resolveRunCredential。
 *
 * @returns 解析结果（mode + 可直接展开进 createWorkflowExecutor 的选项）；
 *          非 mock 模式无可用 Key 时已写 402 并返回 null（调用方立即 return，SSE 未开）。
 */
export async function resolveWorkflowRunOpts(
  body: Record<string, unknown>,
  ctx: AuthContext,
  res: ServerResponse,
  isPlan = false
): Promise<{ mode: RunMode; opts: Omit<WorkflowExecutorOptions, 'onEvent'> } | null> {
  const mode: RunMode =
    ['mock', 'real', 'real-mcp'].includes(String(body.mode ?? ''))
      ? (body.mode as RunMode)
      : 'mock';

  // BYOK 字段（与 handleRun 3653 同款读取 + 前端 AES-GCM 密文解密，明文仅请求期内存中流转）。
  const model: string | undefined = body.model
    ? String(body.model).trim()
    : undefined;
  const modelBaseUrl: string | undefined = body.modelBaseUrl
    ? String(body.modelBaseUrl).trim()
    : undefined;
  const modelApiKey: string | undefined = (() => {
    const raw = body.modelApiKey ? String(body.modelApiKey).trim() : '';
    if (!raw) return undefined;
    try {
      return decryptApiKey(raw);
    } catch {
      return undefined;
    }
  })();
  const ctxWindow: number | undefined =
    Number.isFinite(Number(body.ctxWindow)) && Number(body.ctxWindow) > 0
      ? Math.floor(Number(body.ctxWindow))
      : undefined;
  const webEnabled: boolean = body.web === true;

  // 校验/反思门禁（P0-2，与 /api/run 同款优先级）+ P4.5 plan 桥默认门禁：
  // 纯决策经 resolvePlanVerify（plan-verify.ts）——body.verify > body.autoVerify >
  // env AGENT_AUTO_VERIFY > plan 桥确定性默认（auto + 结果断言 + 逐 task outputChecks）。
  // 用户显式 autoVerify:false 视为选择退出；非 plan 路径行为与旧版逐字一致（零回归）。
  const planVerifyRetries = parsePlanVerifyRetries(process.env.AGENT_PLAN_VERIFY_RETRIES);
  const { verifyConfig, verifyMaxRetries: planVerifyRetriesOverride, planOutputChecks } =
    resolvePlanVerify({
      isPlan,
      bodyVerify: body.verify,
      bodyAutoVerify: body.autoVerify,
      envAutoVerify:
        process.env.AGENT_AUTO_VERIFY === 'true' ||
        process.env.AGENT_AUTO_VERIFY === '1',
      planVerifyRetries
    });

  // 凭据解析（per-owner，绝不写 process.env）：非 mock 且无 Key → 402 引导配置（与 /api/run 一致）。
  let cred: CredentialResult = { source: 'none' };
  if (mode !== 'mock') {
    cred = await resolveRunCredential(ctx.sub, {
      model,
      modelBaseUrl,
      modelApiKey
    });
    if (!cred.apiKey) {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'provider_key_required',
          hint: '当前账号未配置可用的 LLM API Key，请到「设置 → 模型服务商」填入你的 Key 后再继续。'
        })
      );
      return null;
    }
  }
  // 与 run-queue.ts:985-994 同款收敛：解析出的 baseUrl 优先于请求自带值；多 Key 一并透传。
  const effectiveBaseUrl = cred.baseUrl ?? modelBaseUrl;
  const effectiveApiKey = cred.apiKey;
  const effectiveApiKeys =
    cred.apiKeys && cred.apiKeys.length
      ? cred.apiKeys
      : effectiveApiKey
        ? [effectiveApiKey]
        : undefined;

  return {
    mode,
    opts: {
      model,
      modelBaseUrl: effectiveBaseUrl,
      modelApiKey: effectiveApiKey,
      apiKeys: effectiveApiKeys,
      ctxWindow,
      webEnabled,
      verify: verifyConfig,
      // P4.5：plan 桥逐 task 结果断言开关（outputChecks → per-step contains 断言）；
      // 非 plan 路径不传（executor 侧零感知，零回归）。
      ...(planOutputChecks ? { planOutputChecks: true } : {}),
      // P4.5：plan 默认门禁的重试预算（仅 plan 默认路径注入；显式 body.verify 保持
      // AGENT_VERIFY_MAX_RETRIES 存量语义，不覆盖）。
      ...(planVerifyRetriesOverride !== undefined ? { verifyMaxRetries: planVerifyRetriesOverride } : {})
    }
  };
}

/**
 * P5.4 活动 DAG run 注册表：workflowId → 运行中的 AbortController。
 * 断连不再中止 run（见 handleWorkflow 注释）后，「停止」按钮需要显式取消通道 ——
 * POST /api/workflows/:id/cancel 据此 abort 引擎 signal。run 终态（含被取消）时移除。
 * 进程内单例即可：DagEngine 检查点本就落在本进程 workflowStore。
 */

async function handleWorkflow(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  let closed = false;
  // P5.3 反转（P5.4）：计划执行期间客户端 SSE 断开（后台标签页节流 / 网络抖动 / 刷新）
  // 不再中止服务端 DAG run。计划是「服务端后台任务」，应在断连后继续跑完并把检查点落盘；
  // 重连的客户端经检查点轮询（GET /api/workflows/:id）读到权威终态（done/failed）。
  // 此前「断连即中止」使串行模式（执行更久、暴露窗口更长）下任何瞬时断连都把进行中的
  // 计划判 failed → 表现为「很容易 timeout」。客户端不会在断连/刷新后自动重派发（confirmPlan
  // 仅由按钮触发），故不中止也不会产生双执行；中止仅在服务优雅停机（shuttingDown）时发生。
  const runAbort = new AbortController();
  res.on('close', () => {
    closed = true;
  });

  const body = await readBody(req);
  const ctx = await requireDeps().guard(req, res, 'workflow:run', body);
  if (!ctx) return;
  // 优雅停机期间不再接受新运行。
  if (requireDeps().isShuttingDown()) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'server is shutting down' }));
    return;
  }

  // P2（plan 来源，见 docs/design/plan-mode-multiagent.md §4/§5）：
  // 请求可携带 `def`（已映射的 WorkflowDef）或 `plan`（ExecutionPlan，前端确认计划时直接发）。
  // `plan` 经 planToWorkflowDef 生成 def（每个 task 一个 step，dependsOn 透传 DAG，
  // 黑板 inputMapping 取上游真实产出）；初始输入默认取 plan.goal（buildInputMapping 的
  // goal:'input' 映射到各 step 的 goal 键）。agentRef 缺省回落 DEFAULT_AGENT_ID。
  let def = body.def as WorkflowDef | undefined;
  if (body.plan && !def) {
    // agentRef 归一化：前端 agentId 缺省为 ''（走默认 agent），'' 与 undefined 一律回落
    // DEFAULT_AGENT_ID（?? 只拦 null/undefined，拦不住空串）。
    const agentRef: string =
      typeof body.agentRef === 'string' && body.agentRef.trim()
        ? body.agentRef
        : DEFAULT_AGENT_ID;
    // 与 /api/run 同款 fail-fast（server.ts:3729）：unknown agentRef 立即 400，
    // 不拖到 executor 运行期才抛错（那时 SSE 已开、计划卡片已置 running）。
    if (agentRef !== DEFAULT_AGENT_ID) {
      const card = await getAgentRegistry().get(agentRef);
      if (!card) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `unknown agentRef: ${agentRef}` }));
        return;
      }
    }
    def = planToWorkflowDef(body.plan as ExecutionPlan, {
      agentRef,
      workflowId:
        typeof body.workflowId === 'string' && body.workflowId
          ? body.workflowId
          : undefined,
      tenantId: typeof body.tenantId === 'string' ? body.tenantId : undefined,
      traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
      // P5 执行顺序（2026-09-20 起自动决策）：缺省（未传）由计划桥按 DAG 形状决定
      // （波宽 > 1 → 有界并行；纯链 → 串行）；显式 'parallel' / 'serial' 覆盖自动决策。
      execMode:
        body.execMode === 'parallel' || body.execMode === 'serial'
          ? body.execMode
          : undefined
    });
  }
  if (
    !def ||
    typeof def.id !== 'string' ||
    !Array.isArray(def.steps) ||
    def.steps.length === 0
  ) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'invalid workflow def: 需要 { id: string, steps: StepDef[] } 或 { plan, agentRef? }'
      })
    );
    return;
  }

  // plan 来源：初始输入默认取 plan.goal（buildInputMapping 的 goal:'input' 映射到各 step 的 goal 键）。
  const initialInput: unknown = body.plan ? (body.plan as ExecutionPlan).goal ?? body.input : body.input;

  // SSE 发送器延迟绑定：先声明 no-op，校验通过后再挂真实 SSE；校验失败时根本不开 SSE。
  // mode 与 /api/run 同款白名单（server.ts:3567）：plan DAG 需按发起会话的运行模式
  // （前端透传）执行，默认 mock（离线）——保证「计划确认」与「当前聊天模式」语义一致。
  // P1（断点续跑）：BYOK 凭据 + 校验门禁收敛到共享 helper resolveWorkflowRunOpts
  // （与 resume / approve 路由同款语义，消灭「两处 24 参各自维护」陷阱）。
  // 前端随请求带上 model / 自定义模型端点（密钥为 AES-GCM 密文，同 /api/run），
  // 服务端按登录 owner（ctx.sub，不可伪造）走 resolveRunCredential 解析链
  // （自定义模型 → 用户 provider Key → 请求自带 Key → 平台兜底 → none），
  // 明文 Key 仅在请求期内存中流转、绝不落日志 / 审计 / 检查点。
  const execOpts = await resolveWorkflowRunOpts(
    body as Record<string, unknown>,
    ctx,
    res,
    !!body.plan // P4.5：plan 桥路径启用默认验证门禁 + 逐 task 结果断言
  );
  if (!execOpts) return; // 非 mock 无 Key 时 402 已写出（SSE 未开，不进入执行）
  const mode = execOpts.mode;
  let send: (payload: unknown) => void = () => {};
  // P5 静默展示策略（仅 plan 桥路径）：抑制 token 级流式事件（llm:token）——
  // 计划执行过程中 UI 不直播各 step 的回答内容，仅经 wf:step:* 驱动计划卡状态、
  // 经 llm:reasoning 驱动「当前任务思考面板」，最终结果在编排终态一次性输出。
  // llm:token 不在 StepTraceCollector 白名单内，此处过滤对调用链路落盘零影响；
  // 非 plan 工作流（def 来源）保持全量直播，行为不变。
  const quietPresentation = !!body.plan;
  const onHarnessEvent = (e: { type?: unknown }, stepId?: string) => {
    if (quietPresentation && e?.type === 'llm:token') return;
    // P5.1 同步修复：外层帧携带 stepId —— 前端思考面板据此把 llm:reasoning 归因到
    // 正确任务（wf:step:start 丢失/乱序时自愈，不再错挂旧任务标签）。
    if (!closed) send(stepId ? { type: 'harness', event: e, stepId } : { type: 'harness', event: e });
  };
  // P2-3 补全：plan 来源的 DAG 执行进度同步到 PlanStore（节点 doing/done/blocked + 文档终态），
  // 失败仅告警——执行链路（SSE 直播 / 审计）不依赖计划看板可用性。
  // sessionId 缺省按 body.plan 的会话关联回落：仅当请求显式携带 sessionId 才建同步器，
  // 避免 def 来源（非 plan 工作流）误写计划文档。
  const planSync: PlanTaskSync | null = createPlanTaskSync(
    typeof body.sessionId === 'string' ? body.sessionId : undefined,
    ctx.sub
  );
  const onWfEvent = (e: WorkflowEvent) => {
    auditWfEvent(e, ctx);
    planSync?.sync(e);
    if (!closed) send(e);
  };
  const executor = createWorkflowExecutor({
    onEvent: onHarnessEvent,
    mode,
    // P1（断点续跑）：BYOK 模型/凭据 + 校验门禁 + 上下文窗口 + 联网开关，经共享
    // resolveWorkflowRunOpts 解析（与 /api/run、resume 路由完全同款语义），
    // 经 executor → assembleAgent 的 20–23 号位置参数进入每个 step 的 LLM 装配。
    ...execOpts.opts
  });
  const engine = new DagEngine({
    store: workflowStore(),
    executor,
    onEvent: onWfEvent
  });

  // 拓扑合法性 fail-fast：环 / 未知依赖 / 重复 stepId 立即 400，不进入异步执行才失败。
  try {
    engine.validateWorkflow(def);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: `invalid workflow topology: ${
          e instanceof Error ? e.message : String(e)
        }`
      })
    );
    return;
  }

  send = startSse(res, req);

  requireDeps().auditAction('workflow.run', {
    workflowId: def.id,
    stepCount: def.steps.length,
    role: ctx.role,
    sub: ctx.sub
  });

  // 后台运行；SSE 已随 step 进度推送。完成后推送 _wf_done 并关闭。
  // initialInput：plan 来源时 = plan.goal（buildInputMapping 的 goal:'input' 映射到各 step 的 goal 键）；
  // def 来源时 = body.input（保持现有行为）。
  // P5.4：登记活动 run，供 POST /:id/cancel 显式取消（终态时移除）。
  activeWorkflowAborts.set(def.id, runAbort);
  engine
    .run(def, initialInput, runAbort.signal)
    .then(async (run: unknown) => {
      // P4.6：plan 桥终态先归档「交付文件」（幂等、无效产出跳过、绝不抛错），
      // 归档完成再发 _wf_done 终态帧——前端在终态帧后拉 GET /api/artifacts?runId=<wfId> 必然命中。
      await archivePlanArtifacts({ def, run: run as WorkflowRun, owner: ctx.sub }).catch((e) => {
        console.warn(`[plan-artifacts] 归档失败（不阻断执行）：${e instanceof Error ? e.message : String(e)}`);
      });
      if (!closed) send({ type: '_wf_done', workflowId: def.id, run });
      if (!closed) res.end();
    })
    .catch((e) => {
      if (!closed)
        send({
          type: 'wf:error',
          workflowId: def.id,
          message: e instanceof Error ? e.message : String(e)
        });
      if (!closed) res.end();
    })
    .finally(() => {
      activeWorkflowAborts.delete(def.id);
    });
  return;
}

/**


/* ==================== resolveTraceId ==================== */


/**
 * 启动引导：先按 env 选定并初始化 AgentRegistry 持久后端（幂等，须早于首个请求），
 * 再注册行业合规画像，最后开始监听。把这些放到 listen 之前，杜绝「请求早于注册表就绪」的竞态。
 */
/** 解析当前请求的 traceId（客户端显式声明优先，否则生成 UUID）。 */
function resolveTraceId(
  req: IncomingMessage,
  body?: Record<string, unknown>
): string {
  // 先查 Request Body
  const bodyTraceId = body?.traceId;
  if (typeof bodyTraceId === 'string' && bodyTraceId.trim().length > 0) {
    return bodyTraceId.trim().slice(0, 64);
  }
  // 再查 HTTP Header（透传上游 LB 注入的 X-Request-Id）
  const headerTraceId = req.headers['x-request-id'] as string | undefined;
  if (headerTraceId && headerTraceId.trim().length > 0) {
    return headerTraceId.trim().slice(0, 64);
  }
  // 兜底：生成 UUID v4
  return randomBytes(16).toString('hex');
}


export { handleWorkflow };
