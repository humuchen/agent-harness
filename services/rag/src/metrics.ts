/**
 * metrics.ts — 可观测埋点（P3：可观测性）。
 *
 * 零依赖。维护计数器（入库 / 检索 / 缓存命中率）与延迟 reservoir（P50/P95/P99），
 * 导出 Prometheus 文本格式（GET /v1/metrics）。每次检索返回 trace_id + latency_ms，
 * 服务端埋点（召回命中、P95）便于与 agent 侧 trace 日志联合排障（设计文档第 8/11 节）。
 */

export class Metrics {
  ingestTotal = 0;
  ingestAccepted = 0; // 异步入队任务数
  ingestDone = 0;
  ingestFailed = 0;
  retrieveTotal = 0;
  cacheHits = 0;
  cacheMisses = 0;
  tenantChunks: Record<string, number> = {};

  private latSamples: number[] = [];
  private maxSamples = 2000;

  recordIngestAccepted(): void {
    this.ingestAccepted++;
  }

  recordIngest(done: boolean): void {
    this.ingestTotal++;
    if (done) this.ingestDone++;
    else this.ingestFailed++;
  }

  recordRetrieve(latencyMs: number, cacheHit: boolean): void {
    this.retrieveTotal++;
    if (cacheHit) this.cacheHits++;
    else this.cacheMisses++;
    this.latSamples.push(latencyMs);
    if (this.latSamples.length > this.maxSamples) this.latSamples.shift();
  }

  setTenantChunks(map: Record<string, number>): void {
    this.tenantChunks = map;
  }

  private percentile(p: number): number {
    if (!this.latSamples.length) return 0;
    const s = [...this.latSamples].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))));
    return s[idx];
  }

  p50(): number {
    return this.percentile(50);
  }
  p95(): number {
    return this.percentile(95);
  }
  p99(): number {
    return this.percentile(99);
  }

  cacheHitRate(): number {
    const total = this.cacheHits + this.cacheMisses;
    return total ? this.cacheHits / total : 0;
  }

  /** Prometheus 文本格式。 */
  toPrometheus(): string {
    const lines: string[] = [
      '# HELP rag_ingest_total 累计入库文档数（含异步完成）',
      '# TYPE rag_ingest_total counter',
      `rag_ingest_total ${this.ingestTotal}`,
      '# HELP rag_ingest_accepted_total 异步入队任务数',
      '# TYPE rag_ingest_accepted_total counter',
      `rag_ingest_accepted_total ${this.ingestAccepted}`,
      '# HELP rag_ingest_done_total 异步入库完成数',
      '# TYPE rag_ingest_done_total counter',
      `rag_ingest_done_total ${this.ingestDone}`,
      '# HELP rag_ingest_failed_total 异步入库失败数',
      '# TYPE rag_ingest_failed_total counter',
      `rag_ingest_failed_total ${this.ingestFailed}`,
      '# HELP rag_retrieve_total 累计检索次数',
      '# TYPE rag_retrieve_total counter',
      `rag_retrieve_total ${this.retrieveTotal}`,
      '# HELP rag_cache_hits_total 检索缓存命中',
      '# TYPE rag_cache_hits_total counter',
      `rag_cache_hits_total ${this.cacheHits}`,
      '# HELP rag_cache_misses_total 检索缓存未命中',
      '# TYPE rag_cache_misses_total counter',
      `rag_cache_misses_total ${this.cacheMisses}`,
      '# HELP rag_retrieve_latency_ms 检索延迟(ms) 分位',
      '# TYPE rag_retrieve_latency_ms summary',
      `rag_retrieve_latency_ms{p="50"} ${this.p50().toFixed(2)}`,
      `rag_retrieve_latency_ms{p="95"} ${this.p95().toFixed(2)}`,
      `rag_retrieve_latency_ms{p="99"} ${this.p99().toFixed(2)}`,
    ];
    for (const [t, n] of Object.entries(this.tenantChunks)) {
      lines.push(`rag_tenant_chunks{tenant="${t}"} ${n}`);
    }
    return lines.join('\n') + '\n';
  }

  /** /v1/health 附带的小结。 */
  summary(): Record<string, unknown> {
    return {
      ingest: { accepted: this.ingestAccepted, done: this.ingestDone, failed: this.ingestFailed },
      retrieve_total: this.retrieveTotal,
      cache_hit_rate: Number(this.cacheHitRate().toFixed(3)),
      latency_ms: { p50: this.p50(), p95: this.p95(), p99: this.p99() },
      tenant_chunks: this.tenantChunks,
    };
  }
}

/** 结构化日志（最小实现，零依赖）。 */
export function logTrace(traceId: string, level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), trace_id: traceId, level, msg, ...extra });
  if (level === 'error') process.stderr.write(`[rag] ${line}\n`);
  else process.stdout.write(`[rag] ${line}\n`);
}
