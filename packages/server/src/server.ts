import { createServer } from 'node:http';
import { accessSync } from 'node:fs';
import { readFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assembleAgent, defaultPromptFor, getMemoryStore, invalidateSessionMemory, type RunMode } from './runner';
import { runVerification, type VerifyEvent } from './verification';
import { mcpManager } from './mcp-manager';
import { runQueue } from './run-queue';
import { envPipeline } from './env-pipeline';
import { approve as approveShell, preapprove as preapproveShell, shellSignature } from './shell-approval';
import type { McpTransportType } from '@agent-harness/core';
import { getMetricsSnapshot, Memory, sanitizeKey, structLog, setAlertSink, emitAlert, logError, resolveOpenRouterConfig, getAgentRegistry, policyEngine, type VerifyConfig, type AgentCard, DagEngine, type WorkflowDef, type WorkflowEvent, HttpA2ATransport, type TaskEnvelope, type TaskResult, type A2ARequest } from '@agent-harness/core';
import { createWorkflowExecutor, workflowStore } from './workflow-executor';
import { runAgentTask } from './agent-run';
// 业务策略层（与核心 framework 隔离）：RBAC 鉴权 + 审批工作流，均为可插拔接口。
import { createAuthorizer, type Authorizer, type AuthContext, type Action } from './authz';
// 外部身份源（OIDC Bearer JWT 资源服务器 / proxy 头注入）。提供 JWKS 预热与前端鉴权元信息。
import { warmJwks, getAuthConfig } from './sso';
import { createApprovalPolicy, type ApprovalPolicy } from './approval';
import { createEvaluator, createRecipeStore, runRecordFromEvents, type Evaluator, type RecipeStore } from './eval';
import { createRetentionPolicy, type RetentionPolicy } from './retention';
import { buildOpenApiSpec } from './openapi';
// 密钥外部化：在读取任何 process.env 之前装配（平台 env / SECRETS_FILE / 本地 .env）。
import { loadSecrets } from './secrets';

// 必须在下方任何 `process.env.X` 顶层读取前执行（幂等，仅首次生效）。
loadSecrets();

// 告警通道：根据环境变量装配（Webhook / 日志文件），在捕获任何错误之前就位。
setupAlerting();

// Render (and most PaaS) inject PORT; fall back to UI_PORT then the local default.
const PORT = Number(process.env.PORT ?? process.env.UI_PORT ?? 4173);
const HOST = process.env.UI_HOST ?? '0.0.0.0';

// 接口鉴权：设置 UI_AUTH_TOKEN 后，除健康检查与静态页外的所有 API 都需
// `Authorization: Bearer <token>`（或 `?token=<token>` 兼容旧用法）。
// 未设置则保持开放（仅建议本地 / 演示使用，启动时会给出告警）。
const UI_AUTH_TOKEN = process.env.UI_AUTH_TOKEN || '';
// 身份源：token（默认静态令牌）/ oidc（Bearer JWT）/ proxy（SSO 网关头注入）。
const AUTH_PROVIDER = (process.env.AUTH_PROVIDER || 'token').toLowerCase();
// 非 token 模式即视为需要鉴权；token 模式仅在有静态令牌时才开启（向后兼容）。
const REQUIRE_AUTH = AUTH_PROVIDER !== 'token' || !!(process.env.UI_TOKENS || UI_AUTH_TOKEN);

// 安全加固配置（均可在 .env / 环境变量中调整）。
// 允许跨域的来源白名单（逗号分隔）；为空则仅同源（默认收紧，不再回 `*`，防 CSRF/跨域调用）。
const UI_CORS_ORIGIN = (process.env.UI_CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// 请求体上限（字节），防大报文 DoS。默认 1MB。
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 1_048_576);
// 限流：单 IP 在窗口内的请求数；<=0 关闭限流。默认 120/60s。
const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 120);
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
// 审计日志落盘路径；为空则仅输出到 stdout（JSON 行）。
const AUDIT_LOG = process.env.AUDIT_LOG || '';

// 业务策略装配（组合根）：RBAC 鉴权器 + 审批策略。二者均为可插拔接口实现，
// 核心 framework 不感知任何角色/权限/审批概念。替换身份源或审批后端只需改这两个工厂。
const authorizer: Authorizer = createAuthorizer(REQUIRE_AUTH);

// OIDC 模式：后台预热 JWKS（内联 OIDC_JWKS 无需网络），并每小时刷新密钥（IdP 轮换）。
if (AUTH_PROVIDER === 'oidc') {
  void warmJwks();
  const jwksTimer = setInterval(() => void warmJwks(), 3_600_000);
  if (typeof jwksTimer.unref === 'function') jwksTimer.unref();
}
const approvalPolicy: ApprovalPolicy = createApprovalPolicy();
// 评估与配方版本化（业务质量策略），同样由组合工厂装配，核心不感知。
const evaluator: Evaluator = createEvaluator();
const recipeStore: RecipeStore = createRecipeStore();
// 数据留存/出境策略与 OpenAPI 契约（业务合规层），同样由组合工厂装配，核心不感知。
const retentionPolicy: RetentionPolicy = createRetentionPolicy();
const openApiSpec = buildOpenApiSpec();

// ---------------------------------------------------------------------------
// 安全 / 可观测辅助
// ---------------------------------------------------------------------------

/** 取客户端真实 IP（兼容反向代理 X-Forwarded-For）。 */
function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** 内存态固定窗口限流；超过阈值返回 true（应拒绝）。 */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  if (!(RATE_LIMIT > 0)) return false;
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, b);
  }
  b.count += 1;
  return b.count > RATE_LIMIT;
}

/** 依据配置解析本次响应应回的 CORS 头；未配置则返回空（仅同源）。 */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || UI_CORS_ORIGIN.length === 0) return {};
  if (UI_CORS_ORIGIN.includes('*')) return { 'access-control-allow-origin': '*' };
  if (UI_CORS_ORIGIN.includes(origin)) return { 'access-control-allow-origin': origin };
  return {};
}

