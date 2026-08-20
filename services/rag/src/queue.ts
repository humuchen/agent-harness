/**
 * queue.ts — 异步入库队列（P2：异步入库队列）。
 *
 * 进程内有限并发 worker 池。ingest 请求入队后立即返回 job_id（202 Accepted），
 * 后台并发执行「分块→向量化→upsert」，完成后回调（默认做 JSON 持久化）。
 * 满足设计文档 P2「文档更新 <30s 生效」「Kafka/队列解耦入库」的最小闭环（进程内版）。
 *
 * 零依赖。优雅关闭可调用 drain() 等待在途任务完成。
 */

import type { MemoryVectorStore } from './store';
import type { EmbeddingProvider } from './embed';
import { ingestDocument, IngestInput } from './ingest';

export type IngestStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface IngestJob {
  jobId: string;
  doc_id: string;
  tenant_id: string;
  status: IngestStatus;
  chunks?: number;
  error?: string;
  enqueuedAt: number;
  finishedAt?: number;
}

export interface IngestQueueOptions {
  /** 并发 worker 数，默认 4。 */
  concurrency?: number;
  /** 完成后持久化文件（与 store.persist 同路径）。 */
  dataFile?: string;
  /** 持久化是否按租户分片（P3：向量库按租户分片）。 */
  shardByTenant?: boolean;
  /** 任务完成回调（成功/失败均触发）。 */
  onDone?: (job: IngestJob) => void;
}

let seq = 0;

export class IngestQueue {
  private store: MemoryVectorStore;
  private provider: EmbeddingProvider;
  private concurrency: number;
  private dataFile?: string;
  private shardByTenant: boolean;
  private onDone?: (job: IngestJob) => void;
  private jobs = new Map<string, IngestJob>();
  private queue: { job: IngestJob; input: IngestInput }[] = [];
  private active = 0;

  constructor(store: MemoryVectorStore, provider: EmbeddingProvider, opts?: IngestQueueOptions) {
    this.store = store;
    this.provider = provider;
    this.concurrency = Math.max(1, opts?.concurrency ?? 4);
    this.dataFile = opts?.dataFile;
    this.shardByTenant = !!opts?.shardByTenant;
    this.onDone = opts?.onDone;
  }

  /** 入队一篇文档，立即返回 job（状态 queued）。 */
  enqueue(input: IngestInput): IngestJob {
    const job: IngestJob = {
      jobId: `job_${Date.now().toString(36)}_${(seq++).toString(36)}`,
      doc_id: String(input.doc_id),
      tenant_id: String(input.tenant_id),
      status: 'queued',
      enqueuedAt: Date.now(),
    };
    this.jobs.set(job.jobId, job);
    this.queue.push({ job, input });
    this.pump();
    return job;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const next = this.queue.shift()!;
      this.active++;
      void this.process(next.job, next.input);
    }
  }

  private async process(job: IngestJob, input: IngestInput): Promise<void> {
    job.status = 'processing';
    try {
      const r = await ingestDocument(this.store, this.provider, input);
      job.chunks = r.chunks;
      job.status = 'done';
    } catch (e: any) {
      job.status = 'failed';
      job.error = String(e?.message || e);
    } finally {
      job.finishedAt = Date.now();
      if (this.dataFile && job.status === 'done') {
        try {
          this.store.persist(this.dataFile, this.shardByTenant);
        } catch {
          /* 持久化失败不阻断队列 */
        }
      }
      this.onDone?.(job);
      this.active--;
      this.pump();
    }
  }

  stats(): { queued: number; processing: number; done: number; failed: number; total: number } {
    let queued = 0;
    let processing = 0;
    let done = 0;
    let failed = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'queued') queued++;
      else if (j.status === 'processing') processing++;
      else if (j.status === 'done') done++;
      else if (j.status === 'failed') failed++;
    }
    return { queued, processing, done, failed, total: this.jobs.size };
  }

  job(jobId: string): IngestJob | undefined {
    return this.jobs.get(jobId);
  }

  /** 等待所有在途任务完成（测试 / 优雅关闭）。 */
  async drain(timeoutMs = 5000): Promise<void> {
    const t0 = Date.now();
    while ((this.active > 0 || this.queue.length > 0) && Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
