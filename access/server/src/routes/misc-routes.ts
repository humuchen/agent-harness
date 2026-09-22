/**
 * 数据 / 合规 / 运维杂项路由（自 server.ts 外迁，P2 模块化第八批）。
 *
 * 覆盖：GET /api/sessions、GET+DELETE /api/memory、DELETE /api/data/gdpr、
 *       GET /api/roles、GET /api/audit、GET /api/org、
 *       GET+POST /api/supply-chain/*、GET /api/account/usage、GET /api/jev/status。
 * 鉴权说明：/api/sessions 由主分发器 readAction 预检守卫（sessions:read），
 * 其余端点在 handler 内显式 guard——与外迁前行为一致。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { URL } from 'node:url';
import {
  Memory,
  quotaEngine,
  getJevStats,
  sanitizeKey
} from '@agent-harness/core';
import { getMemoryStore, invalidateSessionMemory } from '../runner';
import { resolveJevCredential } from '../provider-keys';
import { queryAuditFile, resolveAuditFile } from '../audit-query';
import { getOrgTree } from '../org';
import { getSupplyChainScanner } from '../supply-chain';
import { readBody, sendJson, securityHeaders } from '../http-helpers';
import type { Action, Authorizer, AuthContext } from '../authz';

export interface MiscRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action,
    body?: any
  ) => Promise<AuthContext | null>;
  auditAction: (action: string, fields: Record<string, unknown>) => void;
  /** server.ts 组合根装配的鉴权器（roles 概览用）。 */
  authorizer: Authorizer;
}

const AUDIT_OUTCOMES = ['success', 'failure', 'denied', 'info'] as const;

