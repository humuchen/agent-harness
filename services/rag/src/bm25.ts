/**
 * bm25.ts — 真 BM25 检索打分（P2：真 BM25 + 重排）。
 *
 * 纯 TS、零依赖。替换 retrieve.ts 中原先脆弱的「关键词集合交集占比」代理打分，
 * 提供具备 IDF 区分度的词项权重，与稠密余弦做加权融合，显著提升精确匹配召回质量。
 *
 * 用法：每个租户维护一份 Bm25Corpus（df + 每 chunk 的 tf/长度）。检索时对候选 chunk
 * 打分。语料规模较大时建议改为增量索引（设计文档 P3「向量库分片」路径），当前实现
 * 在每次检索时按需从租户全量 chunk 重建（演示/中小规模足够，O(chunk) 级）。
 */

import { tokenize } from './embed';

export interface Bm25Options {
  /** 词频饱和参数，默认 1.5。 */
  k1?: number;
  /** 长度归一化参数，默认 0.75。 */
  b?: number;
}

export class Bm25Corpus {
  private k1: number;
  private b: number;
  /** term -> 含该 term 的 chunk 数（文档频率）。 */
  private df = new Map<string, number>();
  /** chunkId -> { tf: term->count, len }。 */
  private docs = new Map<string, { tf: Map<string, number>; len: number }>();
  private totalLen = 0;
  private nDocs = 0;

  constructor(opts?: Bm25Options) {
    this.k1 = opts?.k1 ?? 1.5;
    this.b = opts?.b ?? 0.75;
  }

  /** 加入/更新一个 chunk（自动去重旧条目）。 */
  add(chunkId: string, content: string): void {
    this.remove(chunkId);
    const terms = tokenize(content);
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    if (tf.size === 0) return;
    this.docs.set(chunkId, { tf, len: terms.length });
    this.nDocs++;
    this.totalLen += terms.length;
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
  }

  /** 移除一个 chunk（删除文档时联动）。 */
  remove(chunkId: string): void {
    const d = this.docs.get(chunkId);
    if (!d) return;
    for (const t of d.tf.keys()) {
      const c = (this.df.get(t) || 0) - 1;
      if (c <= 0) this.df.delete(t);
      else this.df.set(t, c);
    }
    this.nDocs = Math.max(0, this.nDocs - 1);
    this.totalLen -= d.len;
    this.docs.delete(chunkId);
  }

  /** 从 chunk 列表批量构建语料（检索时按需调用）。 */
  static fromChunks(chunks: { chunk_id: string; content: string }[]): Bm25Corpus {
    const c = new Bm25Corpus();
    for (const ch of chunks) c.add(ch.chunk_id, ch.content);
    return c;
  }

  /** 对单个 chunk 按查询词项打分（BM25）。 */
  scoreChunk(chunkId: string, queryTerms: string[]): number {
    const d = this.docs.get(chunkId);
    if (!d || queryTerms.length === 0) return 0;
    const avgdl = this.nDocs ? this.totalLen / this.nDocs : 0;
    let score = 0;
    for (const q of queryTerms) {
      const f = d.tf.get(q);
      if (!f) continue;
      const df = this.df.get(q) || 0;
      if (df === 0) continue;
      const idf = Math.log(1 + (this.nDocs - df + 0.5) / (df + 0.5));
      const denom =
        (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * (d.len / (avgdl || 1))));
      score += idf * denom;
    }
    return score;
  }

  /** query 词项中按 IDF 排序靠前的若干（Pre-retrieval 查询扩展用）。 */
  topTerms(queryTerms: string[], limit = 5): string[] {
    return [...new Set(queryTerms)]
      .map((t) => ({ t, idf: Math.log(1 + (this.nDocs - (this.df.get(t) || 0) + 0.5) / ((this.df.get(t) || 0) + 0.5)) }))
      .sort((a, b) => b.idf - a.idf)
      .slice(0, limit)
      .map((x) => x.t);
  }

  get size(): number {
    return this.docs.size;
  }
}
