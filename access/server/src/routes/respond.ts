/**
 * 接入层 HTTP 响应辅助（被 routes/*.ts 共享，避免各路由文件重复依赖 server.ts 闭包）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 以 200 + JSON 响应（含 CORS 头）。 */
export function sendJsonRoute(res: ServerResponse, obj: unknown): void {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(obj));
}

/** 以指定状态码 + JSON 响应（含 CORS 头）。 */
export function sendJsonError(
  res: ServerResponse,
  status: number,
  obj: unknown,
  req?: IncomingMessage
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(obj));
}
