import { createServer } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  defaultPromptFor,
  getMemoryStore,
  invalidateSessionMemory,
  resetSessionMemory,
  assembleAgent,
  type RunMode
} from './runner';
import { mcpManager } from './mcp-manager';
import { runQueue, sseConnectionLock } from './run-queue';
import { envPipeline } from './env-pipeline';
import {
  getMetricsSnapshot,
  LATENCY_BUCKETS_MS,
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
  type WorkflowRun,
  type WorkflowEvent,
  type TaskEnvelope,
  type TaskResult,
  type A2ARequest,
  features,
  buildPlannerPrompt,
  parsePlanOutput,
  parsePlanOrClarify,
  planToWorkflowDef,
  type ExecutionPlan,
  type PlanClarify,
  DEFAULT_AGENT_ID,
  contextWindowFor,
  enableTelemetryAutosave,
  initOtlpExporter,
  getTeamManager,
  type Team
} from '@agent-harness/core';

// 错误明细存储（展示「错误数量 + 具体错误信息」）。
import {
  getErrorLog,
  getErrorSummary,
  formatErrorReport
} from '@agent-harness/core';
import { createWorkflowExecutor, workflowStore, type WorkflowExecutorOptions } from './workflow-executor';
import { resolvePlanVerify, parsePlanVerifyRetries } from './plan-verify';
import { runAgentTask } from './agent-run';
// md 交付文件预览（?preview=1）的服务端格式转换：markdown → HTML。
import { markdownPreviewHtml } from './markdown-preview';

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
import { corsHeaders, sendJson, startSse, readBody, readRawBody, securityHeaders, sendJsonError, safeEqualString } from './http-helpers';

// 插件系统（P1）：通用扩展点，无业务词。server 不静态依赖任何具体插件包。
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
  listChatSessionsPage,
  parseSessionPageQuery,
  getChatSession,
  peekChatSession,
  createChatSession,
  renameChatSession,
  deleteChatSession,
  appendChatMessage,
  replaceAndTruncateMessages,
  applyPlanWfTerminal,
  updatePlanStatus,
  extractPlanTaskId,
  type StoredTool,
  type TraceNode,
  type ChatMessage
} from './chat-sessions';

// 聊天历史镜像存储（ah_chat_history 接口层）：SQLite 临时持久化，预留正式数据库扩展点。
import { getHistoryStore } from './history-store';

// 聊天实时广播总线（跨设备/跨标签页/跨实例 fanout）。
import { subscribeChatEvents, publishChatEvent } from './chat-bus';

// 备忘提醒实时广播总线（进程内 fanout，单实例足够）。
import { subscribeReminders } from './reminder-bus';

// IM 桥接（用户层入口）：飞书 / 钉钉 / 企业微信 → agent → 回发。纯业务层，core 零感知。
import {
  createImRegistry,
  logImRegistry,
  createDedupStore,
  ImBridge,
  deriveImIdentity,
  type ImExecutor,
  type ImProvider
} from './im';

// 工作空间（参考图能力链路 User → Workspace → Skill → Tool → Data → Credential → Policy）。
import {
  createWorkspaceStore,
  ensureDefaultWorkspace,
  type Workspace
} from './workspace-store';

// 合规审计查询（读侧）：谁在何时做了什么 / 谁审批了谁 / 越权拦截记录。
import { queryAuditFile, resolveAuditFile } from './audit-query';
import { getOrgTree } from './org';
// P1-5 成果物归档页 / 文件库：Agent 产出物持久化 + 浏览 / 下载 / 删除。
import { getArtifactStore } from './artifact-store';
import { archivePlanArtifacts } from './plan-artifacts';
// P1-6 企业 Skill 管理：技能清单 + 启用 / 禁用。
import { getSkillRegistry } from './skill-registry';
// P1-7 企业数据源适配器：数据源注册 + 连通性测试。
// P1-4 浏览器沙箱：受控浏览器会话生命周期管理。
import { getSandboxManager } from './browser-sandbox';
// P1-8 CI 供应链：依赖 / 制品扫描与签名报告。
import { getSupplyChainScanner } from './supply-chain';
// P2-2 策略编辑器：RBAC 矩阵读写 + 预览。
import { getPolicyStore, validatePolicyDoc, allActions } from './policy-editor';
// P2-5 IM 多实例状态聚合。
import { getImStatusAggregator } from './im-status';
// P2-3 Plan 协同存储。
import {
  getPlanStore,
  type PlanDoc,
  type PlanDiff,
  type PlanNode,
  type PlanNodeStatus,
  type PlanStore
} from './plan-store';
// P2-3 Plan 协同事件总线（SSE 协同）。
import { publishPlanEvent } from './plan-bus';
// P3-1 品牌位配置。
import { getBrandConfig, isBrandUrlSafe, type BrandConfig } from './brand';
// P2-1 手机端：设备推送令牌存储。


// 业务策略层（与核心 framework 隔离）：RBAC 鉴权 + 审批工作流，均为可插拔接口。
import {
  createAuthorizer,
  isCookieAuth,
  type Authorizer,
  type AuthContext,
  type Action,
  type Role
} from './authz';

// 外部身份源（OIDC Bearer JWT 资源服务器 / proxy 头注入）。提供 JWKS 预热与前端鉴权元信息。
import { warmJwks, getAuthConfig } from './sso';
import {
  createApprovalPolicy,
  type ApprovalPolicy,
  type ApprovalTicket
} from './approval';
import {
  createEvaluator,
  type Evaluator,
  type RecipeStore
} from './eval';
import { createRetentionPolicy, type RetentionPolicy } from './retention';
import { buildOpenApiSpec } from './openapi';

// 文件上传（图片/文本附件）。

// 启动期环境变量 schema 校验（依赖无关，零新增依赖）。
import { logConfigValidation } from './config-schema';

// P2：全局日志脱敏 scrubber（拦截 API Key / token / password 等敏感信息）
import { installScrubber } from './log-scrub';

import { DEFAULTS, cfgNum } from './config-defaults';
import { rateLimited } from './rate-limit';
import { handleAccountRoutes, handleAccountOauthRoutes } from './routes/account-routes';
import { handleDeviceRoutes } from './routes/device-routes';
import { handleDatasourceRoutes } from './routes/datasource-routes';
import { handleUploadRoutes } from './routes/upload-routes';
import { handlePlanRoutes } from './routes/plan-routes';
import { handleApprovalRoutes } from './routes/approval-routes';
import { handleEvalRecipeRoutes } from './routes/eval-recipe-routes';
import { handleSkillRoutes } from './routes/skill-routes';
import { handleAgentRoutes } from './routes/agent-routes';
import { handleOpsRoutes } from './routes/ops-routes';
import { handlePolicyRoutes } from './routes/policy-routes';
import { handleMetricsRoutes } from './routes/metrics-routes';
import { handleMiscRoutes } from './routes/misc-routes';
import { handleCollabRoutes } from './routes/collab-routes';
import { handleChatDataRoutes } from './routes/chat-data-routes';
import { handleRun, handleWorkflow, activeWorkflowAborts, initRunRoutes, resolveWorkflowRunOpts, createPlanTaskSync, auditWfEvent } from './routes/run-routes';

