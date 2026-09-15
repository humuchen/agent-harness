/**
 * verify-external-rag.cjs — 验证 agent-harness 接入外部 HermesChat RAG 的适配器。
 *
 * 复用真实产物 @agent-harness/core 的 builtin__rag_retrieve：
 *   当 RAG_API_STYLE=hermes 时，该工具调用外部 POST /api/v1/chat，
 *   并把返回的 citations 映射为检索片段（chunk_id / source / content / score）回灌。
 *
 * 注意：镜像内 @agent-harness/core 未软链到 node_modules，故直接 require 构建产物
 *       /app/backend/core/dist/{tools,builtins/rag-retrieve}.js。
 *
 * 用法（agent-harness 容器内，经 docker 网络访问宿主机外部 RAG）：
 *   docker exec -e RAG_URL=http://host.docker.internal:9000 -e RAG_API_STYLE=hermes \
 *     agent-harness-ui-1 node /app/scripts/verify-external-rag.cjs
 *
 * 用法（宿主，直连本机外部 RAG）：
 *   RAG_URL=http://localhost:9000 RAG_API_STYLE=hermes node scripts/verify-external-rag.cjs
 */
'use strict';

function resolveCore() {
  const candidates = [
    '/app/backend/core/dist', // 容器内镜像路径
    require('path').join(__dirname, '..', 'backend', 'core', 'dist'), // 宿主相对路径
  ];
  for (const dir of candidates) {
    const tools = require('path').join(dir, 'tools.js');
    const rag = require('path').join(dir, 'builtins', 'rag-retrieve.js');
    if (require('fs').existsSync(tools) && require('fs').existsSync(rag)) {
      return { tools, rag };
    }
  }
  return null;
}

const core = resolveCore();
if (!core) {
  console.error('FAIL: 找不到 @agent-harness/core 构建产物（backend/core/dist）');
  process.exit(1);
}
const { ToolRegistry } = require(core.tools);
const { registerRagRetrieve } = require(core.rag);

const RAG_URL = process.env.RAG_URL || 'http://localhost:9000';
const RAG_API_STYLE = process.env.RAG_API_STYLE || 'hermes';
const QUERIES = ['玻尿酸填充术后注意事项有哪些', '热玛吉适合哪些人群'];

async function main() {
  if (typeof registerRagRetrieve !== 'function' || typeof ToolRegistry !== 'function') {
    console.error('FAIL: 未导出 registerRagRetrieve / ToolRegistry');
    process.exit(1);
  }

  const registry = new ToolRegistry();
  registerRagRetrieve(registry, {
    baseUrl: RAG_URL,
    token: process.env.RAG_TOKEN,
    apiStyle: RAG_API_STYLE,
  });

  if (!registry.has('builtin__rag_retrieve')) {
    console.error('FAIL: builtin__rag_retrieve 未注册（RAG_URL 可能为空）');
    process.exit(1);
  }
  console.log(`[ok] builtin__rag_retrieve 已注册，目标 ${RAG_URL} (apiStyle=${RAG_API_STYLE})`);

  let total = 0;
  for (const q of QUERIES) {
    const raw = await registry.call('builtin__rag_retrieve', { query: q, top_k: 5 });
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (data && data.error) {
      console.error(`FAIL 查询「${q}」: ${data.error}`);
      process.exit(1);
    }
    const results = (data && data.results) || [];
    total += results.length;
    console.log(`\n=== 查询: ${q} ===`);
    console.log(`n_results=${results.length}  latency_ms=${data.latency_ms}`);
    if (data.generated_answer) {
      console.log(`外部生成摘要: ${String(data.generated_answer).slice(0, 90)}`);
    }
    results.slice(0, 3).forEach((r, i) => {
      const src = (r.metadata && (r.metadata.source || r.metadata.title)) || '-';
      console.log(
        `  [${i + 1}] chunk_id=${r.chunk_id} score=${typeof r.score === 'number' ? r.score.toFixed?.(3) : r.score} source=${src}`
      );
      console.log(`      ${String(r.content).replace(/\s+/g, ' ').slice(0, 96)}`);
    });
  }

  if (total === 0) {
    console.error('FAIL: 未从外部 RAG 取回任何检索片段');
    process.exit(1);
  }
  console.log(`\n✅ 验证通过：外部 HermesChat RAG 适配器成功回灌 ${total} 个片段`);
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