/** 结构化审计：记录 时间/方法/路径/IP/鉴权/状态码 与动作级脱敏字段。 */
function audit(rec: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec });
  if (AUDIT_LOG) {
    appendFile(AUDIT_LOG, line + '\n').catch(() => {});
  }
  console.log('[audit] ' + line);
}

/** 高危动作审计（已脱敏，绝不记录密钥/token/headers）。 */
function auditAction(action: string, fields: Record<string, unknown>): void {
  audit({ kind: 'action', action, ...fields });
}

/** 去掉 URL 中的查询串，避免把内嵌 token 写进审计日志。 */
function redactUrl(url?: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url.split('?')[0];
  }
}

/**
 * 统一准入网关（组合点）：鉴权 → 限流 → 角色授权 → 审批闸门。
 * 失败时已写出响应并返回 null；成功返回 AuthContext，调用方可继续执行业务动作。
 *
 * - body：POST 动作已解析的请求体（用于读取随请求的 approvalTicket，避免二次读流）。
 * - 需审批且未持有效票据时，创建 ticket 并回 202 { ticketId }；调用方据此轮询/重发。
 */
async function guard(req: IncomingMessage, res: ServerResponse, action: Action, body?: any): Promise<AuthContext | null> {
  const ip = clientIp(req);
  const ctx = authorizer.authenticate(req);
  if (!ctx) {
    audit({ kind: 'request', method: req.method, path: req.url, ip, authed: false, status: 401 });
    unauthorized(res);
    return null;
  }
  if (rateLimited(ip)) {
    audit({ kind: 'request', method: req.method, path: req.url, ip, authed: true, status: 429 });
    res.writeHead(429, { 'content-type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify({ error: 'rate limit exceeded' }));
    return null;
  }
  if (!authorizer.can(ctx, action)) {
    audit({ kind: 'request', method: req.method, path: req.url, ip, authed: true, status: 403, action });
    res.writeHead(403, { 'content-type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify({ error: 'forbidden', action }));
    return null;
  }
  audit({ kind: 'request', method: req.method, path: req.url, ip, authed: true, action });

  // 审批闸门：敏感动作需先获批。已携带有效票据（动作一致且已批准）则放行。
  if (approvalPolicy.requiresApproval(action, ctx)) {
    const ticketId: string | null =
      (body && typeof body.approvalTicket === 'string' && body.approvalTicket) ||
      new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams.get('approvalTicket');
    if (ticketId) {
      const t = approvalPolicy.consume(ticketId, action, ctx);
      if (t) return ctx; // 已批准，放行执行
    }
    const ticket = approvalPolicy.create(action, ctx, `${action} · by ${ctx.sub}/${ctx.role}`);
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(req) });
    res.end(JSON.stringify({ ticketId: ticket.id, status: 'pending', message: '需要审批', poll: `/api/approvals/${ticket.id}` }));
    return null;
  }
  return ctx;
}

/** 只读 GET 端点的动作映射（POST 动作由各 handler 自行 guard，需先读 body 判定 mode）。 */
function readAction(path: string): Action | null {
  switch (path) {
    case '/api/mcp/list':
    case '/api/mcp/presets':
      return 'mcp:read';
    case '/api/metrics':
      return 'metrics:read';
    case '/api/jobs':
      return 'jobs:read';
    case '/api/sessions':
      return 'sessions:read';
    default:
      return null;
  }
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized: missing or invalid token' }));
}

// 启动时从环境变量加载并接入已配置的 MCP 服务（后台进行，不阻塞监听）。
mcpManager.init();

// 前端统一由 packages/webapp/dist 托管（见 webappDir）；项目不再包含 public 兜底目录。

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  let path = url.pathname;
  // 版本化 API：/api/v1/* 是稳定契约前缀，内部重写为等价非前缀路径 /api/*（向后兼容别名）。
  if (path.startsWith('/api/v1')) path = path.replace('/api/v1', '/api');

  try {
    // CORS 预检：仅当配置了跨域白名单时才需处理。
    if (req.method === 'OPTIONS') {
      const h: Record<string, string> = {
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
        ...corsHeaders(req),
      };
      res.writeHead(204, h);
      res.end();
      return;
    }

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      // 优先托管 Web SPA 构建产物（packages/webapp/dist）；webapp 未构建则返回 500。
      const wd = webappDir();
      if (wd) {
        try {
          const buf = await readFile(join(wd, 'index.html'));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(buf);
          return;
        } catch {
          /* webapp 未构建，交给 serveHtml 返回 500 */
        }
      }
      return await serveHtml(res);
    }
    // 托管 Web SPA 的静态资源（/assets/*）。仅当 webapp 已构建时生效。
    if (req.method === 'GET' && path.startsWith('/assets/')) {
      const wd = webappDir();
      if (wd) {
        const rel = decodeURIComponent(path.slice('/assets/'.length).split('?')[0]);
        const assetRoot = join(wd, 'assets');
        const fp = resolve(assetRoot, rel);
        if (fp.startsWith(assetRoot)) {
          try {
            const buf = await readFile(fp);
            res.writeHead(200, { 'content-type': contentTypeFor(fp) });
            res.end(buf);
            return;
          } catch {
            /* 文件不存在，落到 404 */
          }
        }
      }
    }
    // 托管 dist 根目录下的零散静态文件（favicon.ico / favicon.svg / robots.txt 等）。
    // vite 会把 public/ 内容原样复制到 dist/ 根，但这些文件不在 /assets/ 前缀下，
    // 需单独放行（仅允许无子目录的根级文件，避免路径穿越）。
    // 注意：path 带前导 '/'（如 /favicon.ico），故用 slice(1) 去掉首斜杠后再判断是否含 '/'，
    // 以区分「根级文件」与「含子目录的路径」。
    if (req.method === 'GET' && !path.slice(1).includes('/') && !path.startsWith('/api')) {
      const wd = webappDir();
      if (wd) {
        const rel = decodeURIComponent(path.slice(1).split('?')[0]);
        const fp = resolve(wd, rel);
        if (fp === join(wd, rel)) {
          try {
            const buf = await readFile(fp);
            res.writeHead(200, { 'content-type': contentTypeFor(fp) });
            res.end(buf);
            return;
          } catch {
            /* 文件不存在，继续走后续路由 */
          }
        }
      }
    }
    if (req.method === 'GET' && path === '/api/state') {
      // 健康检查端点保持开放（Render 等 PaaS 无法在健康检查中带令牌）。
      return sendJson(res, buildState());
    }
    if (req.method === 'GET' && path === '/api/auth/config') {
      // 公开：供前端获取身份源元信息（如 OIDC 授权端点 / clientId / scopes），
      // 以便发起 SSO 登录（授权码流 + PKCE，令牌取回后作为 Bearer 调用本服务）。
      return sendJson(res, getAuthConfig(), req);
    }
    if (req.method === 'GET' && path === '/api/openapi.json') {
      // OpenAPI 3.0 契约（版本化 API 文档）；受 policy:read 保护。
      const ctx = await guard(req, res, 'policy:read');
      if (!ctx) return;
      return sendJson(res, openApiSpec, req);
    }
    if (req.method === 'GET' && path === '/api/retention') {
      // 数据留存 / 出境策略快照（合规查阅）。
      const ctx = await guard(req, res, 'policy:read');
      if (!ctx) return;
      return sendJson(res, retentionPolicy.describe(), req);
    }
    // 只读 GET 端点集中准入：鉴权 + 限流 + 角色授权（审批对该类动作不适用）。
    // POST 动作由各 handler 在读取 body 后自行 guard（需先判定 run mode 等）。
    const readAct = readAction(path);
    if (readAct && req.method === 'GET') {
      const ctx = await guard(req, res, readAct);
      if (!ctx) return;
    }
    if (req.method === 'GET' && path === '/api/mcp/list') {
      return sendJson(res, { servers: mcpManager.list() });
    }
    if (req.method === 'GET' && path === '/api/mcp/presets') {
      // 开箱预设清单（Context7 / GitHub / Composio 等），供前端「预设市场」一键接入。
      return sendJson(res, { presets: mcpManager.presets() });
    }
    if (req.method === 'GET' && path === '/api/metrics') {
      // 可观测性指标（token 用量 / 延迟 / 错误率 / 工具调用数 / 成本 / 队列）。受保护，需令牌。
      const store = getMemoryStore();
      return sendJson(
        res,
        { ...getMetricsSnapshot(), queue: runQueue.stats(), memory: { backend: store.kind } },
        req
      );
    }
    if (req.method === 'GET' && path === '/api/jobs') {
      // 运行队列的脱敏状态快照（运维视角）：当前排队/执行数、最近若干 job 概要。
      return sendJson(res, { queue: runQueue.stats(), jobs: runQueue.list() }, req);
    }
    if (req.method === 'GET' && path === '/api/sessions') {
      // 多租户记忆视图（P1-9）：列出所有已落盘记忆的会话 key 及后端类型。
      const store = getMemoryStore();
      const keys = await store.list();
      return sendJson(res, { backend: store.kind, sessions: keys }, req);
    }
    // ---- P0.1：智能体注册与发现 ----
    if (req.method === 'GET' && path === '/api/agents') {
      // 列出 / 按 domain + capability 发现已注册 agent。受 agent:read 保护。
      const ctx = await guard(req, res, 'agent:read');
      if (!ctx) return;
      const domain = url.searchParams.get('domain') || undefined;
      const capability = url.searchParams.get('capability') || undefined;
      const agents = await getAgentRegistry().query({ ...(domain ? { domain } : {}), ...(capability ? { capability } : {}) });
      return sendJson(res, { agents, count: agents.length }, req);
    }
    if (req.method === 'GET' && path.startsWith('/api/agents/')) {
      // 取单个 agent 卡片（含健康度）。受 agent:read 保护。
      const ctx = await guard(req, res, 'agent:read');
      if (!ctx) return;
      const id = decodeURIComponent(path.slice('/api/agents/'.length).replace(/\/$/, ''));
      const card = id ? await getAgentRegistry().get(id) : null;
      if (!card) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent not found', id }));
        return;
      }
      return sendJson(res, { agent: card }, req);
    }
    // ---- P1-⑤：工作流编排（DAG 执行快照查询）----
    if (req.method === 'GET' && path.startsWith('/api/workflows/')) {
      // 取单个工作流执行快照（含每 step 状态、补偿记录）。受 workflow:read 保护。
      const ctx = await guard(req, res, 'workflow:read');
      if (!ctx) return;
      const id = decodeURIComponent(path.slice('/api/workflows/'.length).replace(/\/$/, ''));
      const run = id ? await workflowStore().get(id) : null;
      if (!run) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'workflow not found', id }));
        return;
      }
      return sendJson(res, { workflow: run }, req);
    }
    if (path === '/api/memory') {
      // 查看 / 清空某个会话（按 session key）的记忆。敏感运维动作，已接入 RBAC + 审批。
      const sessionKey = sanitizeKey(url.searchParams.get('session') || 'anonymous');
      if (req.method === 'DELETE') {
        const body = await readBody(req);
        const ctx = await guard(req, res, 'memory:clear', body);
        if (!ctx) return;
        const store = getMemoryStore();
        const memory = new Memory({ store, sessionKey });
        await memory.clear();
        // 同步失效进程内会话记忆缓存，避免下次 run 仍复用已被清空的旧窗口。
        invalidateSessionMemory(sessionKey);
        auditAction('memory.clear', { sessionKey, role: ctx.role, sub: ctx.sub });
        return sendJson(res, { ok: true, sessionKey }, req);
      }
      // GET：返回该会话的长期笔记与窗口长度（不 dump 完整对话内容，控制暴露面）。
      const ctx = await guard(req, res, 'memory:read');
      if (!ctx) return;
      const store = getMemoryStore();
      const memory = new Memory({ store, sessionKey });
      await memory.load();
      return sendJson(
        res,
        {
          sessionKey,
          backend: store.kind,
          notes: memory.notes(),
          windowLen: memory.history().length,
        },
        req
      );
    }
    if (req.method === 'GET' && path === '/api/roles') {
      // 当前授权配置概览（不含令牌明文），便于运维核对角色权限矩阵。
      return sendJson(res, authorizer.describe(), req);
    }
    if (path === '/api/approvals') {
      // 审批工单列表（admin / 审批人角色可读）。
      if (req.method === 'GET') {
        const ctx = await guard(req, res, 'approvals:review');
        if (!ctx) return;
        const status = url.searchParams.get('status');
        return sendJson(res, { tickets: approvalPolicy.list(status ? { status: status as any } : undefined) }, req);
      }
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    if (path.startsWith('/api/approvals/')) {
      // 单张工单：GET 查看状态；POST 审批人裁决（approve/reject）。
      const id = path.slice('/api/approvals/'.length).replace(/\/$/, '');
      if (req.method === 'GET') {
        const ctx = await guard(req, res, 'approvals:review');
        if (!ctx) return;
        const t = approvalPolicy.list().find((x) => x.id === id);
        return sendJson(res, t ? { ticket: t } : { error: 'not found' }, req);
      }
      if (req.method === 'POST') {
        const ctx = await guard(req, res, 'approvals:review');
        if (!ctx) return;
        const body = await readBody(req);
        const decision = body.decision === 'reject' ? 'reject' : 'approve';
        const t = approvalPolicy.decide(id, decision, ctx.sub);
        if (!t) return sendJson(res, { error: 'ticket not found or already decided' }, req);
        auditAction('approval.decide', { id, decision, by: ctx.sub });
        return sendJson(res, { ticket: t }, req);
      }
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    // ---- 评估与配方版本化（P2-13，业务质量策略）----
    if (req.method === 'POST' && path === '/api/eval') {
      const body = await readBody(req);
      const ctx = await guard(req, res, 'eval:run', body);
      if (!ctx) return;
      const jobId = String(body.jobId ?? '');
      const job = runQueue.get(jobId);
      if (!job) return sendJson(res, { error: 'job not found' }, req);
      const rec = runRecordFromEvents(jobId, job.events);
      const result = evaluator.evaluate(rec);
      auditAction('eval.run', { jobId, score: result.score, passed: result.passed, role: ctx.role, sub: ctx.sub });
      return sendJson(res, { jobId, record: rec, result }, req);
    }
    if (path === '/api/recipes') {
      if (req.method === 'GET') {
        const ctx = await guard(req, res, 'recipe:read');
        if (!ctx) return;
        return sendJson(res, { recipes: recipeStore.list() }, req);
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const ctx = await guard(req, res, 'recipe:save', body);
        if (!ctx) return;
        const jobId = String(body.jobId ?? '');
        const job = runQueue.get(jobId);
        if (!job) return sendJson(res, { error: 'job not found' }, req);
        const rec = runRecordFromEvents(jobId, job.events);
        const id = `rcp_${Date.now().toString(36)}`;
        const recipe = {
          id,
          name: String(body.name ?? id),
          createdAt: Date.now(),
          record: rec,
          notes: body.notes ? String(body.notes) : undefined,
        };
        recipeStore.save(recipe);
        auditAction('recipe.save', { id, name: recipe.name, role: ctx.role, sub: ctx.sub });
        return sendJson(res, { recipe }, req);
      }
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    if (path.startsWith('/api/recipes/')) {
      const id = path.slice('/api/recipes/'.length).replace(/\/$/, '');
      if (req.method === 'GET') {
        const ctx = await guard(req, res, 'recipe:read');
        if (!ctx) return;
        const r = recipeStore.get(id);
        return sendJson(res, r ? { recipe: r } : { error: 'not found' }, req);
      }
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    if (req.method === 'GET' && path === '/api/env') {
      return sendJson(res, { envs: envPipeline.list() });
    }
    if (req.method === 'POST' && path === '/api/run') {
      return await handleRun(req, res);
    }
    if (req.method === 'POST' && path === '/api/workflows') {
      return await handleWorkflow(req, res);
    }
    if (req.method === 'POST' && path === '/api/a2a/tasks') {
      return await handleA2A(req, res);
    }
    if (req.method === 'POST' && path === '/api/verify') {
      return await handleVerify(req, res);
    }
    if (req.method === 'POST' && path === '/api/mcp/add') {
      return await handleMcpAdd(req, res);
    }
    if (req.method === 'POST' && path === '/api/mcp/preset') {
      return await handleMcpPreset(req, res);
    }
    if (req.method === 'POST' && path === '/api/mcp/reconnect') {
      const body = await readBody(req);
      const ctx = await guard(req, res, 'mcp:reconnect', body);
      if (!ctx) return;
      const name = String(body.name ?? '');
      if (!name) {
        return sendJson(res, { error: '缺少 name' }, req);
      }
      auditAction('mcp.reconnect', { name, role: ctx.role, sub: ctx.sub });
      try {
        const meta = await mcpManager.reconnect(name);
        return sendJson(res, { server: meta }, req);
      } catch (e: any) {
        return sendJson(res, { error: e?.message ?? String(e) }, req);
      }
    }
    if (req.method === 'POST' && path === '/api/shell/approve') {
      return await handleShellApprove(req, res);
    }
    if (req.method === 'POST' && path === '/api/env') {
      return await handleEnv(req, res);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e: any) {
    logError('http.request', e, { path: req.url });
    const code = typeof e?.status === 'number' ? e.status : 500;
    if (!res.headersSent) {
      res.writeHead(code, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: e?.message ?? String(e) }));
  }
});

function buildState() {
  return {
    openrouter: !!process.env.OPENROUTER_API_KEY,
    harnessKey: !!process.env.HARNESS_API_KEY,
    harnessDryRun: !process.env.HARNESS_API_KEY,
    mcpUrl: process.env.MCP_SERVER_URL ?? null,
    model: resolveOpenRouterConfig().model,
    mcpServers: mcpManager.list().map((s) => ({
      name: s.name,
      url: s.url ?? null,
      status: s.status,
      health: s.health ?? null,
      reconnectAttempts: s.reconnectAttempts ?? 0,
      toolCount: s.tools.length,
      tools: s.tools.map((t) => ({ registeredName: t.registeredName, originalName: t.originalName })),
      error: s.error ?? null,
    })),
    mcpPresets: mcpManager.presets().map((p) => ({ id: p.id, name: p.name, authType: p.authType })),
    envs: envPipeline.list(),
  };
}

function serveHtml(res: ServerResponse): void {
  // webapp 未构建时的兜底：直接返回 500 并提示先构建前端。
  res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Web 前端未构建，请先构建 webapp：pnpm --filter @agent-harness/webapp run build');
}

/** Web SPA 构建产物目录（packages/webapp/dist）；未构建则返回 null。 */
function webappDir(): string | null {
  const dir = resolve(__dirname, '..', '..', 'webapp', 'dist');
  try {
    accessSync(dir);
    return dir;
  } catch {
    return null;
  }
}

/** 按扩展名推断静态资源 Content-Type（SPA 资源托管用）。 */
function contentTypeFor(fp: string): string {
  const ext = fp.slice(fp.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    html: 'text/html; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    ico: 'image/x-icon',
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
  };
  return map[ext] ?? 'application/octet-stream';
}

function sendJson(res: ServerResponse, obj: unknown, req?: IncomingMessage): void {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    ...corsHeaders(req ?? ({ headers: {} } as IncomingMessage)),
  });
  res.end(JSON.stringify(obj));
}

