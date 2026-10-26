/**
 * 租户管理路由（长期：多租户运营面的管理 API）。
 *
 * 覆盖：
 *   GET    /api/admin/tenants                租户档案列表
 *   POST   /api/admin/tenants                创建/更新档案（tenantId 必填，patch 语义）
 *   GET    /api/admin/tenants/:id            单档案
 *   PUT    /api/admin/tenants/:id            更新档案（patch）
 *   DELETE /api/admin/tenants/:id            删除档案（运营撤销，数据不清理）
 *   GET    /api/admin/tenants/:id/quotas     配额覆盖查询（TenantQuotaStore）
 *   PUT    /api/admin/tenants/:id/quotas     配额覆盖写入（qps/max_concurrency/…）
 *   DELETE /api/admin/tenants/:id/quotas     删除配额覆盖（回退引擎 default）
 *   GET    /api/admin/tenants/:id/usage      用量账单（usage_daily 区间查询，先 flush 保证新鲜）
 *
 * 权限：读 = tenants:read（admin），写 = tenants:manage（admin）；写操作全部 auditAction 留痕。
 * 停用语义：status='suspended' 的租户在 guard（认证租户）与 run-routes（body 声明租户
 * 的非强制模式降级路径）两个入口被准入拒绝，数据保留、可随时恢复。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getTenantRegistry,
  type TenantQuotaStore,
} from '@agent-harness/core';
import { getUsageLedger } from '../usage-ledger';
import { setUserTenant, getUserTenant } from '../accounts';
import { readBody } from '../http-helpers';
import type { Action, AuthContext } from '../authz';

export interface TenantRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action,
    body?: Record<string, unknown>
  ) => Promise<AuthContext | null>;
  auditAction: (action: string, fields: Record<string, unknown>) => void;
  /** 进程共享租户配额存储（server 启动装配；注入以保持路由组无全局状态）。 */
  quotaStore: TenantQuotaStore;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** 校验配额字段（只收有限数值字段，防任意键写入）。提供了但非法的值 → 返回 null（调用方 400）。 */
function parseQuotaPatch(body: Record<string, unknown>): {
  qps?: number;
  maxConcurrency?: number;
  maxTokensPerWindow?: number;
  maxCostPerWindow?: number;
  windowMs?: number;
} | null {
  const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const fields: Array<[string, unknown]> = [
    ['qps', body.qps],
    ['maxConcurrency', body.maxConcurrency],
    ['maxTokensPerWindow', body.maxTokensPerWindow],
    ['maxCostPerWindow', body.maxCostPerWindow],
    ['windowMs', body.windowMs],
  ];
  const out: Record<string, number | undefined> = {};
  let provided = 0;
  for (const [key, raw] of fields) {
    if (raw === undefined) continue;
    const v = num(raw);
    if (v === undefined) return null; // 提供了但非法
    out[key] = v;
    provided++;
  }
  return provided > 0 ? (out as Required<typeof out>) : null;
}

