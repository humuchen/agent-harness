#!/usr/bin/env node
/**
 * rag-golden.cjs — RAG 检索质量 golden 回归批跑 CLI（P6 方案三二期收口）。
 *
 * 用法（需先构建 rag：pnpm --filter @agent-harness/rag-service build）：
 *   node scripts/rag-golden.cjs \
 *     --data ./data/rag.json \            # 服务端同款 RAG_DATA_FILE 持久化索引（MemoryVectorStore.load）
 *     --golden ./services/rag/golden/dataset.json \  # 版本化数据集
 *     [--out ./data/rag-golden-report.json] \        # 报告落盘路径（存在旧报告则自动输出 diff）
 *     [--mode chunk|multi-query|hyde] \   # 检索模式（multi-query/hyde 需 LLM env，见 createLLM）
 *     [--top-k 5] [--tenant default] [--embed-dim 256] [--strict]
 *
 * 退出码：0 = 全部通过；1 = 存在失败（--strict 时）；2 = 参数/数据错误。
 * 与上一版报告的逐项 diff（markdown）输出到 stdout，并写入 `<out>.diff.md`。
 */
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function fail(msg, code = 2) {
  console.error(`[rag-golden] ${msg}`);
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.data || !args.golden) {
    fail(
      '用法：node scripts/rag-golden.cjs --data <RAG_DATA_FILE> --golden <dataset.json> [--out report.json] [--mode chunk|multi-query|hyde] [--top-k 5] [--tenant default] [--embed-dim 256] [--strict]'
    );
  }
  const ragDist = (p) => path.join(__dirname, '..', 'services', 'rag', 'dist', p);
  let storeMod, embedMod, goldenMod, genMod;
  try {
    storeMod = require(ragDist('store.js'));
    embedMod = require(ragDist('embed.js'));
    goldenMod = require(ragDist('golden.js'));
    genMod = require(ragDist('generate.js'));
  } catch (e) {
    fail(`rag dist 未构建（先执行 pnpm --filter @agent-harness/rag-service build）：${e.message}`);
  }
  const { MemoryVectorStore, createVectorStore } = storeMod;
  const { createEmbedder } = embedMod;
  const { loadGoldenDataset, runGoldenSuite, diffGoldenReports } = goldenMod;

  // 索引：显式 --backend qdrant 走远程；缺省 MemoryVectorStore + 服务端同款 RAG_DATA_FILE。
  const dim = Number(args['embed-dim'] || process.env.RAG_EMBED_DIM || 256);
  let store;
  if (args.backend === 'qdrant') {
    process.env.RAG_STORE_BACKEND = 'qdrant';
    store = createVectorStore(dim);
  } else {
    store = new MemoryVectorStore(dim);
    if (!fs.existsSync(String(args.data))) {
      fail(`索引文件不存在：${args.data}（先用服务端 /v1/ingest 生成，或检查 --data 路径）`);
    }
    store.load(String(args.data), String(process.env.RAG_SHARD_BY_TENANT || '').toLowerCase() === 'true');
  }
  const provider = createEmbedder();
  const dataset = loadGoldenDataset(String(args.golden));
  const mode = ['multi-query', 'hyde'].includes(String(args.mode))
    ? String(args.mode)
    : 'chunk';
  const llm = mode === 'chunk' ? undefined : genMod.createLLM();

  console.error(
    `[rag-golden] dataset=${dataset.version} cases=${dataset.cases.length} mode=${mode} chunks=${store.count()} dim=${dim}`
  );
  const report = await runGoldenSuite(store, provider, dataset, {
    llm,
    mode,
    topK: Number(args['top-k'] || 5),
    tenantId: args.tenant ? String(args.tenant) : undefined,
  });

  // 报告落盘 + 与上一版 diff。
  let diffText = '';
  if (args.out) {
    const outPath = String(args.out);
    const old = fs.existsSync(outPath)
      ? JSON.parse(fs.readFileSync(outPath, 'utf8'))
      : null;
    if (old && old.version && old.total !== undefined) {
      diffText = diffGoldenReports(old, report);
      console.log(diffText);
      fs.writeFileSync(`${outPath}.diff.md`, diffText);
    }
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(`[rag-golden] 报告已写入 ${outPath}${diffText ? `（diff: ${outPath}.diff.md）` : ''}`);
  }

  console.error(
    `[rag-golden] 结果：${report.passed}/${report.total} 通过（${Math.round(report.passRate * 100)}%），平均延迟 ${report.latencyAvgMs}ms`
  );
  for (const f of report.failed) console.error(`  ✗ ${f.q}：${f.reason}`);
  if (args.strict && report.passRate < 1) process.exit(1);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
