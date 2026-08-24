/**
 * A2A 传输层（P1-④）。
 *
 * 解耦「派发一个 agent 任务」与「具体怎么执行」：
 * - `LocalA2ATransport`：进程内 handoff，回调由调用方注入的 `runner`（通常
 *   `assembleAgent(card)+harness.run`，server 端复用 /api/run 同款装配）。
 * - `HttpA2ATransport`：跨主机派发，向远端 agent 的 `POST /api/a2a/tasks` 投递
 *   TaskEnvelope，取回 TaskResult；带 SLA 超时主动 abort + 失败降级。
 *
 * 约定：所有传输都返回标准化的 `TaskResult`，调用方无需关心目标是本地还是远端。
 */

import type { AgentCard } from '../agents/types';
import type { TaskEnvelope, TaskResult } from './types';

/** 执行一个 agent 任务的回调（server 端注入：assembleAgent + harness.run）。 */
export type A2ARunner = (
  agentRef: string | AgentCard,
  input: unknown,
  meta: { tenantId?: string; traceId?: string; fromAgent?: string },
) => Promise<unknown>;

/** A2A 传输接口：把一个信封送到目标 agent 并返回结果。 */
export interface A2ATransport {
  send(envelope: TaskEnvelope): Promise<TaskResult>;
}

/** 进程内传输：直接回调注入的 runner（同进程多 agent 协同，零网络开销）。 */
export class LocalA2ATransport implements A2ATransport {
  constructor(private readonly runner: A2ARunner) {}

  async send(envelope: TaskEnvelope): Promise<TaskResult> {
    try {
      const output = await this.runner(envelope.toAgent, envelope.input, {
        tenantId: envelope.tenantId,
        traceId: envelope.traceId,
        fromAgent: envelope.fromAgent,
      });
      return { taskId: envelope.taskId, status: 'success', output };
    } catch (e: any) {
      return { taskId: envelope.taskId, status: 'failed', error: e?.message ?? String(e) };
    }
  }
}

/** 跨主机传输：向远端 agent 的 /api/a2a/tasks 投递信封。fetch 可注入（测试用 mock）。 */
export class HttpA2ATransport implements A2ATransport {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(envelope: TaskEnvelope): Promise<TaskResult> {
    const controller = new AbortController();
    if (envelope.sla?.timeoutMs && envelope.sla.timeoutMs > 0) {
      setTimeout(() => controller.abort(), envelope.sla.timeoutMs);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/api/a2a/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envelope }),
        signal: controller.signal,
      });
    } catch (e: any) {
      return {
        taskId: envelope.taskId,
        status: 'failed',
        error: `a2a transport error: ${e?.message ?? String(e)}`,
      };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        taskId: envelope.taskId,
        status: 'failed',
        error: `remote ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const data = (await res.json().catch(() => null)) as
      | { result?: TaskResult; error?: string }
      | TaskResult
      | null;
    if (!data) {
      return { taskId: envelope.taskId, status: 'failed', error: 'empty a2a response' };
    }
    // 兼容 `{ result: TaskResult }` 与裸 `TaskResult` 两种返回形态。
    if ('result' in data && data.result) return data.result;
    if ('error' in data && data.error && !('status' in data)) {
      return { taskId: envelope.taskId, status: 'failed', error: data.error };
    }
    return data as TaskResult;
  }
}

/** 依据 AgentCard 选择传输：a2a + endpoint → HTTP；其余 → 进程内 local runner。 */
export function transportFor(
  card: AgentCard,
  localRunner: A2ARunner,
  fetchImpl?: typeof fetch,
): A2ATransport {
  if (card.transport === 'a2a' && card.endpoint) {
    return new HttpA2ATransport(card.endpoint, fetchImpl);
  }
  return new LocalA2ATransport(localRunner);
}

/**
 * 一键派发：按目标 agent 的传输方式把信封送到本地或远端，返回标准 TaskResult。
 * 这是 router / run-queue 调用 A2A 的统一入口（核心只做编排，执行由注入的 runner 承担）。
 */
export async function dispatchAgentTask(
  card: AgentCard,
  envelope: TaskEnvelope,
  localRunner: A2ARunner,
  fetchImpl?: typeof fetch,
): Promise<TaskResult> {
  return transportFor(card, localRunner, fetchImpl).send(envelope);
}
