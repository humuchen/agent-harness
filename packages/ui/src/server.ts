import { createServer } from 'node:http';
import { accessSync } from 'node:fs';
import { readFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assembleAgent, defaultPromptFor, type RunMode } from './runner';
import { runVerification, type VerifyEvent } from './verification';
import { mcpManager } from './mcp-manager';
import { envPipeline } from './env-pipeline';
import { approve as approveShell, preapprove as preapproveShell, shellSignature } from './shell-approval';
import type { HarnessEvent, McpTransportType } from '@agent-harness/core';
import { getMetricsSnapshot } from '@agent-harness/core';

// Render (and most PaaS) inject PORT; fall back to UI_PORT then the local default.
const PORT = Number(process.env.PORT ?? process.env.UI_PORT ?? 4173);
const HOST = process.env.UI_HOST ?? '0.0.0.0';

// 接口鉴权：设置 UI_AUTH_TOKEN 后，除健康检查与静态页外的所有 API 都需
// `Authorization: Bearer <token>`（或 `?token=<token>` 兼容旧用法）。
// 未设置则保持开放（仅建议本地 / 演示使用，启动时会给出告警）。
const UI_AUTH_TOKEN = process.env.UI_AUTH_TOKEN || '';
const REQUIRE_AUTH = !!UI_AUTH_TOKEN;

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

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!REQUIRE_AUTH) return true;
  const auth = req.headers['authorization'];
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() === UI_AUTH_TOKEN;
  }
  const t = url.searchParams.get('token');
  if (t) return t === UI_AUTH_TOKEN;
  return false;
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized: missing or invalid token' }));
}

// 启动时从环境变量加载并接入已配置的 MCP 服务（后台进行，不阻塞监听）。
mcpManager.init();

// 解析 public 目录：优先进程工作目录下的 public，回退到源码相对路径。
function publicDir(): string {
  const fromCwd = resolve(process.cwd(), 'public');
  try {
    accessSync(fromCwd);
    return fromCwd;
  } catch {
    return resolve(__dirname, '..', 'public');
  }
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

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
      return await serveHtml(res);
    }
    if (req.method === 'GET' && path === '/api/state') {
      // 健康检查端点保持开放（Render 等 PaaS 无法在健康检查中带令牌）。
      return sendJson(res, buildState());
    }
    // 受保护端点：需通过 UI_AUTH_TOKEN 校验（未配置则开放）。
    const PROTECTED: string[] = [
      '/api/mcp/list',
      '/api/mcp/presets',
      '/api/env',
      '/api/run',
      '/api/verify',
      '/api/mcp/add',
      '/api/mcp/preset',
      '/api/mcp/reconnect',
      '/api/shell/approve',
      '/api/metrics',
    ];
    if (PROTECTED.includes(path)) {
      const ip = clientIp(req);
      if (!authorized(req, url)) {
        audit({ kind: 'request', method: req.method, path, ip, authed: false, status: 401 });
        return unauthorized(res);
      }
      if (rateLimited(ip)) {
        audit({ kind: 'rate-limit', method: req.method, path, ip });
        res.writeHead(429, { 'content-type': 'application/json', ...corsHeaders(req) });
        res.end(JSON.stringify({ error: 'rate limit exceeded' }));
        return;
      }
      audit({ kind: 'request', method: req.method, path, ip, authed: true });
    }
    if (req.method === 'GET' && path === '/api/mcp/list') {
      return sendJson(res, { servers: mcpManager.list() });
    }
    if (req.method === 'GET' && path === '/api/mcp/presets') {
      // 开箱预设清单（Context7 / GitHub / Composio 等），供前端「预设市场」一键接入。
      return sendJson(res, { presets: mcpManager.presets() });
    }
    if (req.method === 'GET' && path === '/api/metrics') {
      // 可观测性指标（token 用量 / 延迟 / 错误率 / 工具调用数 / 成本）。受保护，需令牌。
      return sendJson(res, getMetricsSnapshot(), req);
    }
    if (req.method === 'GET' && path === '/api/env') {
      return sendJson(res, { envs: envPipeline.list() });
    }
    if (req.method === 'POST' && path === '/api/run') {
      return await handleRun(req, res);
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
      const name = String(body.name ?? '');
      if (!name) {
        return sendJson(res, { error: '缺少 name' }, req);
      }
      auditAction('mcp.reconnect', { name });
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
    console.error('[ui] request error:', e?.message ?? e);
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
    model: (process.env.OPENROUTER_MODEL && process.env.OPENROUTER_MODEL.trim()) || 'openai/gpt-4o-mini',
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
  readFile(join(publicDir(), 'index.html'))
    .then((buf) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buf);
    })
    .catch((e) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('UI 文件未找到，请先构建：npm run ui\n' + (e?.message ?? ''));
    });
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
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
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
  const send = startSse(res, req);
  const mode: RunMode = ['mock', 'real', 'real-mcp'].includes(body.mode) ? body.mode : 'mock';
  const prompt: string = (body.prompt && String(body.prompt).trim()) || defaultPromptFor(mode);
  const model: string | undefined = body.model ? String(body.model).trim() : undefined;
  auditAction('agent.run', { mode, promptLen: prompt.length, model: model ?? null });

  try {
    let stepCount = 0;
    const assembled = await assembleAgent(
      mode,
      (e: HarnessEvent) => {
        if (e.type === 'step:start') stepCount = Math.max(stepCount, e.step);
        if (!closed) send(e);
      },
      undefined,
      model,
      prompt
    );
    send({
      type: 'run:meta',
      mode,
      llmKind: assembled.llmKind,
      dryRun: assembled.dryRun,
      mcpConnected: assembled.mcpConnected,
      notes: assembled.notes,
      model: (model && model.trim()) || (process.env.OPENROUTER_MODEL && process.env.OPENROUTER_MODEL.trim()) || 'openai/gpt-4o-mini',
      tokenBudget: assembled.tokenBudget ?? null,
      costBudget: assembled.costBudget ?? null,
      failover: assembled.failover,
    });
    send({ type: 'run:tools', tools: assembled.tools.schemas() });

    const finalText = await assembled.harness.run(prompt);
    if (!closed) send({ type: 'run:end', final: finalText, steps: stepCount });
    if (!closed) send({ type: '_done', final: finalText });
  } catch (e: any) {
    send({ type: 'error', message: e?.message ?? String(e) });
    send({ type: '_done', final: '', error: true });
  } finally {
    if (!closed) res.end();
  }
}

