/**
 * 运行队列持久化后端（业务层，零依赖，与核心 framework 隔离）。
 *
 * 为什么需要它：当前 RunQueue 是完全内存态——进程崩溃/重启后，所有「已提交但还没
 * 执行完」的任务意图会丢失，客户端只能自行重投。对生产场景（Render 重启、k8s 滚动
 * 发布）而言，未开始的任务应当能「重启后自动续跑」，已开始的在飞任务因携带进程内
 * controller/subscribers 不可恢复（符合预期，客户端会重投）。
 *
 * 设计原则（延续本项目一贯约束）：
 * - 仅持久化「提交意图」（JobDescriptor），不含运行态（controller/subscribers/events），
 *   因为运行态不可序列化。重放时按意图原样重建 Job。
 * - 「接口 + 默认实现 + 组合工厂」：QueueBackend 是契约；内置 MemoryQueueBackend
 *   （默认，零行为变更）与 FileQueueBackend（零依赖、JSONL 追加写、崩溃安全）。
 * - 分布式扩展（Redis / BullMQ）只需实现同一 QueueBackend 接口并在 createQueueBackend
 *   工厂里加一个分支——RunQueue 与 handler 一行都不用改（见文件底部示例）。
 */

import type { RunMode } from './runner';
import type { VerifyConfig } from '@agent-harness/core';
import { encryptApiKey, decryptApiKey } from './custom-models';

/** 可持久化的任务意图（RunJob 的纯数据子集，可 JSON 序列化）。 */
export interface JobDescriptor {
  id: string;
  mode: RunMode;
  prompt: string;
  model?: string;
  /** 自定义模型专属接口地址（可选，OpenAI 兼容端点）。随 descriptor 持久化（baseUrl 非机密）。 */
  modelBaseUrl?: string;
  /**
   * 调用方随请求直传的 API Key（旧自定义模型前端路径的遗留明文注入，可选）。
   * 注意：这是「输入」而非解析结果——解析后的明文 Key（用户 provider Key / 自定义模型密文）
   * 绝不写入 descriptor，执行期由 run-queue.execute() 经 resolveRunCredential(owner,...) 重新解析。
   * 正常流程下前端已不再在 run body 带明文 Key，故 descriptor 实际不含任何明文凭据。
   */
  modelApiKey?: string;
  /** 所选模型的官方上下文窗口（token，可选）。随 descriptor 持久化。 */
  ctxWindow?: number;
  sessionKey?: string;
  maxSteps?: number;
  /** 运行期自动验证门禁配置（P0-2，可序列化）。 */
  verify?: VerifyConfig;
  /** P0.1：显式指定的目标 agent id（绕过路由，直达该 agent 的装配配方）。 */
  agentId?: string;
  /** P0.2：客户端/上游声明的领域（比 classify 更可信，可直接过滤候选）。 */
  domain?: string;
  /** P0.3 预留：租户标识（经认证派生，不可客户端伪造）。 */
  tenantId?: string;
  /** P0.2：工作流标识（可观测性，随 run:meta 透出）。 */
  workflowId?: string;
  /** P0.2：链路追踪标识（可观测性）。 */
  traceId?: string;
  /** 图片附件列表，服务端将其转为 ContentBlock[] 传给 LLM。 */
  attachments?: Array<{ url: string; name: string; type: string }>;
  /** 是否开启联网搜索：false/未传时禁用 web_fetch 与「联网检索」技能，避免任何出网检索。 */
  web?: boolean;
  /** 交互模式（P0 计划模式）：qa=问答（默认，现状）；plan=计划。 */
  interactionMode?: 'qa' | 'plan';
  /** 计划阶段：propose=生成计划（缺省）；execute=执行已确认的任务。 */
  planPhase?: 'propose' | 'execute';
  /** 归属用户（= 认证身份 sub，不可客户端伪造）：执行期注入工具链路做数据归属绑定。 */
  owner?: string;
  enqueuedAt: number;
}

/**
 * 计划任务派发判定：计划模式（plan）且非 propose 阶段 = 前端 confirmPlan 的逐任务 run。
 * 服务端据此给这类 run 启用 planTask 宽松输出护栏与更长超时 —— 教学内容易被
 * 弱信号护栏误拦、重任务常超默认 5 分钟（实测 stealth/ox-alpha 源码精读 >300s）。
 */
