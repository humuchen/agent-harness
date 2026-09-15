#!/usr/bin/env node
/**
 * 医美客资插件 —— 手动种子脚本 (standalone, zero npm deps)
 *
 * 用法:
 *   node plugins/medical-aesthetics-lead/scripts/seed-manual.mjs [--clean] [data.json]
 *
 * - 无参数: 写入 200 条模拟客资线索 + 关联院区/项目/号源/预约/对话/阶段流水/发件箱/入站消息
 * - data.json: 插入真实数据 (JSON 格式, 详见下文)
 * - --clean: 清空现有数据库后重新写入
 * - 环境变量: MA_TENANT_ID (默认 default), MA_DATA_DIR / MA_DB_FILE (决定写入位置)
 * - 使用插件自己的 getDb() (SCHEMA 自动执行, CREATE TABLE IF NOT EXISTS)
 *
 * Data JSON 格式:
 * {
 *   "clinics": [{ "clinic_id": "c1", "name": "北京美莱克", "city": "北京", "address": "...", "phone": "138..." }],
 *   "projects": [{ "project_id": "p1", "name": "玻尿酸", "category": "面部", "price_range": "2000-4000", ... }],
 *   "leads": [{ "lead_id": "l1", "clinic_id": "c1", "project_id": "p1", "name": "张三", "phone": "138...", "source": "wechat", "stage": "contacted", ... }],
 *   "appointments": [{ "appt_id": "a1", "lead_id": "l1", "clinic_id": "c1", "project_id": "p1", "slot_time": "2025-01-15 10:00" }],
 *   "lead_messages": [{ "lead_id": "l1", "role": "user", "content": "想了解玻尿酸..." }]
 * }
 * 仅提供要插入的字段即可 (主键 & tenant_id 自动填充; updated_at 自动设为当前时间)
 */
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, readFileSync } from 'node:fs';
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

// 动态 import 插件模块
const seedModule = await import(`file://${join(PLUGIN_ROOT, 'dist', 'infra', 'seed.js')}`);
const { seedDemoData, seedRealData } = seedModule;

// 解析参数
const args = process.argv.slice(2);
const clean = args.includes('--clean');
const dataFile = args.find((a) => a.endsWith('.json'));

// 设置默认 tenant
if (!process.env.MA_TENANT_ID) {
  process.env.MA_TENANT_ID = 'default';
}

console.log('[seed] 📋 配置:');
console.log(`  tenantId: ${process.env.MA_TENANT_ID}`);
console.log(`  MA_DATA_DIR: ${process.env.MA_DATA_DIR || '(未设置)'}`);
console.log(`  MA_DB_FILE: ${process.env.MA_DB_FILE || '(未设置)'}`);
console.log(`  clean: ${clean}`);
console.log(`  dataFile: ${dataFile || '(模拟数据)'}`);

// 导入 config 获取 DB 路径 (用于 --clean)
const configModule = await import(`file://${join(PLUGIN_ROOT, 'dist', 'config.js')}`);
const { getConfig, resetConfig } = configModule;

if (clean) {
  resetConfig();
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
  resetConfig();
}

let result;
if (dataFile) {
  // 导入真实数据
  console.log('[seed] 🚀 开始写入真实数据...');
  const realData = JSON.parse(readFileSync(dataFile, 'utf-8'));
  result = await seedRealData(process.env.MA_TENANT_ID, realData);
} else {
  // 使用模拟数据
  console.log('[seed] 🚀 开始写入模拟数据...');
  result = await seedDemoData(process.env.MA_TENANT_ID);
}

console.log('[seed] ✅ 完成!');
console.log(`  总记录数: ${result.total}`);
console.log('  各表记录:');
for (const [table, count] of Object.entries(result)) {
  if (table === 'total') continue;
  console.log(`    ${table}: ${count}`);
}

process.exit(0);
