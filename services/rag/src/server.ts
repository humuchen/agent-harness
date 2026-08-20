/**
 * server.ts — 外部 RAG 的 HTTP REST 服务（独立部署单元）。
 *
 * 对外协议（设计文档第 4 节）：
 *   POST /v1/retrieve  { query, top_k?, score_threshold?, filters? }  -> RetrieveResponse
 *   POST /v1/ingest    { doc_id, title?, text, tags?, metadata? }     -> IngestResult
 *   GET  /v1/health                                                     -> { ok:true, ... }
 *
 * 安全（设计文档第 8 节「权限隔离」基础版，P1 落地）：
 * - Bearer token 鉴权：RAG_TOKENS="tenantA:secretA,tenantB:secretB" 映射 secret->tenant。
 *   单租户最简：RAG_API_TOKEN=secret + RAG_TENANT_ID=tenantA。
 * - tenant_id 服务端强制重写：ingest/retrieve 的请求体里的 tenant_id 一律被覆盖为解析值，
 *   杜绝客户端伪造跨租户读写。
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { MemoryVectorStore } from './store';
import { createEmbedder, EmbeddingProvider } from './embed';
import { ingestDocument, IngestInput } from './ingest';
import { retrieve, RetrieveRequest, RetrieveResponse } from './retrieve';

export interface RagServerOptions {
  port?: number;
  store?: MemoryVectorStore;
  provider?: EmbeddingProvider;
  /** secret -> tenantId 映射（多租户）。 */
  tokens?: Map<string, string>;
  /** 单租户时的默认 tenant（未配 tokens 时启用，视为可信内网开放）。 */
  defaultTenant?: string;
  dataFile?: string;
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

export function resolveTenant(
  req: IncomingMessage,
  opts: RagServerOptions,
): { tenantId: string } | { error: number; message: string } {
  const tokens = opts.tokens;
  if (!tokens || tokens.size === 0) {
    // 未配置令牌：开放模式（仅限可信内网），默认单租户
    return { tenantId: opts.defaultTenant || 'default' };
  }
  const auth = (req.headers['authorization'] as string | undefined) || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return { error: 401, message: 'missing bearer token' };
  const tenant = tokens.get(m[1]);
  if (!tenant) return { error: 403, message: 'invalid token' };
  return { tenantId: tenant };
}

export function createRagServer(opts: RagServerOptions) {
  const store = opts.store ?? new MemoryVectorStore(Number(process.env.RAG_EMBED_DIM || 256));
  if (opts.dataFile) store.load(opts.dataFile);
  const provider = opts.provider ?? createEmbedder();
  const tokens = opts.tokens;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method || 'GET';

      if (path === '/v1/health' && method === 'GET') {
        return send(res, 200, { ok: true, chunks: store.count(), dim: store.dim });
      }

      if (path === '/v1/retrieve' && method === 'POST') {
        const auth = resolveTenant(req, opts);
        if ('error' in auth) return send(res, auth.error, { error: auth.message });
        const body = await readJson(req);
        const rreq: RetrieveRequest = {
          query: String(body.query ?? ''),
          top_k: body.top_k,
          score_threshold: body.score_threshold,
          filters: body.filters,
          tenant_id: auth.tenantId, // 服务端重写
        };
        if (!rreq.query) return send(res, 400, { error: 'query required' });
        const resp: RetrieveResponse = retrieve(store, provider, rreq);
        return send(res, 200, resp);
      }

      if (path === '/v1/ingest' && method === 'POST') {
        const auth = resolveTenant(req, opts);
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
        const result = await ingestDocument(store, provider, input);
        if (opts.dataFile) store.persist(opts.dataFile);
        return send(res, 200, result);
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
    listen: () => new Promise<void>((resolve) => server.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`[rag] http listening on :${port}`);
      resolve();
    })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    server,
  };
}