export function isPlanTaskRun(d: { interactionMode?: string; planPhase?: string }): boolean {
  return d.interactionMode === 'plan' && d.planPhase !== 'propose';
}

// ─── descriptor 明文凭据落盘防护（P1-2）───────────────────────────────────────
// 旧自定义模型前端路径可能随 run body 直传明文 modelApiKey；该字段若随 descriptor
// 原样持久化（run-queue.jsonl / runq:jobs HASH），明文 Key 将落盘。此处统一在持久层
// 加密（AES-256-GCM，密钥 AH_CRYPTO_KEY，与 custom-models / provider-keys 同源），
// 读取边界（list / claim / 启动重放）统一解密——进程内流（submit → execute）不变。
const MODEL_KEY_ENC_PREFIX = 'enc:v1:';

/** 持久化前加密 descriptor 内的明文 modelApiKey（幂等：已加密原样返回）。 */
function sealModelApiKey(d: JobDescriptor): JobDescriptor {
  if (!d.modelApiKey || d.modelApiKey.startsWith(MODEL_KEY_ENC_PREFIX)) return d;
  try {
    return {
      ...d,
      modelApiKey: MODEL_KEY_ENC_PREFIX + encryptApiKey(d.modelApiKey)
    };
  } catch (e) {
    // AH_CRYPTO_KEY 未配置（开发/测试环境常见）：宁剥离也不落明文——该任务将改走
    // 执行期凭据解析链（provider-keys / 平台兜底），解析不到时按 provider_key_required 拒绝。
    console.error(
      '[queue-backend] modelApiKey 加密失败（AH_CRYPTO_KEY 未配置？），已从持久层剥离该字段:',
      (e as Error)?.message
    );
    return stripModelApiKey(d);
  }
}

/** 从持久层读出时解密 descriptor 内的密文 modelApiKey（明文存量/未加密原样返回）。 */
function openModelApiKey(d: JobDescriptor): JobDescriptor {
  if (!d.modelApiKey || !d.modelApiKey.startsWith(MODEL_KEY_ENC_PREFIX)) return d;
  try {
    return {
      ...d,
      modelApiKey: decryptApiKey(d.modelApiKey.slice(MODEL_KEY_ENC_PREFIX.length))
    };
  } catch (e) {
    console.error(
      '[queue-backend] modelApiKey 解密失败（密钥不匹配或密文损坏），已剥离该字段:',
      (e as Error)?.message
    );
    return stripModelApiKey(d);
  }
}

function stripModelApiKey(d: JobDescriptor): JobDescriptor {
  const stripped = { ...d } as Partial<JobDescriptor>;
  delete stripped.modelApiKey;
  return stripped as JobDescriptor;
}

