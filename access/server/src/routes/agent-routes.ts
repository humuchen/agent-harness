/**
 * 智能体注册发现 / A2A / Agent Teams 路由（自 server.ts 外迁，P2 模块化第四批）。
 *
 * 覆盖：GET /api/agents、GET /api/agents/:id、POST /api/agents（注册）、
 *       POST /api/agents/:id/heartbeat、DELETE /api/agents/:id（注销）、
 *       POST /api/a2a/tasks（A2A 接收）、/api/teams CRUD。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  getAgentRegistry,
  getTeamManager,
  type A2ARequest,
  type AgentCard,
  type AgentHealth,
  type TaskEnvelope,
  type TaskResult,
  type Team
} from '@agent-harness/core';
import { readBody, sendJson } from '../http-helpers';
import { runAgentTask } from '../agent-run';
import type { Action, AuthContext } from '../authz';

export interface AgentRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action,
    body?: any
  ) => Promise<AuthContext | null>;
  auditAction: (action: string, fields: Record<string, unknown>) => void;
  /** 优雅停机旗标读取器（server.ts 的可变状态经 getter 注入）。 */
  isShuttingDown: () => boolean;
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

export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: AgentRouteDeps
): Promise<boolean> {
  const isAgents = path === '/api/agents' || path.startsWith('/api/agents/');
  const isA2a = path.startsWith('/api/a2a/');
  const isTeams = path === '/api/teams' || path.startsWith('/api/teams/');
  if (!isAgents && !isA2a && !isTeams) return false;

  // ---- P0.1：智能体注册与发现 ----
  if (req.method === 'GET' && path === '/api/agents') {
    // 列出 / 按 domain + capability 发现已注册 agent。受 agent:read 保护。
    const ctx = await deps.guard(req, res, 'agent:read');
    if (!ctx) return true;
    const domain = url.searchParams.get('domain') || undefined;
    const capability = url.searchParams.get('capability') || undefined;
    const agents = await getAgentRegistry().query({
      ...(domain ? { domain } : {}),
      ...(capability ? { capability } : {})
    });
    sendJson(res, { agents, count: agents.length }, req);
    return true;
  }
  if (req.method === 'GET' && path.startsWith('/api/agents/')) {
    // 取单个 agent 卡片（含健康度）。受 agent:read 保护。
    const ctx = await deps.guard(req, res, 'agent:read');
    if (!ctx) return true;
    const id = decodeURIComponent(
      path.slice('/api/agents/'.length).replace(/\/$/, '')
    );
    const card = id ? await getAgentRegistry().get(id) : null;
    if (!card) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent not found', id }));
      return true;
    }
    sendJson(res, { agent: card }, req);
    return true;
  }
  if (req.method === 'POST' && path === '/api/a2a/tasks') {
    // P1-④ A2A 接收端点：远端 agent 投递 TaskEnvelope，本平台在「本地」执行。
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'a2a:receive', body);
    if (!ctx) return true;
    if (deps.isShuttingDown()) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'server is shutting down' }));
      return true;
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
      return true;
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
      return true;
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
      return true;
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
    return true;
  }
  // P0.1 写端点：运行期注册 agent（body = AgentCard，至少 { id, capabilities }）。
  if (req.method === 'POST' && path === '/api/agents') {
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'agent:register', body);
    if (!ctx) return true;
    const card = normalizeIncomingCard(body);
    if (!card) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'invalid agent card: 需要 { id: string, capabilities: [] }'
        })
      );
      return true;
    }
    await getAgentRegistry().register(card);
    deps.auditAction('agent.register', {
      id: card.id,
      domain: card.domain,
      transport: card.transport,
      role: ctx.role,
      sub: ctx.sub
    });
    sendJson(res, { ok: true, agent: card }, req);
    return true;
  }
  // P1-④：Agent Teams API — 团队 CRUD
  if (req.method === 'GET' && path === '/api/teams') {
    const ctx = await deps.guard(req, res, 'agent:read');
    if (!ctx) return true;
    const tm = getTeamManager();
    if (!tm) {
      sendJson(res, { error: 'TeamManager not initialized' }, req);
      return true;
    }
    sendJson(res, { teams: tm.list() }, req);
    return true;
  }
  if (req.method === 'POST' && path === '/api/teams') {
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'agent:register', body);
    if (!ctx) return true;
    deps.auditAction('team.register', { role: ctx.role, sub: ctx.sub });
    try {
      const tm = getTeamManager();
      if (!tm) {
        sendJson(res, { error: 'TeamManager not initialized' }, req);
        return true;
      }
      const team: Team = { ...body, members: body.members ?? [] };
      await tm.register(team);
      sendJson(res, { ok: true, team }, req);
      return true;
    } catch (e: any) {
      sendJson(res, { error: e?.message ?? String(e) }, req);
      return true;
    }
  }
  if (req.method === 'DELETE' && path.startsWith('/api/teams/')) {
    const ctx = await deps.guard(req, res, 'agent:register');
    if (!ctx) return true;
    const teamId = path.slice('/api/teams/'.length).replace(/\/$/, '');
    deps.auditAction('team.deregister', {
      teamId,
      role: ctx.role,
      sub: ctx.sub
    });
    const tm = getTeamManager();
    if (!tm) {
      sendJson(res, { error: 'TeamManager not initialized' }, req);
      return true;
    }
    tm.deregister(teamId);
    sendJson(res, { ok: true }, req);
    return true;
  }
  if (req.method === 'GET' && path.startsWith('/api/teams/')) {
    const ctx = await deps.guard(req, res, 'agent:read');
    if (!ctx) return true;
    const teamId = path.slice('/api/teams/'.length).replace(/\/$/, '');
    const tm = getTeamManager();
    if (!tm) {
      sendJson(res, { error: 'TeamManager not initialized' }, req);
      return true;
    }
    const team = tm.get(teamId);
    if (!team) {
      sendJson(res, { error: `Team not found: ${teamId}` }, req);
      return true;
    }
    sendJson(res, { team }, req);
    return true;
  }
  // P0.1 心跳。body = Partial<AgentHealth>（status/load 等）。未注册的 id 静默 ok:false（幂等重试）。
  if (
    req.method === 'POST' &&
    path.startsWith('/api/agents/') &&
    path.endsWith('/heartbeat')
  ) {
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'agent:register', body);
    if (!ctx) return true;
    const id = decodeURIComponent(
      path.slice('/api/agents/'.length, path.length - '/heartbeat'.length)
    );
    if (!id) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing agent id' }));
      return true;
    }
    const existing = await getAgentRegistry().get(id);
    if (!existing) {
      sendJson(res, { ok: false, reason: 'unknown agent', id }, req);
      return true;
    }
    const health = (body ?? {}) as Partial<AgentHealth>;
    await getAgentRegistry().heartbeat(id, health);
    sendJson(res, { ok: true, id }, req);
    return true;
  }
  // P0.1 注销 agent。
  if (req.method === 'DELETE' && path.startsWith('/api/agents/')) {
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'agent:register', body);
    if (!ctx) return true;
    const id = decodeURIComponent(
      path.slice('/api/agents/'.length).replace(/\/$/, '')
    );
    if (!id) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing agent id' }));
      return true;
    }
    await getAgentRegistry().deregister(id);
    deps.auditAction('agent.deregister', { id, role: ctx.role, sub: ctx.sub });
    sendJson(res, { ok: true, id }, req);
    return true;
  }
  return false;
}
