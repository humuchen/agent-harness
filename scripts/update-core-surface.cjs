#!/usr/bin/env node
/**
 * core 主门面导出面基线更新脚本（P2-11 阶段一）。
 *
 * 用法：node scripts/update-core-surface.cjs
 *
 * 从 backend/core/dist/index.js 取运行时导出（Object.keys().sort()），
 * 写入 backend/core/test/index-surface.snapshot.json。
 * 基线更新必须随改动一并提交（PR diff 人工确认新增/移除导出是否应公开）。
 *
 * 前提：需先 `pnpm --filter @agent-harness/core run build` 产出 dist。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'backend', 'core', 'dist', 'index.js');
const BASELINE = path.join(ROOT, 'backend', 'core', 'test', 'index-surface.snapshot.json');

if (!fs.existsSync(DIST)) {
  console.error('✖ backend/core/dist/index.js 不存在，请先 `pnpm --filter @agent-harness/core run build`');
  process.exit(1);
}

const facade = require(DIST);
const keys = Object.keys(facade).sort();

const prev = fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')).runtime
  : [];
const prevSet = new Set(prev);
const added = keys.filter((k) => !prevSet.has(k));
const removed = prev.filter((k) => !keys.includes(k));

fs.writeFileSync(BASELINE, JSON.stringify({ runtime: keys }, null, 2) + '\n');

console.log(`✅ 基线已更新：${keys.length} 个运行时导出`);
if (added.length) console.log(`   新增：${added.join(', ')}`);
if (removed.length) console.log(`   移除：${removed.join(', ')}`);
if (!added.length && !removed.length) console.log('   无变化');
console.log('   基线文件必须随本次改动一并提交（缺失的基线会让棘轮静默失效）。');
