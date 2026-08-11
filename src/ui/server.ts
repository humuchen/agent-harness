import { createServer } from 'node:http';
import { accessSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assembleAgent, defaultPromptFor, type RunMode } from './runner';
import { runVerification, type VerifyEvent } from './verification';
import { mcpManager } from './mcp-manager';
import { envPipeline } from './env-pipeline';
import type { HarnessEvent } from '../index';

// Render (and most PaaS) inject PORT; fall back to UI_PORT then the local default.
const PORT = Number(process.env.PORT ?? process.env.UI_PORT ?? 4173);
const HOST = process.env.UI_HOST ?? '0.0.0.0';

// 启动时从环境变量加载并接入已配置的 MCP 服务（后台进行，不阻塞监听）。
mcpManager.init();

// 解析 public 目录：优先进程工作目录下的 public，回退到源码相对路径。
function publicDir(): string {
  const fromCwd = resolve(process.cwd(), 'public');
  try {
    accessSync(fromCwd);
    return fromCwd;
  } catch {
    return resolve(__dirname, '..', '..', '..', 'public');
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
      return sendJson(res, buildState());
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
    model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
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
    const assembled = await assembleAgent(mode, (e: HarnessEvent) => {
      if (e.type === 'step:start') stepCount = Math.max(stepCount, e.step);
      if (!closed) send(e);
    }, undefined, model);
    send({
      type: 'run:meta',
      mode,
      llmKind: assembled.llmKind,
      dryRun: assembled.dryRun,
      mcpConnected: assembled.mcpConnected,
      notes: assembled.notes,
      model: model ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
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

async function handleMcpAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const name = String(body.name ?? '').trim();
  const url = String(body.url ?? '').trim();
  const headers = body.headers && typeof body.headers === 'object' ? body.headers : undefined;
  if (!name || !url) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'name 与 url 均为必填' }));
    return;
  }
  try {
    const meta = await mcpManager.addServer(name, url, headers);
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
  console.log(`   OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? '已配置' : '未配置（Mock 模式可用）'}`);
  console.log(`   HARNESS_API_KEY: ${process.env.HARNESS_API_KEY ? '已配置' : '未配置（环境流水线走 dry-run 演示）'}`);
  console.log(`   MCP_SERVER_URL: ${process.env.MCP_SERVER_URL ?? '未配置'}\n`);
});

export {};
