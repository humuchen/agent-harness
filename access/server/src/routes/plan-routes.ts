/**
 * 计划（Plan）路由（自 server.ts 外迁，P2 模块化第三批）。
 *
 * 覆盖：GET/POST /api/plans、/api/plans/:id（diff / GET / POST / DELETE）、
 *       GET /api/plans/:id/events（协同 SSE 频道）。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { getPlanStore, type PlanDoc } from '../plan-store';
import { publishPlanEvent, subscribePlanEvents } from '../plan-bus';
import { sseConnectionLock } from '../run-queue';
import { readBody, sendJson, sendJsonError, startSse } from '../http-helpers';
import type { Action, AuthContext } from '../authz';

export interface PlanRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action,
    body?: any
  ) => Promise<AuthContext | null>;
  /** server.ts 的动作级审计闭包（audit 的薄包装）。 */
  auditAction: (action: string, fields: Record<string, unknown>) => void;
}

export async function handlePlanRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: PlanRouteDeps
): Promise<boolean> {
  if (!path.startsWith('/api/plans')) return false;

  if (path === '/api/plans') {
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'plan:read');
      if (!ctx) return true;
      const plans = await getPlanStore().list(ctx.sub);
      sendJson(res, { items: plans }, req);
      return true;
    }
    if (req.method === 'POST') {
      const ctx = await deps.guard(req, res, 'plan:write');
      if (!ctx) return true;
      const b = await readBody(req);
      const plan: PlanDoc = {
        id: b?.id ?? b?.plan?.id ?? '',
        title: b?.title ?? b?.plan?.title ?? '',
        nodes: b?.nodes ?? b?.plan?.nodes ?? [],
        version: b?.version ?? 0,
        updatedBy: ctx.sub,
        updatedAt: b?.updatedAt ?? new Date().toISOString(),
        ...(b?.sessionId ? { sessionId: b.sessionId } : {})
      };
      if (!plan.id || !plan.title) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'id and title are required' }));
        return true;
      }
      // 校验节点
      for (const n of plan.nodes) {
        if (!n.id || !n.title) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'each node needs id and title' }));
          return true;
        }
      }
      const saved = await getPlanStore().save(plan);
      publishPlanEvent(saved.id, ctx.sub, { type: 'plan:update', patch: saved });
      deps.auditAction('plan.save', { planId: saved.id, version: saved.version, role: ctx.role, sub: ctx.sub });
      sendJson(res, { item: saved }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  if (path.startsWith('/api/plans/')) {
    const rest = decodeURIComponent(path.slice('/api/plans/'.length));
    // diff 接口
    const diffMatch = rest.match(/^([^/]+)\/diff$/);
    if (diffMatch && req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'plan:read');
      if (!ctx) return true;
      const otherId = url.searchParams.get('other');
      if (!otherId) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'other param required' }));
        return true;
      }
      try {
        const result = await getPlanStore().diff(diffMatch[1]!, otherId);
        sendJson(res, result, req);
        return true;
      } catch (e: any) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e?.message ?? 'plan not found' }));
        return true;
      }
    }
    // 单文档 CRUD
    const id = rest.replace(/\/.*$/, '');
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'plan:read');
      if (!ctx) return true;
      const plan = await getPlanStore().read(id);
      if (!plan) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'plan not found' }));
        return true;
      }
      // owner 校验：仅更新人可读（除非 admin）
      if (ctx.role !== 'admin' && plan.updatedBy !== ctx.sub) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return true;
      }
      sendJson(res, { item: plan }, req);
      return true;
    }
    if (req.method === 'POST') {
      const ctx = await deps.guard(req, res, 'plan:write');
      if (!ctx) return true;
      const b = await readBody(req);
      const plan: PlanDoc = {
        id,
        title: b?.title ?? '',
        nodes: b?.nodes ?? [],
        version: b?.version ?? 0,
        updatedBy: ctx.sub,
        updatedAt: b?.updatedAt ?? new Date().toISOString(),
        ...(b?.sessionId ? { sessionId: b.sessionId } : {})
      };
      // owner 校验
      const existing = await getPlanStore().read(id);
      if (existing && ctx.role !== 'admin' && existing.updatedBy !== ctx.sub) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return true;
      }
      const saved = await getPlanStore().save(plan);
      publishPlanEvent(saved.id, ctx.sub, { type: 'plan:update', patch: saved });
      deps.auditAction('plan.save', { planId: id, version: saved.version, role: ctx.role, sub: ctx.sub });
      sendJson(res, { item: saved }, req);
      return true;
    }
    if (req.method === 'DELETE') {
      const ctx = await deps.guard(req, res, 'plan:write');
      if (!ctx) return true;
      const existing = await getPlanStore().read(id);
      if (existing && ctx.role !== 'admin' && existing.updatedBy !== ctx.sub) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return true;
      }
      const ok = await getPlanStore().remove(id);
      publishPlanEvent(id, ctx.sub, { type: 'plan:update', patch: { removed: true } });
      deps.auditAction('plan.delete', { planId: id, role: ctx.role, sub: ctx.sub });
      sendJson(res, { ok }, req);
      return true;
    }
    return false;
  }
  // ── P2-3 Plan 协同 SSE 频道 ──
  if (req.method === 'GET' && path.startsWith('/api/plans/') && path.endsWith('/events')) {
    const ctx = await deps.guard(req, res, 'plan:read');
    if (!ctx) return true;
    if (!sseConnectionLock.acquire()) {
      sendJsonError(res, 503, { error: 'too many sse connections' }, req);
      return true;
    }
    const planId = decodeURIComponent(path.slice('/api/plans/'.length, -'/events'.length));
    const send = startSse(res, req);
    send({ type: 'plan:ready', planId, owner: ctx.sub });
    const unsub = subscribePlanEvents(planId, ctx.sub, (e) => {
      try { send(e); } catch { /* 连接已断 */ }
    });
    res.on('close', () => {
      try { unsub(); } catch { /* 重复订阅安全 */ }
      sseConnectionLock.release();
    });
    return true;
  }
  return false;
}
