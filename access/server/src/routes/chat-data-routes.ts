/**
 * 聊天数据路由（自 server.ts 外迁，P2 模块化第十批）：
 * 多会话 Chat App CRUD、聊天历史镜像（/api/history）、BYOK provider-keys 包装。
 *
 * 注意：/api/chat/stream 与 /api/events（实时 SSE）依赖 chatBus，仍留在 server.ts；
 * /api/history 由主分发器 readAction 预检守卫（chat:read），其余端点在 handler 内显式 guard。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { cfgNum, DEFAULTS } from '../config-defaults';
import {
  parseSessionPageQuery,
  listChatSessionsPage,
  createChatSession,
  getChatSession,
  renameChatSession,
  deleteChatSession
} from '../chat-sessions';
import { getHistoryStore } from '../history-store';
import { registerProviderKeyRoutes } from '../provider-keys';
import { readBody, sendJson } from '../http-helpers';
import type { Action, AuthContext } from '../authz';

export interface ChatDataRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action,
    body?: any
  ) => Promise<AuthContext | null>;
}

// 聊天历史单条体积上限（字节）；与 server.ts 的 cfgNum 同源配置。
const HISTORY_MAX_BYTES = cfgNum('HISTORY_MAX_BYTES', DEFAULTS.HISTORY_MAX_BYTES as number);

export async function handleChatDataRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: ChatDataRouteDeps
): Promise<boolean> {
  const isChatData =
    path === '/api/chat/sessions' ||
    path.startsWith('/api/chat/sessions/') ||
    path === '/api/history' ||
    path.startsWith('/api/history/') ||
    path.startsWith('/api/account/provider-keys');
  if (!isChatData) return false;
  // 别名：保持外迁代码的 guard(...) 调用形式与 server.ts 原文逐字一致。
  const guard = deps.guard;

      if (path.startsWith('/api/account/provider-keys')) {
        const ctx = await guard(req, res, 'provider:manage');
        if (!ctx) return true;
        const pkBody = await readBody(req);
        if (
          await registerProviderKeyRoutes(
            req,
            res,
            path,
            req.method ?? 'GET',
            pkBody,
            ctx.sub
          )
        )
          return true;
      }


      /* ----------------- 多会话 Chat App：会话存储 CRUD ----------------- */
      // 注意：与已存在的 /api/sessions（agent 运行期会话）区分，聊天会话走独立前缀。
      // 客户端以版本化 URL /api/v1/chat/sessions 调用，服务端在路由前已统一重写
      // /api/v1 -> /api，故此处按重写后的 /api/chat/sessions 匹配。
      if (req.method === 'GET' && path === '/api/chat/sessions') {
        // 多用户隔离：必须已登录（非匿名）才能读取自己的会话列表；越权/匿名返回 401。
        const ctx = await guard(req, res, 'chat:read');
        if (!ctx) return true;
        if (ctx.sub === 'anon') {
          res.writeHead(401, { 'content-type': 'application/json' });
res.end(
            JSON.stringify({
              error: 'authentication required for chat history'
            })
          );
          return true;
        }
        // 分页（左侧历史列表滚动加载）：limit/offset 缺省 → 返回全量，
        // 与改造前契约一致（老客户端不传参时行为不变）；响应额外带 total/hasMore。
        const { limit, offset } = parseSessionPageQuery({
          limit: url.searchParams.get('limit'),
          offset: url.searchParams.get('offset')
        });
sendJson(
          res,
          listChatSessionsPage(ctx.sub, { limit, offset }),
          req
        );
        return true;
      }
      if (req.method === 'POST' && path === '/api/chat/sessions') {
        const b = await readBody(req);
        const ctx = await guard(req, res, 'chat:write', b);
        if (!ctx) return true;
        if (ctx.sub === 'anon') {
          res.writeHead(401, { 'content-type': 'application/json' });
res.end(
            JSON.stringify({
              error: 'authentication required for chat history'
            })
          );
          return true;
        }
sendJson(
          res,
          createChatSession(b.title, ctx.sub, {
            interactionMode: b.interactionMode,
            model: b.model,
            agentId: b.agentId
          }),
          req
        );
        return true;
      }
      if (req.method === 'GET' && path.startsWith('/api/chat/sessions/')) {
        const id = decodeURIComponent(path.slice('/api/chat/sessions/'.length));
        const ctx = await guard(req, res, 'chat:read');
        if (!ctx) return true;
        if (ctx.sub === 'anon') {
          res.writeHead(401, { 'content-type': 'application/json' });
res.end(
            JSON.stringify({
              error: 'authentication required for chat history'
            })
          );
          return true;
        }
        const s = await getChatSession(id, ctx.sub);
        if (!s) {
          res.writeHead(404, { 'content-type': 'application/json' });
res.end(JSON.stringify({ error: 'session not found' }));
          return true;
        }
sendJson(res, s, req);
        return true;
      }
      if (req.method === 'PATCH' && path.startsWith('/api/chat/sessions/')) {
        const id = decodeURIComponent(path.slice('/api/chat/sessions/'.length));
        const b = await readBody(req);
        const ctx = await guard(req, res, 'chat:write', b);
        if (!ctx) return true;
        if (ctx.sub === 'anon') {
          res.writeHead(401, { 'content-type': 'application/json' });
res.end(
            JSON.stringify({
              error: 'authentication required for chat history'
            })
          );
          return true;
        }
        const s = await renameChatSession(id, b.title, ctx.sub, {
          interactionMode: b.interactionMode,
          model: b.model,
          agentId: b.agentId
        });
        if (!s) {
          res.writeHead(404, { 'content-type': 'application/json' });
res.end(JSON.stringify({ error: 'session not found' }));
          return true;
        }
sendJson(res, s, req);
        return true;
      }
      if (req.method === 'DELETE' && path.startsWith('/api/chat/sessions/')) {
        const id = decodeURIComponent(path.slice('/api/chat/sessions/'.length));
        const ctx = await guard(req, res, 'chat:delete');
        if (!ctx) return true;
        if (ctx.sub === 'anon') {
          res.writeHead(401, { 'content-type': 'application/json' });
res.end(
            JSON.stringify({
              error: 'authentication required for chat history'
            })
          );
          return true;
        }
        const ok = await deleteChatSession(id, ctx.sub);
sendJson(res, { ok }, req);
        return true;
      }


      {
        const HISTORY_PREFIX = '/api/history/';
        const validSid = (sid: string): boolean =>
          !!sid && sid.length <= 128 && /^[A-Za-z0-9_\-]+$/.test(sid);

        if (req.method === 'GET' && path === '/api/history') {
          // 多用户隔离：必须已登录（非匿名）才能读取自己的历史索引；匿名返回 401。
          const ctx = await guard(req, res, 'chat:read');
          if (!ctx) return true;
          if (ctx.sub === 'anon') {
            res.writeHead(401, { 'content-type': 'application/json' });
res.end(
              JSON.stringify({
                error: 'authentication required for chat history'
              })
            );
            return true;
          }
          const index = await getHistoryStore().index(ctx.sub);
sendJson(res, { sessions: index }, req);
          return true;
        }
        if (req.method === 'GET' && path.startsWith(HISTORY_PREFIX)) {
          const sid = decodeURIComponent(path.slice(HISTORY_PREFIX.length));
          const ctx = await guard(req, res, 'chat:read');
          if (!ctx) return true;
          if (ctx.sub === 'anon') {
            res.writeHead(401, { 'content-type': 'application/json' });
res.end(
              JSON.stringify({
                error: 'authentication required for chat history'
              })
            );
            return true;
          }
          if (!validSid(sid)) {
            res.writeHead(400, { 'content-type': 'application/json' });
res.end(JSON.stringify({ error: 'invalid session id' }));
            return true;
          }
          const row = await getHistoryStore().get(sid, ctx.sub);
          if (!row) {
            res.writeHead(404, { 'content-type': 'application/json' });
res.end(JSON.stringify({ error: 'history not found' }));
            return true;
          }
          try {
            const parsed = JSON.parse(row.data);
            // 兼容旧版：data 可能是纯 msgs 数组，也可能是 { msgs, usage } 信封。
            const msgs = Array.isArray(parsed)
              ? parsed
              : Array.isArray(parsed?.msgs)
              ? parsed.msgs
              : [];
            const usage = !Array.isArray(parsed) ? parsed.usage ?? null : null;
sendJson(res, { ...row.meta, v: 1, msgs, usage }, req);
            return true;
          } catch {
            // 存储层数据损坏：明确返回 522 类错误而非抛出未捕获异常。
            res.writeHead(500, { 'content-type': 'application/json' });
res.end(JSON.stringify({ error: 'history data corrupted' }));
            return true;
          }
        }
        if (req.method === 'PUT' && path.startsWith(HISTORY_PREFIX)) {
          const sid = decodeURIComponent(path.slice(HISTORY_PREFIX.length));
          if (!validSid(sid)) {
            res.writeHead(400, { 'content-type': 'application/json' });
res.end(JSON.stringify({ error: 'invalid session id' }));
            return true;
          }
          const b = await readBody(req);
          const ctx = await guard(req, res, 'chat:write', b);
          if (!ctx) return true;
          if (ctx.sub === 'anon') {
            res.writeHead(401, { 'content-type': 'application/json' });
res.end(
              JSON.stringify({
                error: 'authentication required for chat history'
              })
            );
            return true;
          }
          // 参数校验：msgs 必须为数组；title 收敛为字符串；整体序列化体积受限。
          if (!Array.isArray(b.msgs)) {
            res.writeHead(400, { 'content-type': 'application/json' });
res.end(JSON.stringify({ error: 'msgs must be an array' }));
            return true;
          }
          let data: string;
          try {
            // 信封并行携带会话级用量快照（usage，可选），与 msgs 一并落盘，向后兼容旧版。
            data = JSON.stringify({ msgs: b.msgs, usage: b.usage ?? null });
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
res.end(JSON.stringify({ error: 'msgs not serializable' }));
            return true;
          }
          if (Buffer.byteLength(data, 'utf-8') > HISTORY_MAX_BYTES) {
            res.writeHead(413, { 'content-type': 'application/json' });
res.end(JSON.stringify({ error: 'history too large' }));
            return true;
          }
          const now = Date.now();
          // owner 由服务端以 ctx.sub 强制写入，忽略客户端上报（防伪造归属）。
          await getHistoryStore().upsert(
            {
              sid,
              title:
                typeof b.title === 'string' && b.title.trim()
                  ? b.title.trim().slice(0, 200)
                  : '新对话',
              updatedAt:
                typeof b.updatedAt === 'number' && Number.isFinite(b.updatedAt)
                  ? Math.floor(b.updatedAt)
                  : now,
              savedAt: now
            },
            data,
            ctx.sub
          );
sendJson(res, { ok: true }, req);
          return true;
        }
        if (req.method === 'DELETE' && path.startsWith(HISTORY_PREFIX)) {
          const sid = decodeURIComponent(path.slice(HISTORY_PREFIX.length));
          if (!validSid(sid)) {
            res.writeHead(400, { 'content-type': 'application/json' });
res.end(JSON.stringify({ error: 'invalid session id' }));
            return true;
          }
          const ctx = await guard(req, res, 'chat:delete');
          if (!ctx) return true;
          if (ctx.sub === 'anon') {
            res.writeHead(401, { 'content-type': 'application/json' });
res.end(
              JSON.stringify({
                error: 'authentication required for chat history'
              })
            );
            return true;
          }
          const ok = await getHistoryStore().remove(sid, ctx.sub);
sendJson(res, { ok }, req);
          return true;
        }
      }

  return false;
}
