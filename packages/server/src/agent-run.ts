/**
 * 服务端 agent 任务执行 helper（P0.1 / P1-④ 共用）。
 *
 * 把「按 agentRef 解析 AgentCard → assembleAgent(card) → harness.run(input)」收敛到
 * 单一入口，避免工作流 / A2A / 运行队列各自重复易错的 14 参位置调用。
 * - workflow-executor、/api/a2a/tasks、run-queue 的 A2A 派发都复用本函数（本地执行分支）；
 * - 默认 mock 模式（离线、无需密钥），与 /api/run 演示行为一致；
 * - tenantId 透传 TenantContext，复用 P0.3 的租户护栏 + 记忆分区（复合 key `tenant::a2a:<id>`）。
 */

import type { HarnessEvent } from '@agent-harness/core';
import { getAgentRegistry, enforceTenantIsolation, type AgentCard, type TenantContext } from '@agent-harness/core';
import { assembleAgent, type RunMode } from './runner';

export interface RunAgentTaskOpts {
  mode?: RunMode;
  tenantId?: string;
  onEvent?: (e: HarnessEvent) => void;
  signal?: AbortSignal;
}

/** 本地执行一个 agent 任务（进程内 handoff 的最终落点）。 */
export async function runAgentTask(
  agentRef: string | AgentCard,
  input: unknown,
  opts: RunAgentTaskOpts = {},
): Promise<unknown> {
  const registry = getAgentRegistry();
  const card: AgentCard | null =
    typeof agentRef === 'string' ? await registry.get(agentRef) : agentRef;
  if (!card) {
    throw new Error(`unknown agentRef: ${typeof agentRef === 'string' ? agentRef : '(inline card)'}`);
  }
  const tenantCtx: TenantContext | null = opts.tenantId ? { id: opts.tenantId } : null;

  // P2 投产加固：与 /api/run 一致的跨行业隔离强制门禁（REQUIRE_TENANT=true 时生效）。
  // workflow / A2A 入口若把行业 agent 派发到无租户上下文，同样拒绝，避免绕过 /api/run 的守卫。
  const isolationDenied = enforceTenantIsolation({ agentDomain: card.domain ?? null, tenant: tenantCtx });
  if (isolationDenied) {
    throw new Error(`tenant isolation denied: ${isolationDenied.reason}`);
  }

  const sessionKey = opts.tenantId ? `${opts.tenantId}::a2a:${card.id}` : `a2a:${card.id}`;
  const prompt = typeof input === 'string' ? input : JSON.stringify(input ?? '');

  const assembled = await assembleAgent(
    opts.mode ?? 'mock',
    opts.onEvent,
    undefined,
    undefined,
    prompt,
    sessionKey,
    opts.signal,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    card,
    tenantCtx,
  );
  return assembled.harness.run(prompt);
}
