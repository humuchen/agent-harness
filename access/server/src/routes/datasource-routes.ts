/**
 * 数据源路由（自 server.ts 外迁，P2 模块化第二批）。
 *
 * 覆盖：GET /api/datasources、POST /api/datasources/:id/test。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDataSourceRegistry } from '../data-source';
import { sendJson } from '../http-helpers';
import type { Action, AuthContext } from '../authz';

export interface DatasourceRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action
  ) => Promise<AuthContext | null>;
}

export async function handleDatasourceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: DatasourceRouteDeps
): Promise<boolean> {
  if (!path.startsWith('/api/datasources')) return false;

  if (path === '/api/datasources') {
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'datasource:read');
      if (!ctx) return true;
      const items = await getDataSourceRegistry().list();
      sendJson(res, { items }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  if (path.startsWith('/api/datasources/')) {
    const tm = path.slice('/api/datasources/'.length).match(/^([^/]+)\/test$/);
    if (tm && req.method === 'POST') {
      const ctx = await deps.guard(req, res, 'datasource:read');
      if (!ctx) return true;
      const dsid = tm[1];
      if (!dsid) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid datasource path' }));
        return true;
      }
      const result = await getDataSourceRegistry().test(dsid);
      if (!result) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'datasource not found' }));
        return true;
      }
      sendJson(res, { result }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  return false;
}
