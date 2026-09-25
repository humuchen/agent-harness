#!/usr/bin/env node
/**
 * 数据留存清理任务（P2 生产化）
 *
 * 根据 retention.ts 中定义的 RetentionPolicy，清理超期数据：
 * - audit: 90 天
 * - memory: 30 天
 * - recipe: 365 天
 *
 * 用法：
 *   node scripts/cleanup-retention.cjs [--dry-run] [--force]
 *
 * 建议配置为 cron 任务，每日执行。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRetentionPolicy } = require('../access/server/dist/retention');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

function getRetentionDays(kind) {
  const policy = createRetentionPolicy();
  const maxAgeMs = policy.maxAgeMs(kind);
  if (maxAgeMs <= 0) return Infinity;
  return Math.ceil(maxAgeMs / (24 * 60 * 60 * 1000));
}

function scanDirectory(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => pattern.test(f))
    .map(f => path.join(dir, f));
}

function getModTime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function deleteFile(file) {
  if (DRY_RUN) {
    console.log(`[DRY-RUN] Would delete: ${file}`);
    return;
  }
  try {
    fs.unlinkSync(file);
    console.log(`Deleted: ${file}`);
  } catch (e) {
    console.warn(`Failed to delete ${file}: ${e.message}`);
  }
}

function cleanupByAge(files, maxAgeMs, kind) {
  const now = Date.now();
  let deleted = 0;
  for (const file of files) {
    const modTime = getModTime(file);
    const age = now - modTime;
    if (age > maxAgeMs) {
      console.log(`[${kind}] Exceeded ${Math.floor(age / 86400000)} days: ${file}`);
      deleteFile(file);
      deleted++;
    }
  }
  return deleted;
}

function main() {
  const dataDir = process.env.APP_DATA_DIR || '/app/data';
  // P1 误删防护修复：telemetry-metrics.json 不再纳入清理。它是遥测累计计数的热文件
  // （TELEMETRY_FILE，跨重启保留累计 token/成本/租户维度），按 mtime 清理会误删——
  // 低频写入时 mtime 可能长期停更，一旦超 90 天即被删除，累计指标历史全部丢失。
  // 如需控制其体积，应由遥测模块自身的轮转策略管理，而非按龄删除。
  const policies = {
    audit: { dir: path.join(dataDir, 'audit'), pattern: /\.jsonl$/, kind: 'audit' },
    memory: { dir: path.join(dataDir, 'memory'), pattern: /\.json$/, kind: 'memory' }
  };

  console.log(`=== 数据留存清理任务 ===`);
  console.log(`数据目录: ${dataDir}`);
  console.log(`保留策略: audit=${getRetentionDays('audit')}天, memory=${getRetentionDays('memory')}天, recipe=${getRetentionDays('recipe')}天`);
  console.log(`执行模式: ${DRY_RUN ? 'DRY-RUN（仅预览）' : '实际执行'}`);
  console.log('');

  let totalDeleted = 0;

  for (const [kind, config] of Object.entries(policies)) {
    if (!fs.existsSync(config.dir)) {
      console.log(`[跳过] 目录不存在: ${config.dir}`);
      continue;
    }

    const maxAgeMs = createRetentionPolicy().maxAgeMs(kind);
    const files = scanDirectory(config.dir, config.pattern);
    console.log(`\n--- 清理 ${kind} ---`);
    console.log(`扫描到 ${files.length} 个文件`);

    if (files.length === 0) continue;

    const deleted = cleanupByAge(files, maxAgeMs, kind);
    totalDeleted += deleted;
  }

  console.log(`\n=== 完成 ===`);
  console.log(`共删除 ${totalDeleted} 个文件`);
}

main();
