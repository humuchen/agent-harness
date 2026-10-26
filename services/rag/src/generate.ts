/**
 * generate.ts — RAG 生成层（P1+P2）：检索 → LLM 生成 → 带引文回复。
 *
 * 职责：RAG 检索结果融入 LLM 生成，对外提供「检索+生成」一站式接口。
 * - 检索由 retrieve() 完成，将 results[] 作为上下文注入。
 * - 可插拔 LLM provider：默认通过 env 配置 RAG_LLM_BASE_URL + RAG_LLM_API_KEY +
 *   RAG_LLM_MODEL 接入 OpenAI 兼容接口（OpenRouter / 百度千帆 / 阿里百灵等）。
 * - 引用规范：[n] 标注 results[n] 的 chunk_id，最终回复末尾附来源清单。
 * - fail-closed：检索为空或 LLM 失败时，明确告知「数据库无相关来源」，
 *   绝不伪造引用或编造答案。
 *
 * 对应设计文档第 6 节「检索内容融入生成流程」。
 */

import { retrieve, RetrieveRequest, RetrieveResponse } from './retrieve';
import type { VectorStore } from './store';
import { EmbeddingProvider } from './embed';
import { Metrics } from './metrics';

/**
 * 生成结果。answer 携带 [n] 引用标记；sources 是去重来源清单。
 */
export interface GenerateResult {
  /** LLM 生成的回答（含 [n] 引用）。 */
  answer: string;
  /** trace_id，联动检索。 */
  trace_id: string;
  /** 检索命中的 chunk 数。 */
  retrieved: number;
  /** 来源清单：去重后的 { chunk_id, doc_id, title, content }。 */
  sources: Array<{
    chunk_id: string;
    doc_id: string;
    title?: string;
    content: string;
    score: number;
  }>;
  /** 检索是否命中缓存。 */
  cache_hit: boolean;
  /** 总耗时（ms）：检索 + 生成。 */
  latency_ms: number;
}

export interface GenerateOptions {
  /** 最大生成 tokens。 */
  maxTokens?: number;
  /** 温度。 */
  temperature?: number;
  /** 检索参数。 */
  topK?: number;
  /** 置信度门控：检索最高分低于此值时，提示 LLM「知识库无相关权威来源」。 */
  scoreThreshold?: number;
}

/** LLM 提供商接口。 */
export interface LLMProvider {
  /**
   * 发送聊天消息，返回生成文本。
   * @param messages 聊天消息数组
   * @param opts 生成参数
   * @returns 生成文本
   */
  chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<string>;
  /**
   * 流式生成（增强：SSE 增量）。可选；未实现时流式端点回退 chat() 一次性输出。
   * onDelta 逐增量回调（完整拼接结果由返回值给出，二者内容一致）。
   */
  chatStream?(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts: { maxTokens?: number; temperature?: number },
    onDelta: (delta: string) => void,
  ): Promise<string>;
}

/**
 * OpenAI 兼容 LLM 提供商（OpenRouter / 百度千帆 / 阿里百灵等）。
 * 通过 env 配置：RAG_LLM_BASE_URL / RAG_LLM_API_KEY / RAG_LLM_MODEL。
 */
export class OpenAIProvider implements LLMProvider {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;