function startSse(res: ServerResponse, req?: IncomingMessage): (obj: unknown) => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...corsHeaders(req ?? ({ headers: {} } as IncomingMessage)),
  });
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  return (obj: unknown) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      // 客户端已断开（EPIPE 等）：标记 closed，避免对已死连接继续写。
      closed = true;
    }
  };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      const err: any = new Error('request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const err: any = new Error('invalid JSON body');
    err.status = 400;
    throw err;
  }
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const body = await readBody(req);
  const mode: RunMode = ['mock', 'real', 'real-mcp'].includes(body.mode) ? body.mode : 'mock';
  // 按运行模式映射为细分动作，做角色授权 + 审批判定（real / real-mcp 需审批）。
  const runAction: Action =
    mode === 'real-mcp' ? 'agent:run:real-mcp' : mode === 'real' ? 'agent:run:real' : 'agent:run:mock';
  const ctx = await guard(req, res, runAction, body);
  if (!ctx) return;
  // 优雅停机期间不再接受新运行，避免任务在进程退出时被强杀。
  if (shuttingDown) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'server is shutting down' }));
    return;
  }
  const send = startSse(res, req);
  const prompt: string = (body.prompt && String(body.prompt).trim()) || defaultPromptFor(mode);
  const model: string | undefined = body.model ? String(body.model).trim() : undefined;
  // 闭环步数上限：允许前端按任务复杂度覆盖；空/非法则回退到服务端 MAX_STEPS（默认 24）。
  const maxSteps: number | undefined =
    typeof body.maxSteps === 'number' && Number.isFinite(body.maxSteps) && body.maxSteps > 0
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
  const targetId = reconnectId && runQueue.get(reconnectId) ? reconnectId : null;

  // P0.2/P0.3：任务路由 & 租户辅助字段。
  // - domain / workflowId / traceId：客户端显式声明（用于路由与可观测）。
  // - tenantId：P0.3 权威来源为认证身份（SSO 网关 / IdP claim 注入 ctx.tenantId），
  //   客户端声明的 body.tenantId 仅作本地/测试降级；认证身份优先，杜绝客户端伪造越界。
  const domain = body.domain ? String(body.domain).trim() : undefined;
  const declaredTenantId = body.tenantId ? String(body.tenantId).trim() : undefined;
  const effectiveTenantId = ctx.tenantId || declaredTenantId;
  const tenantId = effectiveTenantId || undefined;
  const workflowId = body.workflowId ? String(body.workflowId).trim() : undefined;
  const traceId = body.traceId ? String(body.traceId).trim() : undefined;

  // P0-2：运行期自动验证门禁配置解析（优先级：body.verify 显式完整配置 > body.autoVerify 开关
  // > 服务端 AGENT_AUTO_VERIFY 默认）。验证器最终在 run-queue.execute 内按 config 装配，
  // 并以可序列化形式随 JobDescriptor 持久化，使重放/多实例领取后门禁行为一致。
  let verifyConfig: VerifyConfig | undefined;
  const envAutoVerify =
    process.env.AGENT_AUTO_VERIFY === 'true' || process.env.AGENT_AUTO_VERIFY === '1';
  if (body.verify && typeof body.verify === 'object' && !Array.isArray(body.verify)) {
    verifyConfig = body.verify as VerifyConfig;
  } else if (typeof body.autoVerify === 'boolean') {
    verifyConfig = body.autoVerify ? { auto: true } : undefined;
  } else if (envAutoVerify) {
    verifyConfig = { auto: true };
  }

  let jobId: string;
  if (!targetId) {
    const job = runQueue.submit({ mode, prompt, model, sessionKey, maxSteps, verify: verifyConfig, agentId: agentCard?.id, domain, tenantId, workflowId, traceId });
    auditAction('agent.run', { mode, promptLen: prompt.length, model: model ?? null, jobId: job.id, sessionKey, agentId: agentCard?.id ?? null, role: ctx.role, sub: ctx.sub, verify: verifyConfig ? 'on' : 'off' });
    send({ type: 'job:accepted', jobId: job.id, sessionKey });
    jobId = job.id;
  } else {
    auditAction('agent.run.reconnect', { jobId: targetId, role: ctx.role, sub: ctx.sub });
    jobId = targetId;
  }

  // 订阅事件流：先重放已发生事件，再转发后续；遇到终结事件 _done 主动关闭连接。
  const unsub = runQueue.subscribe(jobId, (e) => {
    if (closed) return;
    send(e);
    if ((e as { type?: string }).type === '_done') {
      try {
        res.end();
      } catch {
        /* 连接可能已关闭 */
      }
    }
  });
  // res.on('close') 已在上方把 closed 置真；这里显式解绑，避免长尾 job 持有已断开订阅者。
  res.on('close', () => {
    unsub();
  });
  return;
}

