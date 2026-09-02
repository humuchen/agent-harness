/**
 * edge-routes —— 接入层「公开 / 运维 / 探针」端点路由表。
 *
 * 将 server.ts 主分发链里彼此独立、无业务副作用、且无需鉴权的端点（健康检查、
 * 存活/就绪探针、运行态、沙箱能力快照、鉴权元信息、错误明细）收敛为一张
 * **可测试的路由表**，由 server.ts 在鉴权守卫前调用 matchEdgeRoute() 短路分发。
 *
 * 设计：
 *  - RouteDef 纯描述「方法 + 路径（精确或前缀）」，不内联处理逻辑；
 *  - 真正处理逻辑以依赖注入方式在 createEdgeRouter(deps) 时绑定，便于单测时
 *    传入桩（stub），无需拉起整个 server 进程；
 *  - routeMatches() 为纯函数，单独单测，覆盖精确匹配 / 前缀匹配 / 方法不匹配。
 *
 * 这是把 3655 行 server.ts「god-file」拆出可测试接缝的第一步：后续可继续把
 * 账户、agent、run、mcp 等同类端点迁移进各自的 routes/*.ts 路由表。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJsonRoute } from './respond';

export interface EdgeRouteDeps {
  buildState: (req: IncomingMessage) => unknown;
  getSandboxStatus: () => unknown;
  getAuthConfig: () => unknown;
  getErrorLog: (opts: { limit?: number }) => unknown[];
  getErrorSummary: () => unknown;
  formatErrorReport: (opts: { limit?: number }) => string;
  handleLiveness: (req: IncomingMessage, res: ServerResponse) => void;
  handleReadiness: (req: IncomingMessage, res: ServerResponse) => void;
}

export type EdgeRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: EdgeRouteDeps
) => void;

export interface RouteDef {
  /** HTTP 方法（大写）；'*' 表示任意方法。 */
  method: string;
  /** 精确路径或前缀（以 '/' 结尾表示前缀匹配）。 */
  path: string;
  /** 是否需要鉴权（errors/错误展示页需，探针/state 不需）。 */
  handler: EdgeRouteHandler;
}

/**
 * 路由匹配（纯函数，可单测）。
 * 规则：方法相同（或 def.method==='*'）时，精确 path 命中或 path 以 '/' 结尾的前缀命中。
 */
export function routeMatches(
  def: Pick<RouteDef, 'method' | 'path'>,
  method: string,
  path: string
): boolean {
  if (def.method !== '*' && def.method !== method) return false;
  if (def.path.endsWith('/')) return path === def.path || path.startsWith(def.path);
  return path === def.path;
}

/** 在路由表中找到第一个命中项（顺序即优先级）。 */
export function findEdgeRoute(
  routes: RouteDef[],
  method: string,
  path: string
): RouteDef | null {
  for (const r of routes) {
    if (routeMatches(r, method, path)) return r;
  }
  return null;
}

/**
 * 构造边缘路由表。逻辑集中在此，server.ts 只负责在合适时机调用。
 * 错误明细展示页/JSON 需要 errors:read 权限，由 server.ts 在调用前完成 guard，
 * 故此处 handler 收到的 req 已通过鉴权（未通过时 server.ts 已 return）。
 */
export function createEdgeRoutes(): RouteDef[] {
  return [
    // K8s Liveness 探针
    {
      method: 'GET',
      path: '/health/live',
      handler: (_req, res, _url, d) => d.handleLiveness(_req, res)
    },
    // K8s Readiness 探针
    {
      method: 'GET',
      path: '/health/ready',
      handler: (_req, res, _url, d) => d.handleReadiness(_req, res)
    },
    // 运行态：保持开放（Render 等 PaaS 无法在健康检查中带令牌）
    {
      method: 'GET',
      path: '/api/state',
      handler: async (_req, res, _url, d) => {
        const state = await d.buildState(_req);
        sendJsonRoute(res, state);
      }
    },
    // 沙箱能力快照：OS 级隔离就绪状态 + 实际生效原语，供前端「可观测」面板展示
    {
      method: 'GET',
      path: '/api/sandbox',
      handler: (_req, res, _url, d) => sendJsonRoute(res, { sandbox: d.getSandboxStatus() })
    },
    // 鉴权元信息（OIDC 端点 / clientId / scopes），供前端发起 SSO 登录
    {
      method: 'GET',
      path: '/api/auth/config',
      handler: (_req, res, _url, d) => sendJsonRoute(res, d.getAuthConfig())
    },
    // 错误明细 JSON：count + summary + errors 列表
    {
      method: 'GET',
      path: '/api/errors',
      handler: (req, res, url, d) => {
        const limitRaw = Number(url.searchParams.get('limit'));
        const limit =
          Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200;
        const full = url.searchParams.get('full') === '1';
        const fmt = url.searchParams.get('format');
        if (fmt === 'text') {
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8'
          });
          res.end(d.formatErrorReport({ limit: full ? undefined : limit }));
          return;
        }
        const list = d.getErrorLog({ limit: full ? undefined : limit });
        sendJsonRoute(res, {
          count: list.length,
          summary: d.getErrorSummary(),
          errors: list
        });
      }
    }
  ];
}

/**
 * 尝试分发边缘路由；命中并已处理返回 true，否则返回 false（交由 server.ts 继续主链）。
 * server.ts 在 CORS 预检、SPA/静态资源、鉴权 guard 之前调用，覆盖纯公开端点；
 * 错误明细页（/errors HTML）因需鉴权，不在此表，仍由 server.ts 处理。
 */
export function tryDispatchEdgeRoute(
  routes: RouteDef[],
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: EdgeRouteDeps,
  /** 已由 server 重写后的路径（如 /api/v1/* → /api/*），用于路由匹配。 */
  path?: string
): boolean {
  const method = req.method ?? 'GET';
  const matchPath = path ?? url.pathname;
  const hit = findEdgeRoute(routes, method, matchPath);
  if (!hit) return false;
  hit.handler(req, res, url, deps);
  return true;
}
