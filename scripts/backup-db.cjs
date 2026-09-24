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
async function doBackup(backupDir, keepDays) {
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
      // P1 修复（D4）：SQLite 一致性备份。此前先发异步 WAL checkpoint 又立即 close，
      // 随后直接 copyFileSync 活动库文件——checkpoint 未必完成、拷贝可能页级撕裂。
      // 现改用 sqlite3 在线 backup API（源库读锁 + 页级一致快照）；驱动不可用时
      // 退化为「等待 checkpoint 完成后拷贝」。
      if (src.name === 'accounts' || src.name === 'memory') {
        const backedUp = await sqliteOnlineBackup(src.path, dest);
        if (!backedUp) {
          await walCheckpointAndWait(src.path);
          fs.copyFileSync(src.path, dest);
          log(`[warn] ${src.name}: sqlite3 驱动不可用，已按 checkpoint 后拷贝（退化模式）`);
        }
      } else {
        fs.copyFileSync(src.path, dest);
      }
      const sz = fs.statSync(dest).size;
      log(`[ok] ${src.name}: ${dest} (${humanSize(sz)})`);
      entries.push({ name: src.name, dest, size: sz });
    } catch (e) {
      log(`[fail] ${src.name}: ${e.message}`);
    }
  }

  // 清理过期备份（P2 修复：只清理本脚本产出的 <name>-<ts> 快照，逐文件容错，
  // 不动 rollback-drill / pre-restore 锚点，也不让单个失败中断整轮清理）
  if (keepDays > 0) {
    try {
      const cutoff = Date.now() - keepDays * 86_400_000;
      const ownPrefix = /^(accounts|memory|rag|telemetry|alerts)-/;
      for (const f of fs.readdirSync(backupDir)) {
        if (!ownPrefix.test(f)) continue; // 跳过 rollback-*/pre-restore-*/子目录等非本脚本产物
        try {
          const st = fs.statSync(path.join(backupDir, f));
          if (!st.isFile() || st.mtimeMs >= cutoff) continue;
          fs.unlinkSync(path.join(backupDir, f));
          log(`[cleanup] 删除过期备份: ${f}`);
        } catch (e) {
          log(`[warn] 清理跳过 ${f}: ${e.message}`);
        }
      }
    } catch (e) {
      log(`[warn] 清理过期备份失败: ${e.message}`);
    }
  }

  log(`[done] 本次备份 ${entries.length} 个文件，目录: ${backupDir}`);
  return entries;
}

/** sqlite3 在线 backup：返回 true=备份成功；false=驱动不可用/失败（调用方退化拷贝）。 */
function sqliteOnlineBackup(srcPath, destPath) {
  let Database;
  try {
    ({ Database } = require('sqlite3'));
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let db;
    try {
      db = new Database(srcPath, (openErr) => {
        if (openErr) return finish(false);
        try {
          db.backup(destPath, (completed) => {
            db.close(() => finish(!!completed));
          });
        } catch {
          try { db.close(); } catch {}
          finish(false);
        }
      });
    } catch {
      try { db && db.close(); } catch {}
      finish(false);
    }
  });
}

/** 退化路径：等待 WAL checkpoint 回调完成再返回（此前 checkpoint 异步未等待即拷贝）。 */
function walCheckpointAndWait(srcPath) {
  let Database;
  try {
    ({ Database } = require('sqlite3'));
  } catch {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let db;
    try {
      db = new Database(srcPath, (openErr) => {
        if (openErr) return resolve();
        db.run('PRAGMA wal_checkpoint(TRUNCATE)', (err) => {
          if (err) log(`[warn] WAL checkpoint: ${err.message}`);
          db.close(() => resolve());
        });
      });
    } catch {
      try { db && db.close(); } catch {}
      resolve();
    }
  });
}

// ── 恢复前校验（P1 修复 D1）─────────────────────────────────────────────
const SQLITE_MAGIC = 'SQLite format 3\x00';

/** 校验文件前 16 字节为 SQLite magic header；非 SQLite 类型（JSON 等）做轻量结构检查。 */
function assertRestorable(file, srcName) {
  const isSqlite = srcName === 'accounts' || srcName === 'memory';
  if (isSqlite) {
    const fd = fs.openSync(file, 'r');
    try {
      const hdr = Buffer.alloc(16);
      fs.readSync(fd, hdr, 0, 16, 0);
      if (hdr.toString('latin1') !== SQLITE_MAGIC) {
        throw new Error('备份文件不是合法的 SQLite 数据库（magic header 不匹配）——拒绝恢复，防止坏备份覆盖好库');
      }
    } finally {
      fs.closeSync(fd);
    }
  } else {
    // JSON/JSONL 类：检查首个非空白字符
    const head = fs.readFileSync(file, { flag: 'r' }).subarray(0, 4096).toString('utf8').trimStart();
    if (head && !head.startsWith('{') && !head.startsWith('[')) {
      throw new Error(`备份文件不是合法的 JSON 起始结构——拒绝恢复: ${file}`);
    }
  }
}

