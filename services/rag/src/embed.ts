/**
 * embed.ts — 可插拔文本向量化（Embedding）抽象。
 *
 * 设计要点（对应外部 RAG 设计文档第 4/8 节）：
 * - EmbeddingProvider 是稳定契约，真实部署可替换为 OpenAI / OpenRouter / 本地模型。
 * - 默认 HashEmbedding 为「零依赖、确定性」实现，仅用于单节点冒烟与端到端演示；
 *   它对关键词重叠敏感（令牌哈希入桶 + L2 归一化），足以验证检索闭环，但不具语义泛化能力。
 * - 真实 embedding 通常是异步的，因此契约同时提供同步 embed() 与可选 embedAsync()。
 */

import { createHash } from 'node:crypto';

export interface EmbeddingProvider {
  /** 向量维度。 */
  readonly dim: number;
  /**
   * 模型标识（版本指纹）。写入 chunk 元数据 `embedding_model`，检索时与当前
   * provider 比对，不一致即 fail-fast——模型切换后旧向量语义空间不同，混用会
   * 静默劣化检索质量。HashEmbedding 用 `hash-<dim>` 标识，远程模型用其名称。
   */
  readonly model: string;
  /** 同步向量化（演示/本地模型）。 */
  embed(text: string): number[];
  /** 异步向量化（远程 API）。可选；未实现时 ingest 回退到 embed()。 */
  embedAsync?(text: string): Promise<number[]>;
  /**
   * 批量向量化（增强：ingest 吞吐）。可选；实现方应一次请求携带整批文本，
   * 消除逐条网络往返。失败处置与 embedAsync 同纪律（strict 抛错 / 非 strict 降级不缓存）。
   * 返回顺序与输入一一对应。
   */
  embedBatchAsync?(texts: string[]): Promise<number[][]>;
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
  readonly model: string;
  constructor(dim = 256) {
    this.dim = dim;
    this.model = `hash-${dim}`;
  }
  embed(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (const t of tokenize(text)) {
      const idx = hashStr(t) % this.dim;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    return l2normalize(v);
  }
}

/**
 * P1（嵌入失败毒化防护）：远程嵌入最终失败时抛出。
 *
 * 旧行为：调用失败 → 静默降级哈希向量并写入缓存——降级向量与真实向量同维度混入
 * 语料/缓存，检索质量静默崩塌且无告警；API 抖动恢复后该文本仍永久保持哈希向量
 * （缓存永不自愈）。新行为：重试耗尽后，默认（RAG_EMBED_STRICT!=='false'）抛出
 * 本错误，让 ingest 明确失败（文档不被污染）、检索明确报错（不返回垃圾结果）；
 * 显式关闭 strict 时降级为「本次不缓存 + 告警日志」，杜绝永久毒化。
 */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

/** strict 模式开关：默认开启（secure by default）；RAG_EMBED_STRICT=false 供演示环境降级。 */
function strictEmbedding(): boolean {
  return (process.env.RAG_EMBED_STRICT ?? 'true').trim().toLowerCase() !== 'false';
}

/**
 * 远程嵌入请求超时（毫秒），默认 60s（RAG_EMBED_TIMEOUT_MS 可调）。
 * P1 修复：此前两处 fetch 均未传 AbortSignal——embed-server 挂起（TCP 建连但不响应）
 * 时请求永不返回，并发 4 的 ingest worker 池会被 4 个挂起请求全部耗尽，后续
 * ingest 永久排队。超时后进入既有失败处置（strict 抛错 / 降级），闭环不中断。
 */
const EMBED_TIMEOUT_MS = Number(process.env.RAG_EMBED_TIMEOUT_MS ?? 60_000) || 60_000;

/** 带重试的远程嵌入调用（指数退避：200ms / 400ms），耗尽后把最后一个错误抛给调用方。 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 每实例只告警一次的降级提示（非 strict 模式仍要可见，不能静默）。 */
function warnDegradedOnce(provider: string, text: string): void {
  if (warnDegradedOnce.warned) return;
  warnDegradedOnce.warned = true;
  console.warn(
    `[rag:${provider}] 远程嵌入失败，本次降级哈希向量（不写缓存，不永久毒化语料）。` +
      `采样文本=${text.slice(0, 40)}…；生产建议保持 RAG_EMBED_STRICT 默认开启。`,
  );
}
warnDegradedOnce.warned = false;

/**
 * P1 无界增长修复：嵌入缓存改为容量上限 LRU——旧实现按原文全文为 key 的 Map
 * 永不淘汰，长期运行的 RAG 服务随 ingest 量线性增长（1024 维向量约 8KB/条，
 * 10 万条即 800MB+）。key 改为 sha256(text)（全文键字符串也随缓存常驻内存），
 * 命中时刷新插入序实现真 LRU。
 */
const EMBED_CACHE_MAX_ENTRIES =
  Number(process.env.RAG_EMBED_CACHE_MAX ?? 20_000) || 20_000;

class EmbedCache {
  private map = new Map<string, number[]>();

