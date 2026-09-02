import { createServer } from 'node:http';
import { accessSync } from 'node:fs';
import { readFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
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
  contextWindowFor,
  enableTelemetryAutosave,
  initTeamManager,
  getTeamManager,
  type Team
} from '@agent-harness/core';
// 错误明细存储（展示「错误数量 + 具体错误信息」）。
import {
  getErrorLog,
  getErrorSummary,
  formatErrorReport
} from '@agent-harness/core';
import { createWorkflowExecutor, workflowStore } from './workflow-executor';
import { runAgentTask } from './agent-run';
// 视图层（HTML 渲染）已拆出到 views.ts，server.ts 仅消费其导出。
import {
  serveHtml,
  esc,
  renderOAuthTransitionHtml,
  renderErrorsHtml,
  webappDir,
  contentTypeFor
} from './views';
// HTTP 传输层辅助（CORS / JSON / SSE / 请求体读取）已拆出到 http-helpers.ts。
import {
  corsHeaders,
  sendJson,
  startSse,
  readBody
} from './http-helpers';
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
  peekChatSession,
  createChatSession,
  renameChatSession,
  deleteChatSession,
  appendChatMessage,
  updatePlanStatus,
  type StoredTool,
  type TraceNode,
  type ChatMessage
} from './chat-sessions';
// 聊天历史镜像存储（ah_chat_history 接口层）：SQLite 临时持久化，预留正式数据库扩展点。
import { getHistoryStore } from './history-store';
// 聊天实时广播总线（跨设备/跨标签页/跨实例 fanout）。
import { subscribeChatEvents, publishChatEvent, chatSubscriberCount } from './chat-bus';
// 备忘提醒实时广播总线（进程内 fanout，单实例足够）。
import { subscribeReminders } from './reminder-bus';
// 业务策略层（与核心 framework 隔离）：RBAC 鉴权 + 审批工作流，均为可插拔接口。
import {
  createAuthorizer,
  type Authorizer,
  type AuthContext,
  type Action
} from './authz';
// 外部身份源（OIDC Bearer JWT 资源服务器 / proxy 头注入）。提供 JWKS 预热与前端鉴权元信息。
import { warmJwks, getAuthConfig } from './sso';
import { createApprovalPolicy, type ApprovalPolicy, type ApprovalTicket } from './approval';
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
// 启动期环境变量 schema 校验（依赖无关，零新增依赖）。
import { logConfigValidation } from './config-schema';
import { DEFAULTS } from './config-defaults';
// 租户上下文（P0.3 租户隔离）：解析 + 强制门禁。
import { resolveTenantContext, type TenantContext } from '@agent-harness/core';
// K8s健康检查端点
import { handleLiveness, handleReadiness } from './health';
// 自定义模型 SQLite 持久化 + AES-GCM 解密
import { registerCustomModelRoutes, decryptApiKey } from './custom-models';
import {
  registerProviderKeyRoutes,
  resolveRunCredential
} from './provider-keys';
// P2.2 配额/用量看板：进程内配额引擎单例（per-owner 用量统计）。
import { quotaEngine } from '@agent-harness/core';
// P2.1 OpenRouter OAuth（PKCE）授权框架。
import { registerOAuthRoutes } from './oauth';
// 账户密码鉴权：注册 / 登录（签发 7 天 cookie token）。与 OIDC/proxy/静态令牌共存。
import {
  registerUser,
  loginUser,
  upsertGithubUser,
  upsertGoogleUser,
  usernameFromCookie,
  cookieValue,
  authCookieValue,
  clearAuthCookie,
  getProfile,
  changePassword,
  revokeAllTokens,
  requestPasswordReset,
  resetPassword,
  AUTH_COOKIE,
  type AccountResult
} from './accounts';
// 密钥外部化：在读取任何 process.env 之前装配（平台 env / SECRETS_FILE / 本地 .env）。
import { loadSecrets } from './secrets';
// 接入层公开/运维探针路由表（可测试接缝，详见 routes/edge-routes.ts）。
import {
  createEdgeRoutes,
  tryDispatchEdgeRoute,
  type EdgeRouteDeps
} from './routes/edge-routes';
// 接入层结构化日志封装（统一收口启动横幅 / 降级告警 / 自检结论）。
import { log, banner } from './logger';

// 必须在下方任何 `process.env.X` 顶层读取前执行（幂等，仅首次生效）。
loadSecrets();

// 告警通道：根据环境变量装配（Webhook / 日志文件），在捕获任何错误之前就位。
setupAlerting();

// Render (and most PaaS) inject PORT; fall back to UI_PORT then the local default.
// 默认值统一来自 config-defaults.DEFAULTS（单一事实来源，消除与 schema 校验的漂移）。
const PORT = Number(process.env.PORT ?? process.env.UI_PORT ?? (DEFAULTS.PORT as number));
const HOST = process.env.UI_HOST ?? (DEFAULTS.UI_HOST as string);

// 边缘路由表（公开/运维探针）：在鉴权守卫前分发，命中即短路。
// deps 在首次需要时构造，getSandboxStatus 懒加载 core 的沙箱执行器，避免模块加载期副作用。
const edgeRoutes = createEdgeRoutes();
function edgeRouteDeps(): EdgeRouteDeps {
  return {
    buildState: (req) => buildState(req),
    getSandboxStatus: () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { createOSSandboxExecutor } = require('@agent-harness/core');
        const exec = createOSSandboxExecutor();
        return (exec as { describe?(): unknown }).describe?.() ?? null;
      } catch {
        return null;
      }
    },
    getAuthConfig: () => getAuthConfig(),
    getErrorLog: (opts) => getErrorLog(opts),
    getErrorSummary: () => getErrorSummary(),
    formatErrorReport: (opts) => formatErrorReport(opts),
    handleLiveness,
    handleReadiness
  };
}


// OAuth：CSRF state 临时存于 HttpOnly cookie（10 分钟有效，仅用于校验回调来源）。
// 按提供方分别命名，避免 GitHub / Google 两套流程共用同一 cookie 互相串扰。
const OAUTH_STATE_COOKIE = 'ah_oauth_state';

/** 请求是否来自 localhost（dev 可走 http，不置 Secure）。 */
function isReqLocalhost(req: { headers?: Record<string, unknown> }): boolean {
  const host = String(req?.headers?.host ?? '');
  return (
    host.startsWith('localhost') ||
    host.startsWith('127.') ||
    host.startsWith('[::1]')
  );
}