/** 对 SQLite 备份副本执行 PRAGMA integrity_check（驱动不可用时返回 'skipped'）。 */
function sqliteIntegrityCheck(file) {
  let Database;
  try {
    ({ Database } = require('sqlite3'));
  } catch {
    return Promise.resolve('skipped');
  }
  return new Promise((resolve) => {
    let db;
    try {
      db = new Database(file, (openErr) => {
        if (openErr) return resolve(`打开失败: ${openErr.message}`);
        db.get('PRAGMA integrity_check', (e, row) => {
          const result = e
            ? `integrity_check 出错: ${e.message}`
            : row && Object.values(row)[0] === 'ok'
              ? 'ok'
              : `integrity_check 未通过: ${JSON.stringify(row)}`;
          db.close(() => resolve(result));
        });
      });
    } catch (e) {
      try { db && db.close(); } catch {}
      resolve(`打开失败: ${e.message}`);
    }
  });
}

// ── restore ─────────────────────────────────────────────────────────────
async function doRestore(file, force) {
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

  // P1 修复（D1）：恢复前完整性校验——此前直接 copyFileSync 覆盖，
  // 坏备份也「恢复成功」且已覆盖好库，且活动库残留 -wal/-shm 会被 SQLite 重放到新库造成损坏。
  log(`校验备份完整性: ${file}`);
  try {
    assertRestorable(file, srcName);
  } catch (e) {
    console.error(`❌ 校验失败: ${e.message}`);
    process.exit(1);
  }
  const isSqlite = srcName === 'accounts' || srcName === 'memory';
  if (isSqlite) {
    const check = await sqliteIntegrityCheck(file);
    if (check !== 'ok' && check !== 'skipped') {
      console.error(`❌ 校验失败: ${check}`);
      process.exit(1);
    }
    log(check === 'skipped' ? '[warn] sqlite3 驱动不可用，跳过 integrity_check（magic 已通过）' : `[ok] integrity_check: ok`);
  }

  const backupSize = fs.statSync(file).size;
  log(`恢复中: ${file} -> ${src.path} (${humanSize(backupSize)})`);

  // 覆盖确认门：目标已存在且非 --force 时只打印计划并退出（防误覆盖活动库；
  // 恢复前必须停服——运行中的服务持有旧句柄，覆盖后其缓冲仍会写入造成新旧混杂）。
  if (fs.existsSync(src.path) && !force) {
    console.error('\n⚠️  即将覆盖现有文件，请先停止服务并使用 --force 显式确认：');
    console.error(`    node scripts/backup-db.cjs --action restore --file ${file} --force`);
    process.exit(1);
  }

  // 备份当前文件作为回退
  if (fs.existsSync(src.path)) {
    const safePath = `${src.path}.pre-restore-${nowIso()}`;
    fs.copyFileSync(src.path, safePath);
    log(`[safe] 当前文件已备份到: ${safePath}`);
  }

  // 清理目标库的 WAL/SHM 附属文件（旧句柄重放是新库损坏的主要来源）
  if (isSqlite) {
    for (const suffix of ['-wal', '-shm']) {
      const side = `${src.path}${suffix}`;
      if (fs.existsSync(side)) {
        fs.unlinkSync(side);
        log(`[clean] 已删除附属文件: ${side}`);
      }
    }
  }

  fs.copyFileSync(file, src.path);
  log(`[ok] 恢复完成: ${src.name}`);
  log('[hint] 若服务此前在运行，请确认已停服后再启动，以避免旧句柄写入残留。');
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
async function main() {
  const args = process.argv.slice(2);
  let action = null;
  let file = null;
  let backupDir = BACKUP_DIR;
  let keepDays = MAX_KEEP_DAYS;
  let force = false;

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
      case '--force':
        force = true;
        break;
      case '--help':
      case '-h':
        console.log(`
用法: node scripts/backup-db.cjs [选项]

动作:
  --action backup   备份所有数据库和配置文件（默认；SQLite 走在线 backup API 保证页级一致）
  --action restore  从备份文件恢复（恢复前自动校验 magic header + integrity_check）
  --action list     列出可用备份

选项:
  --file <path>     恢复时指定备份文件路径
  --dir <path>      备份目录（默认: $AH_BACKUP_DIR 或 /var/lib/agent-harness/backups）
  --keep <days>     保留天数，过期自动清理（默认: 30；仅清理本脚本产出的快照）
  --force           恢复时显式确认覆盖现有文件（覆盖前请务必停服）
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
    await doBackup(backupDir, keepDays);
    return;
  }

  switch (action) {
    case 'backup':
      await doBackup(backupDir, keepDays);
      break;
    case 'restore':
      await doRestore(file, force);
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