/**
 * P1-④ A2A 接收端点：远端 agent 把 TaskEnvelope 投递到本平台，由本平台在「本地」用
 * 与 /api/run 同款的 assembleAgent+harness 执行（目标 agent 必须已注册或为 local transport）。
 * body: A2ARequest { envelope: TaskEnvelope, card?: AgentCard }。
 * - card 可选：随任务一起自注册/更新目标 agent 的能力卡片（远端 agent 入驻式入驻）；
 * - 执行结果以 { result: TaskResult } 返回（成功 200，目标不存在 400）。
 */
async function handleA2A(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const ctx = await guard(req, res, 'a2a:receive', body);
  if (!ctx) return;
  if (shuttingDown) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'server is shutting down' }));
    return;
  }

  const reqBody = body as Partial<A2ARequest>;
  const envelope = reqBody.envelope as TaskEnvelope | undefined;
  if (!envelope || typeof envelope.taskId !== 'string' || typeof envelope.toAgent !== 'string') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid a2a request: 需要 { envelope: { taskId, toAgent, ... } }' }));
    return;
  }

  // 远端 agent 随任务自注册能力卡片（首次入驻或覆盖更新）。
  const card = reqBody.card as AgentCard | undefined;
  if (card && typeof card.id === 'string') {
    await getAgentRegistry().register(card);
  }

  const target = await getAgentRegistry().get(envelope.toAgent);
  if (!target) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `unknown a2a target agent: ${envelope.toAgent}` }));
    return;
  }

  // 安全红线：本端点只执行本地 agent（transport=local）。远端 a2a 目标不应被当作本地执行，
  // 否则会与 run-queue 的跨主机派发语义混淆——跨主机由发起方经 HttpA2ATransport 走。
  if (target.transport !== 'local') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `agent "${target.id}" transport=${target.transport} 不是本地 agent，无法被本端点直接执行` }));
    return;
  }

  try {
    const output = await runAgentTask(target, envelope.input, {
      tenantId: envelope.tenantId,
      onEvent: undefined,
    });
    const result: TaskResult = { taskId: envelope.taskId, status: 'success', output };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result }));
  } catch (e: any) {
    const result: TaskResult = { taskId: envelope.taskId, status: 'failed', error: e?.message ?? String(e) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result }));
  }
}

