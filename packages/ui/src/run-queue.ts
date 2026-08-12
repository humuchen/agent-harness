import type { HarnessEvent } from '@agent-harness/core';
import { incCounter, recordLatency } from '@agent-harness/core';
import { assembleAgent, type RunMode } from './runner';
import { createQueueBackend, type QueueBackend, type JobDescriptor } from './queue-backend';

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
 *   这一步把「Web 进程被长连接绑死」彻底解开。
 * - 并发上限避免无限制扇出；超出上限的任务排队，pump() 在 worker 空闲时自动续跑。
 * - 持久化后端（见 queue-backend.ts 的 QueueBackend）：提交意图异步落盘，进程崩溃/重启后
 *   自动重放「未开始」的任务（默认内存、零行为变更；RUN_QUEUE_BACKEND=file 开启 JSONL 落盘；
 *   Redis/BullMQ 等分布式后端只需实现同一接口并在工厂切换，RunQueue/handler 零改动）。
 *
 * 健壮性增强（与核心 framework 隔离，仅本业务层）：
 * - 每个 Job 自带 AbortController + 看门狗（JOB_TIMEOUT_MS）：即使底层工具/LLM 调用
 *   意外挂死，也能在超时后中止并释放 worker 槽位，避免任务永久占坑。
 * - jobs 表有界（RUN_JOBS_MAX）：已结束且无活跃订阅者的 job 会被惰性淘汰，防止内存膨胀。
 * - 同会话串行化：共享 sessionKey 的并发 Job 错开执行，避免并发写记忆后端互相覆盖。
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
  /** job 级取消信号（超时 / 优雅停机触发）。 */
  controller: AbortController;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

const MAX_BUFFER = Number(process.env.RUN_QUEUE_BUFFER ?? 500) || 500;
const CONCURRENCY = Number(process.env.RUN_CONCURRENCY ?? 4) || 4;
// 单次运行整体超时；超时后中止循环并释放 worker 槽位（默认 5 分钟）。
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 300_000) || 300_000;
// jobs 表上限；超出后惰性淘汰「已结束且无人订阅」的最旧 job，防内存泄漏。
const JOBS_MAX = Number(process.env.RUN_JOBS_MAX ?? 500) || 500;

export class RunQueue {
  private jobs = new Map<string, RunJob>();
  private queue: RunJob[] = [];
  private running = 0;
  private seq = 0;
  private concurrency = CONCURRENCY;
  /** 正在执行的会话集合，用于同会话串行化（避免并发写记忆后端互相覆盖）。 */
  private runningSessions = new Set<string>();
  /** 持久化后端：默认内存（重启即丢）；RUN_QUEUE_BACKEND=file 时落盘可重放。 */
  private backend: QueueBackend;

  constructor(backend?: QueueBackend) {
    this.backend = backend ?? createQueueBackend();
    // 启动期重放：仅 file 后端存在「未开始」任务；重放后清空持久层，避免二次重放。
    if (this.backend.kind === 'file') {
      void this.replayPending();
    }
  }

  /**
   * 提交一次 agent 运行任务，立即返回 Job（不等待执行）。
   * 提交意图会异步落盘（file 后端），进程崩溃/重启后可重放尚未开始的任务。
   */
  submit(input: { mode: RunMode; prompt: string; model?: string; sessionKey?: string }): RunJob {
    const job = this.enqueue(input);
    const descriptor: JobDescriptor = {
      id: job.id,
      mode: job.mode,
      prompt: job.prompt,
      model: job.model,
      sessionKey: job.sessionKey,
      enqueuedAt: job.enqueuedAt,
    };
    // 异步落盘：不阻塞提交返回；失败仅记录，不影响内存态任务运行。
    void this.backend.append(descriptor).catch((e) => {
      console.error('[run-queue] persist failed:', (e as Error)?.message);
    });
    return job;
  }

  /** 仅入队（不持久化）：供启动重放复用——重放的任务已在持久层、不应再次落盘。 */
  private enqueue(input: { mode: RunMode; prompt: string; model?: string; sessionKey?: string }): RunJob {
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
      controller: new AbortController(),
      enqueuedAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.queue.push(job);
    this.pump();
    return job;
  }

