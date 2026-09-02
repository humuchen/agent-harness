import type { HarnessEvent } from '@agent-harness/core';
import {
  incCounter,
  recordLatency,
  resolveOpenRouterConfig,
  createVerifier,
  resolveTask,
  resolveTenantContext,
  enforceTenantIsolation,
  policyEngine,
  quotaEngine,
  audit,
  resolveIsolationBackend,
  runWithUser,
  HttpA2ATransport,
  type TaskEnvelope,
  type TaskResult,
  type VerifyConfig,
  withRequestContext,
  type RequestContext
} from '@agent-harness/core';
import { assembleAgent, type RunMode } from './runner';
import {
  createQueueBackend,
  isPlanTaskRun,
  type QueueBackend,
  type JobDescriptor
} from './queue-backend';
import { resolveRunCredential } from './provider-keys';
import { evaluateCompletion, resolveEvalGate, getRecipeStore } from './eval';

/** 内存监控阈值（MB）：超过此值触发告警，OOM 前预警。 */
const MEMORY_WARN_MB = Number(process.env.JOB_MEMORY_WARN_MB ?? 800) || 800;
const MEMORY_CRITICAL_MB = Number(process.env.JOB_MEMORY_CRITICAL_MB ?? 950) || 950;
/** 监控间隔（ms）：每此间隔采样一次内存。 */
const MEMORY_CHECK_INTERVAL_MS = Number(process.env.JOB_MEMORY_CHECK_MS ?? 5000) || 5000;

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
export type JobPriority = 'low' | 'normal' | 'high' | 'urgent';

/** 优先级映射：数字越小越优先 */
const PRIORITY_SCORE: Record<JobPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3
};

export interface RunJob {
  id: string;
  status: JobStatus;
  mode: RunMode;
  prompt: string;

  /** 任务优先级（低/普通/高/紧急），缺省 normal。 */
  priority?: JobPriority;
  model?: string;

  /** 自定义模型专属接口地址（可选，OpenAI 兼容端点）。透传给 runner 构造直连 LLM。 */
  modelBaseUrl?: string;

  /** 自定义模型专属 API Key（可选）。缺省走服务端默认凭证。 */
  modelApiKey?: string;

  /** 所选模型的官方上下文窗口（token，可选）：前端从模型目录获取后随请求下发。 */
  ctxWindow?: number;

  /** 会话/租户标识（P1-9）：记忆按 key 隔离并持久化到所选后端。 */
  sessionKey?: string;

  /** 单次 run 的循环步数上限（来自 UI 输入 / env MAX_STEPS）。 */
  maxSteps?: number;

  /** 运行期自动验证门禁配置（P0-2，可序列化，随 job 持久化）。 */
  verify?: VerifyConfig;

  /** P0.1：显式指定的目标 agent id（绕过路由，直达该 agent 的装配配方）。 */
  agentId?: string;

  /** P0.2：任务领域（显式声明时直接过滤候选，优于自动分类）。 */
  domain?: string;

  /** P0.3 预留：租户标识（经认证派生，不可客户端伪造）。 */
  tenantId?: string;

  /** P0.2：工作流标识（可观测性）。 */
  workflowId?: string;

  /** P0.2：链路追踪标识（可观测性）。 */
  traceId?: string;

  /** 图片附件列表，服务端将其转为 ContentBlock[] 传给 LLM。 */
  attachments?: Array<{ url: string; name: string; type: string }>;

  /** 是否开启联网搜索：false/未传时禁用 web_fetch 与「联网检索」技能，避免任何出网检索。 */
  web?: boolean;

  /** 交互模式（P0 计划模式）：qa=问答（默认）；plan=计划。仅 server 消费（token 抑制/计划落盘）。 */
  interactionMode?: 'qa' | 'plan';

  /** 计划阶段：propose=生成计划（缺省）；execute=执行已确认的任务。 */
  planPhase?: 'propose' | 'execute';

  /** 归属用户（= 认证身份 sub）：执行期经 runWithUser 注入工具链路，插件据此绑定数据归属。 */
  owner?: string;

  /** 事件重放缓冲（带上限裁剪）。 */
  events: unknown[];

  /** job 内事件单调序号计数器：emit 时为每个事件附加递增 seq，供客户端断线续传（since 游标）去重。 */
  eventSeq: number;
  subscribers: Set<(e: unknown) => void>;
  /** job 级取消信号（超时 / 优雅停机触发）。 */
  controller: AbortController;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 内存使用超警告阈值（由内存监控器设置）。 */
  memoryWarned?: boolean;
  /** 内存使用超临界阈值，已触发 abort。 */
  memoryCritical?: boolean;
}

