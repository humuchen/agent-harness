/**
 * 策略 / 合规 / 品牌路由（自 server.ts 外迁，P2 模块化第七批）。
 *
 * 覆盖：GET /api/openapi.json、GET /api/retention、GET /api/features、
 *       POST /api/features/toggle、GET /api/im/status、GET+POST /api/policy、
 *       GET /api/policy/preview、GET /api/brand。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { features } from '@agent-harness/core';
import { getPolicyStore, validatePolicyDoc, allActions } from '../policy-editor';
import { getImStatusAggregator } from '../im-status';
import type { ImBridge } from '../im';
import { getBrandConfig } from '../brand';
import { readBody, sendJson } from '../http-helpers';
import type { Action, AuthContext, Role } from '../authz';
import type { RetentionPolicy } from '../retention';

export interface PolicyRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action,
    body?: any
  ) => Promise<AuthContext | null>;
  auditAction: (action: string, fields: Record<string, unknown>) => void;
  /** server.ts 组合根装配的策略/契约单例。 */
  retentionPolicy: RetentionPolicy;
  openApiSpec: unknown;
  imBridge: ImBridge;
}

export async function handlePolicyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: PolicyRouteDeps
): Promise<boolean> {
  const isPolicyGroup =
    path === '/api/openapi.json' ||
    path === '/api/retention' ||
    path === '/api/features' ||
    path === '/api/features/toggle' ||
    path === '/api/im/status' ||
    path === '/api/policy' ||
    path === '/api/policy/preview' ||
    path === '/api/brand';
  if (!isPolicyGroup) return false;

  if (req.method === 'GET' && path === '/api/openapi.json') {
    // OpenAPI 3.0 契约（版本化 API 文档）；受 policy:read 保护。
    const ctx = await deps.guard(req, res, 'policy:read');
    if (!ctx) return true;
    sendJson(res, deps.openApiSpec, req);
    return true;
  }
  if (req.method === 'GET' && path === '/api/retention') {
    // 数据留存 / 出境策略快照（合规查阅）。
    const ctx = await deps.guard(req, res, 'policy:read');
    if (!ctx) return true;
    sendJson(res, deps.retentionPolicy.describe(), req);
    return true;
  }
  if (req.method === 'GET' && path === '/api/features') {
    // 特性开关状态（运行时查询/审计），受 policy:read 保护。
    const ctx = await deps.guard(req, res, 'policy:read');
    if (!ctx) return true;
    sendJson(
      res,
      { flags: features.getAll(), stats: features.getStats() },
      req
    );
    return true;
  }
  if (req.method === 'GET' && path === '/api/im/status') {
    // IM 多实例状态聚合（健康 / 连接 / 吞吐 / 心跳 / 故障转移）。
    // 受 policy:read 保护（复用既有权限，无需新增 Action）。
    const ctx = await deps.guard(req, res, 'policy:read');
    if (!ctx) return true;
    const snapshot = getImStatusAggregator([deps.imBridge]).snapshot();
    sendJson(res, snapshot, req);
    return true;
  }
  if (req.method === 'POST' && path === '/api/features/toggle') {
    // 运行时切换特性开关，受 features:write 保护。
    const ctx = await deps.guard(req, res, 'features:write');
    if (!ctx) return true;
    const b = await readBody(req);
    const key = typeof b?.key === 'string' ? b.key : '';
    const enabled = typeof b?.enabled === 'boolean' ? b.enabled : undefined;
    if (!key) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing key' }));
      return true;
    }
    if (enabled === undefined) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing enabled' }));
      return true;
    }
    try {
      features.setOverride(key, enabled);
      sendJson(res, { ok: true, key, enabled }, req);
    } catch (e: any) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }
  // ── P2-2 策略编辑器：RBAC 矩阵读写 + 预览 ──
  if (req.method === 'GET' && path === '/api/policy') {
    const ctx = await deps.guard(req, res, 'policy:read');
    if (!ctx) return true;
    const store = getPolicyStore();
    const doc = await store.read();
    sendJson(
      res,
      { matrix: doc.matrix, actions: allActions() },
      req
    );
    return true;
  }
  if (req.method === 'GET' && path === '/api/policy/preview') {
    const ctx = await deps.guard(req, res, 'policy:read');
    if (!ctx) return true;
    const role = url.searchParams.get('role');
    const action = url.searchParams.get('action');
    if (
      !role ||
      !action ||
      !['admin', 'operator', 'viewer'].includes(role) ||
      !(allActions() as readonly string[]).includes(action)
    ) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'role and action are required and must be valid' }));
      return true;
    }
    const allowed = await getPolicyStore().preview(
      role as Role,
      action as Action
    );
    sendJson(res, { role, action, allowed }, req);
    return true;
  }
  if (req.method === 'POST' && path === '/api/policy') {
    const ctx = await deps.guard(req, res, 'policy:write');
    if (!ctx) return true;
    const b = await readBody(req);
    const matrix = b?.matrix as Record<string, string[]> | undefined;
    if (!matrix || typeof matrix !== 'object') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'matrix is required' }));
      return true;
    }
    // 校验 Action 合法性
    const doc: { matrix: Record<string, Action[]> } = { matrix: {} };
    for (const role of ['admin', 'operator', 'viewer'] as Role[]) {
      const acts = matrix[role] ?? [];
      doc.matrix[role] = acts.map(String) as Action[];
    }
    const err = validatePolicyDoc(doc);
    if (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err }));
      return true;
    }
    try {
      await getPolicyStore().write(doc);
      deps.auditAction('policy.write', { role: ctx.role, sub: ctx.sub });
      sendJson(res, { ok: true }, req);
    } catch (e: any) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e?.message ?? 'write failed' }));
    }
    return true;
  }
  // ── P3-1 品牌位：公开无需鉴权（属展示信息） ──
  if (req.method === 'GET' && path === '/api/brand') {
    sendJson(res, getBrandConfig(), req);
    return true;
  }
  return false;
}