  static key(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  get(key: string): number[] | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // LRU：命中即刷新插入序。
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, vec: number[]): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, vec);
    while (this.map.size > EMBED_CACHE_MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
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
  readonly model: string;
  private baseUrl: string;
  private apiKey: string;
  private cache = new EmbedCache();

  constructor(opts?: {
    dim?: number;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  }) {
    this.dim = opts?.dim ?? 1536;
    this.model = opts?.model ?? process.env.RAG_EMBEDDING_MODEL ?? 'text-embedding-3-small';
    this.baseUrl = (opts?.baseUrl ?? process.env.RAG_EMBEDDING_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.apiKey = opts?.apiKey ?? process.env.RAG_EMBEDDING_API_KEY ?? '';
  }

  embed(_text: string): number[] {
    throw new Error('OpenAIEmbedding 仅支持异步 embedAsync()；请勿在同步路径调用');
  }

  async embedAsync(text: string): Promise<number[]> {
    const ckey = EmbedCache.key(text);
    const cached = this.cache.get(ckey);
    if (cached) return cached;
    if (this.apiKey) {
      try {
        const resp = await withRetry(() =>
          fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ model: this.model, input: text }),
            signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
          })
        );
        if (resp.ok) {
          const data = (await resp.json()) as { data?: { embedding: number[] }[] };
          const vec = data.data?.[0]?.embedding;
          if (vec && vec.length) {
            this.cache.set(ckey, vec); // 缓存只存真实远程向量（P1）
            return vec;
          }
        }
        // 非 ok 响应也视为失败（进入下方失败处置）
        if (strictEmbedding()) {
          throw new EmbeddingUnavailableError(
            `远程嵌入失败：${this.baseUrl} 返回 HTTP ${resp.status}（模型 ${this.model}）；已重试 3 次`
          );
        }
      } catch (e) {
        if (e instanceof EmbeddingUnavailableError) throw e;
        if (strictEmbedding()) {
          throw new EmbeddingUnavailableError(
            `远程嵌入失败：${e instanceof Error ? e.message : String(e)}（已重试 3 次）`
          );
        }
      }
    }
    // 降级路径（仅 RAG_EMBED_STRICT=false）：不写缓存——API 恢复后同一文本会重走远程，
    // 不会永久停留在哈希向量（P1：缓存只存真实结果）。
    warnDegradedOnce('openai-embedding', text);
    return new HashEmbedding(this.dim).embed(text);
  }

  /**
   * 批量向量化（增强：单次请求携带整批，消除 ingest 逐条网络往返）。
   * OpenAI /embeddings 原生支持 input 数组；按 data[].index 对齐返回顺序。
   * strict 失败抛 EmbeddingUnavailableError（毒化防护，与 embedAsync 同纪律）；
   * 非 strict 失败逐条降级哈希（不写缓存）。内部按 96 条/请求分批，防超时。
   */
  async embedBatchAsync(texts: string[]): Promise<number[][]> {
    const out: number[][] = new Array(texts.length);
    const pending: Array<{ idx: number; text: string }> = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const cached = this.cache.get(EmbedCache.key(text));
      if (cached) out[i] = cached;
      else pending.push({ idx: i, text });
    }
    if (pending.length === 0) return out;
    if (!this.apiKey) {
      // 与 embedAsync 同口径：配置缺失降级（不缓存）。
      for (const p of pending) {
        warnDegradedOnce('openai-embedding', p.text);
        out[p.idx] = new HashEmbedding(this.dim).embed(p.text);
      }
      return out;
    }
    const CHUNK = 96;
    try {
      for (let start = 0; start < pending.length; start += CHUNK) {
        const chunk = pending.slice(start, start + CHUNK);
        const resp = await withRetry(() =>
          fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ model: this.model, input: chunk.map((c) => c.text) }),
            signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
          })
        );
        if (!resp.ok) {
          throw new EmbeddingUnavailableError(
            `远程批量嵌入失败：${this.baseUrl} 返回 HTTP ${resp.status}（模型 ${this.model}）；已重试 3 次`
          );
        }
        const data = (await resp.json()) as { data?: { index?: number; embedding: number[] }[] };
        const arr = data.data ?? [];
        if (arr.length !== chunk.length) {
          throw new EmbeddingUnavailableError(
            `远程批量嵌入返回数量不匹配：期望 ${chunk.length}，实际 ${arr.length}`
          );
        }
        // 按 index 对齐（OpenAI 批量响应带 index；缺省按顺序；越界防护取回本批内）。
        arr.forEach((d, i) => {
          const vec = d.embedding;
          if (!vec?.length) {
            throw new EmbeddingUnavailableError(`远程批量嵌入第 ${d.index ?? i} 条返回空向量`);
          }
          if (vec.length !== this.dim) {
            throw new EmbeddingUnavailableError(
              `向量维度不匹配：期望 ${this.dim}，远程返回 ${vec.length}`
            );
          }
          const pos = Math.min(Math.max(d.index ?? i, 0), chunk.length - 1);
          const target = chunk[pos]!;
          out[target.idx] = vec;
          this.cache.set(EmbedCache.key(target.text), vec); // 缓存只存真实远程向量（P1）
        });
      }
      return out;
    } catch (e) {
      if (e instanceof EmbeddingUnavailableError) throw e;
      if (strictEmbedding()) {
        throw new EmbeddingUnavailableError(
          `远程批量嵌入失败：${e instanceof Error ? e.message : String(e)}（已重试 3 次）`
        );
      }
      for (const p of pending) {
        warnDegradedOnce('openai-embedding', p.text);
        out[p.idx] = new HashEmbedding(this.dim).embed(p.text);
      }
      return out;
    }
  }
}

