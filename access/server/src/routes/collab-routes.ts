/**
 * 协作资源路由（自 server.ts 外迁，P2 模块化第九批）：
 * 工作空间 / 成果物归档 / 浏览器沙箱会话。
 *
 * 覆盖：GET+POST /api/workspaces、/api/workspaces/:id（GET/PATCH/PUT/DELETE）、
 *       /api/workspaces/:id/sessions、
 *       GET+POST /api/artifacts、GET+DELETE /api/artifacts/:id、
 *       GET+POST /api/sandbox/sessions、GET+DELETE /api/sandbox/sessions/:id。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  createWorkspaceStore,
  ensureDefaultWorkspace,
  type Workspace,
  type WorkspaceStore
} from '../workspace-store';
import { getArtifactStore } from '../artifact-store';
import { getSandboxManager } from '../browser-sandbox';
import { listChatSessions } from '../chat-sessions';
import { markdownPreviewHtml } from '../markdown-preview';
import { readBody, sendJson } from '../http-helpers';
import type { Action, AuthContext } from '../authz';

export interface CollabRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action,
    body?: any
  ) => Promise<AuthContext | null>;
  auditAction: (action: string, fields: Record<string, unknown>) => void;
  /** server.ts 组合根持有的工作空间存储单例（createWorkspaceStore 非单例工厂，必须注入共享）。 */
  workspaceStore: WorkspaceStore;
}

/** 空间访问控制：admin 全可见；否则需为成员（owner 天然是成员）。 */
function canAccessWorkspace(ws: Workspace, sub: string, role: string): boolean {
  return role === 'admin' || ws.members.includes(sub) || ws.owner === sub;
}

