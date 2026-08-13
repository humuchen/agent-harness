/**
 * SSE 流消费 + 审批工单处理。把 client 的三个 *stream* 方法收敛成统一的
 * 「打印事件 / 处理 202 审批 / 可选轮询重投」逻辑。
 */
import {
  AgentClient,
  ApprovalRequiredError,
  type StreamEvent,
} from '@agent-harness/client';
import { c, err, jsonOut, out, summarizeEvent } from './output.js';

export interface StreamOpts {
  json: boolean;
  /** 遇到 202 审批时是否自动轮询并在批准后重投。默认 false（仅打印工单）。 */
  waitApproval: boolean;
  /** 轮询审批的超时（毫秒）。 */
  pollTimeoutMs: number;
  signal?: AbortSignal;
}

/** 返回进程退出码：0 成功 / 1 错误 / 2 需审批但未等待。 */
export async function runStream(
  client: AgentClient,
  makeStart: (approvalTicket?: string) => AsyncGenerator<StreamEvent>,
  opts: StreamOpts
): Promise<number> {
  try {
    for await (const ev of makeStart()) {
      if (opts.json) jsonOut(ev);
      else out(`  ${c('blue', (ev.type ?? 'event').padEnd(13))} ${summarizeEvent(ev as Record<string, unknown>)}`);
    }
    return 0;
  } catch (e: unknown) {
    if (e instanceof ApprovalRequiredError) {
      err(c('yellow', `⚠ 动作需审批：工单 ${e.ticketId}`));
      if (opts.waitApproval && e.ticketId) {
        err(c('dim', `  正在轮询审批结果（超时 ${Math.round(opts.pollTimeoutMs / 1000)}s）…`));
        const ticket = await client.pollApproval(e.ticketId, {
          timeoutMs: opts.pollTimeoutMs,
          signal: opts.signal,
        });
        if (ticket.status !== 'approved') {
          err(c('red', `  审批被拒绝（${ticket.status}）`));
          return 1;
        }
        err(c('green', '  已批准，自动重投请求…'));
        return runStream(client, (t) => makeStart(t ?? e.ticketId), {
          ...opts,
          waitApproval: false,
        });
      }
      err(c('dim', `  批准后重投：在请求中附加 --approval-ticket ${e.ticketId}`));
      return 2;
    }
    const msg = e instanceof Error ? e.message : String(e);
    err(c('red', `错误: ${msg}`));
    return 1;
  }
}