/**
 * 远程 embedding 提供商 — 对接外部 embed-server / embed API。
 *
 * 与 OpenAIEmbedding 不同，本类适配「自定义 embed-server」的 API 格式：
 *   POST {baseUrl}/embeddings  { texts: string[] }  →  { embeddings: number[][] }
 * （例如外部 Docker RAG 栈的 embed-server，或任何 OpenAI-不兼容的嵌入服务。）
 *
 * 通过 env 配置：
 *   RAG_EMBEDDING_ENDPOINT_URL  embed API 地址（如 http://host.docker.internal:8001/embeddings）
 *   RAG_EMBED_DIM              向量维度（BGE-M3 默认 1024，必须与 embed-server 一致）
 *
 * 同步 embed() 不可用（远程是异步），调用方应使用 embedAsync()。
 * retrieve() 已升级为 async，以支持远程 embedding。
 */
export class RemoteEmbedding implements EmbeddingProvider {
  readonly dim: number;
  readonly model: string;
  private baseUrl: string;
  private apiKey: string;
  private cache = new EmbedCache();

  constructor(opts?: {
    dim?: number;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  }) {
    this.dim = opts?.dim ?? Number(process.env.RAG_EMBED_DIM || 1024);
    // 模型标识：显式传入 > RAG_EMBEDDING_MODEL > 端点推导。用于 chunk 模型版本戳与检索守卫。
    this.model =
      opts?.model ??
      process.env.RAG_EMBEDDING_MODEL ??
      `remote-embed-${this.dim}`;
    this.baseUrl = (opts?.baseUrl ?? process.env.RAG_EMBEDDING_ENDPOINT_URL ?? '').replace(/\/+$/, '');
    this.apiKey = opts?.apiKey ?? process.env.RAG_EMBEDDING_API_KEY ?? '';
  }

  embed(_text: string): number[] {
    throw new Error('RemoteEmbedding 仅支持异步 embedAsync()；请勿在同步路径调用');
  }

