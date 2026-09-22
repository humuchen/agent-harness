/**
 * 设备推送令牌路由（自 server.ts 外迁，P2 模块化第二批）。
 *
 * 覆盖：POST /api/devices（移动端 FCM/APNs 令牌注册）。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md：
 * deps 注入 server.ts 闭包（guard），未命中返回 false 由主分发器继续。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDeviceStore } from '../device-store';
import { readBody, sendJson } from '../http-helpers';
import type { Action, AuthContext } from '../authz';

export interface DeviceRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action
  ) => Promise<AuthContext | null>;
}

export async function handleDeviceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: DeviceRouteDeps
): Promise<boolean> {
  if (!path.startsWith('/api/devices')) return false;

  // ── P2-1 手机端：设备推送令牌注册 ──
  // 移动端在启动时注册 FCM/APNs 设备令牌，供服务端推送通知使用。
  // 受 chat:read 保护（已登录用户才能注册自己的设备）。
  if (path === '/api/devices' && req.method === 'POST') {
    const ctx = await deps.guard(req, res, 'chat:read');
    if (!ctx) return true;
    const b = await readBody(req);
    const token = typeof b?.token === 'string' ? b.token.trim() : '';
    const platform = b?.platform === 'android' ? 'android' : 'ios';
    if (!token) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'token is required' }));
      return true;
    }
    const device = await getDeviceStore().register({
      owner: ctx.sub,
      token,
      platform
    });
    sendJson(res, { device }, req);
    return true;
  }
  return false;
}
