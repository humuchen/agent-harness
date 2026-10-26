/**
 * cron/scheduler.ts — 框架级周期任务调度 + leader 选举锁（中期落地）。
 *
 * 背景与目标：
 * - 三个业务插件此前各自 setInterval 轮询（memo 提醒 / 客服 reminders-trigger /
 *   医美 scheduler+outbox），多副本部署时会**重复执行**（规划/投递/提醒双发）。
 * - 本模块提供进程内「单飞 + 抖动 + 可选 leader 选举」的统一调度器：
 *   单副本行为与 setInterval 等价（零回归）；多副本注入 Redis 选举器后同一任务
 *   全集群仅 leader 副本执行。
 *
 * 范式约定（与 agents/store、quota/engine 一致）：
 * - core 不 import 任何 redis 库；Redis client 经最小契约注入，测试用 Fake 注入。
 * - 选举为「尽力而为」：Redis 故障时各副本按各自决策执行（fail-open），宁可重复
 *   不可全停 —— 周期任务（提醒/规划/回捞）重复执行可由下游幂等键兜底，全停则丢单。
 */

/** 进程 id（日志与选举 token 用）。 */
const PID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Redis 客户端最小契约（仅 SET NX PX 与 EVAL）。真实实现为 ioredis（原生支持），
 * 与 AgentStoreRedis / QuotaRedisClient 同范式：由调用方注入，core 零依赖。
 */
export interface LeaderRedisClient {
  /** SET key value NX PX <ms> → 'OK'（获得锁）| null（已被他方持有）。 */
  set(key: string, value: string, nx: 'NX', px: 'PX', ttlMs: number): Promise<unknown>;
  /** EVAL <script> <numkeys> <key> <token>（释放锁的 Lua：token 相符才 DEL）。 */
  eval(script: string, numKeys: number, key: string, token: string): Promise<unknown>;
}

/** leader 选举器契约：当次决策「本进程是否应执行 leader 任务」。 */
export interface LeaderElector {
  isLeader(): Promise<boolean>;
}

/** Redis 选举器：SET NX PX 抢锁；抢不到时 GET===self 仍视为 leader（续期语义）。 */
export class RedisLeaderElector implements LeaderElector {
  private readonly client: LeaderRedisClient;
  private readonly key: string;
  private readonly ttlMs: number;
  private readonly token: string;
  /** 释放锁 Lua：token 相符才 DEL（防误删他方锁）。 */
  private static readonly RELEASE_LUA =
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

