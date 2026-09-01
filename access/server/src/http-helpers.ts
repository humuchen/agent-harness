/**
 * http-helpers：HTTP 传输层辅助（从 server.ts 单体拆出）。
 *
 * 收敛「请求体读取 + 响应写出」的纯传输逻辑：CORS 头解析、JSON 响应、
 * SSE 流封装、请求体读取（含 413/400 上限与 JSON 校验）。
 * 这些函数只依赖配置默认值（DEFAULTS，单一事实来源）与 node:http，不耦合 server 的
 * 鉴权 / 路由 / 业务常量，可独立测试与维护（见可维护性审计 P2：降低 server.ts 单体规模）。
 *
 * 注意：server.ts 自身仍保留一份 UI_CORS_ORIGIN / MAX_BODY_BYTES 副本用于启动期日志，
 * 两处均派生自 DEFAULTS，不存在配置漂移风险。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULTS } from './config-defaults';

// 本地派生（与 server.ts 同源 DEFAULTS）：避免对 server 模块常量的编译期耦合 / 循环依赖。
const UI_CORS_ORIGIN = (process.env.UI_CORS_ORIGIN ?? (DEFAULTS.UI_CORS_ORIGIN as string))
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? (DEFAULTS.MAX_BODY_BYTES as number));

/** 依据配置解析本次响应应回的 CORS 头；未配置则返回空（仅同源）。 */
export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || UI_CORS_ORIGIN.length === 0) return {};
  if (UI_CORS_ORIGIN.includes('*'))
    return { 'access-control-allow-origin': '*' };
  if (UI_CORS_ORIGIN.includes(origin))
    return { 'access-control-allow-origin': origin };
  return {};
}

export function sendJson(
  res: ServerResponse,
  obj: unknown,
  req?: IncomingMessage
): void {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    ...corsHeaders(req ?? ({ headers: {} } as IncomingMessage))
  });
  res.end(JSON.stringify(obj));
}

export function startSse(
  res: ServerResponse,
  req?: IncomingMessage
): (obj: unknown) => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // 禁用反向代理（nginx/网关）对 SSE 的缓冲，确保 token 级事件边产生边下发到浏览器。
    'x-accel-buffering': 'no',
    ...corsHeaders(req ?? ({ headers: {} } as IncomingMessage))
  });
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  return (obj: unknown) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      // 客户端已断开（EPIPE 等）：标记 closed，避免对已死连接继续写。
      closed = true;
    }
  };
}

export async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      const err: any = new Error('request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const err: any = new Error('invalid JSON body');
    err.status = 400;
    throw err;
  }
}