  constructor(opts?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  }) {
    this.baseUrl = (
      opts?.baseUrl ??
      process.env.RAG_LLM_BASE_URL ??
      'https://openrouter.ai/api/v1'
    ).replace(/\/+$/, '');
    this.apiKey = opts?.apiKey ?? process.env.RAG_LLM_API_KEY ?? '';
    this.model = opts?.model ?? process.env.RAG_LLM_MODEL ?? 'anthropic/claude-3.5-haiku';
  }

  async chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('LLM API key 未配置（RAG_LLM_API_KEY）');
    }
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts?.maxTokens ?? 512,
        temperature: opts?.temperature ?? 0.3,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LLM 请求失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? '';
  }

  /**
   * 流式生成（增强）：stream=true 的 OpenAI 兼容 SSE —— 逐 `data:` 行解析
   * choices[0].delta.content，`data: [DONE]` 结束。返回完整拼接文本（与增量一致）。
   */
  async chatStream(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts: { maxTokens?: number; temperature?: number },
    onDelta: (delta: string) => void,
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('LLM API key 未配置（RAG_LLM_API_KEY）');
    }
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.3,
        stream: true,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LLM 请求失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const body = resp.body;
    if (!body) throw new Error('LLM 流式响应无 body');
    const reader = (body as unknown as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    let done = false;
    while (!done) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      // SSE 按 \n\n 分帧；逐帧提取 data: 行。
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            done = true;
            continue;
          }
          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              onDelta(delta);
            }
          } catch {
            /* 非 JSON 帧（心跳/注释）跳过 */
          }
        }
        if (done) break;
      }
    }
    return full;
  }
}

/** 构造 LLM 提供商（env 配置优先）。 */
export function createLLM(): LLMProvider | null {
  const baseUrl = (process.env.RAG_LLM_BASE_URL ?? '').trim();
  const apiKey = (process.env.RAG_LLM_API_KEY ?? '').trim();
  if (!baseUrl || !apiKey) return null;
  return new OpenAIProvider();
}

/**
 * 构建 system prompt：约定引用格式 + 幻觉防控。
 */
function buildSystemPrompt(): string {
  return [
    '你是企业知识库问答助手。请严格依据【知识库片段】回答用户问题。',
    '回答时在相关处用 [n] 引用对应片段（n 从 1 开始），并在回答末尾附来源清单。',
    '如果知识库片段无法支持你的回答，请明确告知「我不清楚，知识库中没有相关权威来源」，不要编造。',
    '来源格式：\n[1] 文档名（页码/章节，如无则省略）：片段摘要\n[2] ...',
  ].join('\n');
}

/**
 * 构建用户消息：检索上下文 + 问题。
 */
function buildUserMessage(query: string, ctx: RetrieveResponse): string {
  const parts: string[] = ['【知识库片段】\n'];
  ctx.results.forEach((r, i) => {
    const title = r.title ?? r.doc_id;
    parts.push(`[${i + 1}] ${title}: ${r.content.trim()}\n`);
  });
  if (ctx.results.length === 0) {
    parts.push('（知识库中没有检索到相关内容）\n');
  }
  parts.push(`\n用户问题：${query}\n`);
  parts.push(
    '请结合上述片段，用 [n] 引用来源，用简洁专业的语言答复。若无相关片段，请如实说明。',
  );
  return parts.join('');
}

/**
 * RAG 生成：检索 → LLM 生成 → 带引文回复。
 *
 * @param store 向量存储
 * @param provider embedding 提供商
 * @param llm LLM 提供商
 * @param req 检索请求（query / top_k / filters / tenant_id 等）
 * @param opts 生成选项
 */
export async function generateAnswer(
  store: VectorStore,
  provider: EmbeddingProvider,
  llm: LLMProvider,
  req: RetrieveRequest & { query: string },
  opts?: GenerateOptions,
): Promise<GenerateResult> {
  const t0 = Date.now();
  const topK = opts?.topK ?? req.top_k ?? 5;
  const scoreThreshold = opts?.scoreThreshold ?? 0;

  // 1) 检索
  const ctx = await retrieve(store, provider, {
    ...req,
    top_k: topK,
    score_threshold: scoreThreshold,
  });

  // 2) 构建上下文
  const ctxMsg = buildUserMessage(req.query, ctx);
  const sources = ctx.results.map((r, i) => ({
    chunk_id: r.chunk_id,
    doc_id: r.doc_id,
    title: r.title,
    content: r.content,
    score: r.score,
  }));

  // 3) LLM 生成
  let answer: string;
  try {
    answer = await llm.chat(
      [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: ctxMsg },
      ],
      {
        maxTokens: opts?.maxTokens,
        temperature: opts?.temperature,
      },
    );
  } catch (e: any) {
    // fail-closed：LLM 失败时明确告知，绝不伪造
    answer = `知识库检索到 ${ctx.results.length} 条相关片段，但生成服务暂时不可用（${e?.message ?? '未知错误'}）。\n\n检索到的参考：\n${sources.map((s, i) => `[${i + 1}] ${s.content}`).join('\n')}`;
  }

  return {
    answer,
    trace_id: ctx.trace_id,
    retrieved: ctx.results.length,
    sources,
    cache_hit: ctx.cache_hit ?? false,
    latency_ms: Date.now() - t0,
  };
}

