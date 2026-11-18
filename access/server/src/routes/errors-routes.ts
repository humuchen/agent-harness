/**
 * 错误明细展示路由（自 server.ts 外迁，P2 模块化第十批）。
 *
 * 覆盖：
 *   GET /errors       → HTML 错误明细页（服务端渲染，深色主题）
 *   GET /api/errors   → JSON / text 错误明细 API（支持 ?limit=&full=1&format=text）
 *
 * 鉴权：两者均受 errors:read 保护（P1 安全修复：此前 /api/errors 挂在 edge 路由表
 * guard 之前，匿名可拉取内部错误明细——现统一走 guard）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  getErrorLog,
  getErrorSummary,
  formatErrorReport
} from '@agent-harness/core';
import { renderErrorsHtml } from '../views.js';
import { securityHeaders } from '../http-helpers.js';
import type { Action, AuthContext } from '../authz.js';

export interface ErrorsRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action
  ) => Promise<AuthContext | null>;
}

export async function handleErrorsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: ErrorsRouteDeps
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const guard = deps.guard;

  // HTML 错误明细展示页（服务端渲染，深色主题）。受 errors:read 保护。
  if (path === '/errors') {
    const ctx = await guard(req, res, 'errors:read');
    if (!ctx) return true;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache'
    });
    res.end(renderErrorsHtml());
    return true;
  }

  // 错误明细 JSON API：受 errors:read 保护。
  // P1 安全修复：此前该端点挂在 edge 路由表（guard 之前）且未做任何鉴权，
  // 匿名即可拉取内部错误明细（堆栈/内部路径/上游响应片段）——现与 /errors HTML 页
  // 同权走 guard，并把 edge 路由表中的同名条目移除（消除「注释声称有 guard 实际无」的不一致）。
  if (path === '/api/errors') {
    const ctx = await guard(req, res, 'errors:read');
    if (!ctx) return true;
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200;
    const full = url.searchParams.get('full') === '1';
    const fmt = url.searchParams.get('format');
    if (fmt === 'text') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        ...securityHeaders()
      });
      res.end(formatErrorReport({ limit: full ? undefined : limit }));
      return true;
    }
    const list = getErrorLog({ limit: full ? undefined : limit });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...securityHeaders()
    });
    res.end(
      JSON.stringify({ count: list.length, summary: getErrorSummary(), errors: list })
    );
    return true;
  }

  return false;
}
