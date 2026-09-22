/**
 * 运维 / 工具端点路由（自 server.ts 外迁，P2 模块化第五批）。
 *
 * 覆盖：GET /api/jobs、/api/mcp/*（list/presets/add/preset/reconnect/remove）、
 *       POST /api/verify（SSE）、POST /api/shell/approve、GET+POST /api/env（SSE）。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpTransportType } from '@agent-harness/core';
import { runVerification, type VerifyEvent } from '../verification';
import { mcpManager } from '../mcp-manager';
import { runQueue } from '../run-queue';
import { envPipeline } from '../env-pipeline';
import {
  approve as approveShell,
  preapprove as preapproveShell,
  shellSignature
} from '../shell-approval';
import { readBody, sendJson, startSse } from '../http-helpers';
import type { Action, AuthContext } from '../authz';

export interface OpsRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action,
    body?: Record<string, unknown>
  ) => Promise<AuthContext | null>;
  auditAction: (action: string, fields: Record<string, unknown>) => void;
  /** server.ts 的 URL 脱敏助手（去掉查询串，避免内嵌 token 进审计日志）。 */
  redactUrl: (url?: string) => string;
}

// 合法的传输类型（与 core 的 McpTransportType 保持一致）。
const MCP_TRANSPORT_TYPES = new Set(['auto', 'sse', 'streamable-http']);

