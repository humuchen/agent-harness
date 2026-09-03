#!/usr/bin/env node
/**
 * 微调数据导出工具（P1）
 *
 * 从运行历史中导出对话数据，格式化为 SFT（Supervised Fine-Tuning）数据集。
 *
 * 使用方式：
 *   node scripts/export-sft-data.cjs [--agent-id <id>] [--tenant-id <id>] [--since <ISO>] [--until <ISO>] [--output <path>]
 *
 * 输出格式（JSONL）：
 *   {"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}, ...]}
 */

const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

// ---------------------------------------------------------------------------
// 命令行参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    agentId: null,
    tenantId: null,
    since: null,
    until: null,
    output: 'sft-dataset.jsonl',
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--agent-id':
        args.agentId = argv[++i];
        break;
      case '--tenant-id':
        args.tenantId = argv[++i];
        break;
      case '--since':
        args.since = argv[++i];
        break;
      case '--until':
        args.until = argv[++i];
        break;
      case '--output':
        args.output = argv[++i];
        break;
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
微调数据导出工具

用法：
  node scripts/export-sft-data.cjs [选项]

选项：
  --agent-id <id>      仅导出指定 agent 的对话
  --tenant-id <id>     仅导出指定租户的对话
  --since <ISO>        起始时间（ISO 8601）
  --until <ISO>        结束时间（ISO 8601）
  --output <path>      输出文件路径（默认：sft-dataset.jsonl）
  --help               显示帮助

输出格式（JSONL）：
  {"messages": [{"role": "system", "content": "..."}, ...]}
`);
}

// ---------------------------------------------------------------------------
// 数据读取
// ---------------------------------------------------------------------------

/**
 * 从 history-store 读取运行记录。
 * 注意：此脚本是独立工具，不依赖 server 运行时，直接读取数据文件。
 */
function loadHistory(storePath) {
  if (!existsSync(storePath)) {
    console.error(`错误：历史存储文件不存在：${storePath}`);
    process.exit(1);
  }

  const raw = readFileSync(storePath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * 过滤运行记录。
 */
function filterRuns(runs, args) {
  return runs.filter((run) => {
    if (args.agentId && run.agentId !== args.agentId) return false;
    if (args.tenantId && run.tenantId !== args.tenantId) return false;
    if (args.since) {
      const runTime = run.finishedAt || run.startedAt;
      if (runTime < new Date(args.since).getTime()) return false;
    }
    if (args.until) {
      const runTime = run.finishedAt || run.startedAt;
      if (runTime > new Date(args.until).getTime()) return false;
    }
    return true;
  });
}

/**
 * 将运行记录转换为 SFT 格式的 message 序列。
 */
function convertToSFT(runs) {
  const datasets = [];

  for (const run of runs) {
    const messages = [];

    // System prompt（如果有）
    if (run.systemPrompt) {
      messages.push({ role: 'system', content: run.systemPrompt });
    }

    // 对话历史
    if (run.messages && Array.isArray(run.messages)) {
      for (const msg of run.messages) {
        if (msg.role && msg.content) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    // 只保留有用户输入的对话
    if (messages.length > 0) {
      datasets.push({ messages });
    }
  }

  return datasets;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);

  if (args.output === '--help') {
    printHelp();
    return;
  }

  // 默认从历史存储文件读取
  const storePath = process.env.HISTORY_STORE_PATH || join(process.cwd(), 'data', 'history.json');

  console.log(`读取历史存储：${storePath}`);
  const runs = loadHistory(storePath);
  console.log(`共 ${runs.length} 条运行记录`);

  // 过滤
  const filtered = filterRuns(runs, args);
  console.log(`过滤后 ${filtered.length} 条`);

  // 转换
  const datasets = convertToSFT(filtered);
  console.log(`生成 ${datasets.length} 条 SFT 样本`);

  // 输出
  const outputPath = args.output;
  const dir = require('node:path').dirname(outputPath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const lines = datasets.map((ds) => JSON.stringify(ds));
  writeFileSync(outputPath, lines.join('\n') + '\n', 'utf-8');

  console.log(`输出到：${outputPath}`);
  console.log(`共 ${lines.length} 行`);
}

main();
