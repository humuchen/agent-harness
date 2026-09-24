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
    // P1 安全修复：读取同样经 guard（upload:file）——此前读取完全公开，
    // 任何匿名来源可遍历/下载他人上传的附件。浏览器 <img>/<a> 直连场景不受影响：
    // 同源请求自动携带 HttpOnly 会话 cookie（accountTokenRaw 的 cookie 来源即会话凭据）。
    const ctx = await deps.guard(req, res, 'upload:file');
    if (!ctx) return true;
    const filename = decodeURIComponent(um[1] ?? '');
    const result = await serveUploaded(filename);
    if (!result.ok) {
      sendJson(res, { error: result.error }, req);
      return true;
    }
    // P1 安全修复（存储型 XSS 缓解）：可执行类型禁止/限制内联渲染——
    // 上传白名单仍允许 text/html、text/javascript、image/svg+xml（历史数据兼容），
    // 但回显时 html/js 强制 attachment，svg 保留 inline（聊天 <img> 引用不执行脚本）
    // 并统一加 CSP sandbox 兜底（直接导航打开时阻止脚本执行与同源访问）。
    const risky =
      result.mime === 'text/html' ||
      result.mime === 'text/javascript' ||
      result.mime === 'image/svg+xml';
    res.writeHead(200, {
      'content-type': result.mime,
      'cache-control': 'public, max-age=86400',
      ...(risky
        ? {
            'content-security-policy': "sandbox; default-src 'none'",
            ...(result.mime !== 'image/svg+xml'
              ? { 'content-disposition': 'attachment' }
              : {})
          }
        : {}),
      ...corsHeaders(req)
    });
    res.end(result.buf);
    return true;
  }
  return false;
}
