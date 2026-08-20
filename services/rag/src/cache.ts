/**
 * cache.ts — 查询/向量结果缓存（P3：查询缓存）。
 *
 * 零依赖 LRU + TTL。键 = `tenant|top_k|threshold|filters|query`，命中即直接回种，
 * 跳过向量化与检索计算，将重复检索延迟压到近 0（设计文档 P3「p95<150ms」的主要手段）。
 * 缓存内容本身即「向量化后的检索结果」，等价于向量缓存 + 结果缓存合一。
 */

export interface CacheEntry {
  value: unknown;
  expires: number;
}

export class QueryCache {
  private map = new Map<string, CacheEntry>();
  private max: number;
  private ttlMs: number;

  constructor(opts?: { max?: number; ttlMs?: number }) {
    this.max = opts?.max ?? 256;
    this.ttlMs = opts?.ttlMs ?? 60_000;
  }

  /** 构造缓存键（filters 已序列化为字符串）。 */
  key(tenant: string, query: string, topK: number, threshold: number, filters?: string): string {
    return `${tenant}|${topK}|${threshold}|${filters ?? ''}|${query}`;
  }

  get(key: string): unknown | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch：移到末尾
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: unknown): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
