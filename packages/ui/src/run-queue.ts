import type { HarnessEvent } from '@agent-harness/core';
import { incCounter, recordLatency } from '@agent-harness/core';
import { assembleAgent, type RunMode } from './runner';

/**
 * 运行任务队列（解耦「提交」与「执行」）。
 *
 * 背景：原先 `/api/run` 在 Web 进程内 `await harness.run()` 同步跑完整个 agent 循环，
 * 既无并发上限（多个长任务会同时打满 LLM/MCP/内存），也无法横向扩展。这里把
 * 「一次 run」抽象为 Job：handler 立即入队并返回 jobId（SSE 只负责收事件流），
 * 真正的执行由 worker 池（并发上限 RUN_CONCURRENCY）异步完成。
 *
 * 设计要点：
 * - 每个 Job 持有事件重放缓冲（上限 RUN_QUEUE_BUFFER，防内存泄漏），SSE 订阅时先重放
 *   已发生事件、再转发后续事件。因此即使客户端中途断线，也能凭 jobId 重新订阅续上——
 *   这一步把「Web 进程被长连接绑死」彻底解开，也为将来把 worker 抽到独立进程 /
 *   消息队列（Redis/BullMQ 等）留好接口（替换 RunQueue 实现即可，handler 不变）。
 * - 并发上限避免无限制扇出；超出上限的任务排队，pump() 在 worker 空闲时自动续跑。
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface RunJob {
  id: string;
  status: JobStatus;
  mode: RunMode;
  prompt: string;
  model?: string;
  /** 会话/租户标识（P1-9）：记忆按 key 隔离并持久化到所选后端。 */
  sessionKey?: string;
  /** 事件重放缓冲（带上限裁剪）。 */
  events: unknown[];
  subscribers: Set<(e: unknown) => void>;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

const MAX_BUFFER = Number(process.env.RUN_QUEUE_BUFFER ?? 500) || 500;
const CONCURRENCY = Number(process.env.RUN_CONCURRENCY ?? 4) || 4;

export class RunQueue {
  private jobs = new Map<string, RunJob>();
  private queue: RunJob[] = [];
  private running = 0;
  private seq = 0;
  private concurrency = CONCURRENCY;

  /** 提交一次 agent 运行任务，立即返回 Job（不等待执行）。 */
  submit(input: { mode: RunMode; prompt: string; model?: string; sessionKey?: string }): RunJob {
    const id = `job_${++this.seq}_${Date.now().toString(36)}`;
    const job: RunJob = {
      id,
      status: 'queued',
      mode: input.mode,
      prompt: input.prompt,
      model: input.model,
      sessionKey: input.sessionKey,
      events: [],
      subscribers: new Set(),
      enqueuedAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.queue.push(job);
    this.pump();
    return job;
  }

  /**
   * 订阅某 Job 的事件流：先重放缓冲，再转发后续。返回取消订阅函数。
   * 若 Job 已结束，重放中会包含终结事件（_done），订阅方据此关闭连接，无需常驻。
   */
  subscribe(id: string, fn: (e: unknown) => void): () => void {
    const job = this.jobs.get(id);
    if (!job) return () => {};
    job.subscribers.add(fn);
    for (const e of job.events) {
      try {
        fn(e);
      } catch {
        /* 单个订阅者异常不应影响其他订阅者 */
      }
    }
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
      job.subscribers.delete(fn);
    }
    return () => job.subscribers.delete(fn);
  }

  get(id: string): RunJob | undefined {
    return this.jobs.get(id);
  }

  /** 队列运行态快照（供 /api/metrics 与 /api/jobs 使用）。 */
  stats() {
    return {
      concurrency: this.concurrency,
      queued: this.queue.length,
      running: this.running,
      jobs: this.jobs.size,
    };
  }

  /** 最近若干 Job 的脱敏状态列表（运维视角）。 */
  list(limit = 20) {
    return [...this.jobs.values()]
      .sort((a, b) => b.enqueuedAt - a.enqueuedAt)
      .slice(0, limit)
      .map((j) => ({
        id: j.id,
        status: j.status,
        mode: j.mode,
        promptLen: j.prompt.length,
        enqueuedAt: j.enqueuedAt,
        startedAt: j.startedAt ?? null,
        finishedAt: j.finishedAt ?? null,
      }));
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.running += 1;
      job.status = 'running';
      job.startedAt = Date.now();
      void this.execute(job).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async execute(job: RunJob): Promise<void> {
    let stepCount = 0;
    const emit = (e: unknown) => {
      job.events.push(e);
      if (job.events.length > MAX_BUFFER) job.events.shift();
      // 复制一份，避免订阅者在回调内增删 subscribers 造成迭代异常。
      for (const fn of [...job.subscribers]) {
        try {
          fn(e);
        } catch {
          /* 忽略单订阅者异常 */
        }
      }
    };
    const onEvent = (e: HarnessEvent) => {
      if (e.type === 'step:start') stepCount = Math.max(stepCount, e.step);
      emit(e);
    };
    const t0 = Date.now();
    try {
      const assembled = await assembleAgent(job.mode, onEvent, undefined, job.model, job.prompt, job.sessionKey);
      const model =
        (job.model && job.model.trim()) ||
        (process.env.OPENROUTER_MODEL && process.env.OPENROUTER_MODEL.trim()) ||
        'openai/gpt-4o-mini';
      emit({
        type: 'run:meta',
        mode: job.mode,
        llmKind: assembled.llmKind,
        dryRun: assembled.dryRun,
        mcpConnected: assembled.mcpConnected,
        notes: assembled.notes,
        model,
        tokenBudget: assembled.tokenBudget ?? null,
        costBudget: assembled.costBudget ?? null,
        failover: assembled.failover,
      });
      emit({ type: 'run:tools', tools: assembled.tools.schemas() });
      const finalText = await assembled.harness.run(job.prompt);
      emit({ type: 'run:end', final: finalText, steps: stepCount });
      emit({ type: '_done', final: finalText });
      job.status = 'done';
      incCounter('run.success');
    } catch (e: any) {
      emit({ type: 'error', message: e?.message ?? String(e) });
      emit({ type: '_done', final: '', error: true });
      job.status = 'failed';
      incCounter('run.failed');
    } finally {
      job.finishedAt = Date.now();
      recordLatency('run.totalMs', job.finishedAt - (job.startedAt ?? job.finishedAt));
    }
  }
}

/** 全局单例运行队列。 */
export const runQueue = new RunQueue();