// 租户上下文（P0.3 租户隔离）：解析 + 强制门禁。
import {
  resolveTenantContext,
  type TenantContext,
  audit as coreAudit,
  enableAuditFile as coreEnableAuditFile,
  enableJevInjection,
  getJevStats,
} from '@agent-harness/core';

// K8s健康检查端点
import { handleLiveness, handleReadiness } from './health';

// 自定义模型 SQLite 持久化 + AES-GCM 解密
import { registerCustomModelRoutes, decryptApiKey } from './custom-models';

import {
  registerProviderKeyRoutes,
  resolveRunCredential,
  resolveJevCredential,
  type CredentialResult
} from './provider-keys';

// P2.2 配额/用量看板：进程内配额引擎单例（per-owner 用量统计）。
import { quotaEngine } from '@agent-harness/core';

// P2.1 OpenRouter OAuth（PKCE）授权框架。
import { registerOAuthRoutes } from './oauth';

// 账户密码鉴权：注册 / 登录（签发 7 天 cookie token）。与 OIDC/proxy/静态令牌共存。
import {
  verifyDerivedHex,
  upsertGithubUser,
  upsertGoogleUser,
  usernameFromCookie,
  cookieValue,
  authCookieValue,
  CSRF_COOKIE,
  csrfCookieValue,
  issueCsrfToken,
  isAuthSecretConfigured,
  type AccountResult
} from './accounts';
import { REFRESH_TTL_MS } from './accounts';

// 密钥外部化：在读取任何 process.env 之前装配（平台 env / SECRETS_FILE / 本地 .env）。
import { loadSecrets } from './secrets';

// 接入层公开/运维探针路由表（可测试接缝，详见 routes/edge-routes.ts）。
import {
  createEdgeRoutes,
  tryDispatchEdgeRoute,
  type EdgeRouteDeps
} from './routes/edge-routes';

// 接入层结构化日志封装（统一收口启动横幅 / 降级告警 / 自检结论）。
import { log } from './logger';

// 必须在下方任何 `process.env.X` 顶层读取前执行（幂等，仅首次生效）。
loadSecrets();

// 告警通道：根据环境变量装配（Webhook / 日志文件），在捕获任何错误之前就位。
setupAlerting();

// Render (and most PaaS) inject PORT; fall back to UI_PORT then the local default.
// 默认值统一来自 config-defaults.DEFAULTS（单一事实来源，消除与 schema 校验的漂移）。
const PORT = Number(
  process.env.PORT ?? process.env.UI_PORT ?? (DEFAULTS.PORT as number)
);
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

// LLM 统一密钥 OPEN_API_KEY 主要作为模型调用凭证（@agent-harness/core 直接读 process.env.OPEN_API_KEY）。
// 出于向后兼容，OPEN_API_KEY 在 ADMIN_API_KEY 未设置时仍被接受为 admin 鉴权凭证（逃生通道 / 降级唯一凭证），
// 详见 authz.ts 的 createAuthorizer。新部署应显式设置 ADMIN_API_KEY，使「LLM 密钥」与「站点鉴权」职责分离。
// 站点鉴权主链路由「账户密码 / RBAC / OIDC / proxy」负责，未登录一律 401。
// 身份源：token（默认静态令牌）/ oidc（Bearer JWT）/ proxy（SSO 网关头注入）/ account（账户密码）。
const AUTH_PROVIDER = (
  process.env.AUTH_PROVIDER || (DEFAULTS.AUTH_PROVIDER as string)
).toLowerCase();
// 账户密码身份源开关（默认开）：开启后注册/登录可用，且强制要求鉴权（无有效登录态即 401）。
const ACCOUNT_AUTH =
  (
    process.env.ACCOUNT_AUTH ?? (DEFAULTS.ACCOUNT_AUTH as string)
  ).toLowerCase() !== 'off';
// 需要鉴权：非 token 模式、或启用账户密码鉴权、或配置了静态令牌（UI_TOKENS）。
// 若以上均不满足：降级模式下 admin key（ADMIN_API_KEY 或回退 OPEN_API_KEY）仍可作唯一凭证，
// 否则由账户密码档严格拒绝（无 cookie 即 401）。
const REQUIRE_AUTH =
  AUTH_PROVIDER !== 'token' || ACCOUNT_AUTH || !!process.env.UI_TOKENS;

// 安全加固配置（均可在 .env / 环境变量中调整）。
// 允许跨域的来源白名单（逗号分隔）；为空则仅同源（默认收紧，不再回 `*`，防 CSRF/跨域调用）。
const UI_CORS_ORIGIN = (
  process.env.UI_CORS_ORIGIN ?? (DEFAULTS.UI_CORS_ORIGIN as string)
)
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);
// 请求体上限（字节），防大报文 DoS。默认 1MB。
const MAX_BODY_BYTES = Number(
  process.env.MAX_BODY_BYTES ?? (DEFAULTS.MAX_BODY_BYTES as number)
);
// 单会话历史镜像序列化上限（字节）；超出后 PUT /api/history 直接 413。
// 前端据 /api/state 下发的 historyMaxBytes 主动裁剪，避免到服务器才拒绝。
const HISTORY_MAX_BYTES = cfgNum(
  'HISTORY_MAX_BYTES',
  DEFAULTS.HISTORY_MAX_BYTES as number
);
// 限流：单 IP 在窗口内的请求数；<=0 关闭限流。默认 120/60s。
// 用 cfgNum 读取（env 优先、非有限数回落默认），规避 `Number("abc")` 静默变 NaN 后误关限流。
const RATE_LIMIT = cfgNum('RATE_LIMIT', DEFAULTS.RATE_LIMIT as number);
// P0 修复：原代码误读 DEFAULTS.RATE_WINDOW_MS（该键不存在）→ Number(undefined)=NaN →
// 桶 resetAt 为 NaN → 一旦超阈值该 IP 永久 429 且 retry-after=NaN。正确键名为 RATE_LIMIT_WINDOW_MS。
const RATE_WINDOW_MS = cfgNum('RATE_LIMIT_WINDOW_MS', DEFAULTS.RATE_LIMIT_WINDOW_MS as number);
// 单已登录用户限流（防单账号滥用）；默认 60/60s，0=关闭。原内联读取 `|| 60` 对 env=0 静默变 60（关不掉）。
const USER_RATE_LIMIT = cfgNum('USER_RATE_LIMIT', DEFAULTS.USER_RATE_LIMIT as number);
// P1 安全加固：CSRF 双重提交令牌门禁开关。默认开启；CSRF_ENFORCE=off 可关闭
// （仅供无法升级的老客户端平滑过渡，生产不建议常关）。
const CSRF_ENFORCE = process.env.CSRF_ENFORCE !== 'off';
// 审计日志落盘路径；为空则仅输出到 stdout（JSON 行）。
const AUDIT_LOG = process.env.AUDIT_LOG ?? (DEFAULTS.AUDIT_LOG as string);

// 业务策略装配（组合根）：RBAC 鉴权器 + 审批策略。二者均为可插拔接口实现，
// 核心 framework 不感知任何角色/权限/审批概念。替换身份源或审批后端只需改这两个工厂。
const authorizer: Authorizer = createAuthorizer(REQUIRE_AUTH);

// 启动期配置校验：把「写错但静默启动」的 misconfig 显性化为日志告警（不阻断启动，向后兼容）。
logConfigValidation();