/** 持久化后端契约：追加 / 列举 / 原子领取 / 消费确认 / 清空 + 可选跨实例事件桥。 */
export interface QueueBackend {
  readonly kind: 'memory' | 'file' | 'redis' | 'bullmq';
  /** 追加一条待持久化任务（提交时调用）。 */
  append(d: JobDescriptor): Promise<void>;
  /** 列出所有已持久化任务（启动重放 / 运维快照用）。 */
  list(): Promise<JobDescriptor[]>;
  /**
   * 原子领取：把「最旧的一条待执行任务」从 pending 取出并返回（多实例安全）。
   * 共享后端（redis）会把它先迁到 processing 列表并记录领取时刻，便于崩溃回收；
   * 返回 null 表示当前无任务。单实例后端（memory/file）直接弹出本地首条。
   */
  claim(): Promise<JobDescriptor | null>;
  /** 标记某任务已消费（开始执行或被取消），从持久层移除。 */
  ack(id: string): Promise<void>;
  /** 清空整个持久层（启动重放后立即调用，避免二次重放）。 */
  clear(): Promise<void>;
  /**
   * 崩溃回收：把 processing 中「领取时刻距今超过 leaseMs」的任务迁回 pending，
   * 使被崩溃实例占住的任务能被其它实例重新领取。仅共享后端实现；返回回收条数。
   * P0-1：claimedAt 缺失的任务一律跳过 + 告警（宁可滞留等待下一轮，也不冒
   * 「在飞任务被误判为僵尸 → 重复执行」的风险）。
   */
  reclaimStale?(leaseMs: number): Promise<number>;
  /**
   * 续租（仅共享后端实现，P0-1）：把某任务的领取时刻刷新为当前时间。执行实例在
   * 任务执行期间周期调用（默认租约/3），使长任务（如 10 分钟计划任务）不会被其它
   * 实例的 reclaimStale 误判为僵尸而重复执行。仅当 claimedAt 仍存在时刷新——
   * ack（任务终态）后返回 false，续租自然失效。
   */
  renewLease?(id: string): Promise<boolean>;
  /**
   * 跨实例幂等占位（仅共享后端实现）：原子 SET NX，key 已存在时返回既有 jobId。
   * 使「同 idempotencyKey 不重复执行」的保证从进程内扩展到多副本（此前幂等索引
   * 是进程内 Map，同键提交落到不同实例会各自执行）。
   */
  tryAcquireIdem?(
    key: string,
    jobId: string,
    ttlMs: number
  ): Promise<{ acquired: boolean; existingJobId?: string }>;
  /** 释放跨实例幂等占位（任务终态时调用；仅共享后端实现）。 */
  releaseIdem?(key: string): Promise<void>;
  /**
   * 跨实例事件桥（仅共享后端实现）。执行实例把每个事件 publish 到 `runq:events:<jobId>`，
   * 持有 SSE 订阅的任意实例 subscribeEvents 后即可转发，使 SSE 不受「提交/执行在不同实例」
   * 影响。单实例后端（memory/file）不实现，事件走进程内直发（见 run-queue.ts）。
   */
  publishEvent?(jobId: string, event: unknown): Promise<void>;
  subscribeEvents?(jobId: string, fn: (e: unknown) => void): Promise<() => void>;
}

/** 默认后端：纯内存，不落盘。与改造前 RunQueue 行为完全一致（重启即丢）。 */
export class MemoryQueueBackend implements QueueBackend {
  readonly kind = 'memory' as const;
  private items: JobDescriptor[] = [];

  async append(d: JobDescriptor): Promise<void> {
    this.items.push(d);
  }
  async list(): Promise<JobDescriptor[]> {
    return [...this.items];
  }
  async claim(): Promise<JobDescriptor | null> {
    const it = this.items.shift();
    return it ?? null;
  }
  async ack(id: string): Promise<void> {
    this.items = this.items.filter((it) => it.id !== id);
  }
  async clear(): Promise<void> {
    this.items = [];
  }
}

/**
 * 文件后端：JSONL 追加写（每行一个 descriptor）。
 * - 崩溃安全：appendFile 即使中途崩溃最多丢掉「最后半行」，加载时按行解析、坏行丢弃。
 * - ack 后用「临时文件 + rename」原子重写，避免读改写过程中的截断。
 * - 默认文件 `RUN_QUEUE_FILE`（缺省 ./data/queue/run-queue.jsonl）。
 */
export class FileQueueBackend implements QueueBackend {
  readonly kind = 'file' as const;
  private file: string;
  private cache: JobDescriptor[] = [];
  private loaded = false;

  constructor(opts: { file: string }) {
    this.file = opts.file;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    await fs.mkdir(pathMod.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf-8');
      this.cache = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as JobDescriptor;
          } catch {
            return null; // 半截行/损坏行直接丢弃，不阻断启动
          }
        })
        .filter(Boolean) as JobDescriptor[];
    } catch {
      this.cache = []; // 文件不存在视为空
    }
  }

  async append(d: JobDescriptor): Promise<void> {
    await this.ensureLoaded();
    // P1-2：持久层统一加密明文 modelApiKey（cache 与文件都只存密文）。
    const sealed = sealModelApiKey(d);
    this.cache.push(sealed);
    const fs = await import('node:fs/promises');
    await fs.appendFile(this.file, JSON.stringify(sealed) + '\n', 'utf-8');
  }

  async list(): Promise<JobDescriptor[]> {
    await this.ensureLoaded();
    // P1-2：读取边界统一解密，重放/运维快照拿到的是明文 descriptor。
    return this.cache.map(openModelApiKey);
  }

  async claim(): Promise<JobDescriptor | null> {
    await this.ensureLoaded();
    const it = this.cache.shift();
    if (!it) return null;
    // 单实例：claim 即视为已领取，重写持久层。多实例安全由 redis 后端保证。
    await this.rewrite();
    return openModelApiKey(it);
  }

  async ack(id: string): Promise<void> {
    await this.ensureLoaded();
    const next = this.cache.filter((it) => it.id !== id);
    if (next.length === this.cache.length) return;
    this.cache = next;
    await this.rewrite();
  }

  async clear(): Promise<void> {
    this.cache = [];
    const fs = await import('node:fs/promises');
    try {
      await fs.writeFile(this.file, '', 'utf-8');
    } catch {
      /* 文件不存在时忽略 */
    }
  }

  /** 原子重写（临时文件 + rename），避免 ack 时读改写被中断导致整文件损坏。 */
  private async rewrite(): Promise<void> {
    const fs = await import('node:fs/promises');
    const tmp =
      `${this.file}.tmp.${process.pid}.${Date.now().toString(36)}.` +
      `${Math.random().toString(36).slice(2)}`;
    const body =
      this.cache.map((d) => JSON.stringify(d)).join('\n') + (this.cache.length ? '\n' : '');
    await fs.writeFile(tmp, body, 'utf-8');
    await fs.rename(tmp, this.file);
  }
}

