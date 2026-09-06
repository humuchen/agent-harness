/**
 * index.ts — 外部 RAG 服务入口。
 *
 * 启动模式由 RAG_TRANSPORT 决定：
 *   http (默认)  -> HTTP REST 服务（POST /v1/retrieve|/v1/ingest，GET /v1/health）
 *   mcp          -> MCP Server（stdio），供 agent-harness 经 MCP 注册调用
 *
 * 环境变量（见 design doc 第 4/8 节）：
 *   RAG_PORT / RAG_EMBED_DIM / RAG_DATA_FILE
 *   RAG_TOKENS="tenantA:secretA,tenantB:secretB"（多租户）或 RAG_API_TOKEN + RAG_TENANT_ID（单租户）
 *   RAG_EMBEDDING_API_KEY / RAG_EMBEDDING_BASE_URL / RAG_EMBEDDING_MODEL（真实向量化）
 */

import { createRagServer } from './server';
import { startRagMcpServer } from './mcp';
export * from './eval';
export * from './generate';

function parseTokens(): Map<string, string> | undefined {
  const raw = process.env.RAG_TOKENS;
  if (!raw) return undefined;
  const m = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const tenant = pair.slice(0, idx).trim();
    const secret = pair.slice(idx + 1).trim();
    if (tenant && secret) m.set(secret, tenant);
  }
  return m.size ? m : undefined;
}

async function main(): Promise<void> {
  const transport = (process.env.RAG_TRANSPORT || 'http').toLowerCase();

  if (transport === 'mcp') {
    const tenant = process.env.RAG_TENANT_ID || 'default';
    await startRagMcpServer({ tenantId: tenant });
    return;
  }

  // HTTP 模式
  let tokens = parseTokens();
  if (!tokens && process.env.RAG_API_TOKEN) {
    tokens = new Map<string, string>();
    tokens.set(process.env.RAG_API_TOKEN, process.env.RAG_TENANT_ID || 'default');
  }

  const srv = createRagServer({
    port: Number(process.env.RAG_PORT || 8787),
    tokens,
    defaultTenant: process.env.RAG_TENANT_ID || 'default',
    dataFile: process.env.RAG_DATA_FILE,
  });
  await srv.listen();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[rag] fatal:', e);
  process.exit(1);
});