/**
 * P1-⑤ 工作流编排入口：定义并运行一个 DAG 工作流，SSE 直播每 step 进度与最终快照。
 * body: { def: WorkflowDef, input?: unknown }。def 含 steps（agentRef / dependsOn / compensate）。
 * 每个 step 经 createWorkflowExecutor 复用 /api/run 同一套 assembleAgent + harness 装配。
 */
async function handleWorkflow(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const body = await readBody(req);
  const ctx = await guard(req, res, 'workflow:run', body);
  if (!ctx) return;
  // 优雅停机期间不再接受新运行。
  if (shuttingDown) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'server is shutting down' }));
    return;
  }

  const def = body.def as WorkflowDef | undefined;
  if (!def || typeof def.id !== 'string' || !Array.isArray(def.steps) || def.steps.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid workflow def: 需要 { id: string, steps: StepDef[] }' }));
    return;
  }

  // SSE 发送器延迟绑定：先声明 no-op，校验通过后再挂真实 SSE；校验失败时根本不开 SSE。
  let send: (payload: unknown) => void = () => {};
  const onHarnessEvent = (e: any) => {
    if (!closed) send({ type: 'harness', event: e });
  };
  const onWfEvent = (e: WorkflowEvent) => {
    if (!closed) send(e);
  };
  const executor = createWorkflowExecutor({ onEvent: onHarnessEvent });
  const engine = new DagEngine({ store: workflowStore(), executor, onEvent: onWfEvent });

  // 拓扑合法性 fail-fast：环 / 未知依赖 / 重复 stepId 立即 400，不进入异步执行才失败。
  try {
    engine.validateWorkflow(def);
  } catch (e: any) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `invalid workflow topology: ${e?.message ?? String(e)}` }));
    return;
  }

  send = startSse(res, req);

  auditAction('workflow.run', { workflowId: def.id, stepCount: def.steps.length, role: ctx.role, sub: ctx.sub });

  // 后台运行；SSE 已随 step 进度推送。完成后推送 _wf_done 并关闭。
  engine
    .run(def, body.input)
    .then((run) => {
      if (!closed) send({ type: '_wf_done', run });
      if (!closed) res.end();
    })
    .catch((e: any) => {
      if (!closed) send({ type: 'wf:error', message: e?.message ?? String(e) });
      if (!closed) res.end();
    });
  return;
}

