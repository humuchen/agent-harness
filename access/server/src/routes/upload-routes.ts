/**
 * 文件上传路由（自 server.ts 外迁，P2 模块化第二批）。
 *
 * 覆盖：POST /api/upload（multipart/form-data 附件上传）、
 *       GET /api/uploads/:filename（静态展示，含防穿越）。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleUpload, serveUploaded } from '../upload';
import { corsHeaders, sendJson } from '../http-helpers';
import { cfgNum, DEFAULTS } from '../config-defaults';
import type { Action, AuthContext } from '../authz';

export interface UploadRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action
  ) => Promise<AuthContext | null>;
}

// 文件上传：单文件上限（MB）与 /api/upload 请求体截断阈值（字节）。
// 请求体上限比单文件限制多 2MB 余量，覆盖 multipart boundary / headers 开销。
const UPLOAD_MAX_MB = cfgNum('UPLOAD_MAX_MB', DEFAULTS.UPLOAD_MAX_MB as number);
const UPLOAD_BODY_MAX_BYTES = (UPLOAD_MAX_MB + 2) * 1024 * 1024;

export async function handleUploadRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: UploadRouteDeps
): Promise<boolean> {
  if (!path.startsWith('/api/upload')) return false;

  // 上传附件：POST /api/upload（multipart/form-data，图片/文本）。
  if (path === '/api/upload' && req.method === 'POST') {
    const ctx = await deps.guard(req, res, 'upload:file');
    if (!ctx) return true;
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const c of req) {
        total += (c as Buffer).length;
        if (total > UPLOAD_BODY_MAX_BYTES) {
          const err: any = new Error(
            `request body too large (${UPLOAD_MAX_MB + 2} MB limit)`
          );
          err.status = 413;
          throw err;
        }
        chunks.push(c as Buffer);
      }
      const result = await handleUpload(
        Buffer.concat(chunks),
        String(req.headers['content-type'] ?? '')
      );
      if (!result.ok) {
        sendJson(res, { error: result.error }, req);
        return true;
      }
      sendJson(res, { ok: true, meta: result.meta }, req);
      return true;
    } catch (e: any) {
      // 413 已在写出响应前抛出；统一按业务错误回 JSON（状态码沿用原行为：非 413 → 400）。
      sendJson(res, { error: e?.message ?? String(e) }, req);
      return true;
    }
  }

  // 获取已上传文件：GET /api/uploads/:filename（静态展示用，含防穿越）。
  const um = path.match(/^\/api\/uploads\/(.+)$/);
  if (um && req.method === 'GET') {
    const filename = decodeURIComponent(um[1] ?? '');
    const result = await serveUploaded(filename);
    if (!result.ok) {
      sendJson(res, { error: result.error }, req);
      return true;
    }
    res.writeHead(200, {
      'content-type': result.mime,
      'cache-control': 'public, max-age=86400',
      ...corsHeaders(req)
    });
    res.end(result.buf);
    return true;
  }
  return false;
}
