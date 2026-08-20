/**
 * 真实模型端到端验证：agent-harness 运行时 + 外部 RAG（MCP）+ 真实 LLM。
 *
 * 链路（对应设计文档第 11 节「真实模型端到端」）：
 *   1. 顶层 env 注入：RAG_TRANSPORT=mcp、RAG_TENANT_ID、MCP_SERVERS（rag stdio 条目）。
 *      注意：RAG_* 必须放顶层 env（SDK 的 StdioClientTransport 会把 MCP_SERVERS 条目内
 *      的 env 子字段「整体替换」子进程环境，导致 node 丢 PATH 无法启动）。
 *   2. parseMcpServersEnv() + connectMcpServers() 注册 rag__rag_ingest / rag__rag_retrieve。
 *   3. 先经 tools.call('rag__rag_ingest', ...) 注入知识库（agent 侧等价调用）。
 *   4. AgentHarness + createOpenRouterLLM()（真实模型，默认 agnes-2.5-flash）run()：
 *      LLM 自主调用 rag__rag_retrieve → 检索结果作为 tool 消息回灌 → 融合生成回答。
 *   5. disconnectAllMcp() 清理连接。
 *
 * 运行（仓库根，需要 OPENROUTER_API_KEY）：
 *   OPENROUTER_API_KEY=sk-xxx node examples/dist/rag-live-e2e.js
 */
import path from 'node:path';
import {
  AgentHarness,
  ToolRegistry,
  createOpenRouterLLM,
  parseMcpServersEnv,
  connectMcpServers,
  disconnectAllMcp,
  loadEnv,
} from '@agent-harness/core';
import type { LLM } from '@agent-harness/core';

loadEnv(); // 读根 .env（git-ignored）；显式 env 优先

// 顶层 env：RAG 以 stdio MCP 形态接入（RAG_* 不能被 MCP_SERVERS 条目内的 env 子字段覆盖）
process.env.RAG_TRANSPORT = process.env.RAG_TRANSPORT || 'mcp';
process.env.RAG_TENANT_ID = process.env.RAG_TENANT_ID || 'acme';
const ragBin = path.resolve(process.cwd(), 'services/rag/dist/index.js');
process.env.MCP_SERVERS = process.env.MCP_SERVERS
  ? process.env.MCP_SERVERS
  : JSON.stringify([{ name: 'rag', command: 'node', args: [ragBin] }]);

const TENANT = process.env.RAG_TENANT_ID;
const KB = [
  {
    doc_id: 'kb_refund',
    title: '退款政策',
    text: '我们支持七天无理由退款。商品签收后七天内可申请，退款将原路返回至原支付账户，通常三个工作日内到账。',
    tags: ['policy'],
  },
  {
    doc_id: 'kb_hours',
    title: '客服时间',
    text: '客服在线时间为每日 9:00-21:00，节假日另行公告。复杂工单会在 24 小时内响应。',
    tags: ['service'],
  },
];

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[rag-live] 需要 OPENROUTER_API_KEY（参见 .env.example）');
    process.exit(2);
  }

  const tools = new ToolRegistry();

  // 1) 接入 RAG MCP（MCP_SERVERS -> rag__rag_ingest / rag__rag_retrieve）
  const configs = parseMcpServersEnv();
  console.log(`[1/5] 解析 MCP_SERVERS: ${configs.map((c) => c.name).join(', ')}`);
  const metas = await connectMcpServers(tools, configs);
  for (const m of metas) {
    console.log(`  - ${m.name}: ${m.status} (${m.tools.length} tools)` + (m.error ? ` — ${m.error}` : ''));
  }
  if (!tools.has('rag__rag_retrieve')) {
    throw new Error('rag__rag_retrieve 未注册（MCP 接入失败）');
  }
  console.log(`[2/5] 已注册 ${tools.schemas().length} 个工具（含 rag__rag_retrieve / rag__rag_ingest）`);

  // 2) 灌入知识库（等价于 agent 调用 rag__rag_ingest）
  console.log(`[3/5] 注入知识库（tenant=${TENANT}）...`);
  for (const doc of KB) {
    const raw = await tools.call('rag__rag_ingest', doc);
    // MCP 工具结果由 core 展平为字符串，需 JSON.parse 还原
    const r = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { doc_id?: string; chunks?: number };
    console.log(`  ✅ ${r.doc_id ?? doc.doc_id}: ${r.chunks ?? '-'} chunks`);
  }

  // 3) 真实模型驱动（agnes-2.5-flash，推理模型，工具调用自主发生）
  const llm: LLM = createOpenRouterLLM();
  const agent = new AgentHarness({
    llm,
    tools,
    systemPrompt:
      '你是电商客服助手。回答用户问题时，必须先调用 rag__rag_retrieve 检索知识库；' +
      '仅依据检索到的片段回答，并用 [n] 引用片段编号（chunk_id）。若片段不足以回答，如实说明。',
  });

  const question = '你们的退款政策是怎样的？多久能到账？';
  console.log(`[4/5] agent.run("${question}") — 真实模型自主调用 rag__rag_retrieve ...`);
  const answer = await agent.run(question);
  console.log('\n=== 最终回复 ===\n' + answer);

  // 4) 清理连接
  await disconnectAllMcp();
  console.log('\n[5/5] disconnectAllMcp() 完成');
}

main().catch((e) => {
  console.error('[rag-live] failed:', e);
  process.exit(1);
});