async function handleVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const body = await readBody(req);
  const ctx = await guard(req, res, 'verify', body);
  if (!ctx) return;
  const send = startSse(res, req);
  try {
    auditAction('verify', { role: ctx.role, sub: ctx.sub });
    await runVerification((e: VerifyEvent) => {
      if (!closed) send(e);
    });
    if (!closed) send({ type: '_verify_done' });
  } catch (e: any) {
    if (!closed) send({ type: 'verify:error', id: '0', message: e?.message ?? String(e) });
    if (!closed) send({ type: '_verify_done' });
  } finally {
    if (!closed) res.end();
  }
}

// 合法的传输类型（与 core 的 McpTransportType 保持一致）。
const MCP_TRANSPORT_TYPES = new Set(['auto', 'sse', 'streamable-http']);

async function handleMcpAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const ctx = await guard(req, res, 'mcp:add', body);
  if (!ctx) return;
  const name = String(body.name ?? '').trim();
  // 兼容旧字段 `url`，同时接受标准字段 `serverUrl`。
  const serverUrl = String(body.url ?? body.serverUrl ?? '').trim();
  const command = body.command != null ? String(body.command) : undefined;
  const args = Array.isArray(body.args) ? body.args.map(String) : undefined;
  const env = body.env && typeof body.env === 'object' ? (body.env as Record<string, string>) : undefined;
  const headers = body.headers && typeof body.headers === 'object' ? (body.headers as Record<string, string>) : undefined;
  // 仅接受合法的传输类型，其余忽略（回退 core 的 'auto' 自动判定）。
  let transportType: McpTransportType | undefined;
  if (typeof body.transportType === 'string' && MCP_TRANSPORT_TYPES.has(body.transportType)) {
    transportType = body.transportType as McpTransportType;
  }
  if (!name && !serverUrl && !command) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'name 与（serverUrl/url 或 command）至少需提供其一' }));
    return;
  }
  auditAction('mcp.add', { name, url: redactUrl(serverUrl), command: command ?? null, role: ctx.role, sub: ctx.sub });
  try {
    const meta = await mcpManager.addServer({ name, serverUrl, command, args, env, headers, transportType });
    sendJson(res, { server: meta, servers: mcpManager.list() }, req);
  } catch (e: any) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message ?? String(e) }));
  }
}