  /**
   * 启动重放：把持久层中「未开始」的任务重新入队（生成新 job，原 id 不沿用避免歧义）。
   * 重放后立即清空持久层，防止下次重启重复执行。任何异常都不应阻断进程启动。
   */
  private async replayPending(): Promise<void> {
    try {
      const pending = await this.backend.list();
      await this.backend.clear();
      for (const d of pending) {
        const job = this.enqueue({
          mode: d.mode,
          prompt: d.prompt,
          model: d.model,
          sessionKey: d.sessionKey,
        });
        job.enqueuedAt = d.enqueuedAt; // 保留原入队时刻，维持大致顺序
      }
      if (pending.length) {
        console.log(`[run-queue] replayed ${pending.length} pending job(s) from durable backend`);
      }
    } catch (e) {
      console.error('[run-queue] replay pending failed:', (e as Error)?.message);
    }
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
      sessionsRunning: this.runningSessions.size,
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
        sessionKey: j.sessionKey ?? null,
        promptLen: j.prompt.length,
        enqueuedAt: j.enqueuedAt,
        startedAt: j.startedAt ?? null,
        finishedAt: j.finishedAt ?? null,
      }));
  }

  /**
   * 优雅停机：取消所有在飞/排队任务。
   * - 排队中（尚未执行）的 job 直接标记 cancelled 并移出队列，不再执行。
   * - 执行中（running）的 job 通过各自 controller 中止（harness 会在下一检查点退出）。
   */
  abortAll(reason: string = 'shutdown'): void {
    this.queue = this.queue.filter((j) => {
      if (j.status === 'queued') {
        j.status = 'cancelled';
        j.finishedAt = Date.now();
        // 取消的排队任务也移出持久层，避免重启后被重放。
        void this.backend.ack(j.id).catch(() => {});
        return false;
      }
      return true;
    });
    for (const j of this.jobs.values()) {
      if (j.status === 'running') {
        try {
          j.controller.abort(reason);
        } catch {
          /* 忽略重复 abort */
        }
      }
    }
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      // 找下一个「会话未被占用」的待执行 job；找不到则停（等会话释放或 worker 空闲后再触发）。
      let idx = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const cand = this.queue[i];
        if (!cand.sessionKey || !this.runningSessions.has(cand.sessionKey)) {
          idx = i;
          break;
        }
      }
      if (idx < 0) break;
      const job = this.queue.splice(idx, 1)[0];
      this.running += 1;
      if (job.sessionKey) this.runningSessions.add(job.sessionKey);
      job.status = 'running';
      job.startedAt = Date.now();
      void this.execute(job).finally(() => {
        this.running -= 1;
        this.pump();
        this.evictIfNeeded();
      });
    }
  }

  /** 惰性淘汰：jobs 表超过上限时，删除最旧的「已结束且无人订阅」job，防止内存膨胀。 */
  private evictIfNeeded(): void {
    if (this.jobs.size <= JOBS_MAX) return;
    const finished = [...this.jobs.values()]
      .filter(
        (j) =>
          (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') &&
          j.subscribers.size === 0
      )
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    let over = this.jobs.size - JOBS_MAX;
    for (const j of finished) {
      if (over <= 0) break;
      this.jobs.delete(j.id);
      over -= 1;
    }
  }

  private async execute(job: RunJob): Promise<void> {
    // 任务正式开始执行：从持久层移除，重启后不再重放（在飞任务的 controller 不可恢复，
    // 客户端会自行重投）。失败仅记录。
    void this.backend.ack(job.id).catch(() => {});
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
    // 看门狗：整体超时后中止 controller，harness 在下一检查点退出，worker 槽位必然释放。
    const watchdog = setTimeout(() => {
      try {
        job.controller.abort('timeout');
      } catch {
        /* 忽略 */
      }
    }, JOB_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const signal = job.controller.signal;
      const assembled = await assembleAgent(
        job.mode,
        onEvent,
        undefined,
        job.model,
        job.prompt,
        job.sessionKey,
        signal,
        JOB_TIMEOUT_MS
      );
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
      clearTimeout(watchdog);
      if (job.sessionKey) this.runningSessions.delete(job.sessionKey);
      job.finishedAt = Date.now();
      recordLatency('run.totalMs', job.finishedAt - (job.startedAt ?? job.finishedAt));
    }
  }
}

/** 全局单例运行队列。 */
export const runQueue = new RunQueue();
