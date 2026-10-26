/**
 * server.ts — 外部 RAG 的 HTTP REST 服务（独立部署单元）。
 *
 * 对外协议（设计文档第 4 节 + P2/P3 + 短中期增量）：
 *   POST /v1/retrieve        { query, top_k?, score_threshold?, filters?, expand?, acl_principals? } -> RetrieveResponse
 *   POST /v1/ingest          { doc_id, title?, text, tags?, metadata?, acl? }                        -> 202 { accepted, job_id }（异步）| 200 IngestResult（同步）
 *   GET  /v1/ingest/:jobId   异步任务状态
 *   GET  /v1/documents       租户内文档列表（中期：文档管理 API）
 *   DELETE /v1/documents/:docId  删除整篇文档（中期：文档管理 API）
 *   GET  /v1/health          { ok, chunks, dim, cache_size, ingest, metrics }
 *   GET  /v1/metrics         Prometheus 文本格式
 *
 * 安全（设计文档第 8 节「权限隔离」，P1+P2 落地）：
 * - Bearer token 鉴权：RAG_TOKENS="tenantA:secretA" 映射 secret->tenant。
 * - JWT（HS256）鉴权：RAG_JWT_SECRET 配置后启用；令牌 `tenant` 声明即租户（auth.ts）。
 * - tenant_id 服务端强制重写：ingest/retrieve 请求体里的 tenant_id 一律被覆盖，杜绝越权。
 *
 * 可观测（短期修复）：
 * - trace 透传：X-Trace-Id 请求头（或 body.trace_id）全程复用，此前 /v1/retrieve 不读头，
 *   builtin__rag_retrieve 发送的头被丢弃，跨服务 trace 实际断裂。
 *
 * 一致性（短期修复）：
 * - ingest 成功（同步/异步任务完成）后按租户失效查询缓存，消除 TTL 窗口内旧结果脏读。
 *
 * P2：异步入库队列（RAG_ASYNC_INGEST，默认开）；P3：查询缓存（RAG_CACHE）、
 * 可观测（metrics）、按租户分片持久化（RAG_SHARD_BY_TENANT）。
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createVectorStore, type VectorStore } from './store';
import { createEmbedder, EmbeddingProvider } from './embed';
import { ingestDocument, ingestStructured, IngestInput, StructuredIngestInput } from './ingest';
import { multiQueryRetrieve, hydeRetrieve } from './advanced-retrieval';
import { retrieve, RetrieveRequest, RetrieveResponse } from './retrieve';
import { resolveTenant } from './auth';
import { IngestQueue } from './queue';
import { QueryCache } from './cache';
import { Metrics, logTrace } from './metrics';
import { rerankWithApi, mmrRerank } from './rerank';
import { createRAGEvaluator, type EvalDataset } from './eval';
import { generateAnswer, generateAnswerStream, createLLM, type LLMProvider } from './generate';

export interface RagServerOptions {
  port?: number;
  store?: VectorStore;
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
    let total = 0;
    let aborted = false;
    // P1 资源修复：请求体无上限累积——单条请求可携带数百 MB 文本，经
    // JSON.stringify/splitter 多次复制放大内存（容器 limit 仅 512Mi，极易 OOM）。
    const maxBytes =
      Number(process.env.RAG_MAX_BODY_BYTES ?? 10_485_760) || 10_485_760;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      total += c.byteLength;
      if (total > maxBytes) {
        aborted = true;
        try { req.destroy(); } catch { /* 已断开则忽略 */ }
        reject(new Error('request body too large'));
        return;
      }
      body += c;
    });
    req.on('end', () => {
      if (aborted) return;
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
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

/**
 * 短期（trace 透传修复）：提取外部 trace_id —— 优先 X-Trace-Id 请求头
 * （builtin__rag_retrieve / access 层透传的主通道），兼容 body.trace_id。
 * 截断 128 字符防头注入滥用；无效则返回 undefined（retrieve 侧生成新 id）。
 */
function incomingTraceId(req: IncomingMessage, body: Record<string, unknown> | undefined): string | undefined {
  const h = req.headers['x-trace-id'];
  const raw = (Array.isArray(h) ? h[0] : h) || (typeof body?.trace_id === 'string' ? body.trace_id : '');
  const t = typeof raw === 'string' ? raw.trim() : '';
  return t ? t.slice(0, 128) : undefined;
}

export function createRagServer(opts: RagServerOptions) {
  // P6-B：存储后端可插拔（RAG_STORE_BACKEND=memory|qdrant，缺省 memory 存量行为不变）。
  const store = opts.store ?? createVectorStore(Number(process.env.RAG_EMBED_DIM || 256));
  const shard = (process.env.RAG_SHARD_BY_TENANT || '').toLowerCase() === 'true';
  if (opts.dataFile) store.load?.(opts.dataFile, shard);
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
    // 短期（缓存失效联动）：异步任务完成后按租户失效查询缓存（失败任务不动缓存）。
    onDone: (job) => {
      metrics.recordIngest(job.status === 'done');
      if (job.status === 'done' && cacheEnabled) cache.invalidateTenant(job.tenant_id);
    },
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
        // P1 修复：per-tenant 语料明细（租户 id + chunk 数）默认不暴露给匿名
        // 探测；RAG_EXPOSE_TENANT_METRICS=true 显式开启（内网监控需要时）。
        if ((process.env.RAG_EXPOSE_TENANT_METRICS || '').toLowerCase() === 'true') {
          metrics.setTenantChunks(store.tenantCounts?.() ?? {});
        }
        return send(res, 200, {
          ok: true,
          chunks: await store.count(),
          dim: store.dim,
          cache_size: cache.size,
          ingest: queue.stats(),
          metrics: metrics.summary(),
        });
      }

      if (path === '/v1/metrics' && method === 'GET') {
        if ((process.env.RAG_EXPOSE_TENANT_METRICS || '').toLowerCase() === 'true') {
          metrics.setTenantChunks(store.tenantCounts?.() ?? {});
        }
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
          parent: !!body.parent, // P6-B 方案二二期：ParentDocument 父块展开
          acl_principals: Array.isArray(body.acl_principals)
            ? body.acl_principals.map(String) // 长期首片：文档级 ACL
            : undefined,
          trace_id: incomingTraceId(req, body), // 短期：trace 透传修复
        };
        if (!rreq.query) return send(res, 400, { error: 'query required' });

        const t0 = Date.now();
        const ck = cacheEnabled
          ? cache.key(
              auth.tenantId,
              rreq.query,
              rreq.top_k ?? 5,
              rreq.score_threshold ?? 0,
              // 长期首片：acl_principals 参与缓存键 —— 不同 principal 的可见集不同，
              // 共用条目会造成「受限文档泄漏给无权限方」或反之的假阴性。
              JSON.stringify(rreq.filters ?? {}) + '|' + JSON.stringify(rreq.acl_principals ?? []),
            )
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

        // P6-B 方案二二期：高级检索分派（body.mode: multi-query | hyde；需已配置 LLM，
        // 未配置时静默回落普通检索——高级检索是增强能力非必需）。
        const mode = String(body.mode ?? '').toLowerCase();
        let resp: RetrieveResponse;
        if (mode === 'multi-query' && llm) {
          resp = { ...(await multiQueryRetrieve(store, provider, llm, rreq)), cache_hit: false };
        } else if (mode === 'hyde' && llm) {
          resp = { ...(await hydeRetrieve(store, provider, llm, rreq)), cache_hit: false };
        } else {
          resp = { ...(await retrieve(store, provider, rreq)), cache_hit: false };
        }
        // RAG_RERANK=api：真实 cross-encoder 重排（rerank.ts），失败回退 MMR
        const rerankMode = (process.env.RAG_RERANK || 'mmr').toLowerCase();
        if (rerankMode === 'api' && resp.results.length > 1) {
          const rr = await rerankWithApi(rreq.query, resp.results);
          if (rr) {
            resp = { ...resp, results: rr };
          } else {
            const vectorMap = new Map<string, number[]>();
            if (store.hybridCapable) {
              for (const c of await store.getChunks(rreq.tenant_id))
                vectorMap.set(c.chunk_id, c.vector);
            }
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
        // P1 IDOR 修复：job_id 为时间戳+序号（可预测），不校验租户时租户 A 可探测
        // 租户 B 的入库任务状态 / doc_id / 错误信息。归属不符按 404 处理。
        if (!job || job.tenant_id !== auth.tenantId) {
          return send(res, 404, { error: 'job not found' });
        }
        return send(res, 200, job);
      }

      if (path === '/v1/ingest' && method === 'POST') {
        const auth = resolveTenant(req, authOpts);
        if ('error' in auth) return send(res, auth.error, { error: auth.message });
        const body = await readJson(req);
        // P6-B（方案二一期）：结构化入库 —— body.source（{type, value}）存在时走
        // loadDocument + splitAuto（结构感知切分，heading_path 进 metadata）；
        // 缺省仍为纯文本 + 固定滑窗（存量零回归）。source 与 text 二选一。
        const sourceBranch =
          body.source && typeof body.source === 'object' && body.source.type && body.source.value != null;
        const input: IngestInput = {
          doc_id: String(body.doc_id ?? ''),
          tenant_id: auth.tenantId, // 服务端重写
          title: body.title,
          text: sourceBranch ? '' : String(body.text ?? ''),
          tags: body.tags,
          metadata: body.metadata,
          acl: Array.isArray(body.acl) ? body.acl.map(String) : undefined, // 长期首片：文档级 ACL
          chunk_size: body.chunk_size,
          chunk_overlap: body.chunk_overlap,
        };
        if (!input.doc_id || (!sourceBranch && !input.text)) {
          return send(res, 400, { error: 'doc_id and (text or source) required' });
        }

        // 结构化入库强制同步（loader 可能走外部服务，失败需同步反馈调用方；
        // 不进异步队列 —— 队列复用 IngestInput，source 分支的 text 为空会在 worker 里产出 0 chunk）。
        if (sourceBranch) {
          try {
            const result = await ingestStructured(store, provider, {
              ...input,
              text: undefined as unknown as string,
              source: body.source,
              max_len: body.max_len,
            } as unknown as StructuredIngestInput);
            if (opts.dataFile) store.persist?.(opts.dataFile, shard);
            if (cacheEnabled) cache.invalidateTenant(auth.tenantId); // 短期：缓存失效联动
            metrics.recordIngest(true);
            return send(res, 200, result);
          } catch (e) {
            metrics.recordIngest(false);
            return send(res, 400, {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        if (asyncIngest) {
          const job = queue.enqueue(input);
          metrics.recordIngestAccepted();
          logTrace(incomingTraceId(req, body) ?? `rag_job_${job.jobId}`, 'info', 'ingest accepted (async)', {
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
        if (opts.dataFile) store.persist?.(opts.dataFile, shard);
        if (cacheEnabled) cache.invalidateTenant(auth.tenantId); // 短期：缓存失效联动
        metrics.recordIngest(true);
        return send(res, 200, result);
      }

      // 中期（文档管理 API）：GET /v1/documents — 租户内文档列表
      if (path === '/v1/documents' && method === 'GET') {
        const auth = resolveTenant(req, authOpts);
        if ('error' in auth) return send(res, auth.error, { error: auth.message });
        if (typeof store.listDocs !== 'function') {
          return send(res, 501, { error: '当前存储后端不支持文档列表（listDocs 未实现）' });
        }
        const docs = await store.listDocs(auth.tenantId);
        return send(res, 200, { tenant_id: auth.tenantId, docs });
      }

      // 中期（文档管理 API）：DELETE /v1/documents/:docId — 删除整篇文档
      const docMatch = /^\/v1\/documents\/([^/]+)$/.exec(path);
      if (docMatch && method === 'DELETE') {
        const auth = resolveTenant(req, authOpts);
        if ('error' in auth) return send(res, auth.error, { error: auth.message });
        const docId = decodeURIComponent(docMatch[1] ?? '');
        if (!docId) return send(res, 400, { error: 'doc_id required' });
        const deleted = await store.deleteByDoc(docId, auth.tenantId);
        if (cacheEnabled) cache.invalidateTenant(auth.tenantId); // 与 ingest 同一一致性纪律
        logTrace(incomingTraceId(req, undefined) ?? `rag_del_${Date.now().toString(36)}`, 'info', 'document deleted', {
          tenant: auth.tenantId,
          doc_id: docId,
          deleted,
        });
        return send(res, 200, { deleted, doc_id: docId, tenant_id: auth.tenantId });
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
            ? body.samples.map((s: Record<string, unknown>) => ({
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
            } as never);
            return resp.results ?? [];
          };
          const result = await evaluator.evaluate(dataset, retrieveFn);
          return send(res, 200, result);
        } catch (e) {
          return send(res, 500, { error: String(e instanceof Error ? e.message : e) });
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
        const genReq = {
          query,
          top_k: body.top_k,
          score_threshold: body.score_threshold,
          filters: body.filters,
          tenant_id: auth.tenantId,
          expand: !!body.expand,
          acl_principals: Array.isArray(body.acl_principals) ? body.acl_principals.map(String) : undefined,
          trace_id: incomingTraceId(req, body), // 短期：trace 透传修复
        };
        const genOpts = {
          maxTokens: body.max_tokens,
          temperature: body.temperature,
          topK: body.top_k,
          scoreThreshold: body.score_threshold,
        };

        // 增强（流式生成）：stream=true → SSE 单通道 data 帧（sources → delta* → done）。
        if (body.stream === true) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no', // 关闭代理缓冲，保证增量实时
          });
          const emit = (e: unknown): void => {
            res.write(`data: ${JSON.stringify(e)}\n\n`);
          };
          try {
            const result = await generateAnswerStream(store, provider, llm, genReq, genOpts, emit);
            metrics.recordRetrieve(Date.now() - t0, result.cache_hit);
            logTrace(result.trace_id, 'info', 'generate (stream)', {
              tenant: auth.tenantId,
              retrieved: result.retrieved,
              latency_ms: result.latency_ms,
            });
            emit({
              type: 'done',
              answer: result.answer,
              trace_id: result.trace_id,
              retrieved: result.retrieved,
              sources: result.sources,
              latency_ms: result.latency_ms,
            });
          } catch (e) {
            emit({ type: 'error', message: String(e instanceof Error ? e.message : e) });
          }
          return res.end();
        }

        try {
          const result = await generateAnswer(store, provider, llm, genReq, genOpts);
          metrics.recordRetrieve(Date.now() - t0, result.cache_hit);
          logTrace(result.trace_id, 'info', 'generate', {
            tenant: auth.tenantId,
            retrieved: result.retrieved,
            latency_ms: result.latency_ms,
          });
          return send(res, 200, result);
        } catch (e) {
          return send(res, 500, { error: String(e instanceof Error ? e.message : e) });
        }
      }

      return send(res, 404, { error: 'not found', path });
    } catch (e) {
      return send(res, 500, { error: String(e instanceof Error ? e.message : e) });
    }
  });

  const port = opts.port ?? Number(process.env.RAG_PORT || 8787);
  // P1 修复：默认仅绑定回环（见 listen 注释）；RAG_HOST 显式开放。
  const host = process.env.RAG_HOST || '127.0.0.1';
  return {
    store,
    provider,
    llm,
    metrics,
    queue,
    cache,
    listen: () =>
      new Promise<void>((resolve) =>
        // P1 修复：默认仅绑定本机回环——开放模式（未配置 tokens/JWT）此前监听全部
        // 网卡，写接口（ingest/删除文档）对任何来源可用。公网/容器部署需显式
        // RAG_HOST=0.0.0.0（并建议同时配置凭证）。
        server.listen(port, host, () => {
          // eslint-disable-next-line no-console
          console.log(`[rag] http listening on ${host}:${port}`);
          resolve();
        }),
      ),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    server,
  };
}