/**
 * Redis 客户端最小契约（存储命令 + 发布订阅）。真实实现为 ioredis；测试用 FakeRedis 注入，
 * 从而在不依赖真实 Redis 服务的情况下验证后端逻辑。
 */
export interface RedisLike {
  rpush(key: string, value: string): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lrem(key: string, count: number, value: string): Promise<unknown>;
  lmove(
    source: string,
    destination: string,
    from: 'LEFT' | 'RIGHT',
    to: 'LEFT' | 'RIGHT'
  ): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  /**
   * SET 带 PX/NX 选项（跨实例幂等占位用）。可选：测试用 FakeRedis 未实现时，
   * tryAcquireIdem 退化为「总是获取成功」，幂等仅剩进程内一层。
   */
  set?(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    nx: 'NX'
  ): Promise<string | null>;
  get?(key: string): Promise<string | null>;
  /**
   * 执行 Lua 脚本（原子多命令，P0-1）。可选：测试替身未实现时，后端自动退化为
   * 「多命令串行」路径（语义弱化为非原子，但功能一致）。
   */
  eval?(script: string, numkeys: number, ...keysAndArgs: string[]): Promise<unknown>;
}
export interface RedisPubSubLike {
  duplicate(): RedisPubSubLike;
  subscribe(channel: string): void;
  on(event: 'message', cb: (channel: string, message: string) => void): void;
  unsubscribe(channel: string): void;
}
export type RedisClient = RedisLike & RedisPubSubLike & { quit(): Promise<void> };

// ─── P0-1 原子脚本（eval 可用时启用；测试替身缺失 eval 自动退化多命令路径）──────

/** 领取：LMOVE 与「领取时刻」原子同写，消除 lmove→hset 之间崩溃导致 claimedAt 缺失的窗口。 */
const CLAIM_LEASE_LUA = `local id = redis.call('LMOVE', KEYS[1], KEYS[2], 'LEFT', 'RIGHT')
if id then redis.call('HSET', KEYS[3], id, ARGV[1]) end
return id`;

/** 崩溃回收：lrem+rpush 原子化。若任务已被执行实例 ack（lrem 返回 0）则不再回填 pending，
 * 消除「lrem 后 rpush 前 ack → 任务二次入队」的重复执行竞态。 */
const RECLAIM_LUA = `if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
  redis.call('RPUSH', KEYS[2], ARGV[1])
  return 1
end
return 0`;

/** 续租：仅当 claimedAt 仍存在（任务未 ack）时刷新。给已被回收/已完结任务续租无危害：
 * 已完结任务的 claimedAt 已被 ack 删除（返回 0）；已被其它实例重领的任务刷新的只是
 * 新持有者的租约（延长而非缩短，方向安全）。 */
const RENEW_LEASE_LUA = `if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return 1
end
return 0`;