export async function handleCollabRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: CollabRouteDeps
): Promise<boolean> {
  const isCollab =
    path === '/api/workspaces' ||
    path.startsWith('/api/workspaces/') ||
    path === '/api/artifacts' ||
    path.startsWith('/api/artifacts/') ||
    path.startsWith('/api/sandbox/sessions');
  if (!isCollab) return false;

  // ── 工作空间（参考图能力链路：User → Workspace → Skill → Tool → Data → Credential → Policy）──
  // 纯业务层：把「一组会话 / 可用技能 / 成员 / 配额」收拢为显式资源；core 零感知。
  if (path === '/api/workspaces') {
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'workspace:read');
      if (!ctx) return true;
      if (ctx.sub === 'anon') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'authentication required' }));
        return true;
      }
      // 首次访问自动创建「默认空间」，保证开箱即用（幂等：已有空间则原样返回）。
      const spaces = ensureDefaultWorkspace(deps.workspaceStore, ctx.sub);
      sendJson(res, { workspaces: spaces, store: deps.workspaceStore.kind }, req);
      return true;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const ctx = await deps.guard(req, res, 'workspace:write', body);
      if (!ctx) return true;
      if (ctx.sub === 'anon') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'authentication required' }));
        return true;
      }
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing name' }));
        return true;
      }
      const ws = deps.workspaceStore.create({
        name,
        owner: ctx.sub,
        members: Array.isArray(body?.members) ? body.members.map(String) : undefined,
        skills: Array.isArray(body?.skills) ? body.skills.map(String) : undefined,
        quota: body?.quota && typeof body.quota === 'object' ? body.quota : undefined,
        tenantId: ctx.tenantId ?? undefined
      });
      deps.auditAction('workspace.create', { id: ws.id, sub: ctx.sub });
      sendJson(res, { workspace: ws }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  if (path.startsWith('/api/workspaces/')) {
    const rest = path.slice('/api/workspaces/'.length).replace(/\/$/, '');
    // 子资源：/api/workspaces/:id/sessions —— 该空间下的会话列表。
    const sessionsMatch = /^([^/]+)\/sessions$/.exec(rest);
    if (sessionsMatch) {
      const ctx = await deps.guard(req, res, 'workspace:read');
      if (!ctx) return true;
      const ws = deps.workspaceStore.get(decodeURIComponent(sessionsMatch[1] ?? ''));
      if (!ws) {
        sendJson(res, { error: 'not found' }, req);
        return true;
      }
      if (!canAccessWorkspace(ws, ctx.sub, ctx.role)) {
        sendJson(res, { error: 'forbidden' }, req);
        return true;
      }
      const sessions = listChatSessions(ctx.sub).filter((s) => s.workspaceId === ws.id);
      sendJson(res, { workspaceId: ws.id, sessions }, req);
      return true;
    }
    const wsId = decodeURIComponent(rest);
    const action: Action = req.method === 'GET' ? 'workspace:read' : 'workspace:write';
    const ctx = await deps.guard(req, res, action);
    if (!ctx) return true;
    const ws = deps.workspaceStore.get(wsId);
    if (!ws) {
      sendJson(res, { error: 'not found' }, req);
      return true;
    }
    if (!canAccessWorkspace(ws, ctx.sub, ctx.role)) {
      sendJson(res, { error: 'forbidden' }, req);
      return true;
    }
    if (req.method === 'GET') {
      sendJson(res, { workspace: ws }, req);
      return true;
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readBody(req);
      const updated = deps.workspaceStore.update(wsId, {
        ...(body?.name != null ? { name: String(body.name) } : {}),
        ...(Array.isArray(body?.members) ? { members: body.members.map(String) } : {}),
        ...(Array.isArray(body?.skills) ? { skills: body.skills.map(String) } : {}),
        ...(body?.quota !== undefined ? { quota: body.quota } : {})
      });
      deps.auditAction('workspace.update', { id: wsId, sub: ctx.sub });
      sendJson(res, { workspace: updated }, req);
      return true;
    }
    if (req.method === 'DELETE') {
      // 仅 owner 或 admin 可删除空间。
      if (ctx.role !== 'admin' && ws.owner !== ctx.sub) {
        sendJson(res, { error: 'forbidden: only owner or admin can delete' }, req);
        return true;
      }
      deps.workspaceStore.remove(wsId);
      deps.auditAction('workspace.delete', { id: wsId, sub: ctx.sub });
      sendJson(res, { ok: true }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  // ── P1-5 成果物归档页 / 文件库（受 artifact:read / artifact:write 保护）──
  // 列出 / 详情 / 下载 / 删除；POST 以 base64 内容落盘（便于通过 JSON 走现有网关）。
  if (path === '/api/artifacts') {
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'artifact:read');
      if (!ctx) return true;
      // P4.6：?runId=<workflowId> 仅返回该 plan run 归档的交付文件（计划结论底部文件区按 run 拉取）。
      const runIdFilter = url.searchParams.get('runId') || undefined;
      const all = await getArtifactStore().list(runIdFilter);
      // P1 安全修复（IDOR）：列表按 owner 收敛——admin 全可见，其余仅见本人工件。
      // 此前无归属过滤，任意 viewer 可读取所有用户的 Agent 产出物（可能含业务数据）。
      const items = ctx.role === 'admin' ? all : all.filter((m) => m.owner === ctx.sub);
      sendJson(res, { items }, req);
      return true;
    }
    if (req.method === 'POST') {
      const ctx = await deps.guard(req, res, 'artifact:write');
      if (!ctx) return true;
      const b = await readBody(req);
      const name = typeof b?.name === 'string' ? b.name.trim() : '';
      const contentB64 = typeof b?.contentBase64 === 'string' ? b.contentBase64 : '';
      if (!name || !contentB64) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'name and contentBase64 are required' }));
        return true;
      }
      const meta = await getArtifactStore().save({
        name,
        kind: typeof b?.kind === 'string' && b.kind ? b.kind : 'other',
        mimeType:
          typeof b?.mimeType === 'string' && b.mimeType
            ? b.mimeType
            : 'application/octet-stream',
        content: Buffer.from(contentB64, 'base64'),
        owner: ctx.sub,
        runId: typeof b?.runId === 'string' ? b.runId : undefined,
        note: typeof b?.note === 'string' ? b.note : undefined
      });
      sendJson(res, { item: meta }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  if (path.startsWith('/api/artifacts/')) {
    const id = decodeURIComponent(path.slice('/api/artifacts/'.length).replace(/\/.*$/, ''));
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'artifact:read');
      if (!ctx) return true;
      const dl = url.searchParams.get('download') === '1';
      // P4.6：?preview=1 在线打开（content-disposition: inline，浏览器直接渲染/查看文本）；
      // 缺省（无 preview/download 参数）行为与旧版逐字一致——返回 JSON 元数据（成果物归档页零回归）。
      const preview = url.searchParams.get('preview') === '1';
      const meta = await getArtifactStore().get(id);
      if (!meta) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'artifact not found' }));
        return true;
      }
      // P1 安全修复（IDOR）：非 admin 仅可访问本人工件；归属不符按 404 处理，
      // 不泄露资源存在性。此前仅校验 artifact:read 动作权限，任意账号可读他人工件。
      if (ctx.role !== 'admin' && meta.owner !== ctx.sub) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'artifact not found' }));
        return true;
      }
      if (!dl && !preview) {
        sendJson(res, { item: meta }, req);
        return true;
      }
      const buf = await getArtifactStore().readContent(id);
      if (!buf) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'artifact content not found' }));
        return true;
      }
      // md 预览：服务端转成 HTML 渲染页（下载仍返回原始 markdown）。
      if (preview && meta.mimeType === 'text/markdown') {
        const html = markdownPreviewHtml(buf.toString('utf8'), meta.name);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-disposition': `inline; filename="${encodeURIComponent(meta.name)}"`,
          'content-length': Buffer.byteLength(html)
        });
        res.end(html);
        return true;
      }
      // 其余类型（txt/csv/json 等）维持原行为：inline 按原 mimeType 打开。
      res.writeHead(200, {
        'content-type': meta.mimeType,
        'content-disposition': `${dl ? 'attachment' : 'inline'}; filename="${encodeURIComponent(meta.name)}"`,
        'content-length': buf.length
      });
      res.end(buf);
      return true;
    }
    if (req.method === 'DELETE') {
      const ctx = await deps.guard(req, res, 'artifact:write');
      if (!ctx) return true;
      // P1 安全修复（IDOR）：删除同样需归属校验（admin 豁免）；此前 operator 可删任意用户工件。
      // 找不到与归属不符统一按 404 处理，不泄露资源存在性。
      const meta = await getArtifactStore().get(id);
      if (!meta || (ctx.role !== 'admin' && meta.owner !== ctx.sub)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'artifact not found' }));
        return true;
      }
      const ok = await getArtifactStore().remove(id);
      sendJson(res, { ok }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  // ── P1-4 浏览器沙箱（受 sandbox:use 保护）──
  if (path === '/api/sandbox/sessions') {
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'sandbox:use');
      if (!ctx) return true;
      sendJson(res, { items: getSandboxManager().list() }, req);
      return true;
    }
    if (req.method === 'POST') {
      const ctx = await deps.guard(req, res, 'sandbox:use');
      if (!ctx) return true;
      const b = await readBody(req);
      const s = await getSandboxManager().create({
        targetUrl: typeof b?.targetUrl === 'string' ? b.targetUrl : undefined,
        owner: ctx.sub
      });
      sendJson(res, { item: s }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  if (path.startsWith('/api/sandbox/sessions/')) {
    const id = decodeURIComponent(
      path.slice('/api/sandbox/sessions/'.length).replace(/\/.*$/, '')
    );
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'sandbox:use');
      if (!ctx) return true;
      const s = getSandboxManager().get(id);
      if (!s) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return true;
      }
      sendJson(res, { item: s }, req);
      return true;
    }
    if (req.method === 'DELETE') {
      const ctx = await deps.guard(req, res, 'sandbox:use');
      if (!ctx) return true;
      const ok = getSandboxManager().destroy(id);
      sendJson(res, { ok }, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  return false;
}
