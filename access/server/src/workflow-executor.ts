/**
 * 工作流服务端执行器（P1-⑤）。
 *
 * 把核心 `DagEngine` 的「执行一个 step」回调接到本仓库既有的运行装配：
 * `assembleAgent(card) → AgentHarness.run(input)`。这样工作流复用与 `/api/run` 完全相同的
 * 工具 / 技能 / MCP / 护栏 / 记忆装配链路，不另起炉灶。
 *
 * - 默认走 `mock` 模式（离线、无需密钥），与 `/api/run` 演示行为一致；
 * - 每 step 用独立 sessionKey（`wf:<workflowId>:<stepId>`）隔离记忆窗口；
 * - harness 事件透传给上层 SSE 接收者（onEvent），实现工作流进度的细粒度直播；
 * - 若 WorkflowDef 带 tenantId，则构造 TenantContext 注入，复用 P0.3 的租户护栏 + 记忆分区。
 */

import type { StepExecutor, RunContext } from '@agent-harness/core';
import { getAgentRegistry, getWorkflowStore, enforceTenantIsolation, getTeamManager, type TeamManager, type AgentCard, type TenantContext } from '@agent-harness/core';
import type { HarnessEvent } from '@agent-harness/core';
import { assembleAgent, type RunMode } from './runner';

export interface WorkflowExecutorOptions {
  /** harness 事件透传（SSE 直播）。 */
  onEvent?: (e: HarnessEvent) => void;
  /** 运行模式：默认 mock（离线）。真实多 agent 协同可设 real / real-mcp。 */
  mode?: RunMode;
  /** 外部取消信号。 */
  signal?: AbortSignal;
  /**
   * 图片附件透传（图片上传修复）：工作流 step 经本字段把前端图片带给 harness.run 的第 2 参，
   * 确保多模态上下文在工作流 / 团队派发链路不丢（此前漏传 → 图片未到达 LLM）。
   * 类型与 `AgentHarness.run` 的第 2 参完全一致。
   */
  attachments?: Array<{ url: string; name: string; type: string }>;
}

export function createWorkflowExecutor(opts: WorkflowExecutorOptions = {}): StepExecutor {
  const mode = opts.mode ?? 'mock';
  return async (step, input, ctx: RunContext) => {
    const ref = step.agentRef;
    const card: AgentCard | null =
      typeof ref === 'string' ? await getAgentRegistry().get(ref) : ref;
    if (!card) {
      throw new Error(`workflow step "${step.id}": unknown agentRef ${typeof ref === 'string' ? ref : '(inline card)'}`);
    }

    // P1-④：teamRef 优先 —— 通过 TeamManager 按协作模式派发
    const teamManager: TeamManager | null = step.teamRef ? getTeamManager() : null;
    if (teamManager && step.teamRef) {
      const team = teamManager.get(step.teamRef);
      if (!team) {
        throw new Error(`workflow step "${step.id}": unknown teamRef ${step.teamRef}`);
      }

      // 团队成员执行函数：对每个成员调用 assembleAgent + harness.run
      const dispatchAgentTask = async (card: AgentCard, task: string): Promise<string> => {
        const tenantCtx: TenantContext | null = ctx.tenantId ? { id: ctx.tenantId } : null;
        const isolationDenied = enforceTenantIsolation({ agentDomain: card.domain ?? null, tenant: tenantCtx });
        if (isolationDenied) {
          throw new Error(`workflow step "${step.id}": tenant isolation denied: ${isolationDenied.reason}`);
        }
        const subSessionKey = `wf:${ctx.workflowId}:${step.id}:${card.id}`;
        const assembled = await assembleAgent(
          mode,
          opts.onEvent,
          undefined,
          undefined,
          task,
          subSessionKey,
          ctx.signal,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          card,
          tenantCtx
        );
        return assembled.harness.run(task, opts.attachments);
      };

      const task = typeof input === 'string' ? input : JSON.stringify(input ?? '');
      const result = await teamManager.executeTask(step.teamRef, task, dispatchAgentTask);
      return result;
    }

    const tenantCtx: TenantContext | null = ctx.tenantId ? { id: ctx.tenantId } : null;

    // P2 投产加固：与 /api/run、A2A 一致的跨行业隔离强制门禁（REQUIRE_TENANT=true 时生效）。
    // 工作流某个 step 命中行业 agent 但无 tenantCtx → 抛错中断该 step（DagEngine 记为失败并按需补偿）。
    const isolationDenied = enforceTenantIsolation({ agentDomain: card.domain ?? null, tenant: tenantCtx });
    if (isolationDenied) {
      throw new Error(`workflow step "${step.id}": tenant isolation denied: ${isolationDenied.reason}`);
    }

    const sessionKey = `wf:${ctx.workflowId}:${step.id}`;
    const prompt = ctx.compensate
      ? // 补偿语义：以「回滚指令 / 已完成输出」作为本轮输入，交给 agent 执行回滚。
        `（回滚补偿）${typeof input === 'string' ? input : JSON.stringify(input ?? '')}`
      : typeof input === 'string'
        ? input
        : JSON.stringify(input ?? '');

    const assembled = await assembleAgent(
      mode,
      opts.onEvent,
      undefined,
      undefined,
      prompt,
      sessionKey,
      ctx.signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      card,
      tenantCtx
    );
    return assembled.harness.run(prompt, opts.attachments);
  };
}

/** 进程内共享的工作流存储（默认 Volatile；配置 WORKFLOW_STORE_DIR 时 File 持久化）。 */
export function workflowStore() {
  return getWorkflowStore();
}