const MAX_BUFFER = Number(process.env.RUN_QUEUE_BUFFER ?? 500) || 500;
const CONCURRENCY = Number(process.env.RUN_CONCURRENCY ?? 4) || 4;

// 单次运行整体超时；超时后中止循环并释放 worker 槽位（默认 5 分钟）。
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 300_000) || 300_000;
// 计划任务执行（planTask run）专用超时：重任务（源码精读 / 体系化输出等）在真实
// 模型上常超默认 5 分钟（实测 stealth/ox-alpha 单次推理 >300s 被看门狗掐断），
// 默认放宽到 10 分钟，可用 PLAN_TASK_TIMEOUT_MS 环境变量覆盖。
const PLAN_TASK_TIMEOUT_MS =
  Number(process.env.PLAN_TASK_TIMEOUT_MS ?? 600_000) || 600_000;
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
  /** 持久化后端：默认内存（重启即丢）；RUN_QUEUE_BACKEND=file 时落盘可重放；redis 时共享多实例。 */
  private backend: QueueBackend;

  /** 是否共享后端（redis/bullmq）：执行由 claim 驱动、事件走 pub/sub 桥；否则走进程内 this.queue。 */
  private shared: boolean;

  /** 共享模式下领取任务的定时器（setInterval）。 */
  private claimTimer?: ReturnType<typeof setInterval>;

  constructor(backend?: QueueBackend) {
    this.backend = backend ?? createQueueBackend();
    this.shared =
      this.backend.kind === 'redis' || this.backend.kind === 'bullmq';
    if (this.shared) {
      // 共享后端：启动回收被崩溃实例占住的任务，并开启领取轮询。
      void this.startShared();
    } else if (this.backend.kind === 'file') {
      // 单实例文件后端：启动期重放未开始任务（重放后清空，避免二次重放）。
      void this.replayPending();
    }
  }

  /**
   * 提交一次 agent 运行任务，立即返回 Job（不等待执行）。
   * 提交意图会异步落盘（file/redis 后端），进程崩溃/重启后可重放尚未开始的任务。
   * 共享后端（redis）下，执行由 claim 轮询驱动，本实例或任何空闲实例都会领取执行。
   */
  submit(input: {
    mode: RunMode;
    prompt: string;
    priority?: JobPriority;
    model?: string;
    modelBaseUrl?: string;
    modelApiKey?: string;
    ctxWindow?: number;
    sessionKey?: string;
    maxSteps?: number;
    verify?: VerifyConfig;
    agentId?: string;
    domain?: string;
    tenantId?: string;
    workflowId?: string;
    traceId?: string;
    attachments?: Array<{ url: string; name: string; type: string }>;
    web?: boolean;
    interactionMode?: 'qa' | 'plan';
    planPhase?: 'propose' | 'execute';
    owner?: string;
  }): RunJob {
    const id = `job_${++this.seq}_${Date.now().toString(36)}`;
    const job = this.makeJob(input, id);
    const descriptor: JobDescriptor = {
      id,
      mode: job.mode,
      prompt: job.prompt,
      model: job.model,
      modelBaseUrl: job.modelBaseUrl,
      modelApiKey: job.modelApiKey,
      ctxWindow: job.ctxWindow,
      sessionKey: job.sessionKey,
      maxSteps: job.maxSteps,
      verify: job.verify,
      agentId: job.agentId,
      domain: job.domain,
      tenantId: job.tenantId,
      workflowId: job.workflowId,
      traceId: job.traceId,
      attachments: job.attachments,
      web: job.web,
      interactionMode: job.interactionMode,
      planPhase: job.planPhase,
      owner: job.owner,
      enqueuedAt: job.enqueuedAt
    };

    // 异步落盘：不阻塞提交返回；失败仅记录，不影响内存态任务运行。
    void this.backend.append(descriptor).catch((e) => {
      console.error('[run-queue] persist failed:', (e as Error)?.message);
    });
    if (this.shared) {
      // 执行由 claim 驱动；立即触发一次领取以减少首任务延迟（并发满则跳过，待 worker 空闲再扫）。
      void this.sweepOnce();
    } else {
      this.queue.push(job);
      this.pump();
    }
    return job;
  }

  /** 仅创建本地 RunJob（用于 SSE 事件缓冲 / 订阅查找），不触发执行。 */
  private makeJob(
    input: {
      mode: RunMode;
      prompt: string;
      priority?: JobPriority;
      model?: string;
      modelBaseUrl?: string;
      modelApiKey?: string;
      ctxWindow?: number;
      sessionKey?: string;
      maxSteps?: number;
      verify?: VerifyConfig;
      agentId?: string;
      domain?: string;
      tenantId?: string;
      workflowId?: string;
      traceId?: string;
      attachments?: Array<{ url: string; name: string; type: string }>;
      web?: boolean;
      interactionMode?: 'qa' | 'plan';
      planPhase?: 'propose' | 'execute';
      owner?: string;
    },
    id: string
  ): RunJob {
    const job: RunJob = {
      id,
      status: 'queued',
      mode: input.mode,
      prompt: input.prompt,
      model: input.model,
      modelBaseUrl: input.modelBaseUrl,
      modelApiKey: input.modelApiKey,
      priority: input.priority,
      sessionKey: input.sessionKey,
      maxSteps: input.maxSteps,
      verify: input.verify,
      agentId: input.agentId,
      domain: input.domain,
      tenantId: input.tenantId,
      web: input.web,
      interactionMode: input.interactionMode,
      planPhase: input.planPhase,
      workflowId: input.workflowId,
      traceId: input.traceId,
      owner: input.owner,
      attachments: input.attachments,
      events: [],
      eventSeq: 0,
      subscribers: new Set(),
      controller: new AbortController(),
      enqueuedAt: Date.now()
    };
    this.jobs.set(id, job);
    return job;
  }

  /**
   * 启动共享后端：回收崩溃实例占住的任务，并开启领取轮询。
   * 领取到的任务由 execute() 执行；跨实例事件经 publishEvent/subscribeEvents 桥接回订阅方。
   */
  private async startShared(): Promise<void> {
    const leaseMs = Number(process.env.QUEUE_LEASE_MS ?? 300_000) || 300_000;
    try {
      const moved = this.backend.reclaimStale
        ? await this.backend.reclaimStale(leaseMs)
        : 0;
      if (moved > 0)
        console.log(
          `[run-queue] reclaimed ${moved} stale job(s) from crashed instance`
        );
    } catch (e) {
      console.error('[run-queue] reclaim stale failed:', (e as Error)?.message);
    }
    const intervalMs =
      Number(process.env.QUEUE_CLAIM_INTERVAL_MS ?? 3000) || 3000;
    this.claimTimer = setInterval(() => {
      void this.sweepOnce();
    }, intervalMs);
    // 立即扫一次，缩短启动后首任务延迟。
    void this.sweepOnce();
  }

  /**
   * 领取并执行一条任务（共享后端 worker）。原子 claim 保证同一任务只被一个实例领取，
   * 故不存在重复执行；本实例已提交的任務被自己领取时复用本地 RunJob（SSE 缓冲连续）。
   */
  private async sweepOnce(): Promise<void> {
    if (this.running >= this.concurrency) return;
    let d: JobDescriptor | null = null;
    try {
      d = await this.backend.claim();
    } catch (e) {
      console.error('[run-queue] claim failed:', (e as Error)?.message);
      return;
    }
    if (!d) return;
    let job = this.jobs.get(d.id);
    if (!job) {
      job = this.makeJob(
        {
          mode: d.mode,
          prompt: d.prompt,
          model: d.model,
          modelBaseUrl: d.modelBaseUrl,
          modelApiKey: d.modelApiKey,
          ctxWindow: d.ctxWindow,
          sessionKey: d.sessionKey,
          maxSteps: d.maxSteps,
          verify: d.verify,
          agentId: d.agentId,
          domain: d.domain,
          tenantId: d.tenantId,
          workflowId: d.workflowId,
          traceId: d.traceId,
          interactionMode: d.interactionMode,
          planPhase: d.planPhase,
          owner: d.owner
        },
        d.id
      );
    }
    this.running += 1;
    if (job.sessionKey) this.runningSessions.add(job.sessionKey);
    job.status = 'running';
    job.startedAt = Date.now();
    void this.execute(job).finally(() => {
      this.running -= 1;
      this.pump();
      this.sweepOnce();
      this.evictIfNeeded();
    });
  }

  /**
   * 启动重放（仅 file 后端）：把持久层「未开始」任务重新入队（沿用原 id，避免歧义）。
   * 重放后立即清空持久层，防止下次重启重复执行。任何异常都不应阻断进程启动。
   */
  private async replayPending(): Promise<void> {
    try {
      const pending = await this.backend.list();
      await this.backend.clear();
      for (const d of pending) {
        const job = this.makeJob(
          {
            mode: d.mode,
            prompt: d.prompt,
            model: d.model,
            modelBaseUrl: d.modelBaseUrl,
            modelApiKey: d.modelApiKey,
            ctxWindow: d.ctxWindow,
            sessionKey: d.sessionKey,
            maxSteps: d.maxSteps,
            verify: d.verify,
            agentId: d.agentId,
            domain: d.domain,
            tenantId: d.tenantId,
            workflowId: d.workflowId,
            traceId: d.traceId,
            web: d.web,
            interactionMode: d.interactionMode,
            planPhase: d.planPhase,
            owner: d.owner
          },
          d.id
        );
        this.queue.push(job);
        job.enqueuedAt = d.enqueuedAt; // 保留原入队时刻，维持大致顺序
      }
      if (pending.length) {
        console.log(
          `[run-queue] replayed ${pending.length} pending job(s) from durable backend`
        );
      }
      this.pump();
    } catch (e) {
      console.error(
        '[run-queue] replay pending failed:',
        (e as Error)?.message
      );
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
    // 跨实例事件桥：执行实例若在别处，事件经 Redis pub/sub 转发到本订阅方，SSE 不受影响。
    let unsubBus: (() => void) | null = null;
    if (
      this.backend.subscribeEvents &&
      job.status !== 'done' &&
      job.status !== 'failed' &&
      job.status !== 'cancelled'
    ) {
      void this.backend
        .subscribeEvents(id, (e) => {
          try {
            fn(e);
          } catch {
            /* 忽略桥接异常 */
          }
        })
        .then((u) => {
          unsubBus = u;
        })
        .catch(() => {});
    }
    if (
      job.status === 'done' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      job.subscribers.delete(fn);
    }
    return () => {
      job.subscribers.delete(fn);
      if (unsubBus) unsubBus();
    };
  }

  get(id: string): RunJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * 注入服务端合成事件（如 plan:proposed / warn）：与 execute 内 emit 走同一
   * seq 计数 + events 缓冲 + 订阅通知 + 跨实例桥，保证断线重连（since 游标）
   * 后这些帧可被重放，计划卡片等派生状态不丢。
   * 返回 false 表示 job 不存在（调用方可降级为直写 SSE）。
   */
  emitSynthetic(id: string, e: unknown): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    (e as { seq?: number }).seq = ++job.eventSeq;
    job.events.push(e);
    if (job.events.length > MAX_BUFFER) job.events.shift();
    for (const fn of [...job.subscribers]) {
      try {
        fn(e);
      } catch {
        /* 忽略单订阅者异常 */
      }
    }
    if (this.backend.publishEvent) {
      void this.backend.publishEvent(id, e).catch(() => {});
    }
    return true;
  }

  /** 队列运行态快照（供 /api/metrics 与 /api/jobs 使用）。 */
  stats() {
    return {
      concurrency: this.concurrency,
      pending: this.queue.length,
      running: this.running,
      jobs: this.jobs.size,
      sessionsRunning: this.runningSessions.size,
      memoryCheckTimers: this.memoryCheckTimers.size
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
        finishedAt: j.finishedAt ?? null
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

  /** 停止领取轮询并关闭后端连接（测试与进程退出前调用）。 */
  stop(): void {
    if (this.claimTimer) {
      clearInterval(this.claimTimer);
      this.claimTimer = undefined;
    }
    const backend = this.backend as unknown as { close?: () => Promise<void> };
    if (typeof backend.close === 'function') {
      void backend.close().catch(() => {});
    }
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      // 找下一个「会话未被占用」且优先级最高的待执行 job；找不到则停。
      let idx = -1;
      let bestScore = 999;
      for (let i = 0; i < this.queue.length; i++) {
        const cand = this.queue[i];
        if (!cand) continue;
        if (cand.sessionKey && this.runningSessions.has(cand.sessionKey))
          continue;
        // 按优先级排序：urgent(0) > high(1) > normal(2) > low(3)
        const score =
          PRIORITY_SCORE[
            (cand.priority as JobPriority | undefined) ?? 'normal'
          ] ?? 2;
        if (score < bestScore) {
          bestScore = score;
          idx = i;
        }
      }
      if (idx < 0) break;
      const removed = this.queue.splice(idx, 1);
      const job = removed[0];
      if (!job) break;
      this.running += 1;
      if (job.sessionKey) this.runningSessions.add(job.sessionKey);
      job.status = 'running';
      job.startedAt = Date.now();
      void this.execute(job).finally(() => {
        this.stopMemoryCheck(job.id);
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
          (j.status === 'done' ||
            j.status === 'failed' ||
            j.status === 'cancelled') &&
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

  /** 内存监控定时器 */
  private memoryCheckTimers = new Map<string, NodeJS.Timeout>();

  /** 启动 per-job 内存监控，超过阈值触发告警并标记 job。 */
  private startMemoryCheck(job: RunJob): void {
    const check = () => {
      const mem = process.memoryUsage();
      const rssMb = mem.rss / 1024 / 1024;
      const heapMb = mem.heapUsed / 1024 / 1024;
      // 触发告警（仅首次）
      if (heapMb > MEMORY_CRITICAL_MB && job.status === 'running') {
        job.memoryCritical = true;
        console.error(`[run-queue] CRITICAL: job=${job.id} heap=${heapMb.toFixed(1)}MB rss=${rssMb.toFixed(1)}MB`);
        // 立即中止：避免 OOM 影响其他 job
        job.controller.abort('memory-critical');
      } else if (heapMb > MEMORY_WARN_MB && !job.memoryWarned) {
        job.memoryWarned = true;
        console.warn(`[run-queue] WARN: job=${job.id} heap=${heapMb.toFixed(1)}MB rss=${rssMb.toFixed(1)}MB`);
      }
    };
    // 立即检查一次
    check();
    // 周期性检查
    const timer = setInterval(check, MEMORY_CHECK_INTERVAL_MS);
    this.memoryCheckTimers.set(job.id, timer);
  }

  /** 停止 per-job 内存监控。 */
  private stopMemoryCheck(jobId: string): void {
    const timer = this.memoryCheckTimers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.memoryCheckTimers.delete(jobId);
    }
  }

  private async execute(job: RunJob): Promise<void> {
    // 启动 per-job 内存监控
    this.startMemoryCheck(job);
    // 任务正式开始执行：从持久层移除，重启后不再重放（在飞任务的 controller 不可恢复，
    // 客户端会自行重投）。失败仅记录。
    void this.backend.ack(job.id).catch(() => {});
    let stepCount = 0;
    const emit = (e: unknown) => {
      // 附加 job 内单调递增序号：客户端凭「已收到的最大 seq」断线续传，
      // 服务端重放时跳过 seq ≤ since 的事件，保证恢复不重复、不丢失。
      (e as { seq?: number }).seq = ++job.eventSeq;
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
      // 跨实例事件桥：把事件广播给持有该 job SSE 订阅的其它实例（共享后端才实现）。
      if (this.backend.publishEvent) {
        void this.backend.publishEvent(job.id, e).catch(() => {});
      }
    };
    const onEvent = (e: HarnessEvent) => {
      if (e.type === 'step:start') stepCount = Math.max(stepCount, e.step);
      // P2.2 用量统计：捕获 run:cost 事件，把 token / 成本累计进 per-owner 配额引擎
      // （keyed by owner，与 admit 的 tenantId 维度解耦；默认无硬上限，仅统计看板用）。
      if (e.type === 'run:cost') {
        quotaEngine.recordUsage(job.owner ?? 'anonymous', {
          tokens:
            (e as unknown as { usage?: { total_tokens?: number } }).usage
              ?.total_tokens ?? 0,
          cost:
            typeof (e as unknown as { stepCost?: number }).stepCost === 'number'
              ? (e as unknown as { stepCost: number }).stepCost
              : 0
        });
      }
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
    // P2.a：配额计费的租户维度键（无 tenantId 归到 'anonymous'，与 telemetry 一致）。
    const tenantIdForQuota = job.tenantId ?? 'anonymous';
    // 在 try 之外保存，供 finally 中的审计留存引用（try 内 const 不可见于 finally）。
    let resolvedAgentId: string | null = null;
    let admitted = false;
    // 为本次执行建立请求级上下文，让所有 structLog / audit 调用自动携带 traceId。
    const reqCtx: RequestContext = {
      traceId: job.traceId || job.id,
      jobId: job.id,
      tenantId: job.tenantId
    };
    return withRequestContext(reqCtx, async () => {
      try {
        const signal = job.controller.signal;
        // P0-2：从 job 携带的可序列化验证配置装配运行期验证器（undefined 表示关闭门禁）。
        const verifier = createVerifier(job.verify);
        const verifyMaxRetries = verifier
          ? Number(process.env.AGENT_VERIFY_MAX_RETRIES ?? 0) || 0
          : 0;
        // P0.2：capability-aware 路由解析目标 agent。
        // - 显式 agentId 直达该 agent 装配配方；
        // - 否则按 domain 过滤 / 经 IntentRouter 分类 + AgentSelector 打分选最优；
        // - 无更优专属 agent 或 router 关闭（TASK_ROUTER=off）时回退 default 通用 harness。
        // 全程降级可用：任何解析异常都退化为 default，不中断执行。
        const route = await resolveTask({
          agentId: job.agentId,
          domain: job.domain,
          tenantId: job.tenantId,
          prompt: job.prompt,
          workflowId: job.workflowId,
          traceId: job.traceId
        }).catch(() => null);
        const targetCard = route?.card ?? null;
        // P0.3：由 job.tenantId 派生租户上下文（无 tenantId 则 null → 通用默认策略 + 原始记忆 key）。
        const tenantCtx = resolveTenantContext({ tenantId: job.tenantId });

        // P2 投产加固：跨行业数据隔离强制门禁（REQUIRE_TENANT=true 时生效）。
        // 路由命中非 generic 行业 agent（医疗/金融等）但无 tenantCtx → 拒绝执行，防止行业敏感数据
        // 在无租户分区/无出网管控的默认通道混流。通用任务不受影响；默认关闭，向后兼容。
        // 放在配额准入前：被拒任务不消耗配额，仅审计 denied。
        const isolationDenied = enforceTenantIsolation({
          agentDomain: targetCard?.domain ?? null,
          tenant: tenantCtx
        });
        if (isolationDenied) {
          emit({
            type: 'warn',
            message: `tenant isolation denied: ${isolationDenied.reason}`
          });
          audit({
            tenantId: job.tenantId,
            actor: job.tenantId ?? 'anonymous',
            action: 'agent.run.denied',
            outcome: 'denied',
            target: route?.agentId ?? job.agentId ?? 'default',
            detail: {
              reason: isolationDenied.reason,
              mode: job.mode,
              domain: targetCard?.domain ?? job.domain ?? null,
              guard: 'require-tenant'
            }
          });
          incCounter('run.tenant.denied');
          emit({ type: '_done', final: '', error: true });
          job.status = 'failed';
          return;
        }

        // P2.a 配额/计费准入：QPS 令牌桶 + 并发信号量（硬限 token/cost 默认关闭，仅统计）。
        // 任一维度拒绝则整体拒绝——不消耗配额、不装配 harness，直接标记失败并审计留痕。
        // （return 发生在 try 内，finally 仍会执行看门狗清理与并发额度归还。）
        const admit = quotaEngine.admit(tenantIdForQuota);
        if (!admit.allowed) {
          emit({
            type: 'warn',
            message: `quota denied (tenant=${tenantIdForQuota}): ${admit.reason}`
          });
          audit({
            tenantId: job.tenantId,
            actor: job.tenantId ?? 'anonymous',
            action: 'agent.run.denied',
            outcome: 'denied',
            target: route?.agentId ?? job.agentId ?? 'default',
            detail: {
              reason: admit.reason,
              mode: job.mode,
              domain: job.domain ?? null
            }
          });
          incCounter('run.quota.denied');
          emit({ type: '_done', final: '', error: true });
          job.status = 'failed';
          return;
        }
        admitted = true;
        resolvedAgentId = route?.agentId ?? job.agentId ?? 'default';
        audit({
          tenantId: job.tenantId,
          actor: job.tenantId ?? 'anonymous',
          action: 'agent.run.start',
          outcome: 'info',
          target: resolvedAgentId,
          detail: {
            mode: job.mode,
            domain: job.domain ?? null,
            decidedBy: route?.decidedBy ?? 'fallback'
          }
        });

        // P2.d per-job 隔离后端：按 card 声明 → 租户策略强制 → env 默认 → 跨行业不可信升级，
        // 收敛为最终 backend 字符串，传给 assembleAgent（shell 执行器据此选择 OS/容器/本地隔离）。
        const sandboxBackend = resolveIsolationBackend({
          card: targetCard,
          tenantPolicy: tenantCtx ? policyEngine.getPolicy(tenantCtx.id) : null,
          tenantDomain: tenantCtx?.domain ?? null,
          envBackend: process.env.SANDBOX_BACKEND
        });

        // P1-④ A2A 跨主机派发：路由到的目标若是远端 a2a agent（transport=a2a 且有 endpoint），
        // 则不再本地装配 harness，而是经 HttpA2ATransport 把任务派发给远端 agent 执行，
        // 取回 TaskResult 作为本轮输出。派发失败（网络/远端错误）则降级回退本地默认 harness，
        // 不中断执行（符合「一切降级可用」约定），并发告警事件。
        if (targetCard?.transport === 'a2a' && targetCard?.endpoint) {
          const envelope: TaskEnvelope = {
            taskId: `task-${job.id}`,
            tenantId: job.tenantId ?? 'default',
            traceId: job.traceId,
            fromAgent: 'default',
            toAgent: targetCard.id,
            input: job.prompt,
            // 与本地 harness 看门狗一致：计划任务执行放宽到 PLAN_TASK_TIMEOUT_MS。
            sla: {
              timeoutMs: isPlanTaskRun(job)
                ? PLAN_TASK_TIMEOUT_MS
                : JOB_TIMEOUT_MS
            }
          };
          const result: TaskResult | null = await new HttpA2ATransport(
            targetCard.endpoint
          )
            .send(envelope)
            .catch(() => null);
          if (result && result.status === 'success') {
            const finalText =
              typeof result.output === 'string'
                ? result.output
                : JSON.stringify(result.output ?? '');
            emit({
              type: 'run:meta',
              mode: job.mode,
              agentId: targetCard.id,
              decidedBy: route?.decidedBy ?? 'a2a-remote',
              domain: job.domain ?? null,
              tenantId: tenantCtx?.id ?? null,
              llmKind: 'remote-a2a',
              dryRun: false,
              mcpConnected: false,
              notes: [`A2A 跨主机派发至 ${targetCard.endpoint}`],
              model: null,
              tokenBudget: null,
              costBudget: null,
              failover: false,
              workflowId: job.workflowId ?? null,
              traceId: job.traceId ?? null
            });
            emit({ type: 'run:end', final: finalText, steps: 0 });
            emit({ type: '_done', final: finalText });
            job.status = 'done';
            incCounter('run.success');
            return;
          }
          emit({
            type: 'warn',
            message: `A2A 派发至 ${
              targetCard.id
            } 失败，降级回退本地默认 harness：${result?.error ?? 'unknown'}`
          });
        }

        // P1.3：凭据不在持久化 descriptor 中存明文，执行期按 owner + model 重新解析
        // （自定义模型 / 用户 provider Key / 平台兜底），与 /api/run 提交期的解析链一致。
        // 这样 file/redis 后端落盘的任务意图不会把明文 Key 写进 run-queue.jsonl / redis。
        const cred = await resolveRunCredential(job.owner ?? 'anonymous', {
          model: job.model,
          modelBaseUrl: job.modelBaseUrl,
          modelApiKey: job.modelApiKey
        });
        if (job.mode !== 'mock' && !cred.apiKey) {
          // 重放 / 跨实例领取后，用户可能已删除 Key：拒绝执行（与提交期 402 一致），
          // 不回退为无 Key 静默跑，避免裸奔调用上游。
          emit({
            type: 'warn',
            message: 'provider_key_required: 执行期未解析到可用 LLM Key'
          });
          audit({
            tenantId: job.tenantId,
            actor: job.owner ?? 'anonymous',
            action: 'agent.run.denied',
            outcome: 'denied',
            target: route?.agentId ?? job.agentId ?? 'default',
            detail: {
              reason: 'provider_key_required',
              mode: job.mode,
              domain: job.domain ?? null
            }
          });
          incCounter('run.credential.missing');
          emit({ type: '_done', final: '', error: true });
          job.status = 'failed';
          return;
        }
        const effectiveBaseUrl = cred.baseUrl ?? job.modelBaseUrl;
        const effectiveApiKey = cred.apiKey;
        // P2.4 多 Key：把解析出的全部 Key 透传给 assembleAgent；长度 > 1 时启用
        // 按 Key 隔离的负载/故障转移，单 Key 时退化为旧行为（apiKeys 透传不生效）。
        const effectiveApiKeys =
          cred.apiKeys && cred.apiKeys.length
            ? cred.apiKeys
            : effectiveApiKey
            ? [effectiveApiKey]
            : [];

        const assembled = await assembleAgent(
          job.mode,
          onEvent,
          undefined,
          job.model,
          job.prompt,
          job.sessionKey,
          signal,
          // 计划任务执行用更长超时：重任务（源码精读等）常超默认 5 分钟
          //（实测 stealth/ox-alpha 单次推理 >300s），被 watchdog 掐断后只能整任务作废。
          isPlanTaskRun(job) ? PLAN_TASK_TIMEOUT_MS : JOB_TIMEOUT_MS,
          job.maxSteps,
          undefined,
          verifier,
          verifyMaxRetries,
          // P0.1/P0.2：解析出的目标 AgentCard（null 退化为今天的通用 harness）。
          targetCard,
          // P0.3：租户上下文（记忆分区 + 护栏策略覆盖 + 出网管控）。
          tenantCtx,
          // P2.d：per-job 隔离后端（card/租户/env 收敛，跨行业不可信强制强隔离）。
          sandboxBackend,
          // token 级流式：沿用默认（undefined → 受 AGENT_STREAM_TOKENS 控制，默认开启）。
          undefined,
          // 联网搜索开关：仅当本次 run 显式开启时才注册 web_fetch 与「联网检索」技能；
          // 否则即便用户询问最新/外部信息，也不触发任何出网检索，避免无意义请求与资源消耗。
          job.web ?? false,
          // 计划模式 propose（P0）：透传给 harness，使其对计划 JSON 输出走结构化校验
          // （跳过业务合规输出规则），避免计划被误拦后回退普通回答。
          job.interactionMode === 'plan' && job.planPhase !== 'execute',
          // 计划任务执行（P0）：输出走 checkTaskOutput 宽松扫描 —— 教学内容含
          // 「system prompt」等弱信号词会被 medium 注入短语误拦成兜底话术。
          isPlanTaskRun(job),
          // 自定义模型专属端点（可选）：执行期重新解析出的 baseUrl/apiKey 透传给 runner，
          // 使其构造直连该端点的 LLM；缺省 undefined 走服务端默认 OpenRouter。
          effectiveBaseUrl,
          effectiveApiKey,
          job.ctxWindow,
          effectiveApiKeys
        );
        const model = resolveOpenRouterConfig({ model: job.model }).model;
        emit({
          type: 'run:meta',
          mode: job.mode,
          agentId: route?.agentId ?? job.agentId ?? null,
          decidedBy: route?.decidedBy ?? 'fallback',
          domain: job.domain ?? null,
          tenantId: tenantCtx?.id ?? null,
          llmKind: assembled.llmKind,
          dryRun: assembled.dryRun,
          mcpConnected: assembled.mcpConnected,
          notes: assembled.notes,
          model,
          tokenBudget: assembled.tokenBudget ?? null,
          costBudget: assembled.costBudget ?? null,
          failover: assembled.failover,
          workflowId: job.workflowId ?? null,
          traceId: job.traceId ?? null
        });
        emit({ type: 'run:tools', tools: assembled.tools.schemas() });
        // 归属用户注入（数据绑定）：整个 agent 循环（含工具执行）都在 runWithUser 上下文内，
        // 插件工具（如 memo note_save）经 getRunUser() 拿到 owner，把产出数据绑定到登录用户。
        // owner 缺省（旧 job / 内部派发）时保持无上下文，由工具侧自行兜底匿名桶。
        const finalText = await runWithUser(
          job.owner ? { sub: job.owner } : null,
          () => assembled.harness.run(job.prompt, job.attachments)
        );

        // 运行完成闸门（P2-13 延伸）：自动评估本轮质量，据 HARNESS_EVAL_GATE 决定告警或拦截。
        // - off（默认）：不评估，零开销；
        // - warn：评估并下发 eval:result 事件，但不改变运行结果；
        // - enforce：评估未通过则判本次运行失败（fail closed），并审计留痕。
        const evalGate = resolveEvalGate();
        if (evalGate !== 'off') {
          const completion = evaluateCompletion(
            job.id,
            job.events,
            finalText,
            evalGate
          );
          if (completion) {
            emit({
              type: 'eval:result',
              jobId: job.id,
              score: completion.result.score,
              passed: completion.result.passed,
              reasons: completion.result.reasons,
              gate: completion.gate
            });
            // 配方版本化：把本轮 RunRecord 存为可回溯快照（内存/文件库由 RECIPE_DIR 决定）。
            try {
              getRecipeStore().save({
                id: job.id,
                name: `${job.mode}:${job.prompt.slice(0, 48)}`,
                createdAt: Date.now(),
                record: completion.record
              });
            } catch {
              /* 配方存储失败不影响主流程 */
            }
            if (evalGate === 'enforce' && !completion.result.passed) {
              incCounter('run.eval.failed');
              audit({
                tenantId: job.tenantId,
                actor: job.tenantId ?? 'anonymous',
                action: 'agent.run.eval_failed',
                outcome: 'denied',
                target: resolvedAgentId ?? 'default',
                detail: {
                  score: completion.result.score,
                  reasons: completion.result.reasons,
                  mode: job.mode
                }
              });
              emit({
                type: 'warn',
                message: `运行自评估未通过（score=${
                  completion.result.score
                }）：${completion.result.reasons.join('; ')}`
              });
              emit({ type: '_done', final: finalText, error: true });
              job.status = 'failed';
              return;
            }
          }
        }

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
        recordLatency(
          'run.totalMs',
          job.finishedAt - (job.startedAt ?? job.finishedAt)
        );
        // P2.a：归还并发额度（admit 成功才消耗；denied 路径 active=0，release 为 no-op 安全）。
        if (admitted) quotaEngine.release(tenantIdForQuota);
        // P2.a：运行结束审计留痕（成功/失败，便于强合规租户对账）。
        audit({
          tenantId: job.tenantId,
          actor: job.tenantId ?? 'anonymous',
          action: 'agent.run.end',
          outcome:
            job.status === 'done'
              ? 'success'
              : job.status === 'failed'
              ? 'failure'
              : 'info',
          target: resolvedAgentId ?? 'default',
          detail: { steps: stepCount, mode: job.mode }
        });
      }
    }); // end withRequestContext
  }
}

/** 全局单例运行队列。 */
export const runQueue = new RunQueue();