function toEpochMs(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function handleMiscRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: MiscRouteDeps
): Promise<boolean> {
  const isMisc =
    path === '/api/sessions' ||
    path === '/api/memory' ||
    path === '/api/data/gdpr' ||
    path === '/api/roles' ||
    path === '/api/audit' ||
    path === '/api/org' ||
    path.startsWith('/api/supply-chain/') ||
    path === '/api/account/usage' ||
    path === '/api/jev/status';
  if (!isMisc) return false;

  if (req.method === 'GET' && path === '/api/sessions') {
    // 多租户记忆视图（P1-9）：列出所有已落盘记忆的会话 key 及后端类型。
    const store = getMemoryStore();
    const keys = await store.list();
    sendJson(res, { backend: store.kind, sessions: keys }, req);
    return true;
  }
  if (path === '/api/memory') {
    // 查看 / 清空某个会话（按 session key）的记忆。敏感运维动作，已接入 RBAC + 审批。
    const sessionKey = sanitizeKey(
      url.searchParams.get('session') || 'anonymous'
    );
    if (req.method === 'DELETE') {
      const body = await readBody(req);
      const ctx = await deps.guard(req, res, 'memory:clear', body);
      if (!ctx) return true;
      const store = getMemoryStore();
      const memory = new Memory({ store, sessionKey });
      await memory.clear();
      // 同步失效进程内会话记忆缓存，避免下次 run 仍复用已被清空的旧窗口。
      invalidateSessionMemory(sessionKey);
      deps.auditAction('memory.clear', {
        sessionKey,
        role: ctx.role,
        sub: ctx.sub
      });
      sendJson(res, { ok: true, sessionKey }, req);
      return true;
    }
    // GET：返回该会话的长期笔记与窗口长度（不 dump 完整对话内容，控制暴露面）。
    const ctx = await deps.guard(req, res, 'memory:read');
    if (!ctx) return true;
    const store = getMemoryStore();
    const memory = new Memory({ store, sessionKey });
    await memory.load();
    sendJson(
      res,
      {
        sessionKey,
        backend: store.kind,
        notes: memory.notes(),
        windowLen: memory.history().length
      },
      req
    );
    return true;
  }
  if (req.method === 'DELETE' && path === '/api/data/gdpr') {
    // GDPR 数据删除：按 tenantId 级联清理记忆、队列任务、会话历史。
    // 需要 memory:clear 权限 + admin 角色。
    const ctx = await deps.guard(req, res, 'memory:clear');
    if (!ctx) return true;
    if (ctx.role !== 'admin') {
      res.writeHead(403, {
        'content-type': 'application/json',
        ...securityHeaders()
      });
      res.end(JSON.stringify({ error: 'forbidden: admin only' }));
      return true;
    }
    const b = await readBody(req);
    const tenantId = typeof b?.tenantId === 'string' ? b.tenantId : '';
    if (!tenantId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing tenantId' }));
      return true;
    }
    try {
      const store = getMemoryStore();
      const allKeys = await store.list();
      let deleted = 0;
      for (const key of allKeys) {
        // 简单匹配：sessionKey 包含 tenantId 或等于 tenantId
        if (key.includes(tenantId) || key === tenantId) {
          await store.delete(key);
          invalidateSessionMemory(key);
          deleted++;
        }
      }
      deps.auditAction('gdpr.delete', { tenantId, deletedCount: deleted, role: ctx.role, sub: ctx.sub });
      sendJson(res, { ok: true, tenantId, deletedSessions: deleted }, req);
    } catch (e: any) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }
  if (req.method === 'GET' && path === '/api/roles') {
    // 当前授权配置概览（不含令牌明文），便于运维核对角色权限矩阵。
    sendJson(res, deps.authorizer.describe(), req);
    return true;
  }
  if (req.method === 'GET' && path === '/api/audit') {
    const ctx = await deps.guard(req, res, 'audit:read');
    if (!ctx) return true;
    const outcomeRaw = url.searchParams.get('outcome') ?? '';
    const outcome = (AUDIT_OUTCOMES as readonly string[]).includes(outcomeRaw)
      ? (outcomeRaw as 'success' | 'failure' | 'denied' | 'info')
      : undefined;
    const result = await queryAuditFile(resolveAuditFile(), {
      limit: Number(url.searchParams.get('limit')) || undefined,
      offset: Number(url.searchParams.get('offset')) || undefined,
      actor: url.searchParams.get('actor') || undefined,
      action: url.searchParams.get('action') || undefined,
      outcome,
      since: toEpochMs(url.searchParams.get('since')),
      until: toEpochMs(url.searchParams.get('until')),
      q: url.searchParams.get('q') || undefined
    });
    sendJson(res, result, req);
    return true;
  }
  // ── 企业组织树（P1-3）：部门 / 成员层级，受 org:read 保护 ──
  if (req.method === 'GET' && path === '/api/org') {
    const ctx = await deps.guard(req, res, 'org:read');
    if (!ctx) return true;
    const tree = await getOrgTree();
    sendJson(res, tree, req);
    return true;
  }
  // ── 供应链安全：SBOM / 依赖扫描报告（supplychain:read）──
  if (path === '/api/supply-chain/report') {
    if (req.method === 'GET') {
      const ctx = await deps.guard(req, res, 'supplychain:read');
      if (!ctx) return true;
      // 本模块位于 src/routes/，仓库根需再上溯一级（server.ts 在 src/ 时为三级）。
      const repoRoot = resolve(__dirname, '..', '..', '..', '..');
      const report = await getSupplyChainScanner(repoRoot).scan();
      sendJson(res, report, req);
      return true;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  if (path === '/api/supply-chain/scan' && req.method === 'POST') {
    const ctx = await deps.guard(req, res, 'supplychain:read');
    if (!ctx) return true;
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const report = await getSupplyChainScanner(repoRoot).scan();
    sendJson(res, report, req);
    return true;
  }
  if (path === '/api/account/usage' && req.method === 'GET') {
    const ctx = await deps.guard(req, res, 'provider:manage');
    if (!ctx) return true;
    const usage = quotaEngine.getUsage(ctx.sub);
    const limits = quotaEngine.getQuota(ctx.sub);
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(
      JSON.stringify({
        usage,
        limits: {
          qps: limits.qps ?? null,
          maxConcurrency: limits.maxConcurrency ?? null,
          maxTokensPerWindow: limits.maxTokensPerWindow ?? null,
          maxCostPerWindow: limits.maxCostPerWindow ?? null,
          windowMs: limits.windowMs ?? null
        }
      })
    );
    return true;
  }
  if (req.method === 'GET' && path === '/api/jev/status') {
    const ctx = await deps.guard(req, res, 'provider:manage');
    if (!ctx) return true;
    const userCred = await resolveJevCredential(ctx.sub).catch(() => null);
    const source =
      userCred?.apiKey ? 'user' : process.env.TYPESAFE_API_KEY ? 'env' : 'none';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        {
          configured: source !== 'none',
          credentialSource: source,
          baseUrl: process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1',
          switches: {
            // 三开关默认 off：off 时各子系统完全走旧逻辑（零 Jev 调用）。
            injectionGate: (process.env.JEV_INJECTION_GATE || 'off').toLowerCase() === 'on',
            routing: (process.env.JEV_ROUTING || 'off').toLowerCase() === 'on',
            contextCompress:
              (process.env.JEV_CONTEXT_COMPRESS || 'off').toLowerCase() === 'on'
          },
          // lastCalledAt === null 表示本进程启动以来 Jev 从未被调用过。
          stats: getJevStats()
        },
        null,
        2
      )
    );
    return true;
  }
  return false;
}
