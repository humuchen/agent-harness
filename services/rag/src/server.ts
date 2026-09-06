/**
 * server.ts — 外部 RAG 的 HTTP REST 服务（独立部署单元）。
 *
 * 对外协议（设计文档第 4 节 + P2/P3）：
 *   POST /v1/retrieve        { query, top_k?, score_threshold?, filters?, expand? } -> RetrieveResponse
 *   POST /v1/ingest          { doc_id, title?, text, tags?, metadata? }             -> 202 { accepted, job_id }（异步）| 200 IngestResult（同步）
 *   GET  /v1/ingest/:jobId   异步任务状态
 *   GET  /v1/health          { ok, chunks, dim, cache_size, ingest, metrics }
 *   GET  /v1/metrics         Prometheus 文本格式
 *
 * 安全（设计文档第 8 节「权限隔离」，P1+P2 落地）：
 * - Bearer token 鉴权：RAG_TOKENS="tenantA:secretA" 映射 secret->tenant。
 * - JWT（HS256）鉴权：RAG_JWT_SECRET 配置后启用；令牌 `tenant` 声明即租户（auth.ts）。
 * - tenant_id 服务端强制重写：ingest/retrieve 请求体里的 tenant_id 一律被覆盖，杜绝越权。
 *
 * P2：异步入库队列（RAG_ASYNC_INGEST，默认开）；P3：查询缓存（RAG_CACHE）、
 * 可观测（metrics）、按租户分片持久化（RAG_SHARD_BY_TENANT）。
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { MemoryVectorStore } from './store';
import { createEmbedder, EmbeddingProvider } from './embed';
import { ingestDocument, IngestInput } from './ingest';
import { retrieve, RetrieveRequest, RetrieveResponse } from './retrieve';
import { resolveTenant } from './auth';
import { IngestQueue } from './queue';
import { QueryCache } from './cache';
import { Metrics, logTrace } from './metrics';
import { rerankWithApi, mmrRerank } from './rerank';
import { createRAGEvaluator, type EvalDataset } from './eval';
import { generateAnswer, createLLM, type LLMProvider } from './generate';

export interface RagServerOptions {
  port?: number;
  store?: MemoryVectorStore;
  provider?: EmbeddingProvider;
  /** secret -> tenantId 映射（多租户静态令牌）。 */
  tokens?: Map<string, string>;
  /** 单租户时的默认 tenant（未配 tokens/JWT 时启用，视为可信内网开放）。 */
  defaultTenant?: string;
  dataFile?: string;
  /** JWT（HS256）校验密钥；未配置则仅静态令牌/开放模式。 */
  jwtSecret?: string;
  /** LLM 提供商（生成层）；未传则从 env 构建。 */
  llm?: LLMProvider;
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(buf);
}