/**
 * Redis 后端：把「可插拔接口」变成真正的共享、多实例队列。
 *
 * 数据结构（统一前缀 `runq:`）：
 * - `runq:pending`    LIST  —— 待领取任务（仅存 id）
 * - `runq:processing` LIST  —— 已被某实例领取、正在执行（仅存 id）
 * - `runq:jobs`       HASH  —— id → JobDescriptor(JSON)，claim/list/ack 的内容源
 * - `runq:claimedAt`  HASH  —— id → 领取时刻(ms)，供 reclaimStale 判定租约过期
 *
 * 多实例安全性来自 `claim()` 的原子 `RPOPLPUSH pending→processing`：无论多少实例并发领取，
 * 同一任务只会被一个实例拿到。该实例执行中崩溃 → 任务留在 processing；其它实例周期性
 * `reclaimStale(leaseMs)` 把超租约的任务迁回 pending 重新领取（崩溃恢复）。
 *
 * 事件桥：`publishEvent/subscribeEvents` 用独立 sub 连接做 pub/sub，使 SSE 不受「提交实例 ≠
 * 执行实例」影响（配合负载均衡的 sticky session 即可无缝多实例部署）。
 */
export class RedisQueueBackend implements QueueBackend {
  readonly kind = 'redis' as const;
  private pending = 'runq:pending';
  private processing = 'runq:processing';
  private jobsKey = 'runq:jobs';
  private claimedAt = 'runq:claimedAt';
  private client: RedisClient;
  private sub: RedisPubSubLike;
  private listeners = new Map<string, Set<(msg: string) => void>>();