/** 构造 OAuth state cookie 串：HttpOnly + SameSite=Lax + 10min，非 localhost 追加 Secure。 */
function oauthStateCookie(
  req: { headers?: Record<string, unknown> },
  name: string,
  value: string
): string {
  const parts = [
    `${name}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=600'
  ];
  if (!isReqLocalhost(req)) parts.push('Secure');
  return parts.join('; ');
}

/** 恒定时间字符串比较，避免 CSRF state 比较泄漏时序差。长度不同直接拒。 */
function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// 协议自适应的 GitHub OAuth 回调 URL 构造：
//   1) 显式 GITHUB_OAUTH_REDIRECT（完整 http(s) URL）→ 直接用，最高优先级；
//   2) 否则读反向代理注入的 X-Forwarded-Proto（Render/Vercel/Cloud Run 等都会注入）；
//   3) 兜底：host 为 localhost/127.0.0.1 用 http，其余（生产域名）默认 https。
// 关键：authorize 跳转 与 callback 换 token 必须返回完全一致的值，否则 GitHub 会因
// redirect_uri 不一致再次拒绝授权（此前在 Render 上因后端写死 http:// 导致此问题）。
function githubRedirectUri(req: IncomingMessage): string {
  const cfg = process.env.GITHUB_OAUTH_REDIRECT || '/api/account/oauth/github/callback';
  if (cfg.startsWith('http')) return cfg; // 完整 URL，直接采用，不走协议推断
  const host = req.headers.host ? String(req.headers.host) : '';
  if (!host) return `${cfg.startsWith('/') ? '' : '/'}${cfg}`; // 无 host 兜底（保持原行为）
  const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0]?.trim();
  const proto = xfp || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}${cfg.startsWith('/') ? '' : '/'}${cfg}`;
}
// Google OAuth 回调 URL 构造：与 githubRedirectUri 同理
function googleRedirectUri(req: IncomingMessage): string {
  const cfg = process.env.GOOGLE_OAUTH_REDIRECT || '/api/account/oauth/google/callback';
  if (cfg.startsWith('http')) return cfg;
  const host = req.headers.host ? String(req.headers.host) : '';
  if (!host) return `${cfg.startsWith('/') ? '' : '/'}${cfg}`;
  const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0]?.trim();
  const proto = xfp || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}${cfg.startsWith('/') ? '' : '/'}${cfg}`;
}
// LLM 统一密钥 OPEN_API_KEY 主要作为模型调用凭证（@agent-harness/core 直接读 process.env.OPEN_API_KEY）。
// 出于向后兼容，OPEN_API_KEY 在 ADMIN_API_KEY 未设置时仍被接受为 admin 鉴权凭证（逃生通道 / 降级唯一凭证），
// 详见 authz.ts 的 createAuthorizer。新部署应显式设置 ADMIN_API_KEY，使「LLM 密钥」与「站点鉴权」职责分离。
// 站点鉴权主链路由「账户密码 / RBAC / OIDC / proxy」负责，未登录一律 401。
// 身份源：token（默认静态令牌）/ oidc（Bearer JWT）/ proxy（SSO 网关头注入）/ account（账户密码）。
const AUTH_PROVIDER = (process.env.AUTH_PROVIDER || (DEFAULTS.AUTH_PROVIDER as string)).toLowerCase();
// 账户密码身份源开关（默认开）：开启后注册/登录可用，且强制要求鉴权（无有效登录态即 401）。
const ACCOUNT_AUTH = (process.env.ACCOUNT_AUTH ?? (DEFAULTS.ACCOUNT_AUTH as string)).toLowerCase() !== 'off';
// 需要鉴权：非 token 模式、或启用账户密码鉴权、或配置了静态令牌（UI_TOKENS）。
// 若以上均不满足：降级模式下 admin key（ADMIN_API_KEY 或回退 OPEN_API_KEY）仍可作唯一凭证，
// 否则由账户密码档严格拒绝（无 cookie 即 401）。
const REQUIRE_AUTH =
  AUTH_PROVIDER !== 'token' ||
  ACCOUNT_AUTH ||
  !!(process.env.UI_TOKENS);

// 安全加固配置（均可在 .env / 环境变量中调整）。
// 允许跨域的来源白名单（逗号分隔）；为空则仅同源（默认收紧，不再回 `*`，防 CSRF/跨域调用）。
const UI_CORS_ORIGIN = (process.env.UI_CORS_ORIGIN ?? (DEFAULTS.UI_CORS_ORIGIN as string))
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);
// 请求体上限（字节），防大报文 DoS。默认 1MB。
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? (DEFAULTS.MAX_BODY_BYTES as number));
// 限流：单 IP 在窗口内的请求数；<=0 关闭限流。默认 120/60s。
const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? (DEFAULTS.RATE_LIMIT as number));
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? (DEFAULTS.RATE_WINDOW_MS as number));
// 审计日志落盘路径；为空则仅输出到 stdout（JSON 行）。
const AUDIT_LOG = process.env.AUDIT_LOG ?? (DEFAULTS.AUDIT_LOG as string);

// 业务策略装配（组合根）：RBAC 鉴权器 + 审批策略。二者均为可插拔接口实现，
// 核心 framework 不感知任何角色/权限/审批概念。替换身份源或审批后端只需改这两个工厂。
const authorizer: Authorizer = createAuthorizer(REQUIRE_AUTH);

// 启动期配置校验：把「写错但静默启动」的 misconfig 显性化为日志告警（不阻断启动，向后兼容）。
logConfigValidation();

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

/** 取客户端真实 IP：优先 Cloudflare 注入头，其次 X-Forwarded-For 首个，最后 socket。 */
function clientIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return (xff.split(',')[0] ?? '').trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** 内存态固定窗口限流；返回是否应拒绝 + 剩余毫秒数（用于 Retry-After）。 */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): { limited: boolean; retryAfter: number } {
  if (!(RATE_LIMIT > 0)) return { limited: false, retryAfter: 0 };
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, b);
  }
  b.count += 1;
  return { limited: b.count > RATE_LIMIT, retryAfter: Math.max(0, b.resetAt - now) };
}

/** SSE 长连接端点：固定窗口限流会把连接/重连计入同一计数器，极易在刷新时触发 429 螺旋。 */
function isSseEndpoint(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false;
  const path = String(req.url ?? '').split('?')[0];
  return path === '/api/events' || path === '/api/chat/stream';
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
    return (url.split('?')[0] ?? '');
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
  const ctx = await authorizer.authenticate(req);
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

  // P0.3 租户隔离：若强制租户隔离（REQUIRE_TENANT=true），校验请求携带的
  // 租户上下文（优先认证身份派生，其次请求体声明），无租户上下文则拒绝。
  const requireTenant = isTenantRequired();
  if (requireTenant) {
    const tenant = resolveTenantContext({
      tenantId: body?.tenantId ?? null,
      authenticatedTenantId: ctx.tenantId ?? null,
      name: ctx.email,
      domain: undefined
    });
    if (!tenant) {
      audit({
        kind: 'request',
        method: req.method,
        path: req.url,
        ip,
        authed: true,
        status: 403,
        action,
        reason: 'tenant isolation required but no tenant context provided'
      });
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden', reason: 'tenant isolation required' }));
      return null;
    }
    // 将解析后的租户上下文附加到 AuthContext，供下游消费。
    (ctx as AuthContext & { tenantCtx?: TenantContext }).tenantCtx = tenant;
  }
  // SSE 长连接不计入全局固定窗口：其重连/保活特性会在刷新时产生瞬时请求尖峰，
  // 与短 API 共享同一 120/60s 桶极易误伤；生产环境仍受连接数/代理层保护。
  const { limited, retryAfter } = isSseEndpoint(req)
    ? { limited: false, retryAfter: 0 }
    : rateLimited(ip);
  if (limited) {
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
      'retry-after': String(Math.ceil(retryAfter / 1000)),
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
      const t = await approvalPolicy.consume(ticketId, action, ctx);
      if (t) return ctx; // 已批准，放行执行
    }
    const ticket = await approvalPolicy.create(
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
      if (path === '/api/history' || path.startsWith('/api/history/'))
        return 'chat:read';
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
          'access-control-allow-headers':
            'content-type,authorization,x-ah-username',
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
      // SPA fallback（history 路由）：前端使用 history.pushState 做客户端路由
      //（如 /chat /verify），刷新或直接打开深链接时这些路径会打到服务器。
      // 所有「非 API、非静态资源」的 GET 请求统一回退到 index.html，由前端路由接管。
      // 已知接口/探针路径不回退（保持 404 语义，避免掩盖路由错误）。
      const SPA_FALLBACK_EXCLUDED = [
        '/api',
        '/assets',
        '/health',
        '/favicon.ico',
        '/favicon.svg',
        '/robots.txt'
      ];
      if (
        req.method === 'GET' &&
        !SPA_FALLBACK_EXCLUDED.some(
          (p) =>
            path === p || path.startsWith(p + '/') || path.startsWith(p + '?')
        )
      ) {
        const wd = webappDir();
        if (wd) {
          try {
            let html = await readFile(join(wd, 'index.html'), 'utf8');
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-cache'
            });
            res.end(html);
            return;
          } catch {
            /* webapp 未构建，交给后续 serveHtml 返回 500 */
          }
        }
        return await serveHtml(res);
      }
      // 托管 Web SPA 的静态资源（/assets/*）。仅当 webapp 已构建时生效。
      if (req.method === 'GET' && path.startsWith('/assets/')) {
        const wd = webappDir();
        if (wd) {
          const rel = decodeURIComponent(
            path.slice('/assets/'.length).split('?')[0] ?? ''
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
          const rel = decodeURIComponent(path.slice(1).split('?')[0] ?? '');
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
      // 边缘路由（公开/运维探针）：命中即短路分发，未命中继续主链。
      // 覆盖 health/live、health/ready、/api/state、/api/sandbox、/api/auth/config、
      // /api/errors（受 guard 保护的错误明细 JSON 由下方单独处理）。
      if (
        await tryDispatchEdgeRoute(edgeRoutes, req, res, url, edgeRouteDeps(), path)
      ) {
        return;
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
      // ── 账户密码鉴权（与 OIDC/proxy/静态令牌共存）──
      // 这两个端点本身公开（不需要先登录），但会被上面的 guard 默认拦掉，
      // 故显式放在 guard 之前处理。
      if (path === '/api/account/register' && req.method === 'POST') {
        const b = await readBody(req);
        const u = typeof b?.username === 'string' ? b.username : '';
        const p = typeof b?.password === 'string' ? b.password : '';
        const r: AccountResult = await registerUser(u, p, b.email);
        if (!r.ok) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: r.error }));
          return;
        }
        // 注册成功顺带登录，直接下发 cookie token，减少一次往返。
        const lr: AccountResult = await loginUser(u, p);
        if (!lr.ok || !lr.token) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ ok: false, error: '注册成功但签发登录态失败' })
          );
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': authCookieValue(req, lr.token),
          'cache-control': 'no-store'
        });
        res.end(JSON.stringify({ ok: true, username: lr.username }));
        return;
      }
      if (path === '/api/account/login' && req.method === 'POST') {
        const b = await readBody(req);
        const u = typeof b?.username === 'string' ? b.username : '';
        const p = typeof b?.password === 'string' ? b.password : '';
        const r: AccountResult = await loginUser(u, p);
        if (!r.ok || !r.token) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: r.error ?? '登录失败' }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': authCookieValue(req, r.token),
          'cache-control': 'no-store'
        });
        res.end(JSON.stringify({ ok: true, username: r.username }));
        return;
      }
      // ── 忘记密码 / 重置密码（公开，放在 guard 之前，与 register/login 同区）──
      if (req.method === 'POST' && path === '/api/account/forgot-password') {
        const b = await readBody(req);
        const identifier =
          typeof b?.identifier === 'string' ? b.identifier : '';
        const r = await requestPasswordReset(identifier);
        if (!r.ok) {
          res.writeHead(400, {
            'content-type': 'application/json',
            'cache-control': 'no-store'
          });
          res.end(JSON.stringify({ ok: false, error: r.error }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store'
        });
        res.end(JSON.stringify({ ok: true, resetToken: r.resetToken ?? null }));
        return;
      }
      if (req.method === 'POST' && path === '/api/account/reset-password') {
        const b = await readBody(req);
        const token = typeof b?.token === 'string' ? b.token : '';
        const newPw = typeof b?.newPassword === 'string' ? b.newPassword : '';
        const r = await resetPassword(token, newPw);
        if (!r.ok) {
          res.writeHead(400, {
            'content-type': 'application/json',
            'cache-control': 'no-store'
          });
          res.end(JSON.stringify({ ok: false, error: r.error }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store'
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'GET' && path === '/api/account/me') {
        // 当前会话：仅依赖 ah_auth cookie（不要求 x-ah-username 双因子，避免鸡生蛋）。
        // 前端在 OAuth 回调后回填用户名（setSession）时调用。
        const u = await usernameFromCookie(req);
        if (!u) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '未登录' }));
          return;
        }
        // 账户密码档在 RBAC 中统一为 admin 角色（authz.ts: AccountAuthorizer）。
        // 这里随 /me 一并返回 username / role / email，供顶栏用户菜单展示。
        const profile = await getProfile(u);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          ok: true,
          username: u,
          role: 'admin',
          email: profile?.email ?? null
        }));
        return;
      }
      if (req.method === 'POST' && path === '/api/account/change-password') {
        // 改密：需先登录（cookie 有效且 x-ah-username 双因子一致，由下方 guard 保证）。
        const ctx = await guard(req, res, 'chat:write');
        if (!ctx) return;
        const b = await readBody(req);
        const oldPw = typeof b?.oldPassword === 'string' ? b.oldPassword : '';
        const newPw = typeof b?.newPassword === 'string' ? b.newPassword : '';
        const r = await changePassword(ctx.sub, oldPw, newPw);
        if (!r.ok) {
          res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: r.error }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'POST' && path === '/api/account/logout') {
        // 登出：清除服务端 token 记录 + 让浏览器丢弃 ah_auth cookie（HttpOnly 只能由服务端清除）。
        const u = await usernameFromCookie(req);
        if (u) await revokeAllTokens(u);
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': clearAuthCookie(req),
          'cache-control': 'no-store'
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // ── GitHub OAuth 授权码流（后端持有 client_secret）──
      // 1) 前端按钮跳转这里 → 302 到 GitHub 授权页（带 CSRF state，存于 HttpOnly cookie）。
      if (req.method === 'GET' && path === '/api/account/oauth/github') {
        const clientId = process.env.GITHUB_CLIENT_ID;
        if (!clientId || !process.env.GITHUB_CLIENT_SECRET) {
          res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: '服务端未配置 GitHub OAuth（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）。' }));
          return;
        }
        const redirectUri = githubRedirectUri(req);
        const state = randomBytes(16).toString('hex');
        const ghUrl =
          `https://github.com/login/oauth/authorize` +
          `?client_id=${encodeURIComponent(clientId || '')}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&scope=${encodeURIComponent('read:user user:email')}` +
          `&state=${encodeURIComponent(state)}`;
        res.writeHead(302, {
          'set-cookie': oauthStateCookie(req, OAUTH_STATE_COOKIE, state),
          'cache-control': 'no-store',
          location: ghUrl
        });
        res.end();
        return;
      }
      // 2) GitHub 回调：校验 state → 用 code 换 token → 拉 user + 主邮箱 → 本地 upsert → 下发 cookie → 回首页。
      if (req.method === 'GET' && path === '/api/account/oauth/github/callback') {
        const fail = (code: number, msg: string) => {
          if (code === 500 && process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
            // 配置正常但处理异常：返回 HTML 错误页
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderOAuthTransitionHtml({ ok: false, message: msg }));
            return;
          }
          res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: msg }));
          return;
        };
        if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
          return fail(500, '服务端未配置 GitHub OAuth（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）。');
        }
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const expect = cookieValue(req, OAUTH_STATE_COOKIE);
        if (!state || !expect || !safeEqualString(state, expect)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderOAuthTransitionHtml({ ok: false, message: 'OAuth state 校验失败（可能是 CSRF 或过期），请重新登录。' }));
          return;
        }
        if (!code) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderOAuthTransitionHtml({ ok: false, message: 'GitHub 未回传授权码，请重试。' }));
          return;
        }
        try {
          const redirectUri = githubRedirectUri(req);
          // 换 access_token（GitHub 接受 Accept: application/json）。
          const tokRes = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              client_id: process.env.GITHUB_CLIENT_ID,
              client_secret: process.env.GITHUB_CLIENT_SECRET,
              code,
              redirect_uri: redirectUri
            })
          });
          const tok = (await tokRes.json()) as { access_token?: string; error?: string };
          if (!tok.access_token) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderOAuthTransitionHtml({ ok: false, message: `GitHub 换 token 失败：${tok.error ?? '未知错误'}` }));
            return;
          }
          // 拉用户基本信息。
          const userRes = await fetch('https://api.github.com/user', {
            headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-harness' }
          });
          const user = (await userRes.json()) as { login?: string; id?: number; email?: string };
          if (!user.login) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderOAuthTransitionHtml({ ok: false, message: '无法获取 GitHub 用户信息。' }));
            return;
          }
          // 拉主邮箱（user.email 常常为空，需单独调 /user/emails 取 primary/verified）。
          let email = user.email;
          if (!email) {
            try {
              const emRes = await fetch('https://api.github.com/user/emails', {
                headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-harness' }
              });
              const ems = (await emRes.json()) as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
              // 仅接受 GitHub 已 verified 的邮箱；未验证邮箱一律不采用，避免冒用他人邮箱身份。
              const primary = ems.find((e) => e.verified);
              email = primary?.email;
            } catch { /* 邮箱可选，失败不阻断登录 */ }
          }
          const r: AccountResult = await upsertGithubUser(user.login, Number(user.id ?? 0), email);
          if (!r.ok || !r.token) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderOAuthTransitionHtml({ ok: false, message: '创建/登录本地账户失败，请稍后重试。' }));
            return;
          }
          const home = process.env.GITHUB_OAUTH_SUCCESS_REDIRECT || '/';
          // 先下发 cookie，再返回 HTML 过渡页（带自动跳转），避免空白页
          res.writeHead(200, {
            'set-cookie': authCookieValue(req, r.token),
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(renderOAuthTransitionHtml({
            ok: true,
            message: `欢迎回来，${r.username}！正在跳转到工作台…`,
            redirect: `${home}${home.includes('?') ? '&' : '?'}oauth=success`
          }));
          return;
        } catch (err) {
          return fail(500, `GitHub OAuth 处理异常：${(err as Error)?.message ?? String(err)}`);
        }
      }
      // ── Google OAuth 授权码流（后端持有 client_secret）──
      // 1) 前端按钮跳转这里 → 302 到 Google 授权页（带 CSRF state + PKCE code_challenge）。
      if (req.method === 'GET' && path === '/api/account/oauth/google') {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
          res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: '服务端未配置 Google OAuth（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）。' }));
          return;
        }
        const redirectUri = googleRedirectUri(req);
        const state = randomBytes(16).toString('hex');
        const codeVerifier = randomBytes(32).toString('base64url');
        const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
        const googleUrl =
          `https://accounts.google.com/o/oauth2/v2/auth` +
          `?client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code` +
          `&scope=${encodeURIComponent('openid email profile')}` +
          `&state=${encodeURIComponent(state)}` +
          `&code_challenge=${encodeURIComponent(codeChallenge)}` +
          `&code_challenge_method=S256` +
          `&access_type=online` +
          `&prompt=consent`;
        res.writeHead(302, {
          'set-cookie': [
            oauthStateCookie(req, OAUTH_STATE_COOKIE, state),
            `ah_oauth_cv=${codeVerifier}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`
          ],
          'cache-control': 'no-store',
          location: googleUrl
        });
        res.end();
        return;
      }
      // 2) Google 回调：校验 state → 用 code + code_verifier 换 token → 解析 id_token → 本地 upsert → 下发 cookie → 回首页。
      if (req.method === 'GET' && path === '/api/account/oauth/google/callback') {
        if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderOAuthTransitionHtml({ ok: false, message: '服务端未配置 Google OAuth。' }));
          return;
        }
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const expect = cookieValue(req, OAUTH_STATE_COOKIE);
        const codeVerifier = cookieValue(req, 'ah_oauth_cv');
        if (!state || !expect || !safeEqualString(state, expect)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderOAuthTransitionHtml({ ok: false, message: 'OAuth state 校验失败（可能是 CSRF 或过期），请重新登录。' }));
          return;
        }
        if (!code) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderOAuthTransitionHtml({ ok: false, message: 'Google 未回传授权码，请重试。' }));
          return;
        }
        if (!codeVerifier) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderOAuthTransitionHtml({ ok: false, message: 'PKCE code_verifier 丢失，请重新登录。' }));
          return;
        }
        try {
          const redirectUri = googleRedirectUri(req);
          // 换 token
          const tokRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID,
              client_secret: process.env.GOOGLE_CLIENT_SECRET,
              code,
              redirect_uri: redirectUri,
              grant_type: 'authorization_code',
              code_verifier: codeVerifier
            }).toString()
          });
          const tok = (await tokRes.json()) as { id_token?: string; access_token?: string; error?: string };
          if (!tok.id_token) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderOAuthTransitionHtml({ ok: false, message: `Google 换 token 失败：${tok.error ?? '未知错误'}` }));
            return;
          }
          // 解析 JWT id_token（不验签，已来自 Google 直连 + 后续用 access_token 拉 userinfo 复核）
          const parts = tok.id_token.split('.');
          if (parts.length !== 3 || !parts[1]) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderOAuthTransitionHtml({ ok: false, message: 'Google 返回的 id_token 格式异常。' }));
            return;
          }
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as {
            sub?: string;
            email?: string;
            name?: string;
            email_verified?: boolean;
          };
          if (!payload.sub || !payload.email || payload.email_verified === false) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderOAuthTransitionHtml({ ok: false, message: 'Google 账号未验证邮箱或信息不完整。' }));
            return;
          }
          // 用 access_token 拉 userinfo 做最终复核（防 id_token 被重放）
          const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { authorization: `Bearer ${tok.access_token}` }
          });
          const info = (await infoRes.json()) as { sub?: string; email?: string };
          if (info.sub && info.sub !== payload.sub) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderOAuthTransitionHtml({ ok: false, message: 'Google 用户信息校验不一致。' }));
            return;
          }
          const r: AccountResult = await upsertGoogleUser(payload.sub, payload.email, payload.name);
          if (!r.ok || !r.token) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderOAuthTransitionHtml({ ok: false, message: '创建/登录本地账户失败，请稍后重试。' }));
            return;
          }
          const home = process.env.GOOGLE_OAUTH_SUCCESS_REDIRECT || '/';
          res.writeHead(200, {
            'set-cookie': authCookieValue(req, r.token),
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(renderOAuthTransitionHtml({
            ok: true,
            message: `欢迎回来，${r.username}！正在跳转到工作台…`,
            redirect: `${home}${home.includes('?') ? '&' : '?'}oauth=success`
          }));
          return;
        } catch (err) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderOAuthTransitionHtml({ ok: false, message: `Google OAuth 处理异常：${(err as Error)?.message ?? String(err)}` }));
          return;
        }
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
        return sendJson(
          res,
          { flags: features.getAll(), stats: features.getStats() },
          req
        );
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
              tickets: await approvalPolicy.list(
                status ? { status: (status as any) } : undefined
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
          const t = (await approvalPolicy.list()).find((x: ApprovalTicket) => x.id === id);
          return sendJson(res, t ? { ticket: t } : { error: 'not found' }, req);
        }
        if (req.method === 'POST') {
          const ctx = await guard(req, res, 'approvals:review');
          if (!ctx) return;
          const body = await readBody(req);
          const decision = body.decision === 'reject' ? 'reject' : 'approve';
          const t = await approvalPolicy.decide(id, decision, ctx.sub);
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
        return sendJson(res, { envs: envPipeline.list() }, req);
      }
      // 自定义模型 CRUD（SQLite 持久化；apiKey 由服务端 AES-GCM 加密落库，GET 仅回掩码）。
      // P1.1：owner 隔离——必须已登录且具备 provider:manage，owner 强制 = ctx.sub，
      // 忽略请求体任何 owner 字段（防越权）；admin/operator 额外可见平台遗留模型（includeLegacy）。
      // 仅当路径命中前缀时才读 body —— 否则会把请求流消费掉，导致后续路由再次 readBody 时挂起。
      if (path.startsWith('/api/custom-models')) {
        const ctx = await guard(req, res, 'provider:manage');
        if (!ctx) return;
        const cmBody = await readBody(req);
        if (
          await registerCustomModelRoutes(
            req,
            res,
            path,
            req.method ?? 'GET',
            cmBody,
            ctx.sub,
            ctx.role === 'admin' || ctx.role === 'operator'
          )
        )
          return;
      }
      if (req.method === 'POST' && path === '/api/run') {
        return await handleRun(req, res);
      }

      // P2.2 配额与用量看板：/api/account/usage（per-owner 滚动窗口用量 + 当前限额）。
      // owner 强制 = ctx.sub，与 provider-keys 同权限档（仅本人可见）。
      if (path === '/api/account/usage' && req.method === 'GET') {
        const ctx = await guard(req, res, 'provider:manage');
        if (!ctx) return;
        const usage = quotaEngine.getUsage(ctx.sub);
        const limits = quotaEngine.getQuota(ctx.sub);
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store'
        });
        res.end(
          JSON.stringify({
            usage,
            limits: {
              qps: limits.qps ?? null,
              maxConcurrency: limits.maxConcurrency ?? null,
              maxTokensPerWindow: limits.maxTokensPerWindow ?? null,
              maxCostPerWindow: limits.maxCostPerWindow ?? null,
              windowMs: limits.windowMs ?? null
            }
          })
        );
        return;
      }

      // P2.1 OpenRouter OAuth（PKCE）授权框架：/api/account/oauth*。
      // /config 与 /exchange 需登录（owner=ctx.sub）；/callback 为公开静态 HTML。
      if (path.startsWith('/api/account/oauth')) {
        if (path === '/api/account/oauth/callback') {
          if (await registerOAuthRoutes(req, res, path, req.method ?? 'GET'))
            return;
        } else {
          const ctx = await guard(req, res, 'provider:manage');
          if (!ctx) return;
          // 把已认证的 owner 暂存到 req，供 oauth 交换落库使用。
          (req as unknown as { ahOwner?: string }).ahOwner = ctx.sub;
          if (await registerOAuthRoutes(req, res, path, req.method ?? 'GET'))
            return;
        }
      }

      // 用户自带 LLM 凭据（BYOK）：/api/account/provider-keys*。
      // owner 强制 = ctx.sub（服务端认证身份），忽略请求体任何 owner/username（防越权）。
      if (path.startsWith('/api/account/provider-keys')) {
        const ctx = await guard(req, res, 'provider:manage');
        if (!ctx) return;
        const pkBody = await readBody(req);
        if (
          await registerProviderKeyRoutes(
            req,
            res,
            path,
            req.method ?? 'GET',
            pkBody,
            ctx.sub
          )
        )
          return;
      }

      /* ----------------- 多会话 Chat App：会话存储 CRUD ----------------- */
      // 注意：与已存在的 /api/sessions（agent 运行期会话）区分，聊天会话走独立前缀。
      // 客户端以版本化 URL /api/v1/chat/sessions 调用，服务端在路由前已统一重写
      // /api/v1 -> /api，故此处按重写后的 /api/chat/sessions 匹配。
      if (req.method === 'GET' && path === '/api/chat/sessions') {
        // 多用户隔离：必须已登录（非匿名）才能读取自己的会话列表；越权/匿名返回 401。
        const ctx = await guard(req, res, 'chat:read');
        if (!ctx) return;
        if (ctx.sub === 'anon') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'authentication required for chat history' }));
        }
        return sendJson(res, { sessions: listChatSessions(ctx.sub) }, req);
      }
      if (req.method === 'POST' && path === '/api/chat/sessions') {
        const b = await readBody(req);
        const ctx = await guard(req, res, 'chat:write', b);
        if (!ctx) return;
        if (ctx.sub === 'anon') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'authentication required for chat history' }));
        }
        return sendJson(
          res,
          createChatSession(b.title, ctx.sub, {
            interactionMode: b.interactionMode,
            model: b.model,
            agentId: b.agentId
          }),
          req
        );
      }
      if (req.method === 'GET' && path.startsWith('/api/chat/sessions/')) {
        const id = decodeURIComponent(path.slice('/api/chat/sessions/'.length));
        const ctx = await guard(req, res, 'chat:read');
        if (!ctx) return;
        if (ctx.sub === 'anon') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'authentication required for chat history' }));
        }
        const s = await getChatSession(id, ctx.sub);
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
        if (ctx.sub === 'anon') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'authentication required for chat history' }));
        }
        const s = await renameChatSession(id, b.title, ctx.sub, {
          interactionMode: b.interactionMode,
          model: b.model,
          agentId: b.agentId
        });
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
        if (ctx.sub === 'anon') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'authentication required for chat history' }));
        }
        const ok = await deleteChatSession(id, ctx.sub);
        return sendJson(res, { ok }, req);
      }

      /* ------------- 聊天实时广播通道（跨设备 / 跨标签页同步） ------------- */
      // 前端登录后建立一条常驻 SSE：按 owner 订阅 chat-bus，把本账户其它端写入的
      // 消息/标题/删除事件实时推回。单实例走进程内 fanout，多实例（有 Redis）走
      // chat-bus 的 pub/sub 桥自动跨实例转发。心跳保活，断线由前端按游标重连。
      if (req.method === 'GET' && path === '/api/chat/stream') {
        const ctx = await guard(req, res, 'chat:read');
        if (!ctx) return;
        if (ctx.sub === 'anon') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(
            JSON.stringify({ error: 'authentication required for chat stream' })
          );
        }
        const send = startSse(res, req);
        // 连接建立即时确认，便于前端判定通道已就绪。
        send({ type: 'chat:ready', owner: ctx.sub });
        const unsub = subscribeChatEvents(ctx.sub, (e) => {
          try {
            send(e);
          } catch {
            /* 连接已断，unsub 在 close 时执行 */
          }
        });
        res.on('close', () => {
          try {
            unsub();
          } catch {
            /* 重复 unsub 安全 */
          }
        });
        return;
      }

      /* ------------- 插件事件实时广播通道（SSE，提醒即时推送） ------------- */
      // 前端登录后建立一条常驻 SSE：按 owner 订阅 reminder-bus，只收本用户的备忘提醒
      // （memo:reminder 事件携带 owner，跨用户不互见）。前端据此立即弹 ah-notification +
      // 浏览器桌面通知（替代纯轮询）。心跳保活，断线前端按指数退避重连，
      // 重连期间漏掉的提醒由前端轮询 /api/plugins/memo/reminders 兜底补发。
      if (req.method === 'GET' && path === '/api/events') {
        const ctx = await guard(req, res, 'chat:read');
        if (!ctx) return;
        const send = startSse(res, req);
        // 连接建立即时确认（带 owner，便于前端核对归属）。
        send({ type: 'events:ready', owner: ctx.sub });
        const unsub = subscribeReminders(ctx.sub, (e) => {
          try {
            send(e);
          } catch {
            /* 连接已断，unsub 在 close 时执行 */
          }
        });
        res.on('close', () => {
          try {
            unsub();
          } catch {
            /* 重复 unsub 安全 */
          }
        });
        return;
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
          // 多用户隔离：必须已登录（非匿名）才能读取自己的历史索引；匿名返回 401。
          const ctx = await guard(req, res, 'chat:read');
          if (!ctx) return;
          if (ctx.sub === 'anon') {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'authentication required for chat history' }));
          }
          const index = await getHistoryStore().index(ctx.sub);
          return sendJson(res, { sessions: index }, req);
        }
        if (req.method === 'GET' && path.startsWith(HISTORY_PREFIX)) {
          const sid = decodeURIComponent(path.slice(HISTORY_PREFIX.length));
          const ctx = await guard(req, res, 'chat:read');
          if (!ctx) return;
          if (ctx.sub === 'anon') {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'authentication required for chat history' }));
          }
          if (!validSid(sid)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'invalid session id' }));
          }
          const row = await getHistoryStore().get(sid, ctx.sub);
          if (!row) {
            res.writeHead(404, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'history not found' }));
          }
          try {
            const parsed = JSON.parse(row.data);
            // 兼容旧版：data 可能是纯 msgs 数组，也可能是 { msgs, usage } 信封。
            const msgs = Array.isArray(parsed)
              ? parsed
              : Array.isArray(parsed?.msgs)
                ? parsed.msgs
                : [];
            const usage = !Array.isArray(parsed) ? parsed.usage ?? null : null;
            return sendJson(
              res,
              { ...row.meta, v: 1, msgs, usage },
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
          if (ctx.sub === 'anon') {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'authentication required for chat history' }));
          }
          // 参数校验：msgs 必须为数组；title 收敛为字符串；整体序列化体积受限。
          if (!Array.isArray(b.msgs)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'msgs must be an array' }));
          }
          let data: string;
          try {
            // 信封并行携带会话级用量快照（usage，可选），与 msgs 一并落盘，向后兼容旧版。
            data = JSON.stringify({ msgs: b.msgs, usage: b.usage ?? null });
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'msgs not serializable' }));
          }
          if (Buffer.byteLength(data, 'utf-8') > HISTORY_MAX_BYTES) {
            res.writeHead(413, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'history too large' }));
          }
          const now = Date.now();
          // owner 由服务端以 ctx.sub 强制写入，忽略客户端上报（防伪造归属）。
          await getHistoryStore().upsert(
            {
              sid,
              title:
                typeof b.title === 'string' && b.title.trim()
                  ? b.title.trim().slice(0, 200)
                  : '新对话',
              updatedAt:
                typeof b.updatedAt === 'number' && Number.isFinite(b.updatedAt)
                  ? Math.floor(b.updatedAt)
                  : now,
              savedAt: now
            },
            data,
            ctx.sub
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
          if (ctx.sub === 'anon') {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'authentication required for chat history' }));
          }
          const ok = await getHistoryStore().remove(sid, ctx.sub);
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
      // P1-④：Agent Teams API — 团队 CRUD
      if (req.method === 'GET' && path === '/api/teams') {
        const ctx = await guard(req, res, 'agent:read');
        if (!ctx) return;
        const tm = getTeamManager();
        if (!tm) return sendJson(res, { error: 'TeamManager not initialized' }, req);
        return sendJson(res, { teams: tm.list() }, req);
      }
      if (req.method === 'POST' && path === '/api/teams') {
        const body = await readBody(req);
        const ctx = await guard(req, res, 'agent:register', body);
        if (!ctx) return;
        auditAction('team.register', { role: ctx.role, sub: ctx.sub });
        try {
          const tm = getTeamManager();
          if (!tm) {
            return sendJson(res, { error: 'TeamManager not initialized' }, req);
          }
          const team: Team = { ...body, members: body.members ?? [] };
          await tm.register(team);
          return sendJson(res, { ok: true, team }, req);
        } catch (e: any) {
          return sendJson(res, { error: e?.message ?? String(e) }, req);
        }
      }
      if (req.method === 'DELETE' && path.startsWith('/api/teams/')) {
        const ctx = await guard(req, res, 'agent:register');
        if (!ctx) return;
        const teamId = path.slice('/api/teams/'.length).replace(/\/$/, '');
        auditAction('team.deregister', { teamId, role: ctx.role, sub: ctx.sub });
        const tm = getTeamManager();
        if (!tm) return sendJson(res, { error: 'TeamManager not initialized' }, req);
        tm.deregister(teamId);
        return sendJson(res, { ok: true }, req);
      }
      if (req.method === 'GET' && path.startsWith('/api/teams/')) {
        const ctx = await guard(req, res, 'agent:read');
        if (!ctx) return;
        const teamId = path.slice('/api/teams/'.length).replace(/\/$/, '');
        const tm = getTeamManager();
        if (!tm) return sendJson(res, { error: 'TeamManager not initialized' }, req);
        const team = tm.get(teamId);
        if (!team) return sendJson(res, { error: `Team not found: ${teamId}` }, req);
        return sendJson(res, { team }, req);
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
      if (req.method === 'POST' && path === '/api/mcp/remove') {
        const body = await readBody(req);
        const ctx = await guard(req, res, 'mcp:remove', body);
        if (!ctx) return;
        const name = String(body.name ?? '');
        if (!name) {
          return sendJson(res, { error: '缺少 name' }, req);
        }
        auditAction('mcp.remove', { name, role: ctx.role, sub: ctx.sub });
        try {
          await mcpManager.removeServer(name);
          return sendJson(res, { ok: true, servers: mcpManager.list() }, req);
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
      // 视图按当前登录用户渲染（数据 owner 绑定）：鉴权失败 401，开放模式 sub='anon'。
      if (req.method === 'GET' && path === '/api/plugins') {
        const viewUser = await authorizer.authenticate(req);
        if (!viewUser) {
          unauthorized(res);
          return;
        }
        const views = await pluginSystem.webHost.listViews({
          sub: viewUser.sub,
          role: viewUser.role
        });
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
            views
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
          const id = decodeURIComponent(m[1] ?? '');
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
          const id = decodeURIComponent(dm[1] ?? '');
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
              const err: any = new Error(
                'request body too large (20 MB limit)'
              );
              err.status = 413;
              throw err;
            }
            chunks.push(c as Buffer);
          }
          const result = await handleUpload(
            Buffer.concat(chunks),
            String(req.headers['content-type'] ?? '')
          );
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
        const filename = decodeURIComponent(um[1] ?? '');
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
      // 插件数据已按登录用户（owner）落库隔离：分发前必须鉴权，把当前用户传给插件路由。
      // 鉴权失败（无任何有效凭证）→ 401；开放/降级模式 authenticate 恒成功（sub='anon'），
      // 匿名数据归入共享 anon 桶，登录用户各归各桶。
      {
        const pluginUser = await authorizer.authenticate(req);
        if (!pluginUser) {
          audit({
            kind: 'request',
            method: req.method,
            path: req.url,
            ip: clientIp(req),
            authed: false,
            status: 401
          });
          unauthorized(res);
          return;
        }
        if (
          await pluginSystem.serverHost.handle(
            path,
            req,
            res,
            { sub: pluginUser.sub, role: pluginUser.role }
          )
        ) {
          return;
        }
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
  }
);

async function buildState(req: IncomingMessage) {
  let sandbox: unknown = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createOSSandboxExecutor } = require('@agent-harness/core');
    const exec = createOSSandboxExecutor();
    sandbox = (exec as { describe?(): unknown }).describe?.() ?? null;
  } catch {
    // 模块未加载 / 构造失败均不影响主状态
  }
  // 按用户计算 LLM 就绪状态（per-user，绝不依赖全局 env Key）。
  // 未登录（owner 为空）→ 保守视为未就绪；DB 未就绪同样回落未就绪。
  let llm = { ready: false, source: 'none' as string };
  try {
    const owner = await usernameFromCookie(req);
    if (owner) {
      const cred = await resolveRunCredential(owner, {});
      if (cred.apiKey) {
        llm = {
          ready: true,
          source: cred.source,
          ...(cred.provider ? { provider: cred.provider } : {}),
          ...(cred.keyHint ? { keyHint: cred.keyHint } : {}),
          // P2.3：该 Key 是否已到轮换阈值，前端据此提示用户轮换。
          ...(typeof cred.needsRotation === 'boolean'
            ? { keyNeedsRotation: cred.needsRotation }
            : {})
        } as typeof llm & {
          provider?: string;
          keyHint?: string;
          keyNeedsRotation?: boolean;
        };
      }
    }
  } catch {
    // 解析失败（DB 未就绪等）→ 保守视为未就绪，不影响 /api/state 主响应
  }
  return {
    // openrouter 复用为「当前登录用户是否具备真实 LLM 能力」的 pill 指示（per-user）。
    openrouter: llm.ready,
    llm,
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
        originalName: t.originalName,
        description: t.description ?? ''
      })),
      error: s.error ?? null
    })),
    mcpPresets: mcpManager
      .presets()
      .map((p) => ({ id: p.id, name: p.name, authType: p.authType })),
    envs: envPipeline.list()
  };
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
  // 多用户隔离：聊天历史/会话必须登录后才能写入；匿名（auth off 或未登录）直接拒。
  if (ctx.sub === 'anon') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'authentication required for chat history' }));
    return;
  }
  // 优雅停机期间不再接受新运行，避免任务在进程退出时被强杀。
  if (shuttingDown) {
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
  const maybeBroadcastStream = (e: any): void => {
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
      owner: ctx.sub
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
                .slice(0, Math.max(0, Number(ev.messageCount) || sessMsgs.length))
                .map((m) => ({
                  role: m.role,
                  content: m.content ?? '',
                  ts: typeof (m as { ts?: unknown }).ts === 'number'
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
                  工具: `${est.tools}${
                    estTotal
                      ? ` (${((est.tools / estTotal) * 100).toFixed(0)}%)`
                      : ''
                  }`,
                  历史: `${est.history}${
                    estTotal
                      ? ` (${((est.history / estTotal) * 100).toFixed(0)}%)`
                      : ''
                  }`,
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
            }, ctx.sub, body.origin || '');
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
    // 跨设备广播（进行中增量 / 终态全文）：与 send(e) 并列，仅影响其他连接。
    maybeBroadcastStream(e);
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
        }, ctx.sub, body.origin || '');
        // 计划模式任务派发镜像：confirmPlan 按普通问答派发每个任务，run:start 的
        // input 是「【计划任务 tX】标题」形状 —— 据此把 currentTaskId 写入进度镜像。
        const taskMatch = String(ev.input).match(/^【计划任务 (t\d+)】/);
        if (!isPlanPropose && taskMatch) {
          const taskId = taskMatch[1];
          updatePlanStatus(chatSessionId, (prev) => ({
            ...prev,
            status: 'running',
            currentTaskId: taskId,
            failedTaskId: undefined
          }), ctx.sub);
        }
      } else if (ev.type === 'error') {
        // 计划任务执行失败：进度镜像标记 failed + 失败节点，前端恢复时据此续跑。
        if (!isPlanPropose) {
          updatePlanStatus(chatSessionId, (prev) => ({
            ...prev,
            status: 'failed',
            failedTaskId: prev.currentTaskId,
            currentTaskId: undefined
          }), ctx.sub);
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
          updatePlanStatus(chatSessionId, (prev) => {
            if (!prev.currentTaskId || prev.done.includes(prev.currentTaskId))
              return prev;
            const done = [...prev.done, prev.currentTaskId];
            return {
              ...prev,
              status: 'running',
              done,
              currentTaskId: undefined
            };
          }, ctx.sub);
        }
        if (!(last && last.role === 'assistant' && last.content === finalStr)) {
          appendChatMessage(chatSessionId, {
            role: 'assistant',
            content: finalStr,
            ts: Date.now(),
            reasoning: reasoningBuf || undefined,
            tools: toolMap.size ? [...toolMap.values()] : undefined,
            trace: traceRoot ? [traceRoot] : undefined
          }, ctx.sub, body.origin || '');
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
    // 使用非阻塞接入：立刻返回「connecting」占位状态，避免 stdio 服务器
    // 启动耗时（如 uvx 下载包）阻塞 HTTP 响应。连接结果通过后续
    // /api/mcp/list 或健康探测反映到状态上。
    const meta = mcpManager.addServerBackground({
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
  // 多副本一致性自检：当明确声明「多实例」(REPLICA_COUNT>1 或 REPLICA_ID 非空) 时，
  // 运行队列与 AgentStore 必须走 redis，否则各副本各自内存态会导致任务丢失 / agent 漂移。
  // 默认开启；确有单实例或外部共享存储场景可用 REPLICA_CHECK=off 关闭（需自担风险）。
  if ((process.env.REPLICA_CHECK || 'on').toLowerCase() !== 'off') {
    const replicaCount = Number(process.env.REPLICA_COUNT ?? '');
    const multiReplica = replicaCount > 1 || !!process.env.REPLICA_ID;
    if (multiReplica) {
      const redisUrl = process.env.REDIS_URL || process.env.AGENT_STORE_REDIS_URL;
      const queueBackend = (process.env.RUN_QUEUE_BACKEND || '').toLowerCase();
      const agentStore = (process.env.AGENT_STORE || '').toLowerCase();
      const problems: string[] = [];
      if (!redisUrl) problems.push('REDIS_URL 未设置（多副本共享存储缺失）');
      if (queueBackend !== 'redis') problems.push(`RUN_QUEUE_BACKEND=${queueBackend || 'memory'}，应为 redis`);
      if (agentStore !== 'redis') problems.push(`AGENT_STORE=${agentStore || 'volatile'}，应为 redis`);
      if (problems.length) {
        const msg =
          `[multi-replica] 检测到多实例配置但共享后端未就绪：` +
          problems.join('；') +
          '。多副本下内存态队列/注册表会导致任务丢失与 agent 漂移。' +
          '请配置 REDIS_URL 并将 RUN_QUEUE_BACKEND/AGENT_STORE 设为 redis；' +
          '若确为单实例，请设 REPLICA_CHECK=off 关闭本自检。';
        log.error('multi-replica misconfig: refusing to start', {
          problems,
          replicaCount,
          replicaId: process.env.REPLICA_ID ?? null
        });
        // 启动期失败退出，交由编排（k8s/Render）重启并告警，优于带着错误配置静默上线。
        process.exit(1);
      }
      log.info('multi-replica self-check passed (redis-backed queue/registry)');
    }
  }
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

  // P2：指标持久化（跨重启保留累计计数 / token / 成本 / 租户维度）。
  // TELEMETRY_FILE 非空即启用自动落盘（定时 flush + 退出 flush）；默认关闭（'')，
  // 以免测试 / 无状态环境产生意外 IO。Render 部署设置 TELEMETRY_FILE=/app/data/telemetry-metrics.json 即可。
  const TELEMETRY_FILE = process.env.TELEMETRY_FILE ?? (DEFAULTS.TELEMETRY_FILE as string);
  if (TELEMETRY_FILE) {
    enableTelemetryAutosave(TELEMETRY_FILE);
    structLog('info', 'telemetry', { autosave: true, file: TELEMETRY_FILE });
  }

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
      (process.env.UI_TOKENS)
    ) {
      console.log(
        `   🔑 同时启用静态令牌 break-glass：IdP 不可用时可用 UI_TOKENS 直接鉴权（运维逃生通道）`
      );
    }
  } else {
    console.warn(
      `   ⚠️  未设置 UI_TOKENS，UI 接口处于开放状态（仅建议本地 / 演示使用）。`
    );
  }
  // 公网绑定 + 开放鉴权 = 任何人可匿名调用 admin 接口：高危告警。
  if (!REQUIRE_AUTH && HOST && !['localhost', '127.0.0.1', '::1'].includes(HOST)) {
    console.warn(
      `   ⛔ 安全告警：鉴权未启用（REQUIRE_AUTH=false）且监听在 ${HOST}（非本地回环）。\n` +
        `      任何人都能以匿名 admin 调用所有接口。公网部署前请设置 UI_TOKENS 或 ADMIN_API_KEY 并启用鉴权。`
    );
  }
  // OPEN_API_KEY 双用途告警：未单独设置 ADMIN_API_KEY 时，admin 鉴权实际依赖 LLM 密钥。
  if (process.env.OPEN_API_KEY && !process.env.ADMIN_API_KEY) {
    console.warn(
      `   ⚠️  OPEN_API_KEY 同时承担「LLM 密钥」与「站点 admin 凭证」两种职责（ADMIN_API_KEY 未设置）。\n` +
        `      建议设置 ADMIN_API_KEY 将二者解耦，避免同一密钥泄漏即同时失守模型计费与 admin 权限。`
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
    `   🔒 限流：${
      RATE_LIMIT > 0
        ? `每 IP ${RATE_LIMIT} 次 / ${RATE_WINDOW_MS / 1000}s`
        : '关闭'
    }；请求体上限：${MAX_BODY_BYTES} 字节`
  );
  if (AUDIT_LOG) console.log(`   📝 审计日志落盘：${AUDIT_LOG}`);
  console.log(
    `   OPEN_API_KEY: ${
      process.env.OPEN_API_KEY ? '已配置' : '未配置（Mock 模式可用）'
    }`
  );
  console.log(
    `   HARNESS_API_KEY: ${
      process.env.HARNESS_API_KEY
        ? '已配置'
        : '未配置（环境流水线走 dry-run 演示）'
    }`
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
        ? `（${
            process.env.OPEN_API_KEY
              ? '检测到 API key，用 llm 精准分类'
              : '无 API key，降级 rule 关键词分类'
          }）`
        : '')
  );
  // 沙箱隔离启动自检：当「环境要求 OS 级强隔离」却不可用时，显式高声告警，
  // 杜绝「以为有强隔离、其实静默降级为弱隔离」的安全错配（曾为稳定性隐患）。
  // 仅当 SANDBOX_BACKEND=os/java（或跨行业租户需强隔离）时才值得告警；
  // 默认 local/container 不在告警范围。
  try {
    const sandboxBackend = (process.env.SANDBOX_BACKEND || '').toLowerCase();
    const wantOsIsolation =
      sandboxBackend === 'os' || sandboxBackend === 'native' || isTenantRequired();
    if (wantOsIsolation) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createOSSandboxExecutor } = require('@agent-harness/core');
      const status = (createOSSandboxExecutor() as { describe?(): { backend: string; supported: boolean; reason: string } }).describe?.();
      if (status && status.backend === 'os-fallback-local') {
        log.warn('OS-level sandbox degraded to hardened local executor (weak isolation)', {
          reason: status.reason,
          sandboxBackend
        });
      } else if (status) {
        log.info('OS-level sandbox active', {
          backend: status.backend,
          supported: status.supported
        });
      }
    }
  } catch {
    /* 沙箱模块缺失时跳过自检，不影响启动 */
  }
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