  async embedAsync(text: string): Promise<number[]> {
    const ckey = EmbedCache.key(text);
    const cached = this.cache.get(ckey);
    if (cached) return cached;
    if (!this.baseUrl) {
      // 配置缺失属确定性错误：降级但不缓存（配置修复后立即生效），并保持告警可见。
      warnDegradedOnce('remote-embedding', text);
      return new HashEmbedding(this.dim).embed(text);
    }
    try {
      const resp = await withRetry(() =>
        fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ texts: [text] }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        })
      );
      if (resp.ok) {
        const data = (await resp.json()) as { embeddings?: number[][] };
        const vec = data.embeddings?.[0];
        if (vec && vec.length === this.dim) {
          this.cache.set(ckey, vec); // 缓存只存真实远程向量（P1）
          return vec;
        }
        if (vec && vec.length !== this.dim) {
          // 维度不匹配 = 配置错误，混入语料即毒化：strict 下明确失败。
          if (strictEmbedding()) {
            throw new EmbeddingUnavailableError(
              `向量维度不匹配：期望 ${this.dim}，远程返回 ${vec.length}（检查 RAG_EMBED_DIM 与 embed-server 配置）`
            );
          }
          warnDegradedOnce('remote-embedding', text);
          return new HashEmbedding(this.dim).embed(text);
        }
      }
      // 非 ok 响应 → 失败处置
      if (strictEmbedding()) {
        throw new EmbeddingUnavailableError(
          `远程嵌入失败：${this.baseUrl} 返回 HTTP ${resp.status}；已重试 3 次`
        );
      }
    } catch (e) {
      if (e instanceof EmbeddingUnavailableError) throw e;
      if (strictEmbedding()) {
        throw new EmbeddingUnavailableError(
          `远程嵌入失败：${e instanceof Error ? e.message : String(e)}（已重试 3 次）`
        );
      }
    }
    // 降级路径（仅 RAG_EMBED_STRICT=false）：不写缓存，杜绝永久毒化（P1）。
    warnDegradedOnce('remote-embedding', text);
    return new HashEmbedding(this.dim).embed(text);
  }

  /**
   * 批量向量化（增强）：embed-server 契约天然批量 —— POST { texts: string[] } →
   * { embeddings: number[][] }。strict 失败抛 EmbeddingUnavailableError；
   * 非 strict 降级哈希（不缓存）。内部按 64 条/请求分批。
   */
  async embedBatchAsync(texts: string[]): Promise<number[][]> {
    const out: number[][] = new Array(texts.length);
    const pending: Array<{ idx: number; text: string }> = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const cached = this.cache.get(EmbedCache.key(text));
      if (cached) out[i] = cached;
      else pending.push({ idx: i, text });
    }
    if (pending.length === 0) return out;
    if (!this.baseUrl) {
      for (const p of pending) {
        warnDegradedOnce('remote-embedding', p.text);
        out[p.idx] = new HashEmbedding(this.dim).embed(p.text);
      }
      return out;
    }
    const CHUNK = 64;
    try {
      for (let start = 0; start < pending.length; start += CHUNK) {
        const chunk = pending.slice(start, start + CHUNK);
        const resp = await withRetry(() =>
          fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
            },
            body: JSON.stringify({ texts: chunk.map((c) => c.text) }),
            signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
          })
        );
        if (!resp.ok) {
          throw new EmbeddingUnavailableError(
            `远程批量嵌入失败：${this.baseUrl} 返回 HTTP ${resp.status}；已重试 3 次`
          );
        }
        const data = (await resp.json()) as { embeddings?: number[][] };
        const arr = data.embeddings ?? [];
        if (arr.length !== chunk.length) {
          throw new EmbeddingUnavailableError(
            `远程批量嵌入返回数量不匹配：期望 ${chunk.length}，实际 ${arr.length}`
          );
        }
        arr.forEach((vec, i) => {
          const item = chunk[i]!;
          if (!vec?.length) {
            throw new EmbeddingUnavailableError(`远程批量嵌入第 ${i} 条返回空向量`);
          }
          if (vec.length !== this.dim) {
            throw new EmbeddingUnavailableError(
              `向量维度不匹配：期望 ${this.dim}，远程返回 ${vec.length}`
            );
          }
          out[item.idx] = vec;
          this.cache.set(EmbedCache.key(item.text), vec); // 缓存只存真实远程向量（P1）
        });
      }
      return out;
    } catch (e) {
      if (e instanceof EmbeddingUnavailableError) throw e;
      if (strictEmbedding()) {
        throw new EmbeddingUnavailableError(
          `远程批量嵌入失败：${e instanceof Error ? e.message : String(e)}（已重试 3 次）`
        );
      }
      for (const p of pending) {
        warnDegradedOnce('remote-embedding', p.text);
        out[p.idx] = new HashEmbedding(this.dim).embed(p.text);
      }
      return out;
    }
  }
}

