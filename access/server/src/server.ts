import { createServer } from 'node:http';
import { accessSync } from 'node:fs';
import { readFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  assembleAgent,
  defaultPromptFor,
  getMemoryStore,
  invalidateSessionMemory,
  type RunMode
} from './runner';
import { runVerification, type VerifyEvent } from './verification';
import { mcpManager } from './mcp-manager';
import { runQueue } from './run-queue';
import { envPipeline } from './env-pipeline';
import {
  approve as approveShell,
  preapprove as preapproveShell,
  shellSignature
} from './shell-approval';
import type { McpTransportType } from '@agent-harness/core';
import {
  getMetricsSnapshot,
  Memory,
  sanitizeKey,
  structLog,
  setAlertSink,
  emitAlert,
  logError,
  resolveOpenRouterConfig,
  getAgentRegistry,
  initAgentRegistry,
  createAgentStoreFromEnv,
  isTenantRequired,
  resolveIntentMode,
  policyEngine,
  getTokenCacheStats,
  getTokenCacheHistory,
  startTokenCacheAggregation,
  setTokenCacheAlertSink,
  type VerifyConfig,
  type AgentCard,
  type AgentHealth,
  type AgentStore,
  type AgentStoreRedis,
  DagEngine,
  type WorkflowDef,
  type WorkflowEvent,
  HttpA2ATransport,
  type TaskEnvelope,
  type TaskResult,
  type A2ARequest,
  features,
  buildPlannerPrompt,
  parsePlanOutput,
  contextWindowFor
} from '@agent-harness/core';
// 错误明细存储（展示「错误数量 + 具体错误信息」）。
import {
  getErrorLog,
  getErrorSummary,
  formatErrorReport,
  type ErrorRecord
} from '@agent-harness/core';
import { createWorkflowExecutor, workflowStore } from './workflow-executor';
import { runAgentTask } from './agent-run';
// 插件系统（Phase 1）：通用扩展点，无业务词。server 不静态依赖任何具体插件包。
import { ServerPluginHost, WebPluginHost } from './plugin-ext';
import {
  createPluginSystem,
  bootstrapPlugins,
  resolveUpgradeManifest,
  type PluginSystem
} from './plugin-bootstrap';
// 多会话 Chat App 的会话存储（左侧栏列表 + 消息记录持久化）。
import {
  listChatSessions,
  getChatSession,
  createChatSession,
  renameChatSession,
  deleteChatSession,
  appendChatMessage,
  type StoredTool,
  type TraceNode
} from './chat-sessions';
// 聊天历史镜像存储（ah_chat_history 接口层）：SQLite 临时持久化，预留正式数据库扩展点。
import { getHistoryStore } from './history-store';
// 业务策略层（与核心 framework 隔离）：RBAC 鉴权 + 审批工作流，均为可插拔接口。
import {
  createAuthorizer,
  type Authorizer,
  type AuthContext,
  type Action
} from './authz';
// 外部身份源（OIDC Bearer JWT 资源服务器 / proxy 头注入）。提供 JWKS 预热与前端鉴权元信息。
import { warmJwks, getAuthConfig } from './sso';
import { createApprovalPolicy, type ApprovalPolicy } from './approval';
import {
  createEvaluator,
  getRecipeStore,
  runRecordFromEvents,
  type Evaluator,
  type RecipeStore
} from './eval';
import { createRetentionPolicy, type RetentionPolicy } from './retention';
import { buildOpenApiSpec } from './openapi';
// 文件上传（图片/文本附件）。
import { handleUpload, serveUploaded, type UploadMeta } from './upload';
// K8s健康检查端点
import { handleLiveness, handleReadiness } from './health';
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
// 统一认证凭证：OPENROUTER_API_KEY 同时作为 LLM key 与权限校验依据。
// 未接入 RBAC 时它是权限判断的唯一凭证；接入 RBAC 时作为 admin 逃生通道。
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
// 身份源：token（默认静态令牌）/ oidc（Bearer JWT）/ proxy（SSO 网关头注入）。
const AUTH_PROVIDER = (process.env.AUTH_PROVIDER || 'token').toLowerCase();
// 非 token 模式即视为需要鉴权；token 模式在有静态令牌或 OPENROUTER_API_KEY 时开启（向后兼容）。
const REQUIRE_AUTH =
  AUTH_PROVIDER !== 'token' ||
  !!(process.env.UI_TOKENS || UI_AUTH_TOKEN || OPENROUTER_API_KEY);

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
const recipeStore: RecipeStore = getRecipeStore();
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
  if (UI_CORS_ORIGIN.includes('*'))
    return { 'access-control-allow-origin': '*' };
  if (UI_CORS_ORIGIN.includes(origin))
    return { 'access-control-allow-origin': origin };
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
async function guard(
  req: IncomingMessage,
  res: ServerResponse,
  action: Action,
  body?: any
): Promise<AuthContext | null> {
  const ip = clientIp(req);
  const ctx = authorizer.authenticate(req);
  if (!ctx) {
    audit({
      kind: 'request',
      method: req.method,
      path: req.url,
      ip,
      authed: false,
      status: 401
    });
    unauthorized(res);
    return null;
  }
  if (rateLimited(ip)) {
    audit({
      kind: 'request',
      method: req.method,
      path: req.url,
      ip,
      authed: true,
      status: 429
    });
    res.writeHead(429, {
      'content-type': 'application/json',
      ...corsHeaders(req)
    });
    res.end(JSON.stringify({ error: 'rate limit exceeded' }));
    return null;
  }
  if (!authorizer.can(ctx, action)) {
    audit({
      kind: 'request',
      method: req.method,
      path: req.url,
      ip,
      authed: true,
      status: 403,
      action
    });
    res.writeHead(403, {
      'content-type': 'application/json',
      ...corsHeaders(req)
    });
    res.end(JSON.stringify({ error: 'forbidden', action }));
    return null;
  }
  audit({
    kind: 'request',
    method: req.method,
    path: req.url,
    ip,
    authed: true,
    action
  });

  // 审批闸门：敏感动作需先获批。已携带有效票据（动作一致且已批准）则放行。
  if (approvalPolicy.requiresApproval(action, ctx)) {
    const ticketId: string | null =
      (body &&
        typeof body.approvalTicket === 'string' &&
        body.approvalTicket) ||
      new URL(
        req.url ?? '/',
        `http://${req.headers.host ?? 'localhost'}`
      ).searchParams.get('approvalTicket');
    if (ticketId) {
      const t = approvalPolicy.consume(ticketId, action, ctx);
      if (t) return ctx; // 已批准，放行执行
    }
    const ticket = approvalPolicy.create(
      action,
      ctx,
      `${action} · by ${ctx.sub}/${ctx.role}`
    );
    res.writeHead(202, {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(req)
    });
    res.end(
      JSON.stringify({
        ticketId: ticket.id,
        status: 'pending',
        message: '需要审批',
        poll: `/api/approvals/${ticket.id}`
      })
    );
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
    case '/api/env':
      return 'env:read';
    case '/api/chat/sessions':
      return 'chat:read';
    default:
      // 聊天会话详情（含消息 / 推理 / 工具调用）同样属只读敏感数据，需 chat:read。
      if (path.startsWith('/api/chat/sessions/')) return 'chat:read';
      // 聊天历史镜像（ah_chat_history 迁移的接口层）：读取需 chat:read。
      if (path === '/api/history' || path.startsWith('/api/history/')) return 'chat:read';
      return null;
  }
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized: missing or invalid token' }));
}

