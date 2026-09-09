/**
 * builtin__rag_retrieve — RAG 检索工具
 *
 * 调用独立 RAG 服务进行语义检索，支持 trace_id 透传以实现全链路可观测。
 *
 * 环境变量：
 * - RAG_URL: RAG 服务地址（如 http://localhost:8787），必填
 * - RAG_TOKEN: 鉴权 token（可选）
 * - RAG_TIMEOUT_MS: 超时时间（默认 10000ms）
 */

import { objectParams, ToolRegistry } from '../tools';
import { structLog } from '../telemetry';

export type RagApiStyle = 'local' | 'hermes';

export interface RagRetrieveOptions {
  /** RAG 服务基础地址，从 RAG_URL 环境变量读取 */
  baseUrl?: string;
  /** 鉴权 token，从 RAG_TOKEN 环境变量读取 */
  token?: string;
  /** 超时毫秒数 */
  timeoutMs?: number;
  /**
   * 外部 RAG 契约风格：
   * - local（默认）：调本地 services/rag 的 POST /v1/retrieve（纯检索）。
   * - hermes：调外部 HermesChat RAG 的 POST /api/v1/chat（生成式问答），
   *   取返回的 citations 作为检索片段回灌给 agent（外部服务负责检索+重排）。
   * 可由环境变量 RAG_API_STYLE=hermes 开启。
   */
  apiStyle?: RagApiStyle;
}

function getBaseUrl(opts: RagRetrieveOptions): string {
  return opts.baseUrl ?? process.env.RAG_URL ?? '';
}

function getToken(opts: RagRetrieveOptions): string {
  return opts.token ?? process.env.RAG_TOKEN ?? '';
}

export function registerRagRetrieve(registry: ToolRegistry, opts: RagRetrieveOptions = {}): void {
  const baseUrl = getBaseUrl(opts);
  const token = getToken(opts);
  const timeoutMs = opts.timeoutMs ?? Number(process.env.RAG_TIMEOUT_MS ?? 10000);

  if (!baseUrl) {
    // RAG_URL 未配置时不注册工具，符合「一切降级可用」约定
    structLog('info', 'rag_retrieve not registered: RAG_URL not configured');
    return;
  }

  registry.register(
    'builtin__rag_retrieve',
    'Semantic retrieval from the knowledge base. Use this tool to find relevant documents/FAQs for user questions. ' +
      'Returns ranked chunks with content and similarity scores.',
    objectParams(
      {
        query: { type: 'string', description: 'The search query text.' },
        top_k: { type: 'number', description: 'Number of results to return (default 5).' },
        score_threshold: { type: 'number', description: 'Minimum relevance score (0~1, default 0.3).' },
        trace_id: { type: 'string', description: 'Optional trace ID for observability passthrough.' },
      },
      ['query']
    ),
    async (args: Record<string, unknown>, ctx?: { traceId?: string }) => {
      const query = String(args.query ?? '');
      const topK = Number(args.top_k ?? 5);
      const scoreThreshold = Number(args.score_threshold ?? 0.3);
      // trace_id 优先级：调用方传入 > 参数传入 > 本次 run 的 traceId
      const traceId = String(args.trace_id ?? ctx?.traceId ?? '');

      if (!query) {
        return JSON.stringify({ error: 'query is required' });
      }

      const t0 = Date.now();
      const apiStyle: RagApiStyle =
        opts.apiStyle ?? (process.env.RAG_API_STYLE === 'hermes' ? 'hermes' : 'local');

      // ── 外部 HermesChat RAG：POST /api/v1/chat，取 citations 作为检索片段 ──
      if (apiStyle === 'hermes') {
        const url = `${baseUrl.replace(/\/$/, '')}/api/v1/chat`;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (token) headers['Authorization'] = `Bearer ${token}`;
          if (traceId) headers['X-Trace-Id'] = traceId;

          const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ query, user_tags: ['public'], history: [] }),
            signal: controller.signal,
          });
          clearTimeout(timer);

          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            structLog('warn', 'rag_retrieve(hermes): non-2xx response', { status: resp.status, traceId });
            return JSON.stringify({ error: `RAG service error: ${resp.status}`, details: errText.slice(0, 200) });
          }

          const data = (await resp.json()) as {
            answer?: string;
            citations?: Array<{ chunk_id: string; source?: string; content: string; score: number }>;
            latency_ms?: number;
            trace_id?: string;
          };
          const latencyMs = Date.now() - t0;
          const results = (data.citations ?? [])
            .slice(0, topK)
            .map((c) => ({
              chunk_id: c.chunk_id,
              score: c.score,
              content: c.content,
              metadata: { source: c.source ?? 'external', title: c.source ?? 'external' },
            }));

          structLog('info', 'rag_retrieve(hermes)', {
            query: query.slice(0, 100),
            n: results.length,
            latency_ms: latencyMs,
            trace_id: traceId,
          });

          return JSON.stringify({
            trace_id: traceId,
            n_results: results.length,
            latency_ms: latencyMs,
            generated_answer: data.answer ?? '',
            results,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          structLog('error', 'rag_retrieve(hermes) failed', { error: msg, traceId });
          return JSON.stringify({ error: `RAG retrieval failed: ${msg}` });
        }
      }

      // ── 本地 services/rag：POST /v1/retrieve（默认契约） ──
      const url = `${baseUrl.replace(/\/$/, '')}/v1/retrieve`;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        if (traceId) {
          headers['X-Trace-Id'] = traceId;
        }

        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query,
            top_k: topK,
            score_threshold: scoreThreshold,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          structLog('warn', 'rag_retrieve: non-2xx response', { status: resp.status, traceId });
          return JSON.stringify({ error: `RAG service error: ${resp.status}`, details: errText.slice(0, 200) });
        }

        const data = await resp.json() as { results?: Array<{ chunk_id: string; content: string; score: number; metadata?: Record<string, unknown> }>; trace_id?: string };
        const latencyMs = Date.now() - t0;

        structLog('info', 'rag_retrieve', {
          query: query.slice(0, 100),
          n: data.results?.length ?? 0,
          latency_ms: latencyMs,
          trace_id: data.trace_id ?? traceId,
        });

        return JSON.stringify({
          trace_id: data.trace_id ?? traceId,
          n_results: data.results?.length ?? 0,
          latency_ms: latencyMs,
          results: (data.results ?? []).map((r) => ({
            chunk_id: r.chunk_id,
            score: r.score,
            content: r.content,
            metadata: r.metadata,
          })),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        structLog('error', 'rag_retrieve failed', { error: msg, traceId });
        return JSON.stringify({ error: `RAG retrieval failed: ${msg}` });
      }
    },
    'builtin'
  );
}