/** 一键接入预设 MCP 服务（Context7 / GitHub / Composio 等）。 */
async function handleMcpPreset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const ctx = await guard(req, res, 'mcp:preset', body);
  if (!ctx) return;
  const id = String(body.id ?? '').trim();
  const token = body.token != null ? String(body.token) : undefined;
  if (!id) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '缺少预设 id（如 context7 / github / composio）' }));
    return;
  }
  auditAction('mcp.preset', { id, role: ctx.role, sub: ctx.sub });
  try {
    const meta = await mcpManager.connectPreset(id, token);
    sendJson(res, { server: meta, servers: mcpManager.list() }, req);
  } catch (e: any) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message ?? String(e) }));
  }
}

/**
 * 审批一次待执行的 shell 命令（配合 SHELL_REQUIRE_CONFIRM=true）。
 * body: { command, args, preapprove? }。preapprove=true 时仅登记永久批准、不等待。
 * 返回被放行的等待项数量（waitingReleased）或预批准结果（preapproved）。
 */
async function handleShellApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const ctx = await guard(req, res, 'shell:approve', body);
  if (!ctx) return;
  const command = String(body.command ?? '');
  const args = Array.isArray(body.args) ? body.args.map(String) : [];
  if (!command) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '缺少 command' }));
    return;
  }
  auditAction('shell.approve', { command, preapprove: body.preapprove === true, role: ctx.role, sub: ctx.sub });
  if (body.preapprove === true) {
    preapproveShell(shellSignature(command, args));
    return sendJson(res, { preapproved: true }, req);
  }
  const released = approveShell(command, args);
  sendJson(res, { waitingReleased: released }, req);
}

async function handleEnv(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const body = await readBody(req);
  // 按动作类型映射为细分动作，做角色授权 + 审批判定（create/destroy 需审批）。
  const envAction: Action = body.action === 'destroy' ? 'env:destroy' : 'env:create';
  const ctx = await guard(req, res, envAction, body);
  if (!ctx) return;
  const send = startSse(res, req);
  const action = body.action;

  if (action === 'create') {
    const input = {
      envType: String(body.env_type ?? 'ephemeral'),
      branch: String(body.branch ?? 'main'),
      ttlHours: body.ttl_hours != null ? Number(body.ttl_hours) : undefined,
      region: body.region ? String(body.region) : undefined,
      owner: body.owner ? String(body.owner) : undefined,
    };
    auditAction('env.create', { envType: input.envType, branch: input.branch, region: input.region ?? null, owner: input.owner ?? null, role: ctx.role, sub: ctx.sub });
    try {
      await envPipeline.create(input, (env) => {
        if (!closed) send({ type: 'env:status', env });
      });
      if (!closed) send({ type: '_env_done' });
    } catch (e: any) {
      if (!closed) send({ type: 'env:error', message: e?.message ?? String(e) });
      if (!closed) send({ type: '_env_done', error: true });
    } finally {
      if (!closed) res.end();
    }
    return;
  }

  if (action === 'destroy') {
    const envId = String(body.env_id ?? '');
    auditAction('env.destroy', { envId, role: ctx.role, sub: ctx.sub });
    try {
      const env = await envPipeline.destroy(envId, (e) => {
        if (!closed) send({ type: 'env:status', env: e });
      });
      if (!env && !closed) send({ type: 'env:error', message: `未找到环境 ${envId}` });
      if (!closed) send({ type: '_env_done', found: !!env });
    } catch (e: any) {
      if (!closed) send({ type: 'env:error', message: e?.message ?? String(e) });
      if (!closed) send({ type: '_env_done', error: true });
    } finally {
      if (!closed) res.end();
    }
    return;
  }

  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'action 必须是 create 或 destroy' }));
  return;
}

