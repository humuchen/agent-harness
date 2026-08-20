/**
 * 外部 RAG 端到端演示（对应设计文档 P0+P1 最小闭环）。
 *
 * 本脚本演示一个「agent 调用外部 RAG」的完整链路：
 *   1. 启动独立的 RAG 服务（services/rag，HTTP REST 模式）
 *   2. 向知识库注入文档（rag_ingest / POST /v1/ingest）
 *   3. 模拟 agent 发起检索调用（rag_retrieve / POST /v1/retrieve），拿到结构化结果
 *   4. 将检索结果作为上下文融入生成（此处若有 OPENROUTER_API_KEY 走真实 LLM，
 *      否则打印检索上下文并说明融合方式）
 *
 * ── 在 agent-harness 运行时如何接入（P1，零业务改动）──
 *   只需在 MCP_SERVERS 配置里加一条，指向本进程：
 *     {
 *       name: 'rag',
 *       command: 'node',
 *       args: ['services/rag/dist/index.js'],
 *       env: { RAG_TRANSPORT: 'mcp', RAG_TENANT_ID: '<tenant>' }
 *     }
 *   核心 loop 经 parseMcpServersEnv + connectMcpServers 自动注册，
 *   ToolRegistry 生成 rag__rag_retrieve / rag__rag_ingest，交由 LLM 自主调用。
 *   tenant_id 由 RAG 进程持有，agent 侧无需也不应传递，杜绝越权。
 *
 * 运行：pnpm --filter @agent-harness/examples run rag-e2e
 */
import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const RAG_BIN = process.env.RAG_BIN || path.resolve(process.cwd(), 'services/rag/dist/index.js');
const TENANT = process.env.RAG_TENANT_ID || 'acme';
let PORT = 0;
let BASE = '';
let ragProc: ChildProcess | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fetchImpl = (globalThis as any).fetch as typeof fetch;

/** 探测一个空闲端口，避免硬编码端口与泄漏进程冲突。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

function startRag(): ChildProcess {
  const child = spawn('node', [RAG_BIN], {
    env: {
      ...process.env,
      RAG_TRANSPORT: 'http',
      RAG_PORT: String(PORT),
      RAG_TENANT_ID: TENANT,
      RAG_DATA_FILE: '',
      // 演示用同步入库，保证「入库 → 立即可检索」的确定性；
      // 生产默认异步入库（RAG_ASYNC_INGEST=true），由服务端队列 + job 状态端点承接。
      RAG_ASYNC_INGEST: 'false',
    },
    stdio: 'ignore',
  });
  ragProc = child;
  return child;
}

async function waitForHealth(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetchImpl(`${BASE}/v1/health`);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('RAG 服务健康检查超时');
}

async function ingest(doc: {
  doc_id: string;
  title: string;
  text: string;
  tags?: string[];
}): Promise<void> {
  const r = await fetchImpl(`${BASE}/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc),
  });
  const j = (await r.json()) as { chunks?: number };
  console.log(`  ✅ 入库 ${doc.doc_id}: ${j.chunks} chunks`);
}

async function retrieve(query: string, topK = 3) {
  const r = await fetchImpl(`${BASE}/v1/retrieve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, top_k: topK }),
  });
  return (await r.json()) as {
    results: { chunk_id: string; doc_id: string; title?: string; content: string; score: number }[];
    trace_id: string;
    latency_ms: number;
  };
}

async function generateWithLLM(question: string, ctx: string): Promise<string> {
  const r = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.RAG_LLM_MODEL || 'anthropic/claude-3.5-haiku',
      messages: [
        {
          role: 'system',
          content:
            '你是客服助手。仅依据给定的【知识库片段】回答，用 [n] 引用片段编号；无相关片段时如实说明。',
        },
        { role: 'user', content: `【知识库片段】\n${ctx}\n\n用户问题：${question}` },
      ],
    }),
  });
  const j = (await r.json()) as any;
  return j?.choices?.[0]?.message?.content ?? '(LLM 响应解析失败)';
}

async function main(): Promise<void> {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}`;
  console.log(`[1/4] 启动独立 RAG 服务 (port ${PORT}) ...`);
  startRag();
  const cleanup = () => {
    try {
      ragProc?.kill();
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  await waitForHealth();
  console.log(`[2/4] 注入知识库（tenant=${TENANT}）...`);
  await ingest({
    doc_id: 'kb_refund',
    title: '退款政策',
    text: '我们支持七天无理由退款。商品签收后七天内可申请，退款将原路返回至原支付账户，通常三个工作日内到账。',
    tags: ['policy'],
  });
  await ingest({
    doc_id: 'kb_hours',
    title: '营业时间',
    text: '客服在线时间为每日 9:00–21:00，节假日另行公告。复杂工单会在 24 小时内响应。',
    tags: ['service'],
  });

  const question = '你们的退款政策是怎样的？多久能到账？';
  console.log(`[3/4] agent 发起检索调用：rag_retrieve("${question}")`);
  const resp = await retrieve(question);
  console.log(`  检索 ${resp.results.length} 条，trace_id=${resp.trace_id}，延迟 ${resp.latency_ms}ms`);
  resp.results.forEach((r, i) =>
    console.log(`  [${i + 1}] (${r.doc_id}, score=${r.score.toFixed(3)}) ${r.content}`),
  );

  console.log('[4/4] 将检索结果融入生成 ...');
  const ctx = resp.results.map((r, i) => `[${i + 1}] ${r.content}`).join('\n');
  if (process.env.OPENROUTER_API_KEY) {
    const answer = await generateWithLLM(question, ctx);
    console.log('\n增强回答:\n' + answer);
  } else {
    console.log(
      '\n[演示] 将上述片段作为 tool 消息回灌 LLM，即可生成带 [1][2] 引用的回答。\n' +
        '（设置 OPENROUTER_API_KEY 可走真实 LLM 生成；生产环境由 agent-harness 核心 loop 自动完成）',
    );
  }

  cleanup();
}

main().catch((e) => {
  console.error('rag-e2e failed:', e);
  try {
    ragProc?.kill();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