  constructor(client: RedisClient) {
    this.client = client;
    this.sub = client.duplicate();
    this.sub.on('message', (channel, message) => {
      const set = this.listeners.get(channel);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(message);
        } catch {
          /* 单订阅者异常不应影响其他 */
        }
      }
    });
  }

  private chan(jobId: string): string {
    return `runq:events:${jobId}`;
  }

  async append(d: JobDescriptor): Promise<void> {
    // P1-2：持久层统一加密明文 modelApiKey（runq:jobs HASH 只存密文）。
    const sealed = sealModelApiKey(d);
    await this.client.hset(this.jobsKey, sealed.id, JSON.stringify(sealed));
    await this.client.rpush(this.pending, sealed.id);
  }

  async list(): Promise<JobDescriptor[]> {
    const pending = await this.client.lrange(this.pending, 0, -1);
    const proc = await this.client.lrange(this.processing, 0, -1);
    const ids = [...pending, ...proc];
    if (ids.length === 0) return [];
    const raws = await this.client.hmget(this.jobsKey, ...ids);
    const out: JobDescriptor[] = [];
    for (const raw of raws) {
      if (raw) {
        try {
          out.push(openModelApiKey(JSON.parse(raw) as JobDescriptor));
        } catch {
          /* 坏数据跳过 */
        }
      }
    }
    return out;
  }

  async claim(): Promise<JobDescriptor | null> {
    // FIFO：从 pending 左端（最旧）原子弹出并追加到 processing 右端，保证多实例下
    // 同一任务只会被一个实例领取，且领取顺序与提交顺序一致；processing 保持领取顺序
    // 以便 reclaimStale 按原 FIFO 重新入队。
    const id = await this.claimId();
    if (!id) return null;
    const raw = await this.client.hget(this.jobsKey, id);
    if (!raw) {
      await this.client.lrem(this.processing, 1, id);
      return null;
    }
    try {
      return openModelApiKey(JSON.parse(raw) as JobDescriptor);
    } catch {
      await this.client.lrem(this.processing, 1, id);
      return null;
    }
  }

  /**
   * P0-1：领取 id 与领取时刻原子同写（Lua 单脚本）。旧实现 lmove 与 hset 之间存在
   * 窗口：实例在这两步之间崩溃 → claimedAt 缺失 → 回收方按「缺 claimedAt 立即回收」
   * 处理，与真实执行状态脱节。Lua 化后该窗口不存在；eval 不可用（测试替身/旧客户端）
   * 时退化为旧行为。
   */
  private async claimId(): Promise<string | null> {
    if (typeof this.client.eval === 'function') {
      try {
        const id = (await this.client.eval(
          CLAIM_LEASE_LUA,
          3,
          this.pending,
          this.processing,
          this.claimedAt,
          String(Date.now())
        )) as string | null;
        return id ?? null;
      } catch (e) {
        console.error(
          '[queue-backend] atomic claim script failed, falling back to two-step:',
          (e as Error)?.message
        );
      }
    }
    const id = await this.client.lmove(this.pending, this.processing, 'LEFT', 'RIGHT');
    if (!id) return null;
    await this.client.hset(this.claimedAt, id, String(Date.now()));
    return id;
  }

  /** 原子批量操作（pipeline）：多个命令打包为一次网络往返，提升吞吐并保证最终一致性。 */
  async pipeline(commands: Array<{ cmd: string; args: any[] }>): Promise<unknown[]> {
    // ioredis pipeline 形式：client.pipeline().cmd(...args).exec()
    // 此处用简化版：直接串行执行（兼容任何 RedisLike）
    const results: unknown[] = [];
    for (const { cmd, args } of commands) {
      const fn = (this.client as any)[cmd];
      if (typeof fn === 'function') {
        results.push(await fn.apply(this.client, args));
      }
    }
    return results;
  }

  async ack(id: string): Promise<void> {
    await this.client.lrem(this.processing, 1, id);
    await this.client.hdel(this.jobsKey, id);
    await this.client.hdel(this.claimedAt, id);
  }

  async clear(): Promise<void> {
    await this.client.del(this.pending, this.processing, this.jobsKey, this.claimedAt);
  }

  async reclaimStale(leaseMs: number): Promise<number> {
    const proc = await this.client.lrange(this.processing, 0, -1);
    const now = Date.now();
    let moved = 0;
    let missingLease = 0;
    for (const id of proc) {
      const t = Number(await this.client.hget(this.claimedAt, id));
      // P0-1 修复：claimedAt 缺失不再「立即回收」。旧逻辑 `!t || now - t >= leaseMs`
      // 会在 claimedAt 意外丢失（或旧版 claim 的 lmove→hset 崩溃窗口）时把**在飞任务**
      // 迁回 pending，与执行实例的 ack 竞态 → 重复执行。现改为跳过 + 告警：
      // claim() 已 Lua 原子同写 claimedAt，正常路径不存在缺失；缺失只可能是数据
      // 损坏/人工干预，此时保守等待下一轮（宁可滞留，也不冒重复执行风险）。
      if (!t) {
        missingLease += 1;
        continue;
      }
      // 租赁已到期（含恰好到期边界）：now - t >= leaseMs 即视为陈旧，迁回 pending 重新领取。
      if (now - t >= leaseMs) {
        if (await this.moveBackAtomic(id)) moved += 1;
      }
    }
    if (missingLease > 0) {
      console.warn(
        `[queue-backend] reclaimStale: ${missingLease} processing job(s) missing claimedAt — skipped (will retry next cycle)`
      );
    }
    return moved;
  }

  /**
   * P0-1：迁移原子化（Lua lrem+rpush 单脚本）。旧实现两步非原子：lrem 之后、rpush
   * 之前，执行实例恰好 ack（hdel jobsKey/claimedAt）→ rpush 把 id 塞回 pending，
   * 但任务内容已删 → 空 id 空转；更糟的窗口是任务被新实例领取后旧实例 ack —— 任务
   * 被执行两遍。Lua 化后迁移本身原子；与 ack 的残余竞态由「执行期租约续租」把窗口
   * 压到实例真实崩溃的场景。
   */
  private async moveBackAtomic(id: string): Promise<boolean> {
    if (typeof this.client.eval === 'function') {
      try {
        const r = (await this.client.eval(
          RECLAIM_LUA,
          2,
          this.processing,
          this.pending,
          id
        )) as number;
        return Number(r) === 1;
      } catch (e) {
        console.error(
          '[queue-backend] reclaim script failed, falling back to two-step:',
          (e as Error)?.message
        );
      }
    }
    await this.client.lrem(this.processing, 1, id);
    await this.client.rpush(this.pending, id);
    return true;
  }

  /** P0-1：续租——仅当 claimedAt 仍存在（未 ack）时刷新（Lua 原子）。 */
  async renewLease(id: string): Promise<boolean> {
    if (typeof this.client.eval === 'function') {
      try {
        const r = (await this.client.eval(
          RENEW_LEASE_LUA,
          1,
          this.claimedAt,
          id,
          String(Date.now())
        )) as number;
        return Number(r) === 1;
      } catch (e) {
        console.error(
          '[queue-backend] renew lease script failed, falling back:',
          (e as Error)?.message
        );
      }
    }
    // 退化路径（测试替身/旧客户端）：hget 后 hset（非原子；最坏结果为「多续了一次
    // 租」或给已被回收的任务补了一次租约——都无危害，见 RENEW_LEASE_LUA 注释）。
    const t = await this.client.hget(this.claimedAt, id);
    if (t === null) return false;
    await this.client.hset(this.claimedAt, id, String(Date.now()));
    return true;
  }

  private idemKeyOf(key: string): string {
    return `runq:idem:${key}`;
  }

  /** 跨实例幂等占位：原子 SET NX PX；客户端不支持 set/get（旧测试替身）时退化为放行。 */
  async tryAcquireIdem(
    key: string,
    jobId: string,
    ttlMs: number
  ): Promise<{ acquired: boolean; existingJobId?: string }> {
    const client = this.client as RedisLike;
    if (typeof client.set !== 'function' || typeof client.get !== 'function') {
      return { acquired: true };
    }
    const k = this.idemKeyOf(key);
    const res = await client.set(k, jobId, 'PX', ttlMs, 'NX');
    if (res === 'OK' || res === '1') return { acquired: true };
    const existing = await client.get(k);
    return { acquired: false, existingJobId: existing ?? undefined };
  }

  /** 释放跨实例幂等占位（任务终态时由 run-queue 调用）。 */
  async releaseIdem(key: string): Promise<void> {
    await this.client.del(this.idemKeyOf(key));
  }

  async publishEvent(jobId: string, event: unknown): Promise<void> {
    await this.client.publish(this.chan(jobId), JSON.stringify(event));
  }

  async subscribeEvents(jobId: string, fn: (e: unknown) => void): Promise<() => void> {
    const ch = this.chan(jobId);
    const wrapped = (msg: string) => {
      try {
        fn(JSON.parse(msg));
      } catch {
        /* 坏消息跳过 */
      }
    };
    let set = this.listeners.get(ch);
    if (!set) {
      set = new Set();
      this.listeners.set(ch, set);
      this.sub.subscribe(ch);
    }
    set.add(wrapped);
    return () => {
      const s = this.listeners.get(ch);
      if (!s) return;
      s.delete(wrapped);
      if (s.size === 0) {
        this.listeners.delete(ch);
        this.sub.unsubscribe(ch);
      }
    };
  }

  /** 关闭底层连接（优雅停机调用）。 */
  async close(): Promise<void> {
    await this.client.quit().catch(() => {});
  }
}

