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

/** 可持久化的任务意图（RunJob 的纯数据子集，可 JSON 序列化）。 */
export interface JobDescriptor {
  id: string;
  mode: RunMode;
  prompt: string;
  model?: string;
  sessionKey?: string;
  enqueuedAt: number;
}

/** 持久化后端契约：追加 / 列举 / 消费确认 / 清空。 */
export interface QueueBackend {
  readonly kind: 'memory' | 'file' | 'redis' | 'bullmq';
  /** 追加一条待持久化任务（提交时调用）。 */
  append(d: JobDescriptor): Promise<void>;
  /** 列出所有已持久化任务（启动时重放用）。 */
  list(): Promise<JobDescriptor[]>;
  /** 标记某任务已消费（开始执行或被取消），从持久层移除。 */
  ack(id: string): Promise<void>;
  /** 清空整个持久层（启动重放后立即调用，避免二次重放）。 */
  clear(): Promise<void>;
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
    this.cache.push(d);
    const fs = await import('node:fs/promises');
    await fs.appendFile(this.file, JSON.stringify(d) + '\n', 'utf-8');
  }

  async list(): Promise<JobDescriptor[]> {
    await this.ensureLoaded();
    return [...this.cache];
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
 * 组合工厂：按环境变量选择后端。
 * - RUN_QUEUE_BACKEND=file  → FileQueueBackend（崩溃可恢复）
 * - 其余 / 未设置          → MemoryQueueBackend（默认，零行为变更）
 *
 * 接入 Redis/BullMQ 时，只需在此加一个分支（见下方注释示例），RunQueue 无需改动。
 */
export function createQueueBackend(): QueueBackend {
  const kind = (process.env.RUN_QUEUE_BACKEND || 'memory').toLowerCase();
  if (kind === 'file') {
    const file =
      process.env.RUN_QUEUE_FILE || `${process.cwd()}/data/queue/run-queue.jsonl`;
    return new FileQueueBackend({ file });
  }
  return new MemoryQueueBackend();
}

/*
 * ── 分布式扩展示例（不引入 npm 依赖，按需实现）──
 * 只要实现 QueueBackend 接口，即可替换工厂中的分支，RunQueue/handler 零改动：
 *
 * class RedisQueueBackend implements QueueBackend {
 *   readonly kind = 'redis' as const;
 *   constructor(private client: RedisLike) {}
 *   async append(d: JobDescriptor) { await this.client.rpush('runq', JSON.stringify(d)); }
 *   async list() {
 *     const raw = await this.client.lrange('runq', 0, -1);
 *     return raw.map((l) => JSON.parse(l) as JobDescriptor);
 *   }
 *   async ack(id: string) {  // 用 zset/lua 按 id 精确剔除；此处示意
 *     const all = await this.list();
 *     const kept = all.filter((d) => d.id !== id);
 *     await this.client.del('runq');
 *     if (kept.length) await this.client.rpush('runq', ...kept.map((d) => JSON.stringify(d)));
 *   }
 *   async clear() { await this.client.del('runq'); }
 * }
 *
 * 然后在 createQueueBackend 中：
 *   if (kind === 'redis') return new RedisQueueBackend(await createRedisClient());
 */
