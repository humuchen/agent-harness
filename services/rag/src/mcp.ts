/**
 * mcp.ts — 把外部 RAG 封装为 MCP Server（P1：agent 侧零改动注册）。
 *
 * 实现选择（重要）：采用「协议级最小实现」——标准 MCP JSON-RPC 2.0 over stdio，
 * 零运行时依赖（仅 Node 内置）。原因：
 *   1. 外部 RAG 是独立系统，不应被 agent-harness 的 MCP SDK 版本耦合；
 *   2. 当前 workspace 未安装 zod（MCP SDK 高层 McpServer 的硬依赖），协议级实现避免该依赖；
 *   3. agent-harness 现有 MCP client（placeholder + connectMcpServers + ToolRegistry）基于标准
 *      MCP 协议，连本进程即可自动生成 `rag__rag_retrieve` / `rag__rag_ingest`，核心 loop 零改动。
 *
 * 安全：tenant_id 由本 MCP Server 启动时的 env（RAG_TENANT_ID）注入，agent 调用时无需也不应
 * 传 tenant，杜绝越权（设计文档第 7/8 节）。
 */

import { createInterface } from 'node:readline';
import { MemoryVectorStore } from './store';
import { createEmbedder, EmbeddingProvider } from './embed';
import { ingestDocument, IngestInput } from './ingest';
import { retrieve, RetrieveRequest, RetrieveResponse } from './retrieve';
import { generateAnswer, createLLM, LLMProvider } from './generate';
import { QueryCache } from './cache';
import { rerankWithApi, mmrRerank } from './rerank';

export interface RagMcpOptions {
  tenantId: string;
  store?: MemoryVectorStore;
  provider?: EmbeddingProvider;
  /** LLM 提供商（生成层）；未传则从 env 构建。 */
  llm?: LLMProvider;
}

const TOOLS = [
  {
    name: 'rag_retrieve',
    description:
      '从知识库检索与查询最相关的文档片段。返回带 chunk_id 的片段列表，回答时可用 [n] 引用 chunk_id。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索查询' },
        top_k: { type: 'number', description: '返回条数，默认 5' },
        tags: { type: 'array', items: { type: 'string' }, description: '按标签过滤' },
        expand: { type: 'boolean', description: 'Pre-retrieval：返回显著查询扩展词' },
      },
      required: ['query'],
    },
  },
  {
    name: 'rag_ingest',
    description: '向知识库入库一篇文档（自动分块 + 向量化）。返回写入的 chunk 数。',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: '文档唯一 ID' },
        title: { type: 'string', description: '文档标题' },
        text: { type: 'string', description: '文档正文' },
        tags: { type: 'array', items: { type: 'string', description: '文档标签' } },
      },
      required: ['doc_id', 'text'],
    },
  },
  {
    name: 'rag_generate',
    description:
      '检索 + LLM 生成一体化：检索知识库后让 LLM 结合片段生成带 [n] 引用的回答。' +
      '需配置 RAG_LLM_BASE_URL / RAG_LLM_API_KEY / RAG_LLM_MODEL。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用户问题' },
        top_k: { type: 'number', description: '检索返回条数，默认 5' },
        tags: { type: 'array', items: { type: 'string' }, description: '按标签过滤' },
        temperature: { type: 'number', description: '生成温度，默认 0.3' },
        max_tokens: { type: 'number', description: '最大生成 tokens，默认 512' },
      },
      required: ['query'],
    },
  },
];

export async function startRagMcpServer(opts: RagMcpOptions): Promise<void> {
  const store = opts.store ?? new MemoryVectorStore(Number(process.env.RAG_EMBED_DIM || 256));
  const shard = (process.env.RAG_SHARD_BY_TENANT || '').toLowerCase() === 'true';
  if (process.env.RAG_DATA_FILE) store.load(process.env.RAG_DATA_FILE, shard);
  const provider = opts.provider ?? createEmbedder();
  const tenantId = opts.tenantId;
  const llm = opts.llm ?? createLLM();
  const cacheEnabled = (process.env.RAG_CACHE || 'true').toLowerCase() !== 'false';
  const cache = new QueryCache();

  const send = (obj: unknown): void => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || msg.jsonrpc !== '2.0') return;
    // notification（无 id）不回复
    if (msg.id === undefined || msg.id === null) return;

    try {
      if (msg.method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'agent-harness-rag', version: '0.1.0' },
          },
        });
      } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      } else if (msg.method === 'tools/call') {
        const name: string = msg.params?.name;
        const args: any = msg.params?.arguments || {};
        let result: unknown;
        if (name === 'rag_retrieve') {
          const req: RetrieveRequest = {
            query: String(args.query ?? ''),
            top_k: args.top_k,
            tenant_id: tenantId,
            expand: !!args.expand,
          };
          if (args.tags) req.filters = { tags: args.tags };
          const t0 = Date.now();
          const ck = cacheEnabled
            ? cache.key(tenantId, req.query, req.top_k ?? 5, 0, JSON.stringify(req.filters ?? {}))
            : '';
          if (cacheEnabled) {
            const hit = cache.get(ck) as RetrieveResponse | undefined;
            if (hit) {
              const resp: RetrieveResponse = { ...hit, cache_hit: true, latency_ms: Date.now() - t0 };
              result = resp;
            }
          }
          if (result === undefined) {
            let resp: RetrieveResponse = { ...retrieve(store, provider, req), cache_hit: false };
            // RAG_RERANK=api：真实 cross-encoder 重排，失败回退 MMR
            const rerankMode = (process.env.RAG_RERANK || 'mmr').toLowerCase();
            if (rerankMode === 'api' && resp.results.length > 1) {
              const rr = await rerankWithApi(req.query, resp.results);
              if (rr) {
                resp = { ...resp, results: rr };
              } else {
                const vectorMap = new Map<string, number[]>();
                for (const c of store.getChunks(tenantId)) vectorMap.set(c.chunk_id, c.vector);
                resp = { ...resp, results: mmrRerank(resp.results, vectorMap, 0.5) };
              }
            }
            if (cacheEnabled) cache.set(ck, resp);
            result = resp;
          }
        } else if (name === 'rag_ingest') {
          const input: IngestInput = {
            doc_id: String(args.doc_id ?? ''),
            title: args.title,
            text: String(args.text ?? ''),
            tags: args.tags,
            tenant_id: tenantId,
          };
          result = await ingestDocument(store, provider, input);
          if (process.env.RAG_DATA_FILE) store.persist(process.env.RAG_DATA_FILE, shard);
        } else if (name === 'rag_generate') {
          if (!llm) {
            send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'LLM provider 未配置（RAG_LLM_BASE_URL / RAG_LLM_API_KEY / RAG_LLM_MODEL）' } });
            return;
          }
          const query = String(args.query ?? '');
          const genResult = await generateAnswer(
            store,
            provider,
            llm,
            {
              query,
              top_k: args.top_k,
              tenant_id: tenantId,
              filters: args.tags ? { tags: args.tags } : undefined,
            },
            {
              temperature: args.temperature,
              maxTokens: args.max_tokens,
              topK: args.top_k,
            },
          );
          result = genResult;
        } else {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown tool: ${name}` } });
          return;
        }
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        });
      } else if (msg.method === 'ping') {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
      }
    } catch (e: any) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e?.message || e) } });
    }
  });

  process.stderr.write(`[rag] MCP server (stdio) ready, tenant=${tenantId}\n`);
}
