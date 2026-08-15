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
import { getAgentRegistry, getWorkflowStore, type AgentCard, type TenantContext } from '@agent-harness/core';
import type { HarnessEvent } from '@agent-harness/core';
import { assembleAgent, type RunMode } from './runner';

export interface WorkflowExecutorOptions {
  /** harness 事件透传（SSE 直播）。 */
  onEvent?: (e: HarnessEvent) => void;
  /** 运行模式：默认 mock（离线）。真实多 agent 协同可设 real / real-mcp。 */
  mode?: RunMode;
  /** 外部取消信号。 */
  signal?: AbortSignal;
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
    const tenantCtx: TenantContext | null = ctx.tenantId ? { id: ctx.tenantId } : null;
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
    return assembled.harness.run(prompt);
  };
}

/** 进程内共享的工作流存储（默认 Volatile；配置 WORKFLOW_STORE_DIR 时 File 持久化）。 */
export function workflowStore() {
  return getWorkflowStore();
}
