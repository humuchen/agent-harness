/**
 * 企业 Skill 管理路由（自 server.ts 外迁，P2 模块化第三批）。
 *
 * 覆盖：GET /api/skills、POST /api/skills/:id/enable|disable。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSkillRegistry } from '../skill-registry';
import { sendJson } from '../http-helpers';
import type { Action, AuthContext } from '../authz';

export interface SkillRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action
  ) => Promise<AuthContext | null>;
}

export async function handleSkillRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: SkillRouteDeps
): Promise<boolean> {
  if (!path.startsWith('/api/skills')) return false;

  // ── P1-6 企业 Skill 管理（受 skill:read / skill:manage 保护）──
  if (path === '/api/skills') {
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'skill:read');
      if (!ctx) return true;
      const items = await getSkillRegistry().list();
      sendJson(res, { items }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  if (path.startsWith('/api/skills/')) {
    const m = path.slice('/api/skills/'.length).match(/^([^/]+)\/(enable|disable)$/);
    if (m && req.method === 'POST') {
      const ctx = await deps.guard(req, res, 'skill:manage');
      if (!ctx) return true;
      const sid = m[1];
      const enable = m[2] === 'enable';
      if (!sid || !m[2]) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid skill path' }));
        return true;
      }
      const def = await getSkillRegistry().setEnabled(sid, enable);
      if (!def) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'skill not found' }));
        return true;
      }
      sendJson(res, { item: def }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  return false;
}