server.listen(PORT, HOST, () => {
  // P2.c：引导注册全部预置行业合规画像（医疗等保 / 金融数据出境 / 教育放宽），使新建对应行业
  // 租户即自带合规基线（applyIndustryProfile 透明叠加）。幂等，不影响已在运行的租户策略。
  policyEngine.registerIndustryProfiles();
  console.log(`\n🚀 Agent Harness UI 已启动： http://localhost:${PORT}`);
  console.log(`   模式：Mock（离线）/ Real LLM / Real + MCP`);
  if (REQUIRE_AUTH) {
    const prov =
      AUTH_PROVIDER === 'oidc'
        ? 'OIDC (Bearer JWT)'
        : AUTH_PROVIDER === 'proxy'
          ? 'SSO 网关头注入 (proxy)'
          : '静态令牌 (token)';
    console.log(`   🔒 RBAC 鉴权已启用（身份源：${prov}）：请求需 Authorization: Bearer <token>`);
    console.log(`   🔒 敏感动作（real 运行 / 环境创建销毁 / MCP 接入 / 记忆清空等）需审批：POST 返回 202 + ticketId`);
    if ((AUTH_PROVIDER === 'oidc' || AUTH_PROVIDER === 'proxy') && (process.env.UI_TOKENS || UI_AUTH_TOKEN)) {
      console.log(`   🔑 同时启用静态令牌 break-glass：IdP 不可用时可用 UI_AUTH_TOKEN 直接鉴权（运维逃生通道）`);
    }
  } else {
    console.warn(`   ⚠️  未设置 UI_TOKENS / UI_AUTH_TOKEN，UI 接口处于开放状态（仅建议本地 / 演示使用）。`);
  }
  if (UI_CORS_ORIGIN.length === 0) {
    console.log(`   🔒 CORS 仅同源（未配置 UI_CORS_ORIGIN）。跨域调用需显式设置白名单。`);
  } else {
    console.log(`   🔒 CORS 白名单：${UI_CORS_ORIGIN.join(', ')}`);
  }
  console.log(`   🔒 限流：${RATE_LIMIT > 0 ? `每 IP ${RATE_LIMIT} 次 / ${RATE_WINDOW_MS / 1000}s` : '关闭'}；请求体上限：${MAX_BODY_BYTES} 字节`);
  if (AUDIT_LOG) console.log(`   📝 审计日志落盘：${AUDIT_LOG}`);
  console.log(`   OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? '已配置' : '未配置（Mock 模式可用）'}`);
  console.log(`   HARNESS_API_KEY: ${process.env.HARNESS_API_KEY ? '已配置' : '未配置（环境流水线走 dry-run 演示）'}`);
  console.log(`   MCP_SERVER_URL: ${process.env.MCP_SERVER_URL ?? '未配置'}\n`);
});

// 进程级兜底：防止未捕获异常导致整进程裸崩（防御性，不替代正常的错误边界）。
// - uncaughtException：可能使事件循环处于非法状态，记录后安全退出，交由守护进程（k8s/Render）重启。
// - unhandledRejection：仅记录，不退出，避免单个被拒 Promise 拖垮在线服务。

/**
 * 告警接收器工厂。告警下沉是可插拔的：默认关闭，按环境变量装配。
 * - ALERT_WEBHOOK_URL：将告警 JSON POST 到该地址（如 Slack/飞书/钉钉 入站 Webhook、自研告警网关）。
 * - ALERT_LOG_PATH：将告警以 JSON 逐行追加到指定文件（便于被 Filebeat/Loki 采集）。
 * 多个 sink 会依次触发；单个 sink 失败仅告警日志，不影响其它 sink 与主流程。
 */
function createWebhookAlertSink(url: string) {
  return async (a: unknown) => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(a),
      });
    } catch (e: any) {
      structLog('warn', 'alert webhook failed', { error: e?.message ?? String(e) });
    }
  };
}
function createFileAlertSink(filePath: string) {
  return async (a: unknown) => {
    try {
      await appendFile(filePath, JSON.stringify(a) + '\n');
    } catch {
      /* 告警落盘失败不向上传播 */
    }
  };
}
function setupAlerting(): void {
  const url = process.env.ALERT_WEBHOOK_URL;
  const file = process.env.ALERT_LOG_PATH;
  const sinks: Array<(a: unknown) => void | Promise<void>> = [];
  if (url) {
    sinks.push(createWebhookAlertSink(url));
    structLog('info', 'alerting enabled', { sink: 'webhook', url });
  }
  if (file) {
    sinks.push(createFileAlertSink(file));
    structLog('info', 'alerting enabled', { sink: 'file', path: file });
  }
  if (sinks.length) {
    setAlertSink(async (a) => {
      for (const s of sinks) await s(a);
    });
  }
}

function installCrashGuard(): void {
  const fatal = (where: string, err: unknown) => {
    const e = err as { message?: string; stack?: string };
    logError('crash.guard', err, { where });
    emitAlert('fatal', 'crash.guard', `${where}: ${e?.message ?? String(err)}`, { where, stack: e?.stack });
    console.error(`[fatal] ${where}:`, e?.message ?? err, '\n', e?.stack ?? '');
  };
  process.on('uncaughtException', (err) => {
    fatal('uncaughtException', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    fatal('unhandledRejection', reason);
  });
}
installCrashGuard();

// 停机宽限：先中止在飞任务，给其最多该时长退出，再关 MCP 与监听。
const SHUTDOWN_GRACE_MS = Number(process.env.RUN_SHUTDOWN_GRACE_MS ?? 5000) || 5000;
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[ui] 收到停机信号，开始优雅停机…');
  // 1) 中止所有在飞/排队任务（job 级 AbortController），释放 worker 与 LLM/MCP 占用。
  runQueue.abortAll('shutdown');
  // 1b) 停止领取轮询并关闭共享后端（redis）连接，避免进程退出后空转。
  runQueue.stop();
  // 2) 宽限期内让在飞任务尽快退出；超时后不再等待。
  await new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
  // 3) 关闭 MCP 连接（stdio 子进程 / SSE 长连接），避免资源泄漏。
  await mcpManager.shutdown().catch(() => {});
  // 4) 停止接受新连接，等待已建立的连接（如健康检查）关闭。
  server.close(() => {
    console.log('[ui] 已停止接受新连接。');
    process.exit(0);
  });
  // 兜底：若 server.close 因长连接迟迟不结束，强制退出。
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

export {};