// 启动时从环境变量加载并接入已配置的 MCP 服务（后台进行，不阻塞监听）。
mcpManager.init();

// 前端统一由 frontend/webapp/dist 托管（见 webappDir）；项目不再包含 public 兜底目录。

// 插件系统：loader + 双宿主（Server/Web）。在 bootstrap()（initAgentRegistry 之后）构造并赋值，
// 以复用已注入持久后端的共享 AgentRegistry；此处仅声明（definite assignment，listen 前必赋值）。
let pluginSystem!: PluginSystem;

const server = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`
    );
    let path = url.pathname;
    // 版本化 API：/api/v1/* 是稳定契约前缀，内部重写为等价非前缀路径 /api/*（向后兼容别名）。
    if (path.startsWith('/api/v1')) path = path.replace('/api/v1', '/api');

    try {
      // CORS 预检：仅当配置了跨域白名单时才需处理。
      if (req.method === 'OPTIONS') {
        const h: Record<string, string> = {
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization',
          ...corsHeaders(req)
        };
        res.writeHead(204, h);
        res.end();
        return;
      }

      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        // 优先托管 Web SPA 构建产物（frontend/webapp/dist）；webapp 未构建则返回 500。
        const wd = webappDir();
        if (wd) {
          try {
            let html = await readFile(join(wd, 'index.html'), 'utf8');
            // 降级模式下把统一认证凭证注入页面，供 SPA 自动带 Authorization 头，
            // 否则浏览器拿不到 token 会被 401 拦截。仅在配置了 OPENROUTER_API_KEY 时注入。
            if (OPENROUTER_API_KEY) {
              const escaped = OPENROUTER_API_KEY.replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
              if (html.includes('<head>')) {
                html = html.replace(
                  '<head>',
                  `<head>\n    <meta name="ah-api-key" content="${escaped}" />`
                );
              } else {
                html = `<meta name="ah-api-key" content="${escaped}" />\n${html}`;
              }
            }
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-cache'
            });
            res.end(html);
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
          const rel = decodeURIComponent(
            path.slice('/assets/'.length).split('?')[0]
          );
          const assetRoot = join(wd, 'assets');
          const fp = resolve(assetRoot, rel);
          if (fp.startsWith(assetRoot)) {
            try {
              const buf = await readFile(fp);
              res.writeHead(200, {
                'content-type': contentTypeFor(fp),
                'cache-control': 'no-cache'
              });
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
      if (
        req.method === 'GET' &&
        !path.slice(1).includes('/') &&
        !path.startsWith('/api')
      ) {
        const wd = webappDir();
        if (wd) {
          const rel = decodeURIComponent(path.slice(1).split('?')[0]);
          const fp = resolve(wd, rel);
          if (fp === join(wd, rel)) {
            try {
              const buf = await readFile(fp);
              res.writeHead(200, {
                'content-type': contentTypeFor(fp),
                'cache-control': 'no-cache'
              });
              res.end(buf);
              return;
            } catch {
              /* 文件不存在，继续走后续路由 */
            }
          }
        }
      }
      // K8s Liveness 探针 - 进程存活检查
      if (req.method === 'GET' && path === '/health/live') {
        return handleLiveness(req, res);
      }
      // K8s Readiness 探针 - 依赖检查
      if (req.method === 'GET' && path === '/health/ready') {
        return handleReadiness(req, res);
      }
      if (req.method === 'GET' && path === '/api/state') {
        // 健康检查端点保持开放（Render 等 PaaS 无法在健康检查中带令牌）。
        return sendJson(res, buildState());
      }
      if (req.method === 'GET' && path === '/api/sandbox') {
        // 沙箱能力快照（OS 级隔离就绪状态 + 实际生效原语），供前端「可观测」面板展示。
        // 不依赖任何可选依赖；若未加载 OSSandboxExecutor 模块则返回「未启用」占位。
        let sandboxStatus: unknown;
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { createOSSandboxExecutor } = require('@agent-harness/core');
          const exec = createOSSandboxExecutor();
          sandboxStatus = (exec as { describe?(): unknown }).describe?.() ?? null;
        } catch {
          sandboxStatus = null;
        }
        return sendJson(res, { sandbox: sandboxStatus }, req);
      }
      // 错误明细展示页（服务端渲染，深色主题）。受 errors:read 保护。
      if (req.method === 'GET' && path === '/errors') {
        const ctx = await guard(req, res, 'errors:read');
        if (!ctx) return;
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache'
        });
        res.end(renderErrorsHtml());
        return;
      }
      // 错误明细 JSON 接口：count（错误数量）+ summary（分布）+ errors（具体明细列表）。
      // 支持 ?limit=N（默认 200，取最近 N 条）、?full=1（不限条数）、?format=text（文本报告）。
      if (req.method === 'GET' && path === '/api/errors') {
        const ctx = await guard(req, res, 'errors:read');
        if (!ctx) return;
        const limitRaw = Number(url.searchParams.get('limit'));
        const limit =
          Number.isFinite(limitRaw) && limitRaw > 0
            ? Math.floor(limitRaw)
            : 200;
        const full = url.searchParams.get('full') === '1';
        const fmt = url.searchParams.get('format');
        if (fmt === 'text') {
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            ...corsHeaders(req)
          });
          res.end(formatErrorReport({ limit: full ? undefined : limit }));
          return;
        }
        const list = getErrorLog({ limit: full ? undefined : limit });
        return sendJson(
          res,
          { count: list.length, summary: getErrorSummary(), errors: list },
          req
        );
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
      if (req.method === 'GET' && path === '/api/features') {
        // 特性开关状态（运行时查询/审计），受 policy:read 保护。
        const ctx = await guard(req, res, 'policy:read');
        if (!ctx) return;
        return sendJson(res, { flags: features.getAll(), stats: features.getStats() }, req);
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
        // 可观测性指标（token 用量 / 延迟 / 错误率 / 工具调用数 / 成本 / 队列 / token 缓存命中率）。受保护，需令牌。
        const store = getMemoryStore();
        return sendJson(
          res,
          {
            ...getMetricsSnapshot(),
            queue: runQueue.stats(),
            memory: { backend: store.kind },
            tokenCache: getTokenCacheStats(),
            tokenCacheHistory: getTokenCacheHistory(),
            // 错误数量与最近明细（与 /api/errors 同源，便于一处查看）。
            errors: getErrorSummary(),
            recentErrors: getErrorLog({ limit: 20 })
          },
          req
        );
      }
      if (req.method === 'GET' && path === '/api/jobs') {
        // 运行队列的脱敏状态快照（运维视角）：当前排队/执行数、最近若干 job 概要。
        return sendJson(
          res,
          { queue: runQueue.stats(), jobs: runQueue.list() },
          req
        );
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
        const agents = await getAgentRegistry().query({
          ...(domain ? { domain } : {}),
          ...(capability ? { capability } : {})
        });
        return sendJson(res, { agents, count: agents.length }, req);
      }
      if (req.method === 'GET' && path.startsWith('/api/agents/')) {
        // 取单个 agent 卡片（含健康度）。受 agent:read 保护。
        const ctx = await guard(req, res, 'agent:read');
        if (!ctx) return;
        const id = decodeURIComponent(
          path.slice('/api/agents/'.length).replace(/\/$/, '')
        );
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
        const id = decodeURIComponent(
          path.slice('/api/workflows/'.length).replace(/\/$/, '')
        );
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
        const sessionKey = sanitizeKey(
          url.searchParams.get('session') || 'anonymous'
        );
        if (req.method === 'DELETE') {
          const body = await readBody(req);
          const ctx = await guard(req, res, 'memory:clear', body);
          if (!ctx) return;
          const store = getMemoryStore();
          const memory = new Memory({ store, sessionKey });
          await memory.clear();
          // 同步失效进程内会话记忆缓存，避免下次 run 仍复用已被清空的旧窗口。
          invalidateSessionMemory(sessionKey);
          auditAction('memory.clear', {
            sessionKey,
            role: ctx.role,
            sub: ctx.sub
          });
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
            windowLen: memory.history().length
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
          return sendJson(
            res,
            {
              tickets: approvalPolicy.list(
                status ? { status: status as any } : undefined
              )
            },
            req
          );
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
          if (!t)
            return sendJson(
              res,
              { error: 'ticket not found or already decided' },
              req
            );
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
        auditAction('eval.run', {
          jobId,
          score: result.score,
          passed: result.passed,
          role: ctx.role,
          sub: ctx.sub
        });
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
            notes: body.notes ? String(body.notes) : undefined
          };
          recipeStore.save(recipe);
          auditAction('recipe.save', {
            id,
            name: recipe.name,
            role: ctx.role,
            sub: ctx.sub
          });
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

      /* ----------------- 多会话 Chat App：会话存储 CRUD ----------------- */
      // 注意：与已存在的 /api/sessions（agent 运行期会话）区分，聊天会话走独立前缀。
      // 客户端以版本化 URL /api/v1/chat/sessions 调用，服务端在路由前已统一重写
      // /api/v1 -> /api，故此处按重写后的 /api/chat/sessions 匹配。
      if (req.method === 'GET' && path === '/api/chat/sessions') {
        return sendJson(res, { sessions: listChatSessions() }, req);
      }
      if (req.method === 'POST' && path === '/api/chat/sessions') {
        const b = await readBody(req);
        const ctx = await guard(req, res, 'chat:write', b);
        if (!ctx) return;
        return sendJson(res, createChatSession(b.title), req);
      }
      if (req.method === 'GET' && path.startsWith('/api/chat/sessions/')) {
        const id = decodeURIComponent(path.slice('/api/chat/sessions/'.length));
        const s = getChatSession(id);
        if (!s) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'session not found' }));
        }
        return sendJson(res, s, req);
      }
      if (req.method === 'PATCH' && path.startsWith('/api/chat/sessions/')) {
        const id = decodeURIComponent(path.slice('/api/chat/sessions/'.length));
        const b = await readBody(req);
        const ctx = await guard(req, res, 'chat:write', b);
        if (!ctx) return;
        const s = renameChatSession(id, b.title);
        if (!s) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'session not found' }));
        }
        return sendJson(res, s, req);
      }
      if (req.method === 'DELETE' && path.startsWith('/api/chat/sessions/')) {
        const id = decodeURIComponent(path.slice('/api/chat/sessions/'.length));
        const ctx = await guard(req, res, 'chat:delete');
        if (!ctx) return;
        const ok = deleteChatSession(id);
        return sendJson(res, { ok }, req);
      }

      /* ------------- 聊天历史镜像 CRUD（ah_chat_history 接口层） ------------- */
      // 前端不再直写 localStorage：历史容错镜像统一经本组端点落到 ChatHistoryStore
      // （默认 SQLite 临时持久化，HISTORY_BACKEND/HISTORY_DB_FILE 可调，预留正式数据库扩展）。
      // 注意按重写后的 /api/history 匹配（/api/v1 -> /api 已在路由前统一重写）。
      {
        const HISTORY_PREFIX = '/api/history/';
        // 单会话镜像的序列化体积上限：超过即拒绝（防止单行撑爆 SQLite / 内存）。
        const HISTORY_MAX_BYTES = 512 * 1024;
        const validSid = (sid: string): boolean =>
          !!sid && sid.length <= 128 && /^[A-Za-z0-9_\-]+$/.test(sid);

        if (req.method === 'GET' && path === '/api/history') {
          return sendJson(res, { sessions: getHistoryStore().index() }, req);
        }
        if (req.method === 'GET' && path.startsWith(HISTORY_PREFIX)) {
          const sid = decodeURIComponent(path.slice(HISTORY_PREFIX.length));
          if (!validSid(sid)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'invalid session id' }));
          }
          const row = getHistoryStore().get(sid);
          if (!row) {
            res.writeHead(404, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'history not found' }));
          }
          try {
            const msgs = JSON.parse(row.data);
            return sendJson(
              res,
              { ...row.meta, v: 1, msgs: Array.isArray(msgs) ? msgs : [] },
              req
            );
          } catch {
            // 存储层数据损坏：明确返回 522 类错误而非抛出未捕获异常。
            res.writeHead(500, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'history data corrupted' }));
          }
        }
        if (req.method === 'PUT' && path.startsWith(HISTORY_PREFIX)) {
          const sid = decodeURIComponent(path.slice(HISTORY_PREFIX.length));
          if (!validSid(sid)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'invalid session id' }));
          }
          const b = await readBody(req);
          const ctx = await guard(req, res, 'chat:write', b);
          if (!ctx) return;
          // 参数校验：msgs 必须为数组；title 收敛为字符串；整体序列化体积受限。
          if (!Array.isArray(b.msgs)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'msgs must be an array' }));
          }
          let data: string;
          try {
            data = JSON.stringify(b.msgs);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'msgs not serializable' }));
          }
          if (Buffer.byteLength(data, 'utf-8') > HISTORY_MAX_BYTES) {
            res.writeHead(413, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'history too large' }));
          }
          const now = Date.now();
          getHistoryStore().upsert(
            {
              sid,
              title: typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 200) : '新对话',
              updatedAt:
                typeof b.updatedAt === 'number' && Number.isFinite(b.updatedAt)
                  ? Math.floor(b.updatedAt)
                  : now,
              savedAt: now
            },
            data
          );
          return sendJson(res, { ok: true }, req);
        }
        if (req.method === 'DELETE' && path.startsWith(HISTORY_PREFIX)) {
          const sid = decodeURIComponent(path.slice(HISTORY_PREFIX.length));
          if (!validSid(sid)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'invalid session id' }));
          }
          const ctx = await guard(req, res, 'chat:delete');
          if (!ctx) return;
          const ok = getHistoryStore().remove(sid);
          return sendJson(res, { ok }, req);
        }
      }

      if (req.method === 'POST' && path === '/api/workflows') {
        return await handleWorkflow(req, res);
      }
      if (req.method === 'POST' && path === '/api/a2a/tasks') {
        return await handleA2A(req, res);
      }
      // P0.1 写端点：运行期注册/注销/心跳 agent（避免必须在启动期代码里硬编码新行业 agent）。
      if (req.method === 'POST' && path === '/api/agents') {
        return await handleAgentRegister(req, res);
      }
      if (
        req.method === 'POST' &&
        path.startsWith('/api/agents/') &&
        path.endsWith('/heartbeat')
      ) {
        return await handleAgentHeartbeat(req, res, path);
      }
      if (req.method === 'DELETE' && path.startsWith('/api/agents/')) {
        return await handleAgentDeregister(req, res, path);
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
      // ---- 插件宿主：通用扩展点（无业务词）----
      // 元数据端点：列出已安装插件与已注册前端视图（供 webapp 动态渲染 Tab / 热插拔控制台）。
      if (req.method === 'GET' && path === '/api/plugins') {
        return sendJson(
          res,
          {
            plugins: pluginSystem.loader.list().map((r) => ({
              id: r.manifest.id,
              name: r.manifest.name ?? r.manifest.id,
              version: r.manifest.version,
              state: r.state,
              dependencies: r.manifest.dependencies ?? []
            })),
            views: pluginSystem.webHost.listViews()
          },
          req
        );
      }
      // 插件热插拔（Phase 4）：enable / disable / upgrade，受 plugin:manage 动作保护，
      // 操作仅在进程内存注册表上增删，不触碰 /api/state 健康检查，也不重启进程。
      {
        const m = path.match(
          /^\/api\/plugins\/([^/]+)\/(enable|disable|upgrade)$/
        );
        if (m && req.method === 'POST') {
          const id = decodeURIComponent(m[1]);
          const action = m[2];
          const ctx = await guard(req, res, 'plugin:manage');
          if (!ctx) return;
          try {
            if (action === 'upgrade') {
              const body = await readBody(req);
              const manifest = await resolveUpgradeManifest(id, body ?? {});
              const rec = await pluginSystem.loader.upgrade(id, manifest);
              return sendJson(
                res,
                {
                  id,
                  state: rec.state,
                  version: rec.manifest.version,
                  upgradedAt: rec.upgradedAt ?? null
                },
                req
              );
            }
            const rec =
              action === 'enable'
                ? await pluginSystem.loader.enable(id)
                : await pluginSystem.loader.disable(id);
            return sendJson(res, { id, state: rec.state }, req);
          } catch (e: any) {
            return sendJson(res, { error: e?.message ?? String(e) }, req);
          }
        }
        // 兼容计划约定：DELETE /api/plugins/:id/enable 视作停用（不重启进程）。
        const dm = path.match(/^\/api\/plugins\/([^/]+)\/enable$/);
        if (dm && req.method === 'DELETE') {
          const id = decodeURIComponent(dm[1]);
          const ctx = await guard(req, res, 'plugin:manage');
          if (!ctx) return;
          try {
            const rec = await pluginSystem.loader.disable(id);
            return sendJson(res, { id, state: rec.state }, req);
          } catch (e: any) {
            return sendJson(res, { error: e?.message ?? String(e) }, req);
          }
        }
      }
      // 上传附件：POST /api/upload（multipart/form-data，图片/文本）。
      if (path === '/api/upload' && req.method === 'POST') {
        const ctx = await guard(req, res, 'upload:file');
        if (!ctx) return;
        try {
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const c of req) {
            total += (c as Buffer).length;
            if (total > 20 * 1024 * 1024) {
              const err: any = new Error('request body too large (20 MB limit)');
              err.status = 413;
              throw err;
            }
            chunks.push(c as Buffer);
          }
          const result = await handleUpload(Buffer.concat(chunks), String(req.headers['content-type'] ?? ''));
          if (!result.ok) {
            return sendJson(res, { error: result.error }, req);
          }
          return sendJson(res, { ok: true, meta: result.meta }, req);
        } catch (e: any) {
          const code = typeof e?.status === 'number' ? e.status : 400;
          return sendJson(res, { error: e?.message ?? String(e) }, req);
        }
      }

      // 获取已上传文件：GET /api/uploads/:filename（静态展示用，含防穿越）。
      const um = path.match(/^\/api\/uploads\/(.+)$/);
      if (um && req.method === 'GET') {
        const filename = decodeURIComponent(um[1]);
        const result = await serveUploaded(filename);
        if (!result.ok) {
          return sendJson(res, { error: result.error }, req);
        }
        res.writeHead(200, {
          'content-type': result.mime,
          'cache-control': 'public, max-age=86400',
          ...corsHeaders(req)
        });
        res.end(result.buf);
        return;
      }

      // 插件挂载的 HTTP 路由（统一前缀 /api/plugins/:pluginId/*，由宿主收敛）。
      if (await pluginSystem.serverHost.handle(path, req, res)) return;

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
  }
);

function buildState() {
  let sandbox: unknown = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createOSSandboxExecutor } = require('@agent-harness/core');
    const exec = createOSSandboxExecutor();
    sandbox = (exec as { describe?(): unknown }).describe?.() ?? null;
  } catch {
    // 模块未加载 / 构造失败均不影响主状态
  }
  return {
    openrouter: !!process.env.OPENROUTER_API_KEY,
    harnessKey: !!process.env.HARNESS_API_KEY,
    harnessDryRun: !process.env.HARNESS_API_KEY,
    model: resolveOpenRouterConfig().model,
    // 上下文窗口上限随 state 下发：前端「上下文用量」粗估回退用它做分母，
    // 与 llm:usage 精确路径共用 contextWindowFor 单一事实源（如 ox-alpha → 1M）。
    contextWindow: contextWindowFor(resolveOpenRouterConfig().model),
    sandbox,
    mcpServers: mcpManager.list().map((s) => ({
      name: s.name,
      url: s.url ?? null,
      status: s.status,
      health: s.health ?? null,
      reconnectAttempts: s.reconnectAttempts ?? 0,
      toolCount: s.tools.length,
      tools: s.tools.map((t) => ({
        registeredName: t.registeredName,
        originalName: t.originalName
      })),
      error: s.error ?? null
    })),
    mcpPresets: mcpManager
      .presets()
      .map((p) => ({ id: p.id, name: p.name, authType: p.authType })),
    envs: envPipeline.list()
  };
}

function serveHtml(res: ServerResponse): void {
  // webapp 未构建时的兜底：直接返回 500 并提示先构建前端。
  res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(
    'Web 前端未构建，请先构建 webapp：pnpm --filter @agent-harness/webapp run build'
  );
}

/** HTML 转义，防 XSS（错误信息可能含用户 / 第三方内容）。 */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 服务端渲染「系统错误」展示页（深色主题，与运行时面板一致）：
 * 顶部数量横幅（错误总数 + 按名称分布），下方逐条明细表格
 * （序号 / 时间 / 级别 / 名称 / 类型 / 消息 / 堆栈+上下文）。
 * 数据与 /api/errors 同源，刷新即重新拉取最新状态。
 */
function renderErrorsHtml(): string {
  const summary = getErrorSummary();
  const list = getErrorLog({ limit: 500 });
  const pills = Object.entries(summary.byName)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="pill">${esc(k)} <b>${v}</b></span>`)
    .join('');
  const rows = list.length
    ? list
        .slice()
        .reverse()
        .map((e: ErrorRecord, idx: number) => {
          const stack = e.stack
            ? `<details class="stack"><summary>堆栈跟踪</summary><pre>${esc(e.stack)}</pre></details>`
            : '';
          const ctx =
            e.fields && Object.keys(e.fields).length
              ? `<div class="ctx">上下文：${esc(JSON.stringify(e.fields))}</div>`
              : '';
          return `<tr>
      <td class="num">${list.length - idx}</td>
      <td class="mono">${esc(e.ts)}</td>
      <td><span class="sev sev-${esc(e.severity)}">${esc(e.severity)}</span></td>
      <td class="name">${esc(e.name)}</td>
      <td class="type">${esc(e.type ?? '-')}</td>
      <td class="msg">${esc(e.message)}</td>
      <td class="extra">${stack}${ctx}</td>
    </tr>`;
        })
        .join('')
    : `<tr><td colspan="7" class="empty">暂无错误记录</td></tr>`;
  const span =
    summary.firstSeen != null && summary.lastSeen != null
      ? `<div class="span">时间跨度：${esc(new Date(summary.firstSeen).toISOString())} ~ ${esc(
          new Date(summary.lastSeen).toISOString()
        )}</div>`
      : '';
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>系统错误 · Agent Harness</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; background: #0B0E14; color: #C9D1D9;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #E6EDF3; font-weight: 600; }
  .sub { color: #8B949E; margin: 0 0 18px; }
  .banner {
    background: #121622; border: 1px solid #1F2633; border-radius: 10px;
    padding: 16px 18px; margin-bottom: 16px;
  }
  .count { font-size: 34px; font-weight: 700; color: #FF6B6B; line-height: 1; }
  .count.zero { color: #3FB950; }
  .label { color: #8B949E; margin-left: 8px; font-size: 13px; }
  .pills { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
  .pill { background: #0B0E14; border: 1px solid #1F2633; border-radius: 999px; padding: 4px 12px; font-size: 12px; color: #C9D1D9; }
  .pill b { color: #2997FF; margin-left: 4px; }
  .span { color: #8B949E; margin-top: 10px; font-size: 12px; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
  button, .btn {
    background: #1F2633; color: #C9D1D9; border: 1px solid #2A3340; border-radius: 6px;
    padding: 6px 14px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-block;
  }
  button:hover, .btn:hover { background: #2A3340; }
  table { width: 100%; border-collapse: collapse; background: #121622; border: 1px solid #1F2633; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #1A2030; vertical-align: top; }
  th { background: #0E1320; color: #8B949E; font-weight: 600; font-size: 12px; position: sticky; top: 0; }
  tr:last-child td { border-bottom: none; }
  td.num { color: #8B949E; width: 36px; }
  td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  td.name { font-family: ui-monospace, monospace; font-size: 12px; color: #79C0FF; white-space: nowrap; }
  td.type { font-family: ui-monospace, monospace; font-size: 12px; color: #D2A8FF; white-space: nowrap; }
  td.msg { color: #E6EDF3; }
  .sev { font-size: 11px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .sev-error { background: rgba(255,107,107,0.15); color: #FF8787; }
  .sev-fatal { background: rgba(255,71,87,0.2); color: #FF5252; }
  .stack { margin-top: 6px; }
  .stack summary { cursor: pointer; color: #8B949E; font-size: 12px; }
  .stack pre { margin: 6px 0 0; padding: 10px; background: #0B0E14; border: 1px solid #1A2030; border-radius: 6px; overflow-x: auto; font-size: 11px; color: #8B949E; }
  .ctx { margin-top: 6px; font-size: 11px; color: #6E7681; word-break: break-all; }
  .empty { text-align: center; color: #8B949E; padding: 32px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>系统错误明细</h1>
  <p class="sub">错误数量与每条错误的具体信息（类型 / 消息 / 时间 / 堆栈 / 上下文）同源展示。</p>
  <div class="banner">
    <div><span class="count ${summary.total === 0 ? 'zero' : ''}">${summary.total}</span><span class="label">条系统错误</span></div>
    ${span}
    <div class="pills">${pills || '<span class="pill">无</span>'}</div>
  </div>
  <div class="toolbar">
    <button onclick="location.reload()">刷新</button>
    <a class="btn" href="/api/errors?format=text" target="_blank">复制为文本报告</a>
    <a class="btn" href="/api/errors?full=1" target="_blank">原始 JSON（全量）</a>
  </div>
  <table>
    <thead><tr><th>#</th><th>时间</th><th>级别</th><th>名称</th><th>类型</th><th>消息</th><th>堆栈 / 上下文</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
</body>
</html>`;
}

/** Web SPA 构建产物目录（frontend/webapp/dist）；未构建则返回 null。 */
function webappDir(): string | null {
  const dir = resolve(__dirname, '..', '..', '..', 'frontend', 'webapp', 'dist');
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
    ttf: 'font/ttf'
  };
  return map[ext] ?? 'application/octet-stream';
}

function sendJson(
  res: ServerResponse,
  obj: unknown,
  req?: IncomingMessage
): void {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    ...corsHeaders(req ?? ({ headers: {} } as IncomingMessage))
  });
  res.end(JSON.stringify(obj));
}

function startSse(
  res: ServerResponse,
  req?: IncomingMessage
): (obj: unknown) => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // 禁用反向代理（nginx/网关）对 SSE 的缓冲，确保 token 级事件边产生边下发到浏览器。
    'x-accel-buffering': 'no',
    ...corsHeaders(req ?? ({ headers: {} } as IncomingMessage))
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

async function handleRun(
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
  const ctx = await guard(req, res, runAction, body);
  if (!ctx) return;
  // 优雅停机期间不再接受新运行，避免任务在进程退出时被强杀。
  if (shuttingDown) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'server is shutting down' }));
    return;
  }
  const send = startSse(res, req);
  // 兼容前端两种字段名（chat UI 发 prompt，部分旧客户端发 input），避免落到默认示例 prompt。
  const rawPrompt = body.prompt ?? body.input;
  const prompt: string =
    (rawPrompt && String(rawPrompt).trim()) || defaultPromptFor(mode);
  const model: string | undefined = body.model
    ? String(body.model).trim()
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

  // 交互模式（P0 计划模式）：白名单校验，非法值回退 qa（= 现状）。
  const interactionMode: 'qa' | 'plan' =
    body.interactionMode === 'plan' ? 'plan' : 'qa';
  const planPhase: 'propose' | 'execute' =
    body.planPhase === 'execute' ? 'execute' : 'propose';
  const isPlanPropose = interactionMode === 'plan' && planPhase === 'propose';
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
  const traceId = body.traceId ? String(body.traceId).trim() : undefined;

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
    const job = runQueue.submit({
      mode,
      prompt: effectivePrompt,
      model,
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
      planPhase
    });
    auditAction('agent.run', {
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
    auditAction('agent.run.reconnect', {
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
  const traceHandle = (ev: any): void => {
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
        traceLlm = traceNode(parent, 'llm', 'LLM 调用', 'ok', {
          meta: {
            messages: `消息 ${ev.messageCount ?? '?'}`,
            tools: `工具 ${ev.toolCount ?? '?'}`
          }
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
        if (!traceLlm || !ev.call) break;
        const name = String(ev.call.name ?? 'tool');
        const retrieval = RETRIEVAL_RE.test(name);
        traceLastTool = traceNode(
          traceLlm,
          retrieval ? 'retrieval' : 'tool',
          retrieval ? `检索 · ${name}` : name,
          'pending',
          {
            detail:
              typeof ev.call.arguments === 'string'
                ? ev.call.arguments
                : JSON.stringify(ev.call.arguments ?? {})
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
        const est = ev.estTokens;
        const estTotal = est
          ? est.system + est.tools + est.history + est.completion
          : 0;
        traceNode(parent, 'cost', '成本 / 用量', 'ok', {
          meta: {
            tokens: String(
              ev.cumulativeTokens ?? ev.usage?.total_tokens ?? '?'
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
                  工具: `${est.tools}${estTotal ? ` (${((est.tools / estTotal) * 100).toFixed(0)}%)` : ''}`,
                  历史: `${est.history}${estTotal ? ` (${((est.history / estTotal) * 100).toFixed(0)}%)` : ''}`,
                  输出: `${est.completion}`
                }
              : {})
          }
        });
        break;
      }
      case 'run:token-cache': {
        traceEnsureRoot();
        const parent = traceParent ?? traceRoot!;
        const tcHitPct = (Number(ev.hitRate) * 100).toFixed(1);
        const tcByModel = Object.entries<{
          queries: number;
          hits: number;
          hitRate: number;
        }>(ev.byModel ?? {})
          .map(
            ([m, st]) =>
              `${m}: ${(Number(st.hitRate) * 100).toFixed(0)}% (${st.hits}/${st.queries})`
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
          detail: `采集点：LLM 调用返回 usage.prompt_tokens_details.cached_tokens；计算逻辑：命中次数(${ev.hits}) ÷ 总查询次数(${ev.queries}) = ${tcHitPct}%。关联服务/接口：${ev.model ?? '?'} · ${ev.interface ?? 'prompt-cache'}。`
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
          result: (ev.reasons ?? []).join('\n')
        });
        break;
      }
      case 'guardrail:blocked': {
        traceEnsureRoot();
        traceNode(
          traceRoot!,
          'guardrail',
          `护栏拦截 · ${ev.phase ?? ''}`,
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
  unsub = runQueue.subscribe(jobId, (e) => {
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
        const plan = parsePlanOutput(finalStr);
        if (plan) {
          runQueue.emitSynthetic(jobId, { type: 'plan:proposed', plan });
          runQueue.emitSynthetic(jobId, {
            ...(e as object),
            __synthetic: true,
            final: `已生成执行计划（共 ${plan.tasks.length} 个任务）：${plan.goal}。确认后将按依赖顺序逐任务执行。`
          });
          if (chatSessionId) {
            traceHandle(e);
            appendChatMessage(chatSessionId, {
              role: 'assistant',
              content: `📋 ${plan.goal}`,
              ts: Date.now(),
              plan
            });
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

    // 计划模式 propose：抑制原始 JSON token/reasoning/response 流（避免计划 JSON 打字机外泄），
    // 其余事件照常；最终内容由 run:end 分支以友好摘要替换后下发。
    if (
      isPlanPropose &&
      ((e as { type?: string }).type === 'llm:token' ||
        (e as { type?: string }).type === 'llm:reasoning' ||
        (e as { type?: string }).type === 'llm:response')
    ) {
      return;
    }
    send(e);
    // 结构化为调用链路追踪树（供深度思考界面可视化 / 复盘）。
    if (chatSessionId) traceHandle(e);
    // 多会话 Chat App：把 run 的首尾事件落盘到会话存储（user 提问 + assistant 回答），
    // 并在过程中累积推理与工具调用，run 结束时一并写入，保证切换会话后再切回可完整还原。
    if (chatSessionId) {
      const ev = e as { type?: string; input?: unknown; final?: unknown };
      const a = ev as any;
      if (ev.type === 'llm:reasoning' && typeof a.delta === 'string') {
        reasoningBuf += a.delta as string;
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
      } else if (ev.type === 'run:start' && ev.input != null) {
        appendChatMessage(chatSessionId, {
          role: 'user',
          // 计划模式下落盘用户的原始需求（ev.input 是 planner 包装后的提示词）。
          content: isPlanPropose ? prompt : String(ev.input),
          ts: Date.now()
        });
      } else if (ev.type === 'run:end' && ev.final != null) {
        // 去重：run-queue 会在 harness 的 run:end 之后再补发一个不带 runId 的 run:end
        // （两者 final 相同），避免历史里出现两条重复的 assistant 消息。仅当会话最后一条
        // 还不是相同内容的 assistant 时才落盘。
        const finalStr = String(ev.final);
        const last = getChatSession(chatSessionId)?.messages.at(-1);
        if (traceRoot) traceRoot.status = 'ok';
        if (!(last && last.role === 'assistant' && last.content === finalStr)) {
          appendChatMessage(chatSessionId, {
            role: 'assistant',
            content: finalStr,
            ts: Date.now(),
            reasoning: reasoningBuf || undefined,
            tools: toolMap.size ? [...toolMap.values()] : undefined,
            trace: traceRoot ? [traceRoot] : undefined
          });
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
  });
  // res.on('close') 已在上方把 closed 置真；这里显式解绑，避免长尾 job 持有已断开订阅者。
  res.on('close', () => {
    closed = true;
    clearInterval(pingTimer);
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
async function handleA2A(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
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
  if (
    !envelope ||
    typeof envelope.taskId !== 'string' ||
    typeof envelope.toAgent !== 'string'
  ) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error:
          'invalid a2a request: 需要 { envelope: { taskId, toAgent, ... } }'
      })
    );
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
    res.end(
      JSON.stringify({ error: `unknown a2a target agent: ${envelope.toAgent}` })
    );
    return;
  }

  // 安全红线：本端点只执行本地 agent（transport=local）。远端 a2a 目标不应被当作本地执行，
  // 否则会与 run-queue 的跨主机派发语义混淆——跨主机由发起方经 HttpA2ATransport 走。
  if (target.transport !== 'local') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: `agent "${target.id}" transport=${target.transport} 不是本地 agent，无法被本端点直接执行`
      })
    );
    return;
  }

  try {
    const output = await runAgentTask(target, envelope.input, {
      tenantId: envelope.tenantId,
      onEvent: undefined
    });
    const result: TaskResult = {
      taskId: envelope.taskId,
      status: 'success',
      output
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result }));
  } catch (e: any) {
    const result: TaskResult = {
      taskId: envelope.taskId,
      status: 'failed',
      error: e?.message ?? String(e)
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result }));
  }
}

/** 校验并补全一张待注册的 AgentCard（缺省健康度视为初次上线健康）。返回 null 表示非法。 */
function normalizeIncomingCard(raw: unknown): AgentCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<AgentCard>;
  if (typeof c.id !== 'string' || !c.id.trim()) return null;
  if (!Array.isArray(c.capabilities)) return null;
  const now = Date.now();
  return {
    id: c.id.trim(),
    name: typeof c.name === 'string' && c.name ? c.name : c.id.trim(),
    domain: (c.domain ?? 'generic') as AgentCard['domain'],
    description: c.description,
    capabilities: c.capabilities,
    transport: c.transport ?? 'local',
    endpoint: c.endpoint,
    version: c.version,
    isolation: c.isolation,
    assembly: c.assembly,
    // 客户端可上报健康度；缺省视为「初次上线且健康」。
    health: c.health ?? { status: 'healthy', lastHeartbeat: now, load: 0 }
  } as AgentCard;
}

/**
 * P0.1 注册/更新 agent。body = AgentCard（至少 { id, capabilities }）。
 * 受 agent:register 保护（admin/operator）；写穿注册表持久后端，多副本经共享后端立即可见。
 */
async function handleAgentRegister(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readBody(req);
  const ctx = await guard(req, res, 'agent:register', body);
  if (!ctx) return;
  const card = normalizeIncomingCard(body);
  if (!card) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'invalid agent card: 需要 { id: string, capabilities: [] }'
      })
    );
    return;
  }
  await getAgentRegistry().register(card);
  auditAction('agent.register', {
    id: card.id,
    domain: card.domain,
    transport: card.transport,
    role: ctx.role,
    sub: ctx.sub
  });
  return sendJson(res, { ok: true, agent: card }, req);
}

/**
 * P0.1 心跳。path = /api/agents/:id/heartbeat；body = Partial<AgentHealth>（status/load 等）。
 * 未注册的 id 静默返回 ok:false（不 404，便于客户端幂等重试）。
 */
async function handleAgentHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): Promise<void> {
  const body = await readBody(req);
  const ctx = await guard(req, res, 'agent:register', body);
  if (!ctx) return;
  const id = decodeURIComponent(
    path.slice('/api/agents/'.length, path.length - '/heartbeat'.length)
  );
  if (!id) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing agent id' }));
    return;
  }
  const existing = await getAgentRegistry().get(id);
  if (!existing) {
    return sendJson(res, { ok: false, reason: 'unknown agent', id }, req);
  }
  const health = (body ?? {}) as Partial<AgentHealth>;
  await getAgentRegistry().heartbeat(id, health);
  return sendJson(res, { ok: true, id }, req);
}

/** P0.1 注销 agent。path = /api/agents/:id。受 agent:register 保护。 */
async function handleAgentDeregister(
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): Promise<void> {
  const body = await readBody(req);
  const ctx = await guard(req, res, 'agent:register', body);
  if (!ctx) return;
  const id = decodeURIComponent(
    path.slice('/api/agents/'.length).replace(/\/$/, '')
  );
  if (!id) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing agent id' }));
    return;
  }
  await getAgentRegistry().deregister(id);
  auditAction('agent.deregister', { id, role: ctx.role, sub: ctx.sub });
  return sendJson(res, { ok: true, id }, req);
}

/**
 * P1-⑤ 工作流编排入口：定义并运行一个 DAG 工作流，SSE 直播每 step 进度与最终快照。
 * body: { def: WorkflowDef, input?: unknown }。def 含 steps（agentRef / dependsOn / compensate）。
 * 每个 step 经 createWorkflowExecutor 复用 /api/run 同一套 assembleAgent + harness 装配。
 */
async function handleWorkflow(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
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
  if (
    !def ||
    typeof def.id !== 'string' ||
    !Array.isArray(def.steps) ||
    def.steps.length === 0
  ) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'invalid workflow def: 需要 { id: string, steps: StepDef[] }'
      })
    );
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
  const engine = new DagEngine({
    store: workflowStore(),
    executor,
    onEvent: onWfEvent
  });

  // 拓扑合法性 fail-fast：环 / 未知依赖 / 重复 stepId 立即 400，不进入异步执行才失败。
  try {
    engine.validateWorkflow(def);
  } catch (e: any) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: `invalid workflow topology: ${e?.message ?? String(e)}`
      })
    );
    return;
  }

  send = startSse(res, req);

  auditAction('workflow.run', {
    workflowId: def.id,
    stepCount: def.steps.length,
    role: ctx.role,
    sub: ctx.sub
  });

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

async function handleVerify(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
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
    if (!closed)
      send({ type: 'verify:error', id: '0', message: e?.message ?? String(e) });
    if (!closed) send({ type: '_verify_done' });
  } finally {
    if (!closed) res.end();
  }
}

// 合法的传输类型（与 core 的 McpTransportType 保持一致）。
const MCP_TRANSPORT_TYPES = new Set(['auto', 'sse', 'streamable-http']);

async function handleMcpAdd(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readBody(req);
  const ctx = await guard(req, res, 'mcp:add', body);
  if (!ctx) return;
  const name = String(body.name ?? '').trim();
  // 兼容旧字段 `url`，同时接受标准字段 `serverUrl`。
  const serverUrl = String(body.url ?? body.serverUrl ?? '').trim();
  const command = body.command != null ? String(body.command) : undefined;
  const args = Array.isArray(body.args) ? body.args.map(String) : undefined;
  const env =
    body.env && typeof body.env === 'object'
      ? (body.env as Record<string, string>)
      : undefined;
  const headers =
    body.headers && typeof body.headers === 'object'
      ? (body.headers as Record<string, string>)
      : undefined;
  // 仅接受合法的传输类型，其余忽略（回退 core 的 'auto' 自动判定）。
  let transportType: McpTransportType | undefined;
  if (
    typeof body.transportType === 'string' &&
    MCP_TRANSPORT_TYPES.has(body.transportType)
  ) {
    transportType = body.transportType as McpTransportType;
  }
  if (!name && !serverUrl && !command) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'name 与（serverUrl/url 或 command）至少需提供其一'
      })
    );
    return;
  }
  auditAction('mcp.add', {
    name,
    url: redactUrl(serverUrl),
    command: command ?? null,
    role: ctx.role,
    sub: ctx.sub
  });
  try {
    const meta = await mcpManager.addServer({
      name,
      serverUrl,
      command,
      args,
      env,
      headers,
      transportType
    });
    sendJson(res, { server: meta, servers: mcpManager.list() }, req);
  } catch (e: any) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message ?? String(e) }));
  }
}

/** 一键接入预设 MCP 服务（Context7 / GitHub / Composio 等）。 */
async function handleMcpPreset(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readBody(req);
  const ctx = await guard(req, res, 'mcp:preset', body);
  if (!ctx) return;
  const id = String(body.id ?? '').trim();
  const token = body.token != null ? String(body.token) : undefined;
  if (!id) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: '缺少预设 id（如 context7 / github / composio）'
      })
    );
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
async function handleShellApprove(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
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
  auditAction('shell.approve', {
    command,
    preapprove: body.preapprove === true,
    role: ctx.role,
    sub: ctx.sub
  });
  if (body.preapprove === true) {
    preapproveShell(shellSignature(command, args));
    return sendJson(res, { preapproved: true }, req);
  }
  const released = approveShell(command, args);
  sendJson(res, { waitingReleased: released }, req);
}

async function handleEnv(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const body = await readBody(req);
  // 按动作类型映射为细分动作，做角色授权 + 审批判定（create/destroy 需审批）。
  const envAction: Action =
    body.action === 'destroy' ? 'env:destroy' : 'env:create';
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
      owner: body.owner ? String(body.owner) : undefined
    };
    auditAction('env.create', {
      envType: input.envType,
      branch: input.branch,
      region: input.region ?? null,
      owner: input.owner ?? null,
      role: ctx.role,
      sub: ctx.sub
    });
    try {
      await envPipeline.create(input, (env) => {
        if (!closed) send({ type: 'env:status', env });
      });
      if (!closed) send({ type: '_env_done' });
    } catch (e: any) {
      if (!closed)
        send({ type: 'env:error', message: e?.message ?? String(e) });
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
      if (!env && !closed)
        send({ type: 'env:error', message: `未找到环境 ${envId}` });
      if (!closed) send({ type: '_env_done', found: !!env });
    } catch (e: any) {
      if (!closed)
        send({ type: 'env:error', message: e?.message ?? String(e) });
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

/**
 * 按 AGENT_STORE env 构造 AgentRegistry 持久后端（投产：多副本共享 + 重启不丢）。
 * - redis：动态 require ioredis（可选依赖，与 queue-backend 同款）注入最小 Hash 契约；
 *   URL 取 AGENT_STORE_REDIS_URL，回落 REDIS_URL。不可用则回退内存态并告警。
 * - file / sqlite / volatile：由 core 的 createAgentStoreFromEnv 自解析（零依赖）。
 */
function buildAgentStore(): AgentStore {
  const kind = (process.env.AGENT_STORE || '').toLowerCase();
  let redis: AgentStoreRedis | null = null;
  if (kind === 'redis') {
    const url = process.env.AGENT_STORE_REDIS_URL || process.env.REDIS_URL;
    try {
      // ioredis 为可选依赖：动态 require，未安装则回退 volatile（保持「一切降级可用」）。
      const RedisMod = require('ioredis');
      const RedisCtor =
        (RedisMod && (RedisMod.default || RedisMod)) || RedisMod;
      redis = new RedisCtor(url || 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
        lazyConnect: false
      }) as unknown as AgentStoreRedis;
      (redis as any).on?.('error', (e: any) =>
        console.error('[agent-store] redis error:', e?.message)
      );
      console.log(`[agent-store] using Redis backend${url ? ` (${url})` : ''}`);
    } catch (e: any) {
      console.error(
        '[agent-store] ioredis 不可用，回退内存态 volatile 后端：',
        e?.message ?? e
      );
    }
  }
  const store = createAgentStoreFromEnv(process.env, redis);
  if (kind === 'redis' && store.kind !== 'redis') {
    console.warn(
      '[agent-store] ⚠️ AGENT_STORE=redis 但 client 未就绪，实际使用 volatile（重启即丢、多副本不共享）。'
    );
  }
  return store;
}

/**
 * 启动引导：先按 env 选定并初始化 AgentRegistry 持久后端（幂等，须早于首个请求），
 * 再注册行业合规画像，最后开始监听。把这些放到 listen 之前，杜绝「请求早于注册表就绪」的竞态。
 */
async function bootstrap(): Promise<void> {
  const store = buildAgentStore();
  await initAgentRegistry(store);
  // 插件系统：复用已注入持久后端的共享 AgentRegistry，构造 loader + 双宿主。
  pluginSystem = createPluginSystem();
  // 发现并启用插件（动态 require，server 不静态依赖具体插件）。
  const enabledPlugins = await bootstrapPlugins(pluginSystem);
  if (enabledPlugins.length) {
    console.log(`   🔌 已启用插件：${enabledPlugins.join(', ')}`);
  }
  // P2.c：引导注册全部预置行业合规画像（医疗等保 / 金融数据出境 / 教育放宽），使新建对应行业
  // 租户即自带合规基线（applyIndustryProfile 透明叠加）。幂等，不影响已在运行的租户策略。
  policyEngine.registerIndustryProfiles();
  server.listen(PORT, HOST, onListening);
}

function onListening(): void {
  const registry = getAgentRegistry();
  console.log(`\n🚀 Agent Harness UI 已启动： http://localhost:${PORT}`);
  console.log(`   模式：Mock（离线）/ Real LLM / Real + MCP`);
  if (REQUIRE_AUTH) {
    const prov =
      AUTH_PROVIDER === 'oidc'
        ? 'OIDC (Bearer JWT)'
        : AUTH_PROVIDER === 'proxy'
          ? 'SSO 网关头注入 (proxy)'
          : '静态令牌 (token)';
    console.log(
      `   🔒 RBAC 鉴权已启用（身份源：${prov}）：请求需 Authorization: Bearer <token>`
    );
    console.log(
      `   🔒 敏感动作（real 运行 / 环境创建销毁 / MCP 接入 / 记忆清空等）需审批：POST 返回 202 + ticketId`
    );
    if (
      (AUTH_PROVIDER === 'oidc' || AUTH_PROVIDER === 'proxy') &&
      (process.env.UI_TOKENS || UI_AUTH_TOKEN)
    ) {
      console.log(
        `   🔑 同时启用静态令牌 break-glass：IdP 不可用时可用 UI_AUTH_TOKEN 直接鉴权（运维逃生通道）`
      );
    }
  } else {
    console.warn(
      `   ⚠️  未设置 UI_TOKENS / UI_AUTH_TOKEN，UI 接口处于开放状态（仅建议本地 / 演示使用）。`
    );
  }
  if (UI_CORS_ORIGIN.length === 0) {
    console.log(
      `   🔒 CORS 仅同源（未配置 UI_CORS_ORIGIN）。跨域调用需显式设置白名单。`
    );
  } else {
    console.log(`   🔒 CORS 白名单：${UI_CORS_ORIGIN.join(', ')}`);
  }
  console.log(
    `   🔒 限流：${RATE_LIMIT > 0 ? `每 IP ${RATE_LIMIT} 次 / ${RATE_WINDOW_MS / 1000}s` : '关闭'}；请求体上限：${MAX_BODY_BYTES} 字节`
  );
  if (AUDIT_LOG) console.log(`   📝 审计日志落盘：${AUDIT_LOG}`);
  console.log(
    `   OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? '已配置' : '未配置（Mock 模式可用）'}`
  );
  console.log(
    `   HARNESS_API_KEY: ${process.env.HARNESS_API_KEY ? '已配置' : '未配置（环境流水线走 dry-run 演示）'}`
  );
  console.log(`   MCP_SERVER_URL: ${process.env.MCP_SERVER_URL ?? '未配置'}`);
  const storeKind = (registry as any)?.store?.kind ?? 'volatile';
  if (storeKind === 'volatile') {
    console.warn(
      `   ⚠️  AgentRegistry 后端：volatile（内存态，重启即丢、多副本不共享）。生产请设 AGENT_STORE=redis|sqlite|file。`
    );
  } else {
    console.log(
      `   🗄️  AgentRegistry 后端：${storeKind}（持久化，重启保留 / 多副本可共享）。`
    );
  }
  if (isTenantRequired()) {
    console.log(
      `   🔐 跨行业隔离强制：REQUIRE_TENANT=on（行业 agent 无租户上下文将被拒绝执行）。`
    );
  } else {
    console.log(
      `   🔓 跨行业隔离：opt-in（REQUIRE_TENANT 未开启；行业 agent 可在无租户下运行）。生产强合规建议设 REQUIRE_TENANT=true。`
    );
  }
  const intentMode = resolveIntentMode();
  const intentRaw = (process.env.INTENT_ROUTER || 'rule').toLowerCase();
  console.log(
    `   🧭 意图路由：INTENT_ROUTER=${intentRaw} → 生效 ${intentMode}` +
      (intentRaw === 'auto'
        ? `（${process.env.OPENROUTER_API_KEY ? '检测到 API key，用 llm 精准分类' : '无 API key，降级 rule 关键词分类'}）`
        : '')
  );
  console.log('');
}

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
        body: JSON.stringify(a)
      });
    } catch (e: any) {
      structLog('warn', 'alert webhook failed', {
        error: e?.message ?? String(e)
      });
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
  // Token 缓存命中率统计：复用同一套告警通道（webhook / 文件），并启动周期聚合。
  setTokenCacheAlertSink(emitAlert);
  startTokenCacheAggregation();
}

function installCrashGuard(): void {
  const fatal = (where: string, err: unknown) => {
    const e = err as { message?: string; stack?: string };
    logError('crash.guard', err, { where });
    emitAlert(
      'fatal',
      'crash.guard',
      `${where}: ${e?.message ?? String(err)}`,
      { where, stack: e?.stack }
    );
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
const SHUTDOWN_GRACE_MS =
  Number(process.env.RUN_SHUTDOWN_GRACE_MS ?? 5000) || 5000;
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

// 启动：先完成 AgentRegistry 后端初始化 + 行业画像注册，再监听（详见 bootstrap 注释）。
bootstrap().catch((e) => {
  console.error('[ui] bootstrap 失败：', e?.message ?? e);
  process.exit(1);
});

export {};