export async function handleOpsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: OpsRouteDeps
): Promise<boolean> {
  const isOps =
    path === '/api/jobs' ||
    path.startsWith('/api/mcp/') ||
    path === '/api/verify' ||
    path === '/api/shell/approve' ||
    path === '/api/env';
  if (!isOps) return false;

  if (req.method === 'GET' && path === '/api/jobs') {
    // 运行队列的脱敏状态快照（运维视角）：当前排队/执行数、最近若干 job 概要。
    sendJson(res, { queue: runQueue.stats(), jobs: runQueue.list() }, req);
    return true;
  }
  if (req.method === 'GET' && path === '/api/mcp/list') {
    sendJson(res, { servers: mcpManager.list() });
    return true;
  }
  if (req.method === 'GET' && path === '/api/mcp/presets') {
    // 开箱预设清单（Context7 / GitHub / Composio 等），供前端「预设市场」一键接入。
    sendJson(res, { presets: mcpManager.presets() });
    return true;
  }
  if (req.method === 'GET' && path === '/api/env') {
    sendJson(res, { envs: envPipeline.list() }, req);
    return true;
  }
  if (req.method === 'POST' && path === '/api/verify') {
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'verify', body);
    if (!ctx) return true;
    const send = startSse(res, req);
    try {
      deps.auditAction('verify', { role: ctx.role, sub: ctx.sub });
      await runVerification((e: VerifyEvent) => {
        if (!closed) send(e);
      });
      if (!closed) send({ type: '_verify_done' });
    } catch (e) {
      if (!closed)
        send({ type: 'verify:error', id: '0', message: e instanceof Error ? e.message : String(e) });
      if (!closed) send({ type: '_verify_done' });
    } finally {
      if (!closed) res.end();
    }
    return true;
  }
  if (req.method === 'POST' && path === '/api/mcp/add') {
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'mcp:add', body);
    if (!ctx) return true;
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
      return true;
    }
    deps.auditAction('mcp.add', {
      name,
      url: deps.redactUrl(serverUrl),
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
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }
  if (req.method === 'POST' && path === '/api/mcp/preset') {
    // 一键接入预设 MCP 服务（Context7 / GitHub / Composio 等）。
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'mcp:preset', body);
    if (!ctx) return true;
    const id = String(body.id ?? '').trim();
    const token = body.token != null ? String(body.token) : undefined;
    if (!id) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: '缺少预设 id（如 context7 / github / composio）'
        })
      );
      return true;
    }
    deps.auditAction('mcp.preset', { id, role: ctx.role, sub: ctx.sub });
    try {
      const meta = await mcpManager.connectPreset(id, token);
      sendJson(res, { server: meta, servers: mcpManager.list() }, req);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }
  if (req.method === 'POST' && path === '/api/mcp/reconnect') {
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'mcp:reconnect', body);
    if (!ctx) return true;
    const name = String(body.name ?? '');
    if (!name) {
      sendJson(res, { error: '缺少 name' }, req);
      return true;
    }
    deps.auditAction('mcp.reconnect', { name, role: ctx.role, sub: ctx.sub });
    try {
      const meta = await mcpManager.reconnect(name);
      sendJson(res, { server: meta }, req);
    } catch (e) {
      sendJson(res, { error: e instanceof Error ? e.message : String(e) }, req);
    }
    return true;
  }
  if (req.method === 'POST' && path === '/api/mcp/remove') {
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'mcp:remove', body);
    if (!ctx) return true;
    const name = String(body.name ?? '');
    if (!name) {
      sendJson(res, { error: '缺少 name' }, req);
      return true;
    }
    deps.auditAction('mcp.remove', { name, role: ctx.role, sub: ctx.sub });
    try {
      await mcpManager.removeServer(name);
      sendJson(res, { ok: true, servers: mcpManager.list() }, req);
    } catch (e) {
      sendJson(res, { error: e instanceof Error ? e.message : String(e) }, req);
    }
    return true;
  }
  if (req.method === 'POST' && path === '/api/shell/approve') {
    // 审批一次待执行的 shell 命令（配合 SHELL_REQUIRE_CONFIRM=true）。
    // body: { command, args, preapprove? }。preapprove=true 时仅登记永久批准、不等待。
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'shell:approve', body);
    if (!ctx) return true;
    const command = String(body.command ?? '');
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    if (!command) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少 command' }));
      return true;
    }
    deps.auditAction('shell.approve', {
      command,
      preapprove: body.preapprove === true,
      role: ctx.role,
      sub: ctx.sub
    });
    if (body.preapprove === true) {
      preapproveShell(shellSignature(command, args));
      sendJson(res, { preapproved: true }, req);
      return true;
    }
    const released = approveShell(command, args);
    sendJson(res, { waitingReleased: released }, req);
    return true;
  }
  if (req.method === 'POST' && path === '/api/env') {
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const body = await readBody(req);
    // R5 修复：非法 action 必须在 startSse 之前拒绝——SSE 头一旦写出就无法再
    // 回 400（headers-sent 冲突），此前会 fall-through 到外层兜底变成 200 错误 JSON。
    if (body.action !== 'create' && body.action !== 'destroy') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'action 必须是 create 或 destroy' }));
      return true;
    }
    // 按动作类型映射为细分动作，做角色授权 + 审批判定（create/destroy 需审批）。
    const envAction: Action =
      body.action === 'destroy' ? 'env:destroy' : 'env:create';
    const ctx = await deps.guard(req, res, envAction, body);
    if (!ctx) return true;
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
      deps.auditAction('env.create', {
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
      } catch (e) {
        if (!closed)
          send({ type: 'env:error', message: e instanceof Error ? e.message : String(e) });
        if (!closed) send({ type: '_env_done', error: true });
      } finally {
        if (!closed) res.end();
      }
      return true;
    }

    if (action === 'destroy') {
      const envId = String(body.env_id ?? '');
      deps.auditAction('env.destroy', { envId, role: ctx.role, sub: ctx.sub });
      try {
        const env = await envPipeline.destroy(envId, (e) => {
          if (!closed) send({ type: 'env:status', env: e });
        });
        if (!env && !closed)
          send({ type: 'env:error', message: `未找到环境 ${envId}` });
        if (!closed) send({ type: '_env_done', found: !!env });
      } catch (e) {
        if (!closed)
          send({ type: 'env:error', message: e instanceof Error ? e.message : String(e) });
        if (!closed) send({ type: '_env_done', error: true });
      } finally {
        if (!closed) res.end();
      }
      return true;
    }
  }
  return false;
}
