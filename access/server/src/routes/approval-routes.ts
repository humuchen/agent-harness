/**
 * 审批工单路由（自 server.ts 外迁，P2 模块化第三批）。
 *
 * 覆盖：GET /api/approvals（列表，admin/operator）、
 *       GET /api/approvals/:id（查看）、POST /api/approvals/:id（裁决，仅 admin）。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { readBody, sendJson } from '../http-helpers';
import type { Action, AuthContext } from '../authz';
import type { ApprovalPolicy, ApprovalTicket } from '../approval';

export interface ApprovalRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action,
    body?: any
  ) => Promise<AuthContext | null>;
  auditAction: (action: string, fields: Record<string, unknown>) => void;
  /** server.ts 组合根装配的审批策略单例（与 guard 的工单流转共享状态，必须注入）。 */
  approvalPolicy: ApprovalPolicy;
}

export async function handleApprovalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: ApprovalRouteDeps
): Promise<boolean> {
  if (!path.startsWith('/api/approvals')) return false;

  if (path === '/api/approvals') {
    // 审批工单列表（admin / operator 可读：operator 会发起需审批动作，应能看到工单状态）。
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'approvals:read');
      if (!ctx) return true;
      const status = url.searchParams.get('status');
      sendJson(
        res,
        {
          tickets: await deps.approvalPolicy.list(
            status ? { status: status as any } : undefined
          )
        },
        req
      );
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  if (path.startsWith('/api/approvals/')) {
    // 单张工单：GET 查看状态（admin / operator 可读）；POST 审批人裁决（approve/reject，仅 admin）。
    const id = path.slice('/api/approvals/'.length).replace(/\/$/, '');
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'approvals:read');
      if (!ctx) return true;
      const t = (await deps.approvalPolicy.list()).find(
        (x: ApprovalTicket) => x.id === id
      );
      sendJson(res, t ? { ticket: t } : { error: 'not found' }, req);
      return true;
    }
    if (req.method === 'POST') {
      const ctx = await deps.guard(req, res, 'approvals:review');
      if (!ctx) return true;
      const body = await readBody(req);
      const decision = body.decision === 'reject' ? 'reject' : 'approve';
      const t = await deps.approvalPolicy.decide(id, decision, ctx.sub);
      if (!t) {
        sendJson(res, { error: 'ticket not found or already decided' }, req);
        return true;
      }
      deps.auditAction('approval.decide', { id, decision, by: ctx.sub });
      sendJson(res, { ticket: t }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  return false;
}