// 账户 token 签名密钥可见性提示：缺失 → 退化为每进程随机密钥，登录态重启即失效。
// 关键配置缺失时，上方 logConfigValidation() 在 AH_STARTUP_CRITICAL=1 下已阻断启动。
if (!isAuthSecretConfigured()) {
  console.warn(
    '[auth] ⚠️ AH_AUTH_SECRET / AH_CRYPTO_KEY 未配置：账户登录态将退化为每进程随机密钥，服务重启即全部失效。生产务必配置 64hex 密钥。'
  );
}

// P2：初始化全局日志脱敏 scrubber（拦截 API Key / token / password 等敏感信息）
if (process.env.LOG_SCRUB_ENABLED === 'true') {
  installScrubber({});
  structLog('info', 'log-scrub', { enabled: true, note: '全局日志脱敏已激活' });
}

// OIDC 模式：后台预热 JWKS（内联 OIDC_JWKS 无需网络），并每小时刷新密钥（IdP 轮换）。
if (AUTH_PROVIDER === 'oidc') {
  void warmJwks();
  const jwksTimer = setInterval(() => void warmJwks(), 3_600_000);
  if (typeof jwksTimer.unref === 'function') jwksTimer.unref();
}
const approvalPolicy: ApprovalPolicy = createApprovalPolicy();
// 评估与配方版本化（业务质量策略），同样由组合工厂装配，核心不感知。
const evaluator: Evaluator = createEvaluator();
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
  if (typeof xff === 'string' && xff.length)
    return (xff.split(',')[0] ?? '').trim();
  return req.socket?.remoteAddress || 'unknown';
}

// 固定窗口限流已收敛到 ./rate-limit（阈值与窗口显式传入）。
// 原先内联版本只往 Map 里 set 从不 delete，每个唯一 IP 永久占一条记录，
// 属确定性内存泄漏；新实现有惰性过期 + 定时 sweep + 容量上限三层防护。

/** SSE 长连接端点：固定窗口限流会把连接/重连计入同一计数器，极易在刷新时触发 429 螺旋。 */
function isSseEndpoint(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false;
  const path = String(req.url ?? '').split('?')[0];
  return path === '/api/events' || path === '/api/chat/stream';
}

/** 结构化审计：记录 时间/方法/路径/IP/鉴权/状态码 与动作级脱敏字段。
 * 委扲 @agent-harness/core 的 audit()（结构化 AuditEvent + enableAuditFile 文件句柄管理），
 * 取代原先裸写 appendFile 的非结构化实现，支持 pluggable auditSink 与 crash-safe 落盘。 */
