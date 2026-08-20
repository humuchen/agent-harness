/**
 * embed.ts — 可插拔文本向量化（Embedding）抽象。
 *
 * 设计要点（对应外部 RAG 设计文档第 4/8 节）：
 * - EmbeddingProvider 是稳定契约，真实部署可替换为 OpenAI / OpenRouter / 本地模型。
 * - 默认 HashEmbedding 为「零依赖、确定性」实现，仅用于单节点冒烟与端到端演示；
 *   它对关键词重叠敏感（令牌哈希入桶 + L2 归一化），足以验证检索闭环，但不具语义泛化能力。
 * - 真实 embedding 通常是异步的，因此契约同时提供同步 embed() 与可选 embedAsync()。
 */

export interface EmbeddingProvider {
  /** 向量维度。 */
  readonly dim: number;
  /** 同步向量化（演示/本地模型）。 */
  embed(text: string): number[];
  /** 异步向量化（远程 API）。可选；未实现时 ingest 回退到 embed()。 */
  embedAsync?(text: string): Promise<number[]>;
}

const STOP_ZH = new Set([
  '的', '了', '和', '在', '是', '我', '你', '他', '她', '它', '有', '就', '不', '也', '都', '与', '及',
  '对', '到', '会', '能', '要', '这', '那', '一个', '我们', '你们', '他们', '可以', '通过', '使用', '进行',
]);
const STOP_EN = new Set([
  'a', 'an', 'the', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'by', 'at', 'as',
  'this', 'that', 'it', 'we', 'you', 'they', 'can', 'use', 'using', 'via', 'from', 'into',
]);

/** 中英文混合分词：CJK 按二元字串（bigram）切分以保留局部语义，ASCII 按词。 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  // ASCII 词
  const asciiWords = lower.match(/[a-z0-9]+/g) || [];
  for (const w of asciiWords) {
    if (w.length <= 1) continue;
    if (!STOP_EN.has(w)) out.push(w);
  }
  // CJK bigram
  const cjk = lower.match(/[一-龥]+/g) || [];
  for (const seg of cjk) {
    if (STOP_ZH.has(seg)) continue;
    if (seg.length === 1) {
      out.push(seg);
      continue;
    }
    for (let i = 0; i < seg.length - 1; i++) {
      const bg = seg.slice(i, i + 2);
      if (!STOP_ZH.has(bg)) out.push(bg);
    }
  }
  return out;
}

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const norm = Math.sqrt(s) || 1;
  return v.map((x) => x / norm);
}

/** 演示用确定性 embedding：令牌哈希入桶 + L2 归一化。零外部依赖。 */
export class HashEmbedding implements EmbeddingProvider {
  readonly dim: number;
  constructor(dim = 256) {
    this.dim = dim;
  }
  embed(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (const t of tokenize(text)) {
      v[hashStr(t) % this.dim] += 1;
    }
    return l2normalize(v);
  }
}

/**
 * 真实远程 embedding（可选启用）。通过 env 配置：
 *   RAG_EMBEDDING_BASE_URL（默认 https://openrouter.ai/api/v1）
 *   RAG_EMBEDDING_API_KEY
 *   RAG_EMBEDDING_MODEL（默认 text-embedding-3-small 的 OpenRouter 等价模型）
 * 同步 embed() 不可用（远程是异步），调用方应使用 embedAsync()。
 */
export class OpenAIEmbedding implements EmbeddingProvider {
  readonly dim: number;
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private cache = new Map<string, number[]>();

  constructor(opts?: {
    dim?: number;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  }) {
    this.dim = opts?.dim ?? 1536;
    this.baseUrl = (opts?.baseUrl ?? process.env.RAG_EMBEDDING_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.apiKey = opts?.apiKey ?? process.env.RAG_EMBEDDING_API_KEY ?? '';
    this.model = opts?.model ?? process.env.RAG_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  }

  embed(_text: string): number[] {
    throw new Error('OpenAIEmbedding 仅支持异步 embedAsync()；请勿在同步路径调用');
  }

  async embedAsync(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) return cached;
    if (this.apiKey) {
      try {
        const resp = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, input: text }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { data?: { embedding: number[] }[] };
          const vec = data.data?.[0]?.embedding;
          if (vec && vec.length) {
            this.cache.set(text, vec);
            return vec;
          }
        }
      } catch {
        // 落入下方降级
      }
    }
    // 无 key 或调用失败：降级到本地 HashEmbedding，保证检索闭环不中断
    const fallback = new HashEmbedding(this.dim);
    const v = fallback.embed(text);
    this.cache.set(text, v);
    return v;
  }
}

/** 根据 env 构造 embedding 提供方；默认 HashEmbedding。 */
export function createEmbedder(): EmbeddingProvider {
  if ((process.env.RAG_EMBEDDING_API_KEY || '').trim()) {
    return new OpenAIEmbedding();
  }
  return new HashEmbedding(Number(process.env.RAG_EMBED_DIM || 256));
}
