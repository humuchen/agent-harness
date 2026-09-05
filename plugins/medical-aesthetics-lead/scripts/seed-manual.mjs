#!/usr/bin/env node
/**
 * 医美客资插件 —— 手动种子脚本 (standalone, zero npm deps)
 *
 * 用法:
 *   node plugins/medical-aesthetics-lead/scripts/seed-manual.mjs [--clean]
 *
 * - 写入 200 条模拟客资线索 + 关联院区/项目/号源/预约/对话/阶段流水/发件箱/入站消息
 * - --clean: 清空现有 ma_lead 相关数据后重新写入
 * - 环境变量: MA_TENANT_ID (默认 default), MA_DATA_DIR / MA_DB_FILE (决定写入位置)
 * - 使用插件自己的 getDb() (SCHEMA 自动执行, CREATE TABLE IF NOT EXISTS)
 */
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const DIST_INDEX = join(PLUGIN_ROOT, 'dist', 'index.js');

// 检查 dist 是否存在 (Render 构建产物)
if (!existsSync(DIST_INDEX)) {
  console.log('[seed] 🔨 dist/ 不存在，正在编译插件...');
  const result = spawnSync(
    'pnpm',
    ['--filter', '@agent-harness/medical-aesthetics-lead', 'build'],
    { stdio: 'inherit', cwd: resolve(PLUGIN_ROOT, '../..') }
  );
  if (result.status !== 0) {
    console.error('[seed] ❌ 插件编译失败');
    process.exit(1);
  }
}

// 获取插件内部的 seed 函数
const seedModule = await import(`file://${join(PLUGIN_ROOT, 'dist', 'infra', 'seed.js')}`);
const { seedDemoData } = seedModule;

// 解析参数
const args = process.argv.slice(2);
const clean = args.includes('--clean');

// 设置默认 tenant
if (!process.env.MA_TENANT_ID) {
  process.env.MA_TENANT_ID = 'default';
}

console.log('[seed] 📋 配置:');
console.log(`  tenantId: ${process.env.MA_TENANT_ID}`);
console.log(`  MA_DATA_DIR: ${process.env.MA_DATA_DIR || '(未设置)'}`);
console.log(`  MA_DB_FILE: ${process.env.MA_DB_FILE || '(未设置)'}`);
console.log(`  clean: ${clean}`);

if (clean) {
  // 获取 DB 文件路径
  const configModule = await import(`file://${join(PLUGIN_ROOT, 'dist', 'config.js')}`);
  const { getConfig, resetConfig } = configModule;
  resetConfig(); // 确保重新解析 (可能 env 改变了)
  const cfg = getConfig();
  const dbFile = cfg.db.file;
  console.log(`[seed] 🧹 --clean 模式: 删除 DB 文件 (${dbFile})`);
  try {
    rmSync(dbFile, { force: true });
    rmSync(dbFile + '-wal', { force: true });
    rmSync(dbFile + '-shm', { force: true });
    console.log('[seed] ✅ DB 文件已删除');
  } catch (e) {
    console.log('[seed] ⚠️ DB 文件删除失败 (可能不存在):', e.message);
  }
  resetConfig(); // 重置缓存, 让 seedDemoData 重新获取 getDb()
}

// 执行种子
console.log('[seed] 🚀 开始写入演示数据...');
const result = await seedDemoData(process.env.MA_TENANT_ID);
console.log('[seed] ✅ 完成!');
console.log(`  总记录数: ${result.total}`);
console.log('  各表记录:');
for (const [table, count] of Object.entries(result)) {
  if (table === 'total') continue;
  console.log(`    ${table}: ${count}`);
}

process.exit(0);
