/**
 * ingest.ts — 入库流水线最小实现（解析 → 分块 → 向量化 → 幂等 upsert）。
 *
 * 对应设计文档第 2/10 节「最小入库」。解析目前接受纯文本（设计文档的解析器
 * 在 P2 扩展 PDF/HTML/Markdown），分块用滑动窗口重叠策略。upsert 按
 * doc_id + index 派生的 chunk_id 幂等，重复入库同篇文档仅更新，满足「增量更新」。
 */

import type { Chunk } from './store';
import type { EmbeddingProvider } from './embed';
import type { MemoryVectorStore } from './store';

export interface IngestInput {
  doc_id: string;
  tenant_id: string;
  title?: string;
  text: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  chunk_size?: number;
  chunk_overlap?: number;
}

export interface IngestResult {
  doc_id: string;
  tenant_id: string;
  chunks: number;
  replaced: number;
}

/** 滑动窗口分块（按字符，重叠 overlap）。返回每块的纯文本。 */
export function chunkText(text: string, size = 480, overlap = 80): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(clean.length, start + size);
    out.push(clean.slice(start, end));
    if (end === clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

async function embedOne(provider: EmbeddingProvider, text: string): Promise<number[]> {
  if (provider.embedAsync) return provider.embedAsync(text);
  return provider.embed(text);
}

/** 入库一篇文档：分块 + 向量化 + 幂等 upsert；先按 doc_id 清旧 chunk 再写新。 */
export async function ingestDocument(
  store: MemoryVectorStore,
  provider: EmbeddingProvider,
  input: IngestInput,
): Promise<IngestResult> {
  const docId = String(input.doc_id).trim();
  const tenantId = String(input.tenant_id).trim();
  if (!docId) throw new Error('doc_id 必填');
  if (!tenantId) throw new Error('tenant_id 必填');

  const size = input.chunk_size ?? 480;
  const overlap = input.chunk_overlap ?? 80;
  const pieces = chunkText(input.text, size, overlap);

  // P1（嵌入失败毒化防护）：先完成全部向量化，再做任何写操作——
  // 远程嵌入失败（strict 默认抛 EmbeddingUnavailableError）时旧文档原样保留，
  // 不再出现「旧 chunk 已删、新 chunk 半途失败」的半入库中间态；
  // 嵌入产物也不会以静默降级的哈希向量形态混入语料。
  const vectors: number[][] = [];
  for (const piece of pieces) {
    vectors.push(await embedOne(provider, `${input.title ?? ''}\n${piece}`));
  }

  // 增量更新：删除旧 chunk 后写新（幂等由 chunk_id 保证）
  const replaced = store.deleteByDoc(docId, tenantId);

  let idx = 0;
  for (const piece of pieces) {
    const chunk: Chunk = {
      chunk_id: `${docId}#${idx}`,
      doc_id: docId,
      tenant_id: tenantId,
      index: idx,
      content: piece,
      title: input.title,
      tags: input.tags,
      metadata: input.metadata,
      vector: vectors[idx]!,
      created_at: Date.now(),
    };
    store.upsert(chunk);
    idx++;
  }

  return { doc_id: docId, tenant_id: tenantId, chunks: pieces.length, replaced };
}
