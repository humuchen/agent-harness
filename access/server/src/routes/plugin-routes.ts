/**
 * 插件管理路由（自 server.ts 外迁，P2 模块化第九批）。
 *
 * 覆盖：
 *   GET    /api/plugins                      → 列出已安装插件 + Web 视图（需登录）
 *   POST   /api/plugins/:id/enable           → 启用插件（plugin:manage）
 *   POST   /api/plugins/:id/disable          → 停用插件（plugin:manage）
 *   POST   /api/plugins/:id/upgrade          → 升级插件清单（plugin:manage）
 *   DELETE /api/plugins/:id/enable           → 兼容语义：停用（同 disable）
 *
 * 鉴权口径：GET 走 authenticate（仅需登录，返回 sub/role 供 listViews 过滤）；
 * 写操作走 guard('plugin:manage')（RBAC 受控）。操作仅影响进程内存注册表，不重启进程。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson, sendJsonError } from '../http-helpers.js';
import {
  resolveUpgradeManifest,
  type PluginSystem
} from '../plugin-bootstrap.js';
import type { Action, AuthContext } from '../authz.js';

export interface PluginRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action
  ) => Promise<AuthContext | null>;
  /** authorizer.authenticate：GET /api/plugins 用（仅需登录用户身份，不走 RBAC 动作）。 */
  authenticate: (req: IncomingMessage) => Promise<AuthContext | null> | AuthContext | null;
  /** 进程级插件系统单例（server 启动期装配后注入）。 */
  pluginSystem: PluginSystem;
}

export async function handlePluginRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: PluginRouteDeps
): Promise<boolean> {
  // GET /api/plugins：列出已安装插件 + Web 视图
  if (req.method === 'GET' && path === '/api/plugins') {
    const viewUser = await deps.authenticate(req);
    if (!viewUser) {
      sendJsonError(res, 401, { error: 'unauthorized: missing or invalid token' }, req);
      return true;
    }
    const views = await deps.pluginSystem.webHost.listViews({
      sub: viewUser.sub,
      role: viewUser.role
    });
    sendJson(
      res,
      {
        plugins: deps.pluginSystem.loader
          .list()
          .map(
            (r: {
              manifest: { id: string; name?: string; version?: string; dependencies?: string[] };
              state: string;
            }) => ({
          id: r.manifest.id,
          name: r.manifest.name ?? r.manifest.id,
          version: r.manifest.version,
          state: r.state,
          dependencies: r.manifest.dependencies ?? []
        })
      ),
      views
      },
      req
    );
    return true;
  }

  // 插件热插拔（Phase 4）：enable / disable / upgrade，受 plugin:manage 动作保护。
  const m = path.match(/^\/api\/plugins\/([^/]+)\/(enable|disable|upgrade)$/);
  if (m && req.method === 'POST') {
    const id = decodeURIComponent(m[1] ?? '');
    const action = m[2];
    const ctx = await deps.guard(req, res, 'plugin:manage');
    if (!ctx) return true;
    try {
      if (action === 'upgrade') {
        const body = await readBody(req);
        const manifest = await resolveUpgradeManifest(id, body ?? {});
        const rec = await deps.pluginSystem.loader.upgrade(id, manifest);
        sendJson(
          res,
          {
            id,
            state: rec.state,
            version: rec.manifest.version,
            upgradedAt: rec.upgradedAt ?? null
          },
          req
        );
        return true;
      }
      const rec =
        action === 'enable'
          ? await deps.pluginSystem.loader.enable(id)
          : await deps.pluginSystem.loader.disable(id);
      sendJson(res, { id, state: rec.state }, req);
      return true;
    } catch (e) {
      sendJson(
        res,
        { error: e instanceof Error ? e.message : String(e) },
        req
      );
      return true;
    }
  }

  // 兼容计划约定：DELETE /api/plugins/:id/enable 视作停用（不重启进程）。
  const dm = path.match(/^\/api\/plugins\/([^/]+)\/enable$/);
  if (dm && req.method === 'DELETE') {
    const id = decodeURIComponent(dm[1] ?? '');
    const ctx = await deps.guard(req, res, 'plugin:manage');
    if (!ctx) return true;
    try {
      const rec = await deps.pluginSystem.loader.disable(id);
      sendJson(res, { id, state: rec.state }, req);
      return true;
    } catch (e) {
      sendJson(
        res,
        { error: e instanceof Error ? e.message : String(e) },
        req
      );
      return true;
    }
  }

  return false;
}
