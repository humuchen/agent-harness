/**
 * 工作流执行路由（自 server.ts 外迁，P2 模块化第七批）。
 *
 * 覆盖：GET    /api/workflows/:id                      → 执行快照
 *       GET    /api/workflows/:id/run-traces[?runId=]   → run 过程归档查询
 *       POST   /api/workflows/:id/resume                → 从断点续跑（SSE）
 *       POST   /api/workflows/:id/approve               → P3 人工审批放行（写检查点后 resume）
 *       POST   /api/workflows/:id/cancel                → P5.4 显式取消（abort 活动 run）
 *       POST   /api/workflows/:id/rerun                 → P6 分叉重跑（重置 step 及传递下游）
 *       POST   /api/workflows/:id/rollback              → P6 方案一 A（快照回放锚点）
 *
 * 迁移原则（与前六批一致）：语句逐字等价，闭包依赖（guard / auditAction）经 deps
 * 注入；模块级依赖直接 import。鉴权口径：POST 动作（resume/approve/cancel/rerun/
 * rollback）→ workflow:run；GET 快照/归档 → workflow:read。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  DagEngine,
  resetRunForRerun,
  getRunTraceStore,
  type WorkflowEvent
} from '@agent-harness/core';
import { readBody, sendJson, startSse, endSse } from '../http-helpers.js';
import { workflowStore, createWorkflowExecutor } from '../workflow-executor.js';
import { archivePlanArtifacts } from '../plan-artifacts.js';
import {
  activeWorkflowAborts,
  resolveWorkflowRunOpts,
  createPlanTaskSync,
  auditWfEvent,
  maybeArchiveRunTrace
} from './run-routes.js';
import type { Action, AuthContext } from '../authz.js';

export interface WorkflowRouteDeps {
  guard: (
    req: IncomingMessage,
    res: ServerResponse,
    action: Action
  ) => Promise<AuthContext | null>;
  /** server.ts 的动作级审计闭包（audit 的薄包装）。 */
  auditAction: (action: string, fields: Record<string, unknown>) => void;
}