  constructor(opts: { client: LeaderRedisClient; key?: string; ttlMs?: number }) {
    this.client = opts.client;
    this.key = opts.key ?? 'ah:cron:leader';
    this.ttlMs = Math.max(1000, opts.ttlMs ?? 15_000);
    // token 必须实例级唯一：同进程多个 elector 实例（测试/多调度器）互不误判「自持」。
    this.token = `${PID}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async isLeader(): Promise<boolean> {
    try {
      const r = await this.client.set(this.key, this.token, 'NX', 'PX', this.ttlMs);
      if (r === 'OK' || r === 1 || r === true) return true;
      const cur = await (this.client as unknown as { get(key: string): Promise<unknown> })
        .get?.(this.key);
      return cur === this.token;
    } catch {
      // fail-open：Redis 故障时按 leader 处理（宁重复不全停，见文件头纪律）。
      return true;
    }
  }

  /** 进程退出时主动让位（尽力而为）。 */
  async release(): Promise<void> {
    try {
      await this.client.eval(RedisLeaderElector.RELEASE_LUA, 1, this.key, this.token);
    } catch {
      /* 让位失败靠 TTL 自然过期 */
    }
  }
}

/** 进程内选举器：单副本 / 无 Redis 时的缺省实现（本进程恒为 leader）。 */
export class MemoryLeaderElector implements LeaderElector {
  async isLeader(): Promise<boolean> {
    return true;
  }
}

/** 单个 cron 任务的运行时状态。 */
interface CronJob {
  opts: CronJobOptions;
  timer: NodeJS.Timeout;
  busy: boolean;
  runs: number;
  failures: number;
  lastRunAt?: number;
  lastError?: string;
}

/** cron 任务注册项。 */
export interface CronJobOptions {
  /** 任务名（同调度器内唯一；重名注册覆盖旧任务）。 */
  name: string;
  /** 执行间隔（ms，≥250；下限防误设 0/负值打满 CPU）。 */
  everyMs: number;
  /** 任务体；异常被捕获计数，不影响后续 tick。 */
  run: () => Promise<void> | void;
  /**
   * true：多副本时仅 leader 副本执行。未注入选举器时等价 false（单副本场景）。
   * 选举为尽力而为（fail-open），重复执行由任务自身幂等键兜底。
   */
  leaderOnly?: boolean;
  /** 首个 tick 延迟抖动上限（默认 everyMs 的 20%，错开多任务同拍；0 = 立即首跑）。 */
  jitterMs?: number;
}

/** 框架级 cron 调度器：单飞（重叠跳过）+ 异常隔离 + 可选 leader 收敛。 */
export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private elector: LeaderElector | null = null;

  /** 注入 leader 选举器（多副本部署时由宿主装配层调用）；传 null 恢复进程内模式。 */
  configureLeaderElector(e: LeaderElector | null): void {
    this.elector = e;
  }

  /** 注册周期任务，返回注销函数（调用后停止该任务）。重名注册会先停掉旧任务。 */
  register(opts: CronJobOptions): () => void {
    const name = String(opts.name || '');
    if (!name) throw new Error('cron job name required');
    const everyMs = Math.max(250, Math.floor(Number(opts.everyMs) || 0));
    if (typeof opts.run !== 'function') throw new Error(`cron job ${name}: run must be a function`);
    // 重名覆盖：先停旧任务，保证幂等注册（插件热重载安全）。
    this.jobs.get(name)?.timer.unref?.();
    clearInterval(this.jobs.get(name)?.timer);
    const jitter = Math.max(0, Math.floor(opts.jitterMs ?? Math.min(everyMs * 0.2, 5_000)));
    const job: CronJob = {
      opts: { ...opts, everyMs },
      busy: false,
      runs: 0,
      failures: 0,
      timer: null as unknown as NodeJS.Timeout,
    };
    const tick = async (): Promise<void> => {
      if (job.busy) return; // 单飞：上一轮未结束则跳过本轮
      if (job.opts.leaderOnly && this.elector) {
        try {
          if (!(await this.elector.isLeader())) return;
        } catch {
          /* 选举异常按执行处理（fail-open） */
        }
      }
      job.busy = true;
      job.runs++;
      job.lastRunAt = Date.now();
      try {
        await job.opts.run();
      } catch (e) {
        job.failures++;
        job.lastError = e instanceof Error ? e.message : String(e);
      } finally {
        job.busy = false;
      }
    };
    job.timer = setInterval(() => void tick(), everyMs);
    if (typeof job.timer.unref === 'function') job.timer.unref(); // 不阻塞进程退出
    this.jobs.set(name, job);
    if (jitter > 0) {
      const first = setTimeout(() => void tick(), jitter);
      if (typeof first.unref === 'function') first.unref();
    }
    return () => {
      clearInterval(job.timer);
      this.jobs.delete(name);
    };
  }

  /** 停止全部任务（测试 / 优雅关闭）。 */
  stopAll(): void {
    for (const job of this.jobs.values()) clearInterval(job.timer);
    this.jobs.clear();
  }

  stats(): Array<{ name: string; everyMs: number; runs: number; failures: number; lastRunAt?: number; lastError?: string }> {
    return [...this.jobs.values()].map((j) => ({
      name: j.opts.name,
      everyMs: j.opts.everyMs,
      runs: j.runs,
      failures: j.failures,
      ...(j.lastRunAt !== undefined ? { lastRunAt: j.lastRunAt } : {}),
      ...(j.lastError !== undefined ? { lastError: j.lastError } : {}),
    }));
  }

  get size(): number {
    return this.jobs.size;
  }
}

// ---------------------------------------------------------------------------
// 进程共享单例：插件 ctx.cron 与宿主装配层共用同一调度器（选举器全局一致）。
// ---------------------------------------------------------------------------
let _scheduler: CronScheduler | null = null;

/** 取得进程共享 CronScheduler（首次调用时创建）。 */
export function getProcessCronScheduler(): CronScheduler {
  if (!_scheduler) _scheduler = new CronScheduler();
  return _scheduler;
}

/** 为进程共享调度器注入 leader 选举器（多副本部署的宿主装配层调用）。 */
export function configureProcessCronLeaderElector(e: LeaderElector | null): void {
  getProcessCronScheduler().configureLeaderElector(e);
}
