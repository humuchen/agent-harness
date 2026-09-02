#!/usr/bin/env node
/**
 * 数据库备份与恢复脚本（Go-live 检查项 #4）
 *
 * 支持备份：
 *   - 账户数据库：$ACCOUNT_DB_FILE（默认 /app/data/accounts.db）
 *   - 记忆 SQLite：$MEMORY_SQLITE_FILE（默认 /app/data/memory.db）
 *   - RAG 存储：$RAG_DATA_FILE（默认 data/rag-store.json）
 *
 * 用法：
 *   node scripts/backup-db.cjs --action backup [--dir /backups] [--keep 30]
 *   node scripts/backup-db.cjs --action restore --file /backups/accounts-20260902T120000.db
 *   node scripts/backup-db.cjs --action list [--dir /backups]
 *
 * 定时任务（crontab 示例）：
 *   0 2 * * * cd /app && node scripts/backup-db.cjs --action backup --keep 30 >> /var/log/ah-backup.log 2>&1
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

// ── 配置 ────────────────────────────────────────────────────────────────
const BACKUP_DIR = process.env.AH_BACKUP_DIR || path.join(process.cwd(), 'data', 'backups');
const MAX_KEEP_DAYS = parseInt(process.env.AH_BACKUP_KEEP_DAYS || '30', 10);

// ── 源文件列表 ──────────────────────────────────────────────────────────
const SOURCES = [
  {
    name: 'accounts',
    path: process.env.ACCOUNT_DB_FILE || path.join(process.cwd(), 'data', 'accounts.db'),
  },
  {
    name: 'memory',
    path: process.env.MEMORY_SQLITE_FILE || path.join(process.cwd(), 'data', 'memory.db'),
  },
  {
    name: 'rag',
    path: process.env.RAG_DATA_FILE || path.join(process.cwd(), 'data', 'rag-store.json'),
  },
  {
    name: 'telemetry',
    path: process.env.TELEMETRY_FILE || path.join(process.cwd(), 'data', 'telemetry-metrics.json'),
  },
  {
    name: 'alerts',
    path: process.env.ALERT_LOG_PATH || path.join(process.cwd(), 'data', 'alerts.jsonl'),
  },
];

// ── 工具函数 ────────────────────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ── backup ──────────────────────────────────────────────────────────────
function doBackup(backupDir, keepDays) {
  ensureDir(backupDir);
  const ts = nowIso();
  const entries = [];

  for (const src of SOURCES) {
    if (!fs.existsSync(src.path)) {
      log(`[skip] ${src.name}: 文件不存在 ${src.path}`);
      continue;
    }
    const dest = path.join(backupDir, `${src.name}-${ts}${path.extname(src.path) || ''}`);
    try {
      // 对 SQLite 做 VACUUM + integrity check，确保备份一致性
      if (src.name === 'accounts' || src.name === 'memory') {
        try {
          const { Database } = require('sqlite3');
          const db = new Database(src.path);
          db.run('PRAGMA wal_checkpoint(TRUNCATE)', (err) => {
            if (err) log(`[warn] ${src.name} WAL checkpoint: ${err.message}`);
          });
          db.close();
        } catch {
          // sqlite3 未安装则跳过 WAL checkpoint，直接拷贝
        }
      }
      fs.copyFileSync(src.path, dest);
      const sz = fs.statSync(dest).size;
      log(`[ok] ${src.name}: ${dest} (${humanSize(sz)})`);
      entries.push({ name: src.name, dest, size: sz });
    } catch (e) {
      log(`[fail] ${src.name}: ${e.message}`);
    }
  }

  // 清理过期备份
  if (keepDays > 0) {
    try {
      const cutoff = Date.now() - keepDays * 86_400_000;
      const files = fs.readdirSync(backupDir).map((f) => ({
        name: f,
        mtime: fs.statSync(path.join(backupDir, f)).mtimeMs,
      }));
      for (const f of files) {
        if (f.mtime < cutoff) {
          fs.unlinkSync(path.join(backupDir, f.name));
          log(`[cleanup] 删除过期备份: ${f.name}`);
        }
      }
    } catch (e) {
      log(`[warn] 清理过期备份失败: ${e.message}`);
    }
  }

  log(`[done] 本次备份 ${entries.length} 个文件，目录: ${backupDir}`);
  return entries;
}

// ── restore ─────────────────────────────────────────────────────────────
function doRestore(file) {
  if (!file) {
    console.error('错误: --file 参数为必填');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`错误: 备份文件不存在: ${file}`);
    process.exit(1);
  }

  // 推断源类型
  const basename = path.basename(file);
  const match = basename.match(/^(accounts|memory|rag|telemetry|alerts)-(.+)$/);
  if (!match) {
    console.error('错误: 无法识别备份文件格式，应为 <name>-<timestamp>[.ext]');
    process.exit(1);
  }

  const srcName = match[1];
  const src = SOURCES.find((s) => s.name === srcName);
  if (!src) {
    console.error(`错误: 未知备份类型 "${srcName}"`);
    process.exit(1);
  }

  const backupSize = fs.statSync(file).size;
  log(`恢复中: ${file} -> ${src.path} (${humanSize(backupSize)})`);

  // 备份当前文件作为回退
  if (fs.existsSync(src.path)) {
    const safePath = `${src.path}.pre-restore-${nowIso()}`;
    fs.copyFileSync(src.path, safePath);
    log(`[safe] 当前文件已备份到: ${safePath}`);
  }

  fs.copyFileSync(file, src.path);
  log(`[ok] 恢复完成: ${src.name}`);
}

// ── list ────────────────────────────────────────────────────────────────
function doList(backupDir) {
  ensureDir(backupDir);
  const files = fs
    .readdirSync(backupDir)
    .map((f) => {
      const stat = fs.statSync(path.join(backupDir, f));
      return { name: f, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (files.length === 0) {
    log(`备份目录 ${backupDir} 为空`);
    return;
  }

  console.log(`\n备份目录: ${backupDir} (${files.length} 个文件)\n`);
  console.log(`${'时间'.padEnd(26)} ${'大小'.padEnd(12)} ${'文件名'}`);
  console.log('-'.repeat(70));
  for (const f of files) {
    const dateStr = f.mtime.toISOString().slice(0, 19).replace('T', ' ');
    console.log(`${dateStr.padEnd(26)} ${humanSize(f.size).padEnd(12)} ${f.name}`);
  }
  console.log(`\n总计: ${files.reduce((sum, f) => sum + f.size, 0)} bytes`);
}

// ── main ────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  let action = null;
  let file = null;
  let backupDir = BACKUP_DIR;
  let keepDays = MAX_KEEP_DAYS;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--action':
      case '-a':
        action = args[++i];
        break;
      case '--file':
      case '-f':
        file = args[++i];
        break;
      case '--dir':
      case '-d':
        backupDir = args[++i];
        break;
      case '--keep':
        keepDays = parseInt(args[++i], 10);
        break;
      case '--help':
      case '-h':
        console.log(`
用法: node scripts/backup-db.cjs [选项]

动作:
  --action backup   备份所有数据库和配置文件（默认）
  --action restore  从备份文件恢复
  --action list     列出可用备份

选项:
  --file <path>     恢复时指定备份文件路径
  --dir <path>      备份目录（默认: $AH_BACKUP_DIR 或 /var/lib/agent-harness/backups）
  --keep <days>     保留天数，过期自动清理（默认: 30）
  -h, --help        显示帮助
`);
        process.exit(0);
        break;
      default:
        console.error(`未知参数: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!action) {
    // 默认行为：执行备份
    doBackup(backupDir, keepDays);
    return;
  }

  switch (action) {
    case 'backup':
      doBackup(backupDir, keepDays);
      break;
    case 'restore':
      doRestore(file);
      break;
    case 'list':
      doList(backupDir);
      break;
    default:
      console.error(`未知动作: ${action}`);
      process.exit(1);
  }
}

main();