export async function handleTenantRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: TenantRouteDeps
): Promise<boolean> {
  if (!path.startsWith('/api/admin/tenants')) return false;
  const registry = getTenantRegistry();
  const ledger = getUsageLedger();

  // ---- 集合路由 ----
  if (path === '/api/admin/tenants') {
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'tenants:read');
      if (!ctx) return true;
      const tenants = await registry.list();
      return json(res, 200, { tenants, count: tenants.length }), true;
    }
    if (req.method === 'POST') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const ctx = await deps.guard(req, res, 'tenants:manage', body);
      if (!ctx) return true;
      const tenantId = String(body.tenantId ?? '').trim();
      if (!tenantId) return json(res, 400, { error: 'tenantId required' }), true;
      const record = await registry.upsert(tenantId, {
        ...(body.name !== undefined ? { name: String(body.name) } : {}),
        ...(body.status !== undefined ? { status: body.status === 'suspended' ? 'suspended' : 'active' } : {}),
        ...(body.plan !== undefined ? { plan: String(body.plan) } : {}),
        ...(body.dataZone !== undefined ? { dataZone: String(body.dataZone) } : {}),
        ...(body.residency !== undefined ? { residency: String(body.residency) } : {}),
        ...(body.notes !== undefined ? { notes: String(body.notes) } : {}),
      });
      deps.auditAction('tenant.upsert', { tenantId, status: record.status, sub: ctx.sub });
      return json(res, 200, { tenant: record }), true;
    }
    return json(res, 405, { error: 'method not allowed' }), true;
  }

  // ---- 单租户路由 /api/admin/tenants/:id[/quotas|/usage|/status|/accounts] ----
  const m = /^\/api\/admin\/tenants\/([^/]+)(?:\/(quotas|usage|status|accounts))?$/.exec(path);
  if (!m) return false;
  const tenantId = decodeURIComponent(m[1] ?? '');
  const sub = m[2] ?? '';

  // GET /usage：账单区间查询（读权限；先 flush 保证当日数据新鲜）
  if (sub === 'usage' && req.method === 'GET') {
    const ctx = await deps.guard(req, res, 'tenants:read');
    if (!ctx) return true;
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    try {
      await ledger.flush();
    } catch {
      /* flush 失败按已落库数据返回 */
    }
    const daily = await ledger.query(tenantId, from, to);
    const modelDaily = await ledger.queryByModel(tenantId, from, to);
    const totals = daily.reduce(
      (acc, r) => ({ runs: acc.runs + r.runs, tokens: acc.tokens + r.tokens, cost: acc.cost + r.cost }),
      { runs: 0, tokens: 0, cost: 0 }
    );
    return (
      json(res, 200, {
        tenantId,
        from: from || null,
        to: to || null,
        daily,
        modelDaily,
        totals: { ...totals, cost: Number(totals.cost.toFixed(6)) },
      }),
      true
    );
  }

  // 配额覆盖
  if (sub === 'quotas') {
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'tenants:read');
      if (!ctx) return true;
      const quota = await deps.quotaStore.get(tenantId);
      return json(res, 200, { tenantId, quota }), true;
    }
    if (req.method === 'PUT') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const ctx = await deps.guard(req, res, 'tenants:manage', body);
      if (!ctx) return true;
      const patch = parseQuotaPatch(body);
      if (patch === null) {
        return (
          json(res, 400, {
            error: '配额字段非法（须为非负数值）：qps / max_concurrency / max_tokens_per_window / max_cost_per_window / window_ms',
          }),
          true
        );
      }
      await deps.quotaStore.upsert(tenantId, patch);
      deps.auditAction('tenant.quota.upsert', { tenantId, quota: patch, sub: ctx.sub });
      return json(res, 200, { tenantId, quota: await deps.quotaStore.get(tenantId) }), true;
    }
    if (req.method === 'DELETE') {
      const ctx = await deps.guard(req, res, 'tenants:manage');
      if (!ctx) return true;
      await deps.quotaStore.remove(tenantId);
      deps.auditAction('tenant.quota.remove', { tenantId, sub: ctx.sub });
      return json(res, 200, { ok: true, tenantId }), true;
    }
    return json(res, 405, { error: 'method not allowed' }), true;
  }

  // 用户 ↔ 租户绑定（长期：让登录用户进入 guard 的租户准入/dataZone 门禁链路）
  if (sub === 'accounts') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;
    const body = (await readBody(req)) as Record<string, unknown>;
    const ctx = await deps.guard(req, res, 'tenants:manage', body);
    if (!ctx) return true;
    const username = String(body.username ?? '').trim();
    if (!username) return json(res, 400, { error: 'username required' }), true;
    const unbind = body.action === 'unbind';
    try {
      await setUserTenant(username, unbind ? null : tenantId);
      const bound = unbind ? null : await getUserTenant(username);
      deps.auditAction('tenant.account.bind', { tenantId, username, unbind, sub: ctx.sub });
      return json(res, 200, { ok: true, tenantId: unbind ? null : tenantId, username, bound: bound ?? null }), true;
    } catch (e) {
      return json(res, 404, { error: e instanceof Error ? e.message : String(e) }), true;
    }
  }

  // 状态快改（快捷端点）
  if (sub === 'status') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;
    const body = (await readBody(req)) as Record<string, unknown>;
    const ctx = await deps.guard(req, res, 'tenants:manage', body);
    if (!ctx) return true;
    const status = body.status === 'suspended' ? 'suspended' : body.status === 'active' ? 'active' : null;
    if (!status) return json(res, 400, { error: 'status 必须是 active | suspended' }), true;
    const record = await registry.upsert(tenantId, { status });
    deps.auditAction('tenant.status', { tenantId, status, sub: ctx.sub });
    return json(res, 200, { tenant: record }), true;
  }

  // 档案
  if (req.method === 'GET') {
    const ctx = await deps.guard(req, res, 'tenants:read');
    if (!ctx) return true;
    const record = await registry.get(tenantId);
    return (
      json(res, record ? 200 : 404, record ? { tenant: record } : { error: 'tenant not found' }),
      true
    );
  }
  if (req.method === 'PUT') {
    const body = (await readBody(req)) as Record<string, unknown>;
    const ctx = await deps.guard(req, res, 'tenants:manage', body);
    if (!ctx) return true;
    const record = await registry.upsert(tenantId, {
      ...(body.name !== undefined ? { name: String(body.name) } : {}),
      ...(body.status !== undefined ? { status: body.status === 'suspended' ? 'suspended' : 'active' } : {}),
      ...(body.plan !== undefined ? { plan: String(body.plan) } : {}),
      ...(body.dataZone !== undefined ? { dataZone: String(body.dataZone) } : {}),
      ...(body.residency !== undefined ? { residency: String(body.residency) } : {}),
      ...(body.notes !== undefined ? { notes: String(body.notes) } : {}),
    });
    deps.auditAction('tenant.update', { tenantId, sub: ctx.sub });
    return json(res, 200, { tenant: record }), true;
  }
  if (req.method === 'DELETE') {
    const ctx = await deps.guard(req, res, 'tenants:manage');
    if (!ctx) return true;
    await registry.remove(tenantId);
    deps.auditAction('tenant.remove', { tenantId, sub: ctx.sub });
    return json(res, 200, { ok: true, tenantId }), true;
  }
  return json(res, 405, { error: 'method not allowed' }), true;
}