async function handleVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  await readBody(req);
  const send = startSse(res, req);
  try {
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
  auditAction('mcp.add', { name, url: redactUrl(serverUrl), command: command ?? null });
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
  const id = String(body.id ?? '').trim();
  const token = body.token != null ? String(body.token) : undefined;
  if (!id) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '缺少预设 id（如 context7 / github / composio）' }));
    return;
  }
  auditAction('mcp.preset', { id });
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
  const command = String(body.command ?? '');
  const args = Array.isArray(body.args) ? body.args.map(String) : [];
  if (!command) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '缺少 command' }));
    return;
  }
  auditAction('shell.approve', { command, preapprove: body.preapprove === true });
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
    auditAction('env.create', { envType: input.envType, branch: input.branch, region: input.region ?? null, owner: input.owner ?? null });
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
    auditAction('env.destroy', { envId });
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
  console.log(`\n🚀 Agent Harness UI 已启动： http://localhost:${PORT}`);
  console.log(`   模式：Mock（离线）/ Real LLM / Real + MCP`);
  if (REQUIRE_AUTH) {
    console.log(`   🔒 接口鉴权已启用（UI_AUTH_TOKEN）：请求需 Authorization: Bearer <token>`);
  } else {
    console.warn(`   ⚠️  未设置 UI_AUTH_TOKEN，UI 接口处于开放状态（仅建议本地 / 演示使用）。`);
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

// 进程退出时关闭 MCP 连接（stdio 子进程 / SSE 长连接），避免资源泄漏。
async function shutdown(): Promise<void> {
  console.log('\n[ui] 正在关闭，清理 MCP 连接…');
  await mcpManager.shutdown().catch(() => {});
  server.close(() => process.exit(0));
  // 兜底：若 server.close 因长连接迟迟不结束，3 秒后强制退出。
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

export {};
