/**
 * 评估与配方路由（自 server.ts 外迁，P2 模块化第三批）。
 *
 * 覆盖：POST /api/eval（运行结果评估）、
 *       GET/POST /api/recipes、GET /api/recipes/:id（配方存档查询）。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runQueue } from '../run-queue';
import { getRecipeStore, runRecordFromEvents, type Evaluator } from '../eval';
import { readBody, sendJson } from '../http-helpers';
import type { Action, AuthContext } from '../authz';

export interface EvalRecipeRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action,
    body?: any
  ) => Promise<AuthContext | null>;
  auditAction: (action: string, fields: Record<string, unknown>) => void;
  /** server.ts 组合根装配的评估器单例。 */
  evaluator: Evaluator;
}

export async function handleEvalRecipeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: EvalRecipeRouteDeps
): Promise<boolean> {
  if (!path.startsWith('/api/eval') && !path.startsWith('/api/recipes')) {
    return false;
  }

  // ---- 评估与配方版本化（P2-13，业务质量策略）----
  if (req.method === 'POST' && path === '/api/eval') {
    const body = await readBody(req);
    const ctx = await deps.guard(req, res, 'eval:run', body);
    if (!ctx) return true;
    const jobId = String(body.jobId ?? '');
    const job = runQueue.get(jobId);
    if (!job) {
      sendJson(res, { error: 'job not found' }, req);
      return true;
    }
    const rec = runRecordFromEvents(jobId, job.events);
    const result = deps.evaluator.evaluate(rec);
    deps.auditAction('eval.run', {
      jobId,
      score: result.score,
      passed: result.passed,
      role: ctx.role,
      sub: ctx.sub
    });
    sendJson(res, { jobId, record: rec, result }, req);
    return true;
  }
  if (path === '/api/recipes') {
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'recipe:read');
      if (!ctx) return true;
      sendJson(res, { recipes: getRecipeStore().list() }, req);
      return true;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const ctx = await deps.guard(req, res, 'recipe:save', body);
      if (!ctx) return true;
      const jobId = String(body.jobId ?? '');
      const job = runQueue.get(jobId);
      if (!job) {
        sendJson(res, { error: 'job not found' }, req);
        return true;
      }
      const rec = runRecordFromEvents(jobId, job.events);
      const id = `rcp_${Date.now().toString(36)}`;
      const recipe = {
        id,
        name: String(body.name ?? id),
        createdAt: Date.now(),
        record: rec,
        notes: body.notes ? String(body.notes) : undefined
      };
      getRecipeStore().save(recipe);
      deps.auditAction('recipe.save', {
        id,
        name: recipe.name,
        role: ctx.role,
        sub: ctx.sub
      });
      sendJson(res, { recipe }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  if (path.startsWith('/api/recipes/')) {
    const id = path.slice('/api/recipes/'.length).replace(/\/$/, '');
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'recipe:read');
      if (!ctx) return true;
      const r = getRecipeStore().get(id);
      sendJson(res, r ? { recipe: r } : { error: 'not found' }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  return false;
}