export async function handleWorkflowRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  deps: WorkflowRouteDeps
): Promise<boolean> {
  if (!path.startsWith('/api/workflows/')) return false;
  const guard = deps.guard;
  const auditAction = deps.auditAction;

  const isResume = req.method === 'POST' && path.endsWith('/resume');
  const isApprove = req.method === 'POST' && path.endsWith('/approve');
  const isCancel = req.method === 'POST' && path.endsWith('/cancel');
  const isRerun = req.method === 'POST' && path.endsWith('/rerun');
  const isRollback = req.method === 'POST' && path.endsWith('/rollback');
  // POST /resume、/approve、/cancel、/rerun、/rollback 会影响执行中的 agent（写操作）→ workflow:run；GET 快照/归档 → workflow:read。
  const ctx = await guard(
    req,
    res,
    isResume || isApprove || isCancel || isRerun || isRollback ? 'workflow:run' : 'workflow:read'
  );
  if (!ctx) return true;
  const id = decodeURIComponent(
    path.slice('/api/workflows/'.length).replace(/\/$/, '')
  );
  // P6（分叉重跑）：POST /api/workflows/:id/rerun —— body.stepId 指定重新执行的起点。
  // 语义：把该 step 及其全部传递下游重置为 pending（清产出/错误/链路），run 置回
  // pending 落盘；随后调用既有 POST /:id/resume 即从该 step 重新执行（上游 done 产出
  // 复用，执行端点带凭据/SSE 与普通续跑完全同款）。拆成「重置 + 续跑」两步而非一步执行，
  // 是为了完整复用 /resume 的 BYOK 凭据解析与 SSE 链路（不在本分支重复执行器装配）。
  if (isRerun) {
    const workflowId = id.slice(0, -'/rerun'.length);
    if (!workflowId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing workflow id' }));
      return true;
    }
    const body = await readBody(req);
    const stepId = typeof body.stepId === 'string' ? body.stepId.trim() : '';
    if (!stepId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rerun requires body.stepId（分叉重跑起点）' }));
      return true;
    }
    try {
      const store = workflowStore();
      const run = await store.get(workflowId);
      if (!run) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'workflow not found', id: workflowId }));
        return true;
      }
      const updated = resetRunForRerun(run, stepId);
      await store.save(updated);
      auditAction('workflow.rerun', {
        workflowId,
        stepId,
        resetSteps: Object.values(updated.steps).filter((s) => s.state === 'pending').length,
        role: ctx.role,
        sub: ctx.sub
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          workflowId,
          stepId,
          run: updated,
          hint: `POST /api/workflows/${encodeURIComponent(workflowId)}/resume 从 step "${stepId}" 重新执行`
        })
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // running 态拒绝 / 未知 step → 语义化 4xx；其余 500。
      const status = /正在运行/.test(msg) ? 409 : /不存在 step/.test(msg) ? 400 : 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
    return true;
  }
  // P6 观测（方案三一期）：GET /api/workflows/:id/run-traces[?runId=] —— run 过程归档查询。
  // 无 runId → 该工作流最近 ≤20 次执行的归档列表（新→旧）；带 runId → 单次完整归档
  // （per-step 状态/重试/错误/调用链路）。鉴权走本分支共同的 workflow:read（只读）。
  if (req.method === 'GET' && id.endsWith('/run-traces')) {
    const workflowId = id.slice(0, -'/run-traces'.length);
    if (!workflowId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing workflow id' }));
      return true;
    }
    try {
      const traceStore = getRunTraceStore();
      const runId = url.searchParams.get('runId');
      if (runId) {
        const rec = await traceStore.get(workflowId, runId);
        if (!rec) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'run trace not found', workflowId, runId }));
          return true;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ trace: rec }));
        return true;
      }
      const traces = await traceStore.list(workflowId, 20);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ traces }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }
  // P6 方案一 A：POST /api/workflows/:id/rollback —— body.snapshotId 指定回放锚点。
  // 语义：把 run 恢复到该快照时点（steps/outputs 恢复，产出超限 step 重置 pending），
  // state → pending 落盘；随后调用既有 POST /:id/resume 重放（与 rerun 同款「重置 + 续跑」
  // 两步拆分，完整复用 /resume 的 BYOK 凭据解析与 SSE 链路）。运行中拒绝（409）。
  if (isRollback) {
    const workflowId = id.slice(0, -'/rollback'.length);
    if (!workflowId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing workflow id' }));
      return true;
    }
    const body = await readBody(req);
    const snapshotId = typeof body.snapshotId === 'string' ? body.snapshotId.trim() : '';
    if (!snapshotId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'rollback requires body.snapshotId（回放锚点快照 id）' })
      );
      return true;
    }
    try {
      const store = workflowStore();
      const run = await store.get(workflowId);
      if (!run) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'workflow not found', id: workflowId }));
        return true;
      }
      const engine = new DagEngine({ store, executor: async () => ({}), onEvent: (e: unknown) => {
        if (e && typeof e === 'object' && 'type' in e) {
          const ev = e as WorkflowEvent;
          auditWfEvent(ev, ctx);
          maybeArchiveRunTrace(ev);
        }
      } });
      const updated = await engine.rollback(workflowId, snapshotId);
      auditAction('workflow.rollback', {
        workflowId,
        snapshotId,
        restoredSteps: Object.values(updated.steps).filter((s) => s.state === 'done').length,
        role: ctx.role,
        sub: ctx.sub
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          workflowId,
          snapshotId,
          run: updated,
          hint: `POST /api/workflows/${encodeURIComponent(workflowId)}/resume 从快照 "${snapshotId}" 重放`
        })
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /正在运行/.test(msg) ? 409 : /快照不存在/.test(msg) ? 400 : 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
    return true;
  }
  // POST /resume 路径单独处理
  if (req.method === 'POST' && id.endsWith('/resume')) {
    const workflowId = id.slice(0, -'/resume'.length);
    if (!workflowId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing workflow id' }));
      return true;
    }
    let closed = false;
    // P5.4 断连不再中止（同首跑语义）：续跑期间客户端断开（后台标签节流 / 网络抖动），
    // 服务端 run 继续跑完并落检查点；显式取消走 POST /:id/cancel（活动 run 注册表）。
    const runAbort = new AbortController();
    res.on('close', () => {
      closed = true;
    });
    // P1（断点续跑）：resume body 与执行端点同构（mode / BYOK 模型凭据 / ctxWindow /
    // web / verify / sessionId）——检查点按 P1.3 纪律不存明文凭据，续跑时按登录 owner
    // 重新解析凭据；real 模式无 Key 在 SSE 开启前 402 快速失败。旧客户端不带 body 时
    // readBody 返回 {} → 默认 mock，向后兼容。
    const body = await readBody(req);
    // P4.5：前置读检查点 def，判定续跑是否沿用 plan 桥语义（默认验证门禁 +
    // 逐 task 结果断言 + 重试预算）；手工工作流（def 无 failOnInvalidOutput）零回归。
    // 读失败保守按未命中（非 plan），下方原有 try 块的 404 / wf:error 语义不变。
    const store = workflowStore();
    let existing: unknown;
    try {
      existing = await store.get(workflowId);
    } catch {
      existing = undefined;
    }
    const isPlanWorkflow = !!(
      existing &&
      typeof existing === 'object' &&
      (existing as { def?: { failOnInvalidOutput?: boolean } }).def?.failOnInvalidOutput
    );
    const execOpts = await resolveWorkflowRunOpts(body, ctx, res, isPlanWorkflow);
    if (!execOpts) return true; // 402 已写出（SSE 未开，不进入异步执行）
    let send: (payload: unknown) => void = () => {};
    try {
      if (!existing) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'workflow not found', id: workflowId }));
        return true;
      }
      // 检查是否可续跑：steps 是 Record<stepId, StepRun>（非数组）；
      // 终态 = done / skipped / compensated，存在任何非终态 step 即可续跑。
      const stepValues = Object.values(
        (existing as { steps?: Record<string, { state?: string }> }).steps ?? {}
      );
      const unfinished = stepValues.filter(
        (s) => s.state !== 'done' && s.state !== 'skipped' && s.state !== 'compensated',
      );
      if (unfinished.length === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no unfinished steps to resume' }));
        return true;
      }
      send = startSse(res, req);
      // plan 来源工作流续跑同样同步计划看板（P2-3，幂等节流）；仅当请求显式携带 sessionId。
      const planSync = createPlanTaskSync(
        typeof body.sessionId === 'string' ? body.sessionId : undefined,
        ctx.sub
      );
      auditAction('workflow.resume', {
        workflowId,
        mode: execOpts.mode,
        role: ctx.role,
        sub: ctx.sub
      });
      const engine = new DagEngine({
        store,
        executor: createWorkflowExecutor({
          // P5 静默展示（plan 桥工作流续跑同首跑语义）：抑制 llm:token 流式内容。
          onEvent: (e: { type?: string }, stepId: string) => {
            if (isPlanWorkflow && e?.type === 'llm:token') return;
            if (!closed) send({ type: 'harness', event: e, stepId });
          },
          // P1（断点续跑）：BYOK / verify / mode 与执行端点共享解析结果透传（此前缺失 →
          // real 部署下续跑首 step 复现 t1 同款 401/无 Key 故障）。
          mode: execOpts.mode,
          ...execOpts.opts,
        }),
        onEvent: (e: unknown) => {
          // 断点续跑同样产生 wf:step:failed / wf:done / wf:failed → 节点级审计对齐（见 auditWfEvent）。
          if (e && typeof e === 'object' && 'type' in e) {
            const ev = e as WorkflowEvent;
            auditWfEvent(ev, ctx);
            maybeArchiveRunTrace(ev);
            planSync?.sync(ev);
          }
          if (!closed) send(e);
        },
      });
      // P5.4：登记活动 run（显式取消通道），终态时移除（finally 透传原结果/异常）。
      activeWorkflowAborts.set(workflowId, runAbort);
      const run = await engine
        .resume(workflowId, runAbort.signal)
        .finally(() => activeWorkflowAborts.delete(workflowId));
      // P4.6：续跑终态同样归档交付文件（按 runId+stepId 幂等去重，首跑已归档的自动跳过）。
      await archivePlanArtifacts({ def: run.def, run, owner: ctx.sub }).catch((e) => {
        console.warn(`[plan-artifacts] 归档失败（不阻断执行）：${e instanceof Error ? e.message : String(e)}`);
      });
      if (!closed) send({ type: '_wf_done', workflowId, run });
      endSse(res, () => {
        closed = true;
      });
    } catch (e) {
      if (!closed)
        send({ type: 'wf:error', workflowId, message: e instanceof Error ? e.message : String(e) });
      endSse(res, () => {
        closed = true;
      });
    }
    return true;
  }
  // P3（人工审批门）：POST /api/workflows/:id/approve —— 把 stepId 写入检查点
  // run.approvals 后触发 DagEngine.resume（引擎据此跳过审批门继续执行，可能再次
  // 暂停在下一道门并再发 wf:awaiting-approval）。骨架与 /resume 同款（共享
  // resolveWorkflowRunOpts 的 BYOK 解析 + startSse + planSync + 审计）。
  if (req.method === 'POST' && id.endsWith('/approve')) {
    const workflowId = id.slice(0, -'/approve'.length);
    if (!workflowId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing workflow id' }));
      return true;
    }
    let closed = false;
    // P5.3 断连即中止（同首跑 / resume 语义）：审批放行后的续跑期间客户端断开 → 中止引擎 run。
    const runAbort = new AbortController();
    res.on('close', () => {
      closed = true;
      if (!res.writableEnded) runAbort.abort();
    });
    const body = await readBody(req);
    const execOpts = await resolveWorkflowRunOpts(body, ctx, res);
    if (!execOpts) return true; // 402 已写出（SSE 未开，不进入异步执行）
    let send: (payload: unknown) => void = () => {};
    try {
      const store = workflowStore();
      const run = await store.get(workflowId);
      if (!run) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'workflow not found', id: workflowId }));
        return true;
      }
      // 终态工作流不可审批放行（无未决门）。
      if (run.state === 'done' || run.state === 'compensated') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `workflow in terminal state ${run.state}; nothing to approve` }));
        return true;
      }
      // 审批目标：stepId（单节点）/ all:true（当前所有未决门节点）二选一。
      // 候选 = 检查点中非终态（awaiting / pending / running / failed）的 step：
      // awaiting 是正在等放行的门；failed 经审批同样可放行重试（配合旧语义的
      // 断点续跑）；pending/running 放行无害（下一波次自然执行）。
      const stepStates = Object.values((run as unknown as { steps?: Record<string, { state?: string }> }).steps ?? {}) as Array<{ state?: string; id?: string }>;
      const openIds = stepStates.filter((s) => s.state !== 'done' && s.state !== 'skipped' && s.state !== 'compensated').map((s) => s.id!).filter(Boolean);
      const stepId = typeof body.stepId === 'string' && body.stepId ? body.stepId : undefined;
      let approved: string[];
      if (body.all === true) {
        approved = openIds;
      } else if (stepId) {
        if (!openIds.includes(stepId)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `step "${stepId}" is not open (state: ${(run as unknown as { steps?: Record<string, { state?: string }> }).steps?.[stepId]?.state ?? 'absent'})` }));
          return true;
        }
        approved = [stepId];
      } else {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'approve requires body.stepId (single node) or body.all=true (all open gates)' }));
        return true;
      }
      if (approved.length === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no open steps to approve' }));
        return true;
      }
      // 写入检查点（随 FileWorkflowStore 持久化，跨重启保留放行决定）：
      // 去重合并，同 id 重复审批幂等。
      const prev = new Set(Array.isArray(run.approvals) ? run.approvals : []);
      for (const id2 of approved) prev.add(id2);
      (run as unknown as { approvals?: string[] }).approvals = [...prev];
      await store.save(run);
      auditAction('workflow.approve', {
        workflowId,
        approved,
        all: body.all === true,
        mode: execOpts.mode,
        role: ctx.role,
        sub: ctx.sub
      });
      send = startSse(res, req);
      const planSync = createPlanTaskSync(
        typeof body.sessionId === 'string' ? body.sessionId : undefined,
        ctx.sub
      );
      const engine = new DagEngine({
        store,
        executor: createWorkflowExecutor({
          // P5 静默展示（plan 桥工作流审批续跑同首跑语义）：抑制 llm:token 流式内容。
          onEvent: (e: { type?: string }, stepId: string) => {
            const isPlanWf = !!(run as unknown as { def?: { failOnInvalidOutput?: boolean } }).def?.failOnInvalidOutput;
            if (isPlanWf && e?.type === 'llm:token') return;
            if (!closed) send({ type: 'harness', event: e, stepId });
          },
          // P1（断点续跑）：BYOK / verify / mode 与执行端点共享解析结果透传。
          mode: execOpts.mode,
          ...execOpts.opts,
        }),
        onEvent: (e: unknown) => {
          // 审批放行后续跑同样产生 wf:* 事件（含下一道门的 wf:awaiting-approval）→ 审计 + 看板对齐。
          if (e && typeof e === 'object' && 'type' in e) {
            const ev = e as WorkflowEvent;
            auditWfEvent(ev, ctx);
            maybeArchiveRunTrace(ev);
            planSync?.sync(ev);
          }
          if (!closed) send(e);
        },
      });
      // P5.4：登记活动 run（显式取消通道），终态时移除（finally 透传原结果/异常）。
      activeWorkflowAborts.set(workflowId, runAbort);
      const run2 = await engine
        .resume(workflowId, runAbort.signal)
        .finally(() => activeWorkflowAborts.delete(workflowId));
      // P4.6：审批放行续跑终态同样归档交付文件（幂等去重，前序已归档的自动跳过）。
      await archivePlanArtifacts({ def: run2.def, run: run2, owner: ctx.sub }).catch((e) => {
        console.warn(`[plan-artifacts] 归档失败（不阻断执行）：${e instanceof Error ? e.message : String(e)}`);
      });
      if (!closed) send({ type: '_wf_done', workflowId, run: run2 });
      endSse(res, () => {
        closed = true;
      });
    } catch (e) {
      if (!closed)
        send({ type: 'wf:error', workflowId, message: e instanceof Error ? e.message : String(e) });
      endSse(res, () => {
        closed = true;
      });
    }
    return true;
  }
  // P5.4 显式取消：abort 活动 run 的引擎 signal。引擎捕获 abort → 检查点落 failed
  // （step 保留已完成状态），用户可经「从失败任务继续」从断点续跑。仅取消「本进程
  // 正在运行」的 run —— 无活动 run（已终态 / 服务重启后只剩检查点）时直接 ok 返回，
  // 幂等不报错（前端取消语义不受影响：卡片已本地置 cancelled）。
  if (isCancel) {
    const workflowId = id.slice(0, -'/cancel'.length);
    if (!workflowId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing workflow id' }));
      return true;
    }
    const ctrl = activeWorkflowAborts.get(workflowId);
    if (ctrl) {
      ctrl.abort();
      auditAction('workflow.cancel', {
        workflowId,
        role: ctx.role,
        sub: ctx.sub
      });
    }
    sendJson(
      res,
      { ok: true, workflowId, cancelled: !!ctrl },
      req
    );
    return true;
  }
  // GET 取单个工作流执行快照
  if (req.method === 'GET') {
    const run = id ? await workflowStore().get(id) : null;
    if (!run) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'workflow not found', id }));
      return true;
    }
    sendJson(res, { workflow: run }, req);
    return true;
  }
  // 未匹配任何子路径（如 POST 到未知后缀）：与迁移前一致，交回主分发器继续后续路由。
  return false;
}