/** 流式事件（SSE 单通道 data 帧，按 type 区分）。 */
export type GenerateStreamEvent =
  | {
      type: 'sources';
      sources: GenerateResult['sources'];
      retrieved: number;
      trace_id: string;
      cache_hit: boolean;
    }
  | { type: 'delta'; text: string }
  | { type: 'error'; message: string }
  | {
      type: 'done';
      answer: string;
      trace_id: string;
      retrieved: number;
      sources: GenerateResult['sources'];
      latency_ms: number;
    };

/**
 * RAG 流式生成（增强）：检索 →（先发 sources 事件）→ LLM 流式增量（delta 事件）
 * → done 事件（完整结果）。fail-closed 与 generateAnswer 同口径：LLM 失败发
 * error 事件并以兜底文案作为 answer（绝不伪造引用）。无流式能力的 LLM provider
 * 自动回退一次性 chat()（整段作为单个 delta 发出，对客户端透明）。
 */
export async function generateAnswerStream(
  store: VectorStore,
  provider: EmbeddingProvider,
  llm: LLMProvider,
  req: RetrieveRequest & { query: string },
  opts: GenerateOptions | undefined,
  onEvent: (e: GenerateStreamEvent) => void,
): Promise<GenerateResult> {
  const t0 = Date.now();
  const topK = opts?.topK ?? req.top_k ?? 5;
  const scoreThreshold = opts?.scoreThreshold ?? 0;
  const ctx = await retrieve(store, provider, { ...req, top_k: topK, score_threshold: scoreThreshold });
  const ctxMsg = buildUserMessage(req.query, ctx);
  const sources = ctx.results.map((r) => ({
    chunk_id: r.chunk_id,
    doc_id: r.doc_id,
    title: r.title,
    content: r.content,
    score: r.score,
  }));
  onEvent({
    type: 'sources',
    sources,
    retrieved: ctx.results.length,
    trace_id: ctx.trace_id,
    cache_hit: ctx.cache_hit ?? false,
  });
  const messages = [
    { role: 'system' as const, content: buildSystemPrompt() },
    { role: 'user' as const, content: ctxMsg },
  ];
  const genOpts = { maxTokens: opts?.maxTokens, temperature: opts?.temperature };
  let answer: string;
  try {
    if (typeof llm.chatStream === 'function') {
      answer = await llm.chatStream(messages, genOpts, (delta) => onEvent({ type: 'delta', text: delta }));
    } else {
      answer = await llm.chat(messages, genOpts);
      onEvent({ type: 'delta', text: answer });
    }
  } catch (e: any) {
    // fail-closed：明确告知，绝不伪造。
    const fallback = `知识库检索到 ${ctx.results.length} 条相关片段，但生成服务暂时不可用（${e?.message ?? '未知错误'}）。\n\n检索到的参考：\n${sources.map((s, i) => `[${i + 1}] ${s.content}`).join('\n')}`;
    onEvent({ type: 'error', message: e?.message ?? String(e) });
    onEvent({ type: 'delta', text: fallback });
    answer = fallback;
  }
  return {
    answer,
    trace_id: ctx.trace_id,
    retrieved: ctx.results.length,
    sources,
    cache_hit: ctx.cache_hit ?? false,
    latency_ms: Date.now() - t0,
  };
}
