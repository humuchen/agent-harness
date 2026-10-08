/**
 * ingest.ts — 入库流水线最小实现（解析 → 分块 → 向量化 → 幂等 upsert）。
 *
 * 对应设计文档第 2/10 节「最小入库」。解析目前接受纯文本（设计文档的解析器
 * 在 P2 扩展 PDF/HTML/Markdown），分块用滑动窗口重叠策略。upsert 按
 * doc_id + index 派生的 chunk_id 幂等，重复入库同篇文档仅更新，满足「增量更新」。
 */

import type { Chunk, VectorStore } from './store';
import type { EmbeddingProvider } from './embed';
import { loadDocument, type DocumentSource } from './loaders';
import { splitAuto } from './splitter';

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
  store: VectorStore,
  provider: EmbeddingProvider,
  input: IngestInput,
): Promise<IngestResult> {
  const docId = String(input.doc_id).trim();
  const tenantId = String(input.tenant_id).trim();
  if (!docId) throw new Error('doc_id 必填');
  if (!tenantId) throw new Error('tenant_id 必填');

  const pieces = chunkText(input.text, input.chunk_size ?? 480, input.chunk_overlap ?? 80);
  const replaced = await embedAndWrite(
    store,
    provider,
    docId,
    tenantId,
    pieces.map((p) => ({ content: p })),
    input
  );

  return { doc_id: docId, tenant_id: tenantId, chunks: pieces.length, replaced };
}

/**
 * P6-B（方案二一期）结构化入库：source（markdown/text/url/pdf/docx）→ 加载 →
 * 结构感知切分（标题层级 heading_path 进 chunk.metadata）→ 向量化 → 幂等写入。
 * 与 ingestDocument 共用「先全部向量化再写」的毒化防护纪律；行为差异：
 * 切分由 splitAuto 按 markdown 标题/段落/句子递归（不再固定滑窗）。
 */
export interface StructuredIngestInput extends Omit<IngestInput, 'text' | 'chunk_overlap'> {
  source: DocumentSource;
  /** splitter 单片上限（字符），缺省 480。 */
  max_len?: number;
}

export async function ingestStructured(
  store: VectorStore,
  provider: EmbeddingProvider,
  input: StructuredIngestInput
): Promise<IngestResult> {
  const docId = String(input.doc_id).trim();
  const tenantId = String(input.tenant_id).trim();
  if (!docId) throw new Error('doc_id 必填');
  if (!tenantId) throw new Error('tenant_id 必填');
  if (!input.source) throw new Error('source 必填（{ type, value }）');

  const doc = await loadDocument(input.source);
  const pieces = splitAuto(doc.text, { maxLen: input.max_len ?? input.chunk_size ?? 480 });
  if (pieces.length === 0) {
    throw new Error('加载与切分后无有效内容（检查 source 内容或 max_len 配置）');
  }
  const replaced = await embedAndWrite(
    store,
    provider,
    docId,
    tenantId,
    pieces.map((p) => ({
      content: p.content,
      meta: p.headingPath.length ? { heading_path: p.headingPath } : {},
    })),
    input
  );

  return { doc_id: docId, tenant_id: tenantId, chunks: pieces.length, replaced };
}

/**
 * 共享写入段：先完成**全部**向量化（P1 毒化防护 —— 远程嵌入失败时旧文档原样保留，
 * 不出现半入库中间态），再 deleteByDoc + 逐片幂等 upsert。
 * items.meta 会合并进 chunk.metadata（heading_path 等结构信息；空对象不覆盖既有 metadata 语义）。
 */
async function embedAndWrite(
  store: VectorStore,
  provider: EmbeddingProvider,
  docId: string,
  tenantId: string,
  items: Array<{ content: string; meta?: Record<string, unknown> }>,
  base?: { title?: string; tags?: string[]; metadata?: Record<string, unknown> }
): Promise<number> {
  const vectors: number[][] = [];
  for (const item of items) {
    vectors.push(await embedOne(provider, `${base?.title ?? ''}\n${item.content}`));
  }

  // 增量更新：删除旧 chunk 后写新（幂等由 chunk_id 保证）。P6-B：后端可为异步。
  const replaced = await store.deleteByDoc(docId, tenantId);

  let idx = 0;
  for (const item of items) {
    const meta = { ...(base?.metadata ?? {}), ...(item.meta ?? {}) };
    const chunk: Chunk = {
      chunk_id: `${docId}#${idx}`,
      doc_id: docId,
      tenant_id: tenantId,
      index: idx,
      content: item.content,
      ...(base?.title ? { title: base.title } : {}),
      ...(base?.tags ? { tags: base.tags } : {}),
      ...(Object.keys(meta).length ? { metadata: meta } : {}),
      vector: vectors[idx]!,
      created_at: Date.now(),
    };
    await store.upsert(chunk);
    idx++;
  }
  return replaced;
}
