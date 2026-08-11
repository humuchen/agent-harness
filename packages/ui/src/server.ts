import { createServer } from 'node:http';
import { accessSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assembleAgent, defaultPromptFor, type RunMode } from './runner';
import { runVerification, type VerifyEvent } from './verification';
import { mcpManager } from './mcp-manager';
import { envPipeline } from './env-pipeline';
import type { HarnessEvent, McpTransportType } from '@agent-harness/core';

// Render (and most PaaS) inject PORT; fall back to UI_PORT then the local default.
const PORT = Number(process.env.PORT ?? process.env.UI_PORT ?? 4173);
const HOST = process.env.UI_HOST ?? '0.0.0.0';

// 接口鉴权：设置 UI_AUTH_TOKEN 后，除健康检查与静态页外的所有 API 都需
// `Authorization: Bearer <token>`（或 `?token=<token>`）。未设置则保持开放
//（仅建议本地 / 演示使用，启动时会给出告警）。
const UI_AUTH_TOKEN = process.env.UI_AUTH_TOKEN || '';
const REQUIRE_AUTH = !!UI_AUTH_TOKEN;

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
      '/api/env',
      '/api/run',
      '/api/verify',
      '/api/mcp/add',
    ];
    if (PROTECTED.includes(path) && !authorized(req, url)) {
      return unauthorized(res);
    }
    if (req.method === 'GET' && path === '/api/mcp/list') {
      return sendJson(res, { servers: mcpManager.list() });
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
    if (req.method === 'POST' && path === '/api/env') {
      return await handleEnv(req, res);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e: any) {
    console.error('[ui] request error:', e?.message ?? e);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
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
      toolCount: s.tools.length,
      tools: s.tools.map((t) => ({ registeredName: t.registeredName, originalName: t.originalName })),
      error: s.error ?? null,
    })),
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

function sendJson(res: ServerResponse, obj: unknown): void {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function startSse(res: ServerResponse): (obj: unknown) => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
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
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = startSse(res);
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const body = await readBody(req);
  const mode: RunMode = ['mock', 'real', 'real-mcp'].includes(body.mode) ? body.mode : 'mock';
  const prompt: string = (body.prompt && String(body.prompt).trim()) || defaultPromptFor(mode);
  const model: string | undefined = body.model ? String(body.model).trim() : undefined;

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
  const send = startSse(res);
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  await readBody(req);
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
  try {
    const meta = await mcpManager.addServer({ name, serverUrl, command, args, env, headers, transportType });
    sendJson(res, { server: meta, servers: mcpManager.list() });
  } catch (e: any) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message ?? String(e) }));
  }
}

async function handleEnv(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = startSse(res);
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const body = await readBody(req);
  const action = body.action;

  if (action === 'create') {
    const input = {
      envType: String(body.env_type ?? 'ephemeral'),
      branch: String(body.branch ?? 'main'),
      ttlHours: body.ttl_hours != null ? Number(body.ttl_hours) : undefined,
      region: body.region ? String(body.region) : undefined,
      owner: body.owner ? String(body.owner) : undefined,
    };
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
    console.log(`   🔒 接口鉴权已启用（UI_AUTH_TOKEN）`);
  } else {
    console.warn(`   ⚠️  未设置 UI_AUTH_TOKEN，UI 接口处于开放状态（仅建议本地 / 演示使用）。`);
  }
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