/**
 * 组合工厂：按环境变量选择后端。
 * - REDIS_URL 设置 或 RUN_QUEUE_BACKEND=redis → RedisQueueBackend（共享、多实例、崩溃可恢复）
 *   · ioredis 为可选依赖：未安装时自动降级 MemoryQueueBackend 并打印告警（保持「一切降级可用」）。
 * - RUN_QUEUE_BACKEND=file                        → FileQueueBackend（单实例、崩溃可恢复）
 * - 其余 / 未设置                                 → MemoryQueueBackend（默认，零行为变更）
 */
export function createQueueBackend(): QueueBackend {
  const kind = (process.env.RUN_QUEUE_BACKEND || '').toLowerCase();
  const redisUrl = process.env.REDIS_URL;
  if (kind === 'redis' || (kind !== 'file' && redisUrl)) {
    try {
      // ioredis 可选依赖：动态 require，未安装则回退 memory。
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const RedisMod = require('ioredis');
      const RedisCtor = (RedisMod && (RedisMod.default || RedisMod)) || RedisMod;
      const client = new RedisCtor(redisUrl || 'redis://localhost:6379', {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      }) as RedisClient;
      if (typeof (client as any).on === 'function') {
        (client as any).on('error', (e: Error) =>
          console.error('[queue-backend] redis error:', e?.message)
        );
      }
      console.log(`[queue-backend] using Redis backend${redisUrl ? ` (${redisUrl})` : ''}`);
      return new RedisQueueBackend(client);
    } catch (e) {
      console.error(
        '[queue-backend] ioredis 不可用，回退 memory 后端:',
        (e as Error)?.message
      );
      return new MemoryQueueBackend();
    }
  }
  if (kind === 'file') {
    const file =
      process.env.RUN_QUEUE_FILE || `${process.cwd()}/data/queue/run-queue.jsonl`;
    return new FileQueueBackend({ file });
  }
  return new MemoryQueueBackend();
}