/**
 * embedding 失败回退（embedding 模型管理）：主 provider 不可用时自动切换到备 provider，
 * 避免单一远程嵌入服务故障导致整条入库/检索链路中断。
 *
 * 触发条件：主 provider 抛出 `EmbeddingUnavailableError`（strict 模式下远程重试耗尽的
 * 规范失败信号）。非 strict 模式主 provider 会内部降级哈希而不抛错，故不触发回退
 * （降级与回退是两种不同的可用性策略，互不叠加）。
 *
 * 语义空间约束：`model`/`dim` 取主 provider（逻辑模型身份）。备 provider 必须服务于
 * **同一模型**（HA 主备同模型镜像），否则回退产出的向量与主空间不可比——混用会触发
 * retrieve 的模型版本守卫。构造时校验 dim 一致（不一致即配置错误，fail-fast）。
 */
export class FallbackEmbedding implements EmbeddingProvider {
  readonly dim: number;
  readonly model: string;
  private primary: EmbeddingProvider;
  private fallback: EmbeddingProvider;

  constructor(primary: EmbeddingProvider, fallback: EmbeddingProvider) {
    if (primary.dim !== fallback.dim) {
      throw new Error(
        `[rag] FallbackEmbedding 维度不一致：主=${primary.dim}，备=${fallback.dim}；` +
          `回退链要求主备同模型同维度（否则向量语义空间不可比）`
      );
    }
    this.primary = primary;
    this.fallback = fallback;
    this.dim = primary.dim;
    this.model = primary.model;
  }

  embed(text: string): number[] {
    try {
      return this.primary.embed(text);
    } catch (e) {
      if (e instanceof EmbeddingUnavailableError) return this.fallback.embed(text);
      throw e;
    }
  }

  async embedAsync(text: string): Promise<number[]> {
    try {
      if (this.primary.embedAsync) return await this.primary.embedAsync(text);
      return this.primary.embed(text);
    } catch (e) {
      if (e instanceof EmbeddingUnavailableError) {
        if (this.fallback.embedAsync) return await this.fallback.embedAsync(text);
        return this.fallback.embed(text);
      }
      throw e;
    }
  }

  async embedBatchAsync(texts: string[]): Promise<number[][]> {
    try {
      if (this.primary.embedBatchAsync) return await this.primary.embedBatchAsync(texts);
      // 主无批量：逐条走主 embedAsync（批量契约对主不适用时退化为逐条）。
      return await Promise.all(texts.map((t) => this.embedAsync(t)));
    } catch (e) {
      if (e instanceof EmbeddingUnavailableError) {
        if (this.fallback.embedBatchAsync) return await this.fallback.embedBatchAsync(texts);
        return await Promise.all(texts.map((t) => this.embedAsync(t)));
      }
      throw e;
    }
  }
}

/** 根据 env 构造 embedding 提提供方；默认 HashEmbedding。 */
export function createEmbedder(): EmbeddingProvider {
  const endpointUrl = (process.env.RAG_EMBEDDING_ENDPOINT_URL || '').trim();
  const fallbackUrl = (process.env.RAG_EMBEDDING_FALLBACK_ENDPOINT_URL || '').trim();
  if (endpointUrl) {
    const primary = new RemoteEmbedding({ baseUrl: endpointUrl });
    // embedding 失败回退：配置备端点时构造回退链（主远程 → 备远程）。
    if (fallbackUrl) {
      return new FallbackEmbedding(primary, new RemoteEmbedding({ baseUrl: fallbackUrl }));
    }
    return primary;
  }
  if ((process.env.RAG_EMBEDDING_API_KEY || '').trim()) {
    return new OpenAIEmbedding();
  }
  return new HashEmbedding(Number(process.env.RAG_EMBED_DIM || 256));
}