export function createRagServer(opts: RagServerOptions) {
  const store = opts.store ?? new MemoryVectorStore(Number(process.env.RAG_EMBED_DIM || 256));
  const shard = (process.env.RAG_SHARD_BY_TENANT || '').toLowerCase() === 'true';
  if (opts.dataFile) store.load(opts.dataFile, shard);
  const provider = opts.provider ?? createEmbedder();
  const tokens = opts.tokens;
  const jwtSecret = opts.jwtSecret ?? process.env.RAG_JWT_SECRET;

  const metrics = new Metrics();
  const cacheEnabled = (process.env.RAG_CACHE || 'true').toLowerCase() !== 'false';
  const cache = new QueryCache();
  const asyncIngest = (process.env.RAG_ASYNC_INGEST || 'true').toLowerCase() !== 'false';
  const queue = new IngestQueue(store, provider, {
    dataFile: opts.dataFile,
    shardByTenant: shard,
    onDone: (job) => metrics.recordIngest(job.status === 'done'),
  });

  // P2: 生成层 LLM 提供商（可选启用）
  const llm = opts.llm ?? createLLM();
  const authOpts = { tokens, defaultTenant: opts.defaultTenant, jwtSecret };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method || 'GET';

      if (path === '/v1/health' && method === 'GET') {
        metrics.setTenantChunks(store.tenantCounts());
        return send(res, 200, {
          ok: true,
          chunks: store.count(),
          dim: store.dim,
          cache_size: cache.size,
          ingest: queue.stats(),
          metrics: metrics.summary(),
        });
      }

      if (path === '/v1/metrics' && method === 'GET') {
        metrics.setTenantChunks(store.tenantCounts());
        const buf = Buffer.from(metrics.toPrometheus(), 'utf8');
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        return res.end(buf);
      }

      if (path === '/v1/retrieve' && method === 'POST') {
        const auth = resolveTenant(req, authOpts);
        if ('error' in auth) return send(res, auth.error, { error: auth.message });
        const body = await readJson(req);
        const rreq: RetrieveRequest = {
          query: String(body.query ?? ''),
          top_k: body.top_k,
          score_threshold: body.score_threshold,
          filters: body.filters,
          tenant_id: auth.tenantId, // 服务端重写
          expand: !!body.expand,
        };
        if (!rreq.query) return send(res, 400, { error: 'query required' });

        const t0 = Date.now();
        const ck = cacheEnabled
          ? cache.key(auth.tenantId, rreq.query, rreq.top_k ?? 5, rreq.score_threshold ?? 0, JSON.stringify(rreq.filters ?? {}))
          : '';
        if (cacheEnabled) {
          const hit = cache.get(ck) as RetrieveResponse | undefined;
          if (hit) {
            metrics.recordRetrieve(Date.now() - t0, true);
            const resp: RetrieveResponse = { ...hit, cache_hit: true, latency_ms: Date.now() - t0 };
            logTrace(resp.trace_id, 'info', 'retrieve (cache hit)', {
              tenant: auth.tenantId,
              n: resp.results.length,
              latency_ms: resp.latency_ms,
            });
            return send(res, 200, resp);
          }
        }

        let resp: RetrieveResponse = { ...retrieve(store, provider, rreq), cache_hit: false };
        // RAG_RERANK=api：真实 cross-encoder 重排（rerank.ts），失败回退 MMR
        const rerankMode = (process.env.RAG_RERANK || 'mmr').toLowerCase();
        if (rerankMode === 'api' && resp.results.length > 1) {
          const rr = await rerankWithApi(rreq.query, resp.results);
          if (rr) {
            resp = { ...resp, results: rr };
          } else {
            const vectorMap = new Map<string, number[]>();
            for (const c of store.getChunks(rreq.tenant_id)) vectorMap.set(c.chunk_id, c.vector);
            resp = { ...resp, results: mmrRerank(resp.results, vectorMap, 0.5) };
          }
        }
        if (cacheEnabled) cache.set(ck, resp);
        metrics.recordRetrieve(Date.now() - t0, false);
        logTrace(resp.trace_id, 'info', 'retrieve', {
          tenant: auth.tenantId,
          n: resp.results.length,
          latency_ms: resp.latency_ms,
          expand: !!rreq.expand,
        });
        return send(res, 200, resp);
      }

      // 异步任务状态查询
      const jobMatch = /^\/v1\/ingest\/([^/]+)$/.exec(path);
      if (jobMatch && method === 'GET') {
        const auth = resolveTenant(req, authOpts);
        if ('error' in auth) return send(res, auth.error, { error: auth.message });
        const job = queue.job(jobMatch[1] ?? '');
        if (!job) return send(res, 404, { error: 'job not found' });
        return send(res, 200, job);
      }

      if (path === '/v1/ingest' && method === 'POST') {
        const auth = resolveTenant(req, authOpts);
        if ('error' in auth) return send(res, auth.error, { error: auth.message });
        const body = await readJson(req);
        const input: IngestInput = {
          doc_id: String(body.doc_id ?? ''),
          tenant_id: auth.tenantId, // 服务端重写
          title: body.title,
          text: String(body.text ?? ''),
          tags: body.tags,
          metadata: body.metadata,
          chunk_size: body.chunk_size,
          chunk_overlap: body.chunk_overlap,
        };
        if (!input.doc_id || !input.text) {
          return send(res, 400, { error: 'doc_id and text required' });
        }

        if (asyncIngest) {
          const job = queue.enqueue(input);
          metrics.recordIngestAccepted();
          logTrace(`rag_job_${job.jobId}`, 'info', 'ingest accepted (async)', {
            tenant: input.tenant_id,
            job_id: job.jobId,
          });
          return send(res, 202, {
            accepted: true,
            job_id: job.jobId,
            doc_id: input.doc_id,
            tenant_id: input.tenant_id,
          });
        }

        const result = await ingestDocument(store, provider, input);
        if (opts.dataFile) store.persist(opts.dataFile, shard);
        metrics.recordIngest(true);
        return send(res, 200, result);
      }

      // RAG 评估端点：POST /v1/eval — 批量评估检索+生成质量
      if (path === '/v1/eval' && method === 'POST') {
        const auth = resolveTenant(req, authOpts);
        if ('error' in auth) return send(res, auth.error, { error: auth.message });
        const body = await readJson(req);
        // dataset 格式：{ name, samples: [{ query, groundTruthChunkIds?, groundTruthAnswer? }] }
        const dataset: EvalDataset = {
          name: String(body.name ?? 'default'),
          samples: Array.isArray(body.samples)
            ? body.samples.map((s: any) => ({
                query: String(s.query ?? ''),
                groundTruthChunkIds: Array.isArray(s.groundTruthChunkIds) ? s.groundTruthChunkIds : undefined,
                groundTruthAnswer: s.groundTruthAnswer ? String(s.groundTruthAnswer) : undefined,
              }))
            : [],
        };
        if (dataset.samples.length === 0) {
          return send(res, 400, { error: 'samples required' });
        }
        try {
          const evaluator = createRAGEvaluator({ k: Number(body.k) || 5 });
          // 将 retrieve 函数包装为 evaluate 所需的 async 形式
          const retrieveFn = async (query: string): Promise<any[]> => {
            const resp = await retrieve(store, provider, {
              query,
              top_k: Number(body.k) || 5,
              tenant_id: auth.tenantId,
            } as any);
            return resp.results ?? [];
          };
          const result = await evaluator.evaluate(dataset, retrieveFn);
          return send(res, 200, result);
        } catch (e: any) {
          return send(res, 500, { error: String(e?.message || e) });
        }
      }

      // P2: 生成层 — POST /v1/generate — 检索 + LLM 生成一体化
      if (path === '/v1/generate' && method === 'POST') {
        const auth = resolveTenant(req, authOpts);
        if ('error' in auth) return send(res, auth.error, { error: auth.message });
        if (!llm) {
          return send(res, 503, {
            error: 'LLM provider 未配置（RAG_LLM_BASE_URL / RAG_LLM_API_KEY / RAG_LLM_MODEL）',
          });
        }
        const body = await readJson(req);
        const query = String(body.query ?? '');
        if (!query) return send(res, 400, { error: 'query required' });

        const t0 = Date.now();
        try {
          const result = await generateAnswer(
            store,
            provider,
            llm,
            {
              query,
              top_k: body.top_k,
              score_threshold: body.score_threshold,
              filters: body.filters,
              tenant_id: auth.tenantId,
              expand: !!body.expand,
            },
            {
              maxTokens: body.max_tokens,
              temperature: body.temperature,
              topK: body.top_k,
              scoreThreshold: body.score_threshold,
            },
          );
          metrics.recordRetrieve(Date.now() - t0, result.cache_hit);
          logTrace(result.trace_id, 'info', 'generate', {
            tenant: auth.tenantId,
            retrieved: result.retrieved,
            latency_ms: result.latency_ms,
          });
          return send(res, 200, result);
        } catch (e: any) {
          return send(res, 500, { error: String(e?.message || e) });
        }
      }

      return send(res, 404, { error: 'not found', path });
    } catch (e: any) {
      return send(res, 500, { error: String(e?.message || e) });
    }
  });

  const port = opts.port ?? Number(process.env.RAG_PORT || 8787);
  return {
    store,
    provider,
    llm,
    metrics,
    queue,
    cache,
    listen: () =>
      new Promise<void>((resolve) =>
        server.listen(port, () => {
          // eslint-disable-next-line no-console
          console.log(`[rag] http listening on :${port}`);
          resolve();
        }),
      ),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    server,
  };
}