function audit(rec: Record<string, unknown>): void {
  const outcome = rec.status != null
    ? (Number(rec.status) >= 400 ? 'failure' : Number(rec.status) >= 300 ? 'denied' : 'success')
    : (rec.outcome as 'success' | 'failure' | 'denied' | 'info' | undefined) ?? 'info';
  void coreAudit({
    tenantId: (rec.tenantId as string | null | undefined) ?? null,
    // P1 收尾：dataZone/residency 随审计落盘（调用方可通过 rec.dataZone / rec.residency 注入，
    // 缺省读 process.env.TENANT_DATA_ZONE 部署级基线，使合规审计报表可直接按数据分区出数）。
    dataZone: (rec.dataZone as string | undefined) ?? process.env.TENANT_DATA_ZONE,
    residency: rec.residency as string | undefined,
    actor: (rec.actor as string | null | undefined) ?? (rec.authed ? String(rec.sub ?? 'authenticated') : 'anonymous'),
    action: (rec.action as string) ?? (rec.kind === 'action' ? String(rec.kind) : 'request'),
    outcome,
    target: rec.target ? String(rec.target) : undefined,
    detail: {
      method: rec.method,
      path: rec.path,
      ip: rec.ip,
      authed: rec.authed,
      status: rec.status,
      ...(rec.detail as Record<string, unknown> | undefined),
    },
  });
  // 向 stdout 同步打印一份 JSON 行，供容器日志采集。
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec });
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
    return url.split('?')[0] ?? '';
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
  body?: Record<string, unknown>
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

  // P1 安全加固：CSRF 双重提交令牌校验。
  // 仅约束「cookie 来源 + 状态变更方法」的请求——Authorization/query/API key 的
  // 机器客户端没有 CSRF 面（浏览器不会替它们自动带 cookie）；GET/HEAD 无副作用不校验。
  if (
    CSRF_ENFORCE &&
    isCookieAuth(req) &&
    !['GET', 'HEAD', 'OPTIONS'].includes((req.method ?? 'GET').toUpperCase())
  ) {
    const cookieTok = cookieValue(req, CSRF_COOKIE) ?? '';
    const rawHeader = req.headers['x-csrf-token'];
    const headerTok = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader) ?? '';
    if (!cookieTok || !headerTok || !safeEqualString(cookieTok, headerTok)) {
      audit({
        kind: 'request',
        method: req.method,
        path: redactUrl(req.url),
        ip,
        authed: true,
        status: 403,
        reason: 'csrf token missing or mismatched'
      });
      res.writeHead(403, {
        'content-type': 'application/json',
        ...securityHeaders()
      });
      res.end(
        JSON.stringify({
          ok: false,
          error: 'CSRF 校验失败：缺少或无效的 x-csrf-token 头，请刷新页面后重试'
        })
      );
      return null;
    }
  }

  // P0.3 租户隔离：若强制租户隔离（REQUIRE_TENANT=true），校验请求携带的
  // 租户上下文（优先认证身份派生，其次请求体声明），无租户上下文则拒绝。
  const requireTenant = isTenantRequired();
  if (requireTenant) {
    const tenant = resolveTenantContext({
      tenantId: typeof body?.tenantId === 'string' ? body.tenantId : null,
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
      res.writeHead(403, {
        'content-type': 'application/json',
        ...securityHeaders()
      });
      res.end(
        JSON.stringify({
          error: 'forbidden',
          reason: 'tenant isolation required'
        })
      );
      return null;
    }
    // 将解析后的租户上下文附加到 AuthContext，供下游消费。
    (ctx as AuthContext & { tenantCtx?: TenantContext }).tenantCtx = tenant;
  }
  // SSE 长连接不计入固定窗口限流：其重连/保活特性会在刷新时产生瞬时请求尖峰，
  // 与短 API 共享同一 60s 桶极易误伤——故 IP 桶与用户桶都豁免（此前只豁免了 IP 桶，
  // 用户刷新打开流时仍会被用户桶误伤）。生产环境仍受连接数/代理层保护。
  const isSse = isSseEndpoint(req);
  const ipResult = isSse
    ? { limited: false, retryAfter: 0 }
    : rateLimited(ip, RATE_LIMIT, RATE_WINDOW_MS);
  // P1-5: 已登录用户按 sub 限流（防单账号滥用）；SSE 同样豁免（见上）。
  const userRateLimit = isSse || !ctx
    ? { limited: false, retryAfter: 0 }
    : rateLimited(ctx.sub, USER_RATE_LIMIT, RATE_WINDOW_MS);
  // retry-after 取两个桶中较大者：用户桶阈值（60）通常比 IP 桶（120）更严、先满，
  // 若只按 IP 桶剩余时间重试会立刻再撞墙形成风暴；对 SSE 还能刹住「用户桶拦但 retry-after=0 → 立即重连」的螺旋。
  const retryAfter = Math.max(ipResult.retryAfter, userRateLimit.retryAfter);
  if (ipResult.limited || (ctx && userRateLimit.limited)) {
    audit({
      kind: 'request',
      method: req.method,
      path: req.url,
      ip,
      authed: true,
      status: 429,
      ...(ctx ? { sub: ctx.sub } : {})
    });
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': String(Math.ceil(retryAfter / 1000)),
      ...corsHeaders(req),
      ...securityHeaders()
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
      ...corsHeaders(req),
      ...securityHeaders()
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
    case '/api/data/gdpr':
      return 'memory:clear';
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

function unauthorized(res: ServerResponse, req?: IncomingMessage): void {
  res.writeHead(401, {
    'content-type': 'application/json',
    ...corsHeaders(req ?? ({ headers: {} } as IncomingMessage)),
    ...securityHeaders()
  });
  res.end(JSON.stringify({ error: 'unauthorized: missing or invalid token' }));
}

// 启动时从环境变量加载并接入已配置的 MCP 服务（后台进行，不阻塞监听）。
mcpManager.init();

// 危险操作门禁：Jev 语义级注入打分增强（JEV_INJECTION_GATE=off 默认关闭，零行为变更）。
// 开启后，正则/短语基线仍先执行；仅当基线放行时再跑 Jev 语义打分，出错/缺配回落基线（兜底）。
if ((process.env.JEV_INJECTION_GATE || 'off').toLowerCase() === 'on') {
  enableJevInjection();
}

// ── IM 桥接（用户层入口：飞书 / 钉钉 / 企业微信）──
// 装配「已配置且启用」的平台适配器；未开 IM_ENABLED 时整体 no-op（零副作用）。
// agent 执行经注入的 executor 复用既有 assembleAgent + harness 链路（护栏/记忆/配额/审计全生效），
// 对话按 IM owner 落库 chat-sessions，因此在 Web 工作台「历史会话」中同样可见。
const imRegistry = createImRegistry();
logImRegistry(imRegistry);

const imExecutor: ImExecutor = async (msg, prompt, cfg) => {
  const { owner, sessionId } = deriveImIdentity(msg);
  const origin = `im:${msg.provider}`;
  // 落库用户消息（IM 侧输入在 Web 工作台可见）。
  appendChatMessage(sessionId, { role: 'user', content: prompt, ts: Date.now() }, owner, origin);
  // TypeSafe AI Jev 决策工具按用户 BYOK：与 LLM Key 同源、按 owner 隔离解析。
  const jevCred = await resolveJevCredential(owner);
  const mode: RunMode = cfg.defaultMode;
  const assembled = await assembleAgent(
    mode,
    undefined, // onEvent：IM 场景无需流式回推（平台侧按整条消息回复）
    undefined, // systemPrompt：沿用默认
    undefined, // modelOverride
    prompt,
    `${owner}::${sessionId}`,
    undefined, // signal
    cfg.timeoutMs,
    cfg.maxSteps,
    undefined, // memoryArg
    undefined, // verifier
    undefined, // verifyMaxRetries
    undefined, // card
    undefined, // tenantCtx
    undefined, // sandboxBackend
    undefined, // streamTokens
    undefined, // webEnabled
    undefined, // planPropose
    undefined, // planTask
    undefined, // modelBaseUrl
    undefined, // modelApiKey
    undefined, // ctxWindow
    undefined, // apiKeys
    jevCred.apiKey,
    jevCred.baseUrl
  );
  const final = await assembled.harness.run(prompt);
  appendChatMessage(sessionId, { role: 'assistant', content: final, ts: Date.now() }, owner, origin);
  return final;
};

const imBridge = new ImBridge(
  imRegistry.config,
  imExecutor,
  { onAudit: (e) => auditAction(e.action, { ...e }) },
  // 去重后端：配了 REDIS_URL 走 Redis（多副本跨实例去重），否则内存 LRU。
  createDedupStore()
);

// 工作空间存储：WORKSPACE_FILE 配置即持久化，否则内存态（默认零行为变更）。
const workspaceStore = createWorkspaceStore();

/** 空间访问控制：admin 全可见；否则需为成员（owner 天然是成员）。 */
function canAccessWorkspace(ws: Workspace, sub: string, role: string): boolean {
  return role === 'admin' || ws.members.includes(sub) || ws.owner === sub;
}

/** 把查询参数解析为 epoch ms（支持纯数字时间戳或 ISO 字符串）；非法返回 undefined。 */
function toEpochMs(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** 合法审计 outcome 白名单。 */
const AUDIT_OUTCOMES = ['success', 'failure', 'denied', 'info'] as const;

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
        await tryDispatchEdgeRoute(
          edgeRoutes,
          req,
          res,
          url,
          edgeRouteDeps(),
          path
        )
      ) {
        return;
      }
      // ── IM 桥接入站（webhook）──
      // 无用户登录态，安全闸门是各平台签名校验（在 ImBridge 内完成），故必须放在 guard 之前。
      //   POST /api/im/:provider/events  —— 消息事件回调
      //   GET  /api/im/:provider/events  —— URL 验证握手（企业微信 echostr / 飞书 challenge）
      const imMatch = /^\/api\/im\/(feishu|dingtalk|wecom)\/events\/?$/.exec(path);
      if (imMatch && (req.method === 'POST' || req.method === 'GET')) {
        const provider = imMatch[1] as ImProvider;
        let raw = '';
        if (req.method === 'POST') {
          try {
            // 必须读原始字节：签名校验对字节序敏感，JSON 往返会破坏验签。
            raw = await readRawBody(req);
          } catch (e) {
            const status = (e as { status?: number }).status ?? 400;
            sendJsonError(res, status, { error: e instanceof Error ? e.message : String(e) }, req);
            return;
          }
        }
        const result = await imBridge.handleInbound(provider, {
          headers: req.headers,
          rawBody: raw,
          url
        });
        res.writeHead(result.status, {
          'content-type': result.contentType ?? 'application/json; charset=utf-8',
          ...securityHeaders()
        });
        res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
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
      // 这两个端点本身公开（不需要先登录），但会被上面的 guard 默认拦截，
      // 故显式放在 guard 之前处理。
      // ── 账户路由（/api/account/*）：已外迁 routes/account-routes.ts（P2 模块化第一批）──
      if (await handleAccountRoutes(req, res, url, path, { guard, audit, clientIp })) {
        return;
      }
      // OAuth（github/google 授权码流）：已外迁 routes/account-routes.ts（第六批）
      if (await handleAccountOauthRoutes(req, res, path)) {
        return;
      }
      if (await handleDeviceRoutes(req, res, path, { guard })) {
        return;
      }
      // ── 策略 / 合规 / 品牌：已外迁 routes/policy-routes.ts ──
      if (await handlePolicyRoutes(req, res, url, path, { guard, auditAction, retentionPolicy, openApiSpec, imBridge })) {
        return;
      }
      // ── P2-3 Plan 协同：已外迁 routes/plan-routes.ts ──
      if (await handlePlanRoutes(req, res, url, path, { guard, auditAction })) {
        return;
      }

      // POST 动作由各 handler 在读取 body 后自行 guard（需先判定 run mode 等）。
      const readAct = readAction(path);
      if (readAct && req.method === 'GET') {
        const ctx = await guard(req, res, readAct);
        if (!ctx) return;
      }
      // ── 可观测指标：已外迁 routes/metrics-routes.ts ──
      if (await handleMetricsRoutes(req, res, path)) {
        return;
      }
      // ---- P0.1 智能体注册与发现 / A2A / Teams：已外迁 routes/agent-routes.ts ----
      if (await handleAgentRoutes(req, res, url, path, { guard, auditAction, isShuttingDown: () => shuttingDown })) {
        return;
      }

      // ---- P1-⑤：工作流编排（DAG 执行快照查询 + 续跑 + 审批放行 + 显式取消）----
      // GET  /api/workflows/:id     → 执行快照
      // POST /api/workflows/:id/resume → 从断点续跑
      // POST /api/workflows/:id/approve → P3 人工审批放行（写入检查点 approvals 后续跑）
      // POST /api/workflows/:id/cancel → P5.4 显式取消（abort 活动 run；断连不再隐式中止）
      if (path.startsWith('/api/workflows/')) {
        const isResume = req.method === 'POST' && path.endsWith('/resume');
        const isApprove = req.method === 'POST' && path.endsWith('/approve');
        const isCancel = req.method === 'POST' && path.endsWith('/cancel');
        // POST /resume、/approve、/cancel 会影响执行中的 agent（写操作）→ workflow:run；GET 快照 → workflow:read。
        const ctx = await guard(req, res, isResume || isApprove || isCancel ? 'workflow:run' : 'workflow:read');
        if (!ctx) return;
        const id = decodeURIComponent(
          path.slice('/api/workflows/'.length).replace(/\/$/, '')
        );
        // POST /resume 路径单独处理
        if (req.method === 'POST' && id.endsWith('/resume')) {
          const workflowId = id.slice(0, -'/resume'.length);
          if (!workflowId) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing workflow id' }));
            return;
          }
          let closed = false;
          // P5.4 断连不再中止（同首跑语义）：续跑期间客户端断开（后台标签节流 / 网络抖动），
          // 服务端 run 继续跑完并落检查点；显式取消走 POST /:id/cancel（活动 run 注册表）。
          const runAbort = new AbortController();
          res.on('close', () => {
            closed = true;
          });
          // P1（断点续跑）：resume body 与执行端点同构（mode / BYOK 模型凭据 / ctxWindow /
          // web / verify / sessionId）——检查点按 P1.3 纪律不存明文凭据，续跑时按登录 owner
          // 重新解析凭据；real 模式无 Key 在 SSE 开启前 402 快速失败。旧客户端不带 body 时
          // readBody 返回 {} → 默认 mock，向后兼容。
          const body = await readBody(req);
          // P4.5：前置读检查点 def，判定续跑是否沿用 plan 桥语义（默认验证门禁 +
          // 逐 task 结果断言 + 重试预算）；手工工作流（def 无 failOnInvalidOutput）零回归。
          // 读失败保守按未命中（非 plan），下方原有 try 块的 404 / wf:error 语义不变。
          const store = workflowStore();
          let existing: unknown;
          try {
            existing = await store.get(workflowId);
          } catch {
            existing = undefined;
          }
          const isPlanWorkflow = !!(
            existing &&
            typeof existing === 'object' &&
            (existing as { def?: { failOnInvalidOutput?: boolean } }).def?.failOnInvalidOutput
          );
          const execOpts = await resolveWorkflowRunOpts(body, ctx, res, isPlanWorkflow);
          if (!execOpts) return; // 402 已写出（SSE 未开，不进入异步执行）
          let send: (payload: unknown) => void = () => {};
          try {
            if (!existing) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'workflow not found', id: workflowId }));
              return;
            }
            // 检查是否可续跑：steps 是 Record<stepId, StepRun>（非数组）；
            // 终态 = done / skipped / compensated，存在任何非终态 step 即可续跑。
            const stepValues = Object.values(
              (existing as { steps?: Record<string, { state?: string }> }).steps ?? {}
            );
            const unfinished = stepValues.filter(
              (s) => s.state !== 'done' && s.state !== 'skipped' && s.state !== 'compensated',
            );
            if (unfinished.length === 0) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'no unfinished steps to resume' }));
              return;
            }
            send = startSse(res, req);
            // plan 来源工作流续跑同样同步计划看板（P2-3，幂等节流）；仅当请求显式携带 sessionId。
            const planSync = createPlanTaskSync(
              typeof body.sessionId === 'string' ? body.sessionId : undefined,
              ctx.sub
            );
            auditAction('workflow.resume', {
              workflowId,
              mode: execOpts.mode,
              role: ctx.role,
              sub: ctx.sub
            });
            const engine = new DagEngine({
              store,
              executor: createWorkflowExecutor({
                // P5 静默展示（plan 桥工作流续跑同首跑语义）：抑制 llm:token 流式内容。
                onEvent: (e: { type?: string }, stepId: string) => {
                  if (isPlanWorkflow && e?.type === 'llm:token') return;
                  if (!closed) send({ type: 'harness', event: e, stepId });
                },
                // P1（断点续跑）：BYOK / verify / mode 与执行端点共享解析结果透传（此前缺失 →
                // real 部署下续跑首 step 复现 t1 同款 401/无 Key 故障）。
                mode: execOpts.mode,
                ...execOpts.opts,
              }),
              onEvent: (e: unknown) => {
                // 断点续跑同样产生 wf:step:failed / wf:done / wf:failed → 节点级审计对齐（见 auditWfEvent）。
                if (e && typeof e === 'object' && 'type' in e) {
                  const ev = e as WorkflowEvent;
                  auditWfEvent(ev, ctx);
                  planSync?.sync(ev);
                }
                if (!closed) send(e);
              },
            });
            // P5.4：登记活动 run（显式取消通道），终态时移除（finally 透传原结果/异常）。
            activeWorkflowAborts.set(workflowId, runAbort);
            const run = await engine
              .resume(workflowId, runAbort.signal)
              .finally(() => activeWorkflowAborts.delete(workflowId));
            // P4.6：续跑终态同样归档交付文件（按 runId+stepId 幂等去重，首跑已归档的自动跳过）。
            await archivePlanArtifacts({ def: run.def, run, owner: ctx.sub }).catch((e) => {
              console.warn(`[plan-artifacts] 归档失败（不阻断执行）：${e instanceof Error ? e.message : String(e)}`);
            });
            if (!closed) send({ type: '_wf_done', workflowId, run });
            if (!closed) res.end();
          } catch (e) {
            if (!closed)
              send({ type: 'wf:error', workflowId, message: e instanceof Error ? e.message : String(e) });
            if (!closed) res.end();
          }
          return;
        }
        // P3（人工审批门）：POST /api/workflows/:id/approve —— 把 stepId 写入检查点
        // run.approvals 后触发 DagEngine.resume（引擎据此跳过审批门继续执行，可能再次
        // 暂停在下一道门并再发 wf:awaiting-approval）。骨架与 /resume 同款（共享
        // resolveWorkflowRunOpts 的 BYOK 解析 + startSse + planSync + 审计）。
        if (req.method === 'POST' && id.endsWith('/approve')) {
          const workflowId = id.slice(0, -'/approve'.length);
          if (!workflowId) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing workflow id' }));
            return;
          }
          let closed = false;
          // P5.3 断连即中止（同首跑 / resume 语义）：审批放行后的续跑期间客户端断开 → 中止引擎 run。
          const runAbort = new AbortController();
          res.on('close', () => {
            closed = true;
            if (!res.writableEnded) runAbort.abort();
          });
          const body = await readBody(req);
          const execOpts = await resolveWorkflowRunOpts(body, ctx, res);
          if (!execOpts) return; // 402 已写出（SSE 未开，不进入异步执行）
          let send: (payload: unknown) => void = () => {};
          try {
            const store = workflowStore();
            const run = await store.get(workflowId);
            if (!run) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'workflow not found', id: workflowId }));
              return;
            }
            // 终态工作流不可审批放行（无未决门）。
            if (run.state === 'done' || run.state === 'compensated') {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: `workflow in terminal state ${run.state}; nothing to approve` }));
              return;
            }
            // 审批目标：stepId（单节点）/ all:true（当前所有未决门节点）二选一。
            // 候选 = 检查点中非终态（awaiting / pending / running / failed）的 step：
            // awaiting 是正在等放行的门；failed 经审批同样可放行重试（配合旧语义的
            // 断点续跑）；pending/running 放行无害（下一波次自然执行）。
            const stepStates = Object.values((run as unknown as { steps?: Record<string, { state?: string }> }).steps ?? {}) as Array<{ state?: string; id?: string }>;
            const openIds = stepStates.filter((s) => s.state !== 'done' && s.state !== 'skipped' && s.state !== 'compensated').map((s) => s.id!).filter(Boolean);
            const stepId = typeof body.stepId === 'string' && body.stepId ? body.stepId : undefined;
            let approved: string[];
            if (body.all === true) {
              approved = openIds;
            } else if (stepId) {
              if (!openIds.includes(stepId)) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: `step "${stepId}" is not open (state: ${(run as unknown as { steps?: Record<string, { state?: string }> }).steps?.[stepId]?.state ?? 'absent'})` }));
                return;
              }
              approved = [stepId];
            } else {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'approve requires body.stepId (single node) or body.all=true (all open gates)' }));
              return;
            }
            if (approved.length === 0) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'no open steps to approve' }));
              return;
            }
            // 写入检查点（随 FileWorkflowStore 持久化，跨重启保留放行决定）：
            // 去重合并，同 id 重复审批幂等。
            const prev = new Set(Array.isArray(run.approvals) ? run.approvals : []);
            for (const id2 of approved) prev.add(id2);
            (run as unknown as { approvals?: string[] }).approvals = [...prev];
            await store.save(run);
            auditAction('workflow.approve', {
              workflowId,
              approved,
              all: body.all === true,
              mode: execOpts.mode,
              role: ctx.role,
              sub: ctx.sub
            });
            send = startSse(res, req);
            const planSync = createPlanTaskSync(
              typeof body.sessionId === 'string' ? body.sessionId : undefined,
              ctx.sub
            );
            const engine = new DagEngine({
              store,
              executor: createWorkflowExecutor({
                // P5 静默展示（plan 桥工作流审批续跑同首跑语义）：抑制 llm:token 流式内容。
                onEvent: (e: { type?: string }, stepId: string) => {
                  const isPlanWf = !!(run as unknown as { def?: { failOnInvalidOutput?: boolean } }).def?.failOnInvalidOutput;
                  if (isPlanWf && e?.type === 'llm:token') return;
                  if (!closed) send({ type: 'harness', event: e, stepId });
                },
                // P1（断点续跑）：BYOK / verify / mode 与执行端点共享解析结果透传。
                mode: execOpts.mode,
                ...execOpts.opts,
              }),
              onEvent: (e: unknown) => {
                // 审批放行后续跑同样产生 wf:* 事件（含下一道门的 wf:awaiting-approval）→ 审计 + 看板对齐。
                if (e && typeof e === 'object' && 'type' in e) {
                  const ev = e as WorkflowEvent;
                  auditWfEvent(ev, ctx);
                  planSync?.sync(ev);
                }
                if (!closed) send(e);
              },
            });
            // P5.4：登记活动 run（显式取消通道），终态时移除（finally 透传原结果/异常）。
            activeWorkflowAborts.set(workflowId, runAbort);
            const run2 = await engine
              .resume(workflowId, runAbort.signal)
              .finally(() => activeWorkflowAborts.delete(workflowId));
            // P4.6：审批放行续跑终态同样归档交付文件（幂等去重，前序已归档的自动跳过）。
            await archivePlanArtifacts({ def: run2.def, run: run2, owner: ctx.sub }).catch((e) => {
              console.warn(`[plan-artifacts] 归档失败（不阻断执行）：${e instanceof Error ? e.message : String(e)}`);
            });
            if (!closed) send({ type: '_wf_done', workflowId, run: run2 });
            if (!closed) res.end();
          } catch (e) {
            if (!closed)
              send({ type: 'wf:error', workflowId, message: e instanceof Error ? e.message : String(e) });
            if (!closed) res.end();
          }
          return;
        }
        // P5.4 显式取消：abort 活动 run 的引擎 signal。引擎捕获 abort → 检查点落 failed
        // （step 保留已完成状态），用户可经「从失败任务继续」从断点续跑。仅取消「本进程
        // 正在运行」的 run —— 无活动 run（已终态 / 服务重启后只剩检查点）时直接 ok 返回，
        // 幂等不报错（前端取消语义不受影响：卡片已本地置 cancelled）。
        if (isCancel) {
          const workflowId = id.slice(0, -'/cancel'.length);
          if (!workflowId) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing workflow id' }));
            return;
          }
          const ctrl = activeWorkflowAborts.get(workflowId);
          if (ctrl) {
            ctrl.abort();
            auditAction('workflow.cancel', {
              workflowId,
              role: ctx.role,
              sub: ctx.sub
            });
          }
          return sendJson(
            res,
            { ok: true, workflowId, cancelled: !!ctrl },
            req
          );
        }
        // GET 取单个工作流执行快照
        if (req.method === 'GET') {
          const run = id ? await workflowStore().get(id) : null;
          if (!run) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflow not found', id }));
            return;
          }
          return sendJson(res, { workflow: run }, req);
        }
      }
      // ── 审批工单：已外迁 routes/approval-routes.ts ──
      if (await handleApprovalRoutes(req, res, url, path, { guard, auditAction, approvalPolicy })) {
        return;
      }

      // ── 评估与配方：已外迁 routes/eval-recipe-routes.ts ──
      if (await handleEvalRecipeRoutes(req, res, path, { guard, auditAction, evaluator })) {
        return;
      }

      // ── 合规审计查询（谁在何时做了什么 / 谁审批了谁 / 越权拦截记录）──
      // 数据源为 AUDIT_LOG 落盘的 append-only JSONL（写入侧早已就绪，本路由补齐读取侧）。
      // ── P1-6 企业 Skill 管理：已外迁 routes/skill-routes.ts ──
      if (await handleSkillRoutes(req, res, path, { guard })) {
        return;
      }

      // ── P1-7 企业数据源适配器：已外迁 routes/datasource-routes.ts ──
      if (await handleDatasourceRoutes(req, res, path, { guard })) {
        return;
      }

      // ── P1-8 CI 供应链（受 supplychain:read 保护）──
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

      // Jev（TypeSafe AI 决策模型）状态自检：凭据来源 / 子系统开关 / 进程内调用统计。
      // 不回传任何密钥明文，用于回答「Jev 是否已配置、是否真的被调用过」。
      // 用户自带 LLM 凭据（BYOK）：/api/account/provider-keys*。
      // owner 强制 = ctx.sub（服务端认证身份），忽略请求体任何 owner/username（防越权）。
      /* ------------- 聊天实时广播通道（跨设备 / 跨标签页同步） ------------- */
      // 前端登录后建立一条常驻 SSE：按 owner 订阅 chat-bus，把本账户其它端写入的
      // 消息/标题/删除事件实时推回。单实例走进程内 fanout，多实例（有 Redis）走
      // chat-bus 的 pub/sub 桥自动跨实例转发。心跳保活，断线由前端按游标重连。
      if (req.method === 'GET' && path === '/api/chat/stream') {
        const ctx = await guard(req, res, 'chat:read');
        if (!ctx) return;
        if (ctx.sub === 'anon') {
          sendJsonError(res, 401, { error: 'authentication required for chat stream' }, req);
          return;
        }
        // P1-3: SSE 连接数上限检查（防止恶意客户端耗尽连接）
        if (!sseConnectionLock.acquire()) {
          sendJsonError(res, 503, { error: 'too many sse connections' }, req);
          return;
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
          sseConnectionLock.release();
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
        // P1-3: SSE 连接数上限检查
        if (!sseConnectionLock.acquire()) {
          sendJsonError(res, 503, { error: 'too many sse connections' }, req);
          return;
        }
        const send = startSse(res, req);
        // 连接建立即时确认（带 owner，便于前端核对归属）。
        send({ type: 'events:ready', owner: ctx.sub });
        // 支持 role 参数：role=service 订阅客服业务提醒，默认 role=user 订阅备忘提醒
        const url = new URL(req.url ?? '', 'http://localhost');
        const role = url.searchParams.get('role') === 'service' ? 'service' : 'user';
        const unsub = subscribeReminders(ctx.sub, (e) => {
          try {
            send(e);
          } catch {
            /* 连接已断，unsub 在 close 时执行 */
          }
        }, role);
        res.on('close', () => {
          try {
            unsub();
          } catch {
            /* 重复 unsub 安全 */
          }
          sseConnectionLock.release();
        });
        return;
      }

      /* ------------- 聊天历史镜像 CRUD（ah_chat_history 接口层） ------------- */
      if (req.method === 'POST' && path === '/api/workflows') {
        return await handleWorkflow(req, res);
      }
      // ── 运维/工具端点（verify / mcp / shell / env / jobs）：已外迁 routes/ops-routes.ts ──
      if (await handleOpsRoutes(req, res, path, { guard, auditAction, redactUrl })) {
        return;
      }
      // ── 数据 / 合规 / 运维杂项：已外迁 routes/misc-routes.ts ──
      if (await handleMiscRoutes(req, res, url, path, { guard, auditAction, authorizer })) {
        return;
      }
      // ── 协作资源（工作空间 / 成果物 / 沙箱）：已外迁 routes/collab-routes.ts ──
      if (await handleCollabRoutes(req, res, url, path, { guard, auditAction, workspaceStore })) {
        return;
      }
      // ── 聊天数据（chat-sessions / history / provider-keys）：已外迁 routes/chat-data-routes.ts ──
      if (await handleChatDataRoutes(req, res, url, path, { guard })) {
        return;
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
            plugins: pluginSystem.loader
              .list()
              .map(
                (r: {
                  manifest: { id: string; name?: string; version?: string; dependencies?: string[] };
                  state: string;
                }) => ({
              id: r.manifest.id,
              name: r.manifest.name ?? r.manifest.id,
              version: r.manifest.version,
              state: r.state,
                dependencies: r.manifest.dependencies ?? []
              })
            ),
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
          } catch (e) {
            return sendJson(
              res,
              { error: e instanceof Error ? e.message : String(e) },
              req
            );
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
          } catch (e) {
            return sendJson(
              res,
              { error: e instanceof Error ? e.message : String(e) },
              req
            );
          }
        }
      }
      // ── 文件上传：已外迁 routes/upload-routes.ts ──
      if (await handleUploadRoutes(req, res, path, { guard })) {
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
          await pluginSystem.serverHost.handle(path, req, res, {
            sub: pluginUser.sub,
            role: pluginUser.role
          })
        ) {
          return;
        }
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      logError('http.request', e, { path: req.url });
      const code =
        typeof (e as { status?: unknown }).status === 'number'
          ? (e as { status: number }).status
          : 500;
      if (!res.headersSent) {
        res.writeHead(code, { 'content-type': 'application/json' });
      }
      res.end(
        JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
      );
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
    // 历史镜像体积上限随 state 下发：前端据此在 saveThread 前主动裁剪，避免 413 回来的再裁剪。
    historyMaxBytes: HISTORY_MAX_BYTES,
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
      tools: s.tools.map(
        (t: { registeredName?: string; originalName?: string; description?: string }) => ({
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
      (redis as unknown as { on?(ev: string, cb: (e: Error) => void): void }).on?.(
        'error',
        (e: Error) => console.error('[agent-store] redis error:', e.message)
      );
      console.log(`[agent-store] using Redis backend${url ? ` (${url})` : ''}`);
    } catch (e) {
      console.error(
        '[agent-store] ioredis 不可用，回退内存态 volatile 后端：',
        e instanceof Error ? e.message : e
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

async function bootstrap(): Promise<void> {
  // 多副本一致性自检：当明确声明「多实例」(REPLICA_COUNT>1 或 REPLICA_ID 非空) 时，
  // 运行队列与 AgentStore 必须走 redis，否则各副本各自内存态会导致任务丢失 / agent 漂移。
  // 默认开启；确有单实例或外部共享存储场景可用 REPLICA_CHECK=off 关闭（需自担风险）。
  if ((process.env.REPLICA_CHECK || 'on').toLowerCase() !== 'off') {
    const replicaCount = Number(process.env.REPLICA_COUNT ?? '');
    const multiReplica = replicaCount > 1 || !!process.env.REPLICA_ID;
    if (multiReplica) {
      const redisUrl =
        process.env.REDIS_URL || process.env.AGENT_STORE_REDIS_URL;
      const queueBackend = (process.env.RUN_QUEUE_BACKEND || '').toLowerCase();
      const agentStore = (process.env.AGENT_STORE || '').toLowerCase();
      const problems: string[] = [];
      if (!redisUrl) problems.push('REDIS_URL 未设置（多副本共享存储缺失）');
      if (queueBackend !== 'redis')
        problems.push(
          `RUN_QUEUE_BACKEND=${queueBackend || 'memory'}，应为 redis`
        );
      if (agentStore !== 'redis')
        problems.push(`AGENT_STORE=${agentStore || 'volatile'}，应为 redis`);
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
  // TELEMETRY_FILE 非空即启用自动落盘（定时 flush + 退出 flush）；默认关闭（''），
  // 以免测试 / 无状态环境产生意外 IO。Render 部署设置 TELEMETRY_FILE=/app/data/telemetry-metrics.json 即可。
  const TELEMETRY_FILE =
    process.env.TELEMETRY_FILE ?? (DEFAULTS.TELEMETRY_FILE as string);
  if (TELEMETRY_FILE) {
    enableTelemetryAutosave(TELEMETRY_FILE);
    structLog('info', 'telemetry', { autosave: true, file: TELEMETRY_FILE });
  }

  // P1 修复：接通 OTLP 导出器（此前 initOtlpExporter 定义了但从未被调用，分布式追踪/指标导出静默失效）。
  // OTEL_EXPORTER_OTLP_ENDPOINT 非空即启用；未配置时零开销跳过；可选依赖缺失时静默降级，不影响启动。
  await initOtlpExporter();
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    structLog('info', 'telemetry', {
      otlp: true,
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    });
  }

  // P2.a：启用结构化审计日志落盘（委托 @agent-harness/core 的 enableAuditFile）。
  // AUDIT_LOG 非空即启用 crash-safe 落盘（tmp+rename）；默认关闭仅 stdout。
  // 生产环境应通过 configmap/Secret 显式设置 AUDIT_LOG=/app/data/audit/audit.jsonl。
  if (AUDIT_LOG) {
    await coreEnableAuditFile(AUDIT_LOG);
    structLog('info', 'audit', { file: AUDIT_LOG });
  }

  // P0-B 修复：启动时装配 quotaEngine 默认配额，确保 MAX_COST_PER_WINDOW 真正生效。
  // 若不在此处 setDefault，quotaEngine.admit() 的硬上限分支会因 defaultQuotaCfg.maxCostPerWindow=undefined
  // 而短路，导致成本硬上限永远不拦截（"看起来有接线、实际完全不工作"）。
  const maxCostPerWindow = Number(process.env.MAX_COST_PER_WINDOW) || 0;
  if (maxCostPerWindow > 0) {
    quotaEngine.setDefault({ maxCostPerWindow });
    structLog('info', 'quota', {
      enabled: true,
      maxCostPerWindow,
    });
  }

  // P0-D: 启动时自动运行迁移脚本，确保 schema 与代码版本一致。
  // AH_MIGRATE_AUTO=on/1/true 时启用，默认关闭（避免开发环境意外执行）。
  // P1-3: 迁移脚本使用幂等版本检查（SELECT MAX(version)），重复运行安全。
  const MIGRATE_AUTO = (process.env.AH_MIGRATE_AUTO ?? 'off').toLowerCase();
  if (['on', '1', 'true'].includes(MIGRATE_AUTO)) {
    const { execSync } = await import('node:child_process');
    const _m = (globalThis as unknown as { import?: { meta?: { url?: string } } })
      .import?.meta;
    const MIGRATE_SCRIPT = join(
      dirname(_m?.url ? fileURLToPath(_m.url) : __dirname),
      '..', '..', 'scripts', 'db-migrate.cjs'
    );
    try {
      const result = execSync(`node "${MIGRATE_SCRIPT}" --action up`, {
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      structLog('info', 'migration', { status: 'success', output: result.trim() });
      console.log('[migration] 启动迁移完成:', result.trim());
    } catch (e) {
      console.error('[migration] 启动迁移失败:', e instanceof Error ? e.message : String(e));
      // 不阻断启动，但记录错误以便运维排查。
    }
  } else {
    console.log('[migration] AH_MIGRATE_AUTO 未启用，跳过启动时迁移（如需启用请设置 AH_MIGRATE_AUTO=on）');
  }

  // P0-E: 启动定时备份调度器（进程内 setInterval，替代外部 cron 依赖）。
  const AH_BACKUP_ENABLED = (process.env.AH_BACKUP_ENABLED ?? 'on').toLowerCase();
  if (['on', '1', 'true'].includes(AH_BACKUP_ENABLED)) {
    const { scheduleBackup } = await import('./backup-scheduler');
    scheduleBackup();
  }

  // P1-8: 启动数据留存调度器（按策略定期清理过期记录）。
  const AH_RETENTION_ENABLED = (process.env.AH_RETENTION_ENABLED ?? 'on').toLowerCase();
  if (['on', '1', 'true'].includes(AH_RETENTION_ENABLED)) {
    const { scheduleRetention } = await import('./retention');
    scheduleRetention();
  }

  // R1 收口：把组合根闭包（guard/auditAction/shuttingDown）注入 run 路由模块。
  initRunRoutes({ guard, auditAction, isShuttingDown: () => shuttingDown });
  server.listen(PORT, HOST, onListening);
}

function onListening(): void {
  const registry = getAgentRegistry();
  console.log(`\n🚀 Agent Harness UI 已启动： http://localhost:${PORT}`);
  // 构建新鲜度自检（防「改了源码但跑的是旧 dist」排障陷阱）：
  // 打印本文件的构建时间，并在启动前发现源码晚于构建时显式告警。
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { statSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    const { join, dirname } = require('node:path') as typeof import('node:path');
    const distServer = __filename;
    const builtAt = statSync(distServer).mtime;
    console.log(`   📦 后端构建时间：${builtAt.toLocaleString('zh-CN', { hour12: false })}（dist/server.js）`);
    // 以 src 目录最新 mtime 粗略对比：src 比构建新 → 提醒重新 build（informational，不阻断）。
    const srcDir = join(dirname(__dirname), 'src');
    let newestSrc = 0;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) walk(p);
        else if (name.name.endsWith('.ts')) {
          const m = statSync(p).mtimeMs;
          if (m > newestSrc) newestSrc = m;
        }
      }
    };
    walk(srcDir);
    if (newestSrc > builtAt.getTime()) {
      console.warn(
        `   ⚠️  检测到 src/ 源码比 dist/ 构建产物新 —— 当前运行的是旧代码！` +
          `请先执行构建（如 pnpm --filter @agent-harness/core --filter @agent-harness/server run build）再启动。`
      );
    }
  } catch {
    /* 自检失败不影响启动 */
  }
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
      process.env.UI_TOKENS
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
  if (
    !REQUIRE_AUTH &&
    HOST &&
    !['localhost', '127.0.0.1', '::1'].includes(HOST)
  ) {
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
  const storeKind =
    (registry as unknown as { store?: { kind?: string } })?.store?.kind ?? 'volatile';
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
      sandboxBackend === 'os' ||
      sandboxBackend === 'native' ||
      isTenantRequired();
    if (wantOsIsolation) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createOSSandboxExecutor } = require('@agent-harness/core');
      const status = (
        createOSSandboxExecutor() as {
          describe?(): { backend: string; supported: boolean; reason: string };
        }
      ).describe?.();
      if (status && status.backend === 'os-fallback-local') {
        log.warn(
          'OS-level sandbox degraded to hardened local executor (weak isolation)',
          {
            reason: status.reason,
            sandboxBackend
          }
        );
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
    } catch (e) {
      structLog('warn', 'alert webhook failed', {
        error: e instanceof Error ? e.message : String(e)
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
    setAlertSink(async (a: unknown) => {
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
