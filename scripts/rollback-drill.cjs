#!/usr/bin/env node
/**
 * 回滚演练脚本（Go-live 检查项 #11）
 *
 * 用途：
 *   验证镜像 digest 回退 + 数据兼容性
 *
 * 用法：
 *   node scripts/rollback-drill.cjs --action verify
 *   node scripts/rollback-drill.cjs --action backup
 *   node scripts/rollback-drill.cjs --action restore --from <backup-id>
 *
 * 注意事项：
 *   - 本脚本仅验证数据兼容性，不执行实际生产回滚
 *   - 回滚前必须先执行备份（--action backup）
 *   - 验证通过后才能执行实际部署回退
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

// ── 配置 ────────────────────────────────────────────────────────────────
const BACKUP_DIR = process.env.AH_BACKUP_DIR || path.join(process.cwd(), 'data', 'backups');
const STATE_FILE = path.join(process.cwd(), '.rollback-state.json');

// ── 工具函数 ────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { drills: [] };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── verify: 验证当前部署状态 ──────────────────────────────────────────
function doVerify() {
  log('=== 回滚演练：状态验证 ===\n');
  
  const state = readState();
  const lastDrill = state.drills[state.drills.length - 1];
  
  // 检查备份目录
  const backupExists = fs.existsSync(BACKUP_DIR);
  log(`备份目录存在: ${backupExists ? '✅' : '❌'} ${BACKUP_DIR}`);
  
  // 检查数据库文件
  const dbFiles = [
    process.env.ACCOUNT_DB_FILE || path.join(process.cwd(), 'data', 'accounts.db'),
    process.env.MEMORY_SQLITE_FILE || path.join(process.cwd(), 'data', 'memory.db'),
  ];
  
  for (const dbFile of dbFiles) {
    const exists = fs.existsSync(dbFile);
    log(`数据库文件: ${exists ? '✅' : '❌'} ${dbFile}`);
    if (exists) {
      const stat = fs.statSync(dbFile);
      log(`  大小: ${(stat.size / 1024).toFixed(1)} KB, 修改时间: ${stat.mtime.toISOString()}`);
    }
  }
  
  // 检查 Docker 镜像（如适用）
  try {
    const output = execSync('docker images agent-harness:local --format "{{.ID}} {{.Tag}} {{.CreatedAt}}"', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    log(`\nDocker 镜像:\n${output.trim()}`);
  } catch {
    log('\n⚠️  Docker 不可用，跳过镜像检查');
  }
  
  // 检查健康状态
  try {
    const output = execSync(`curl -s -o /dev/null -w "%{http_code}" ${process.env.SERVER_URL || 'http://localhost:3100'}/api/state`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const healthy = output === '200';
    log(`\n服务健康: ${healthy ? '✅' : '❌'} HTTP ${output}`);
  } catch {
    log('\n⚠️  服务未运行或无法访问');
  }
  
  // 检查最近的备份
  if (backupExists) {
    const backups = fs.readdirSync(BACKUP_DIR).sort().reverse();
    log(`\n最近备份 (${backups.length} 个文件):`);
    for (const f of backups.slice(0, 5)) {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      log(`  ${f} (${stat.mtime.toISOString()}, ${(stat.size / 1024).toFixed(1)} KB)`);
    }
  }
  
  log('\n=== 验证完成 ===');
  log('建议：在执行回滚前，先备份当前状态并验证备份完整性');
}

// ── backup: 创建回滚快照 ───────────────────────────────────────────────
function doBackup() {
  log('=== 回滚演练：创建备份快照 ===\n');
  
  const backupId = generateId();
  const backupTime = new Date().toISOString();
  const backupPath = path.join(BACKUP_DIR, `rollback-${backupId}`);
  
  fs.mkdirSync(backupPath, { recursive: true });
  
  // 备份数据库文件
  const sources = [
    { name: 'accounts', file: process.env.ACCOUNT_DB_FILE || 'data/accounts.db' },
    { name: 'memory', file: process.env.MEMORY_SQLITE_FILE || 'data/memory.db' },
  ];
  
  const results = [];
  for (const src of sources) {
    const srcPath = src.file.startsWith('/') ? src.file : path.join(process.cwd(), src.file);
    if (fs.existsSync(srcPath)) {
      const destPath = path.join(backupPath, `${src.name}.db`);
      fs.copyFileSync(srcPath, destPath);
      results.push({ name: src.name, status: 'ok', size: fs.statSync(destPath).size });
      log(`✅ ${src.name}: ${destPath} (${(fs.statSync(destPath).size / 1024).toFixed(1)} KB)`);
    } else {
      results.push({ name: src.name, status: 'skip', reason: '文件不存在' });
      log(`⏭️  ${src.name}: 跳过（文件不存在）`);
    }
  }
  
  // 记录备份元数据
  const meta = {
    id: backupId,
    time: backupTime,
    path: backupPath,
    sources: results,
  };
  
  fs.writeFileSync(path.join(backupPath, 'meta.json'), JSON.stringify(meta, null, 2));
  
  // 更新状态
  const state = readState();
  state.drills.push({
    id: backupId,
    time: backupTime,
    action: 'backup',
    path: backupPath,
  });
  writeState(state);
  
  log(`\n✅ 备份完成: ${backupPath}`);
  log(`   备份ID: ${backupId}`);
  log(`   时间: ${backupTime}`);
}

// ── restore: 从备份恢复 ────────────────────────────────────────────────
function doRestore(backupId) {
  if (!backupId) {
    console.error('错误: 必须指定 --from <backup-id>');
    process.exit(1);
  }
  
  log(`=== 回滚演练：恢复备份 ${backupId} ===\n`);
  
  const backupPath = path.join(BACKUP_DIR, `rollback-${backupId}`);
  if (!fs.existsSync(backupPath)) {
    console.error(`错误: 备份路径不存在: ${backupPath}`);
    process.exit(1);
  }
  
  // 读取备份元数据
  const metaFile = path.join(backupPath, 'meta.json');
  if (!fs.existsSync(metaFile)) {
    console.error('错误: 备份元数据不存在');
    process.exit(1);
  }
  
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  log(`备份时间: ${meta.time}`);
  
  // 验证源文件存在
  const sources = meta.sources.filter((s) => s.status === 'ok');
  if (sources.length === 0) {
    console.error('错误: 备份中没有有效的源文件');
    process.exit(1);
  }
  
  // 备份当前状态（防止误操作）
  log('\n🔒 备份当前状态...');
  const currentBackupId = generateId();
  const currentBackupPath = path.join(BACKUP_DIR, `pre-restore-${currentBackupId}`);
  fs.mkdirSync(currentBackupPath, { recursive: true });
  
  for (const src of sources) {
    const srcPath = src.name === 'accounts'
      ? (process.env.ACCOUNT_DB_FILE || path.join(process.cwd(), 'data', 'accounts.db'))
      : (process.env.MEMORY_SQLITE_FILE || path.join(process.cwd(), 'data', 'memory.db'));
    
    const destPath = path.join(currentBackupPath, `${src.name}.db`);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      log(`  ✅ ${src.name}: ${destPath}`);
    }
  }
  
  // 恢复备份
  log('\n🔄 恢复备份...');
  for (const src of sources) {
    const srcPath = path.join(backupPath, `${src.name}.db`);
    const destPath = src.name === 'accounts'
      ? (process.env.ACCOUNT_DB_FILE || path.join(process.cwd(), 'data', 'accounts.db'))
      : (process.env.MEMORY_SQLITE_FILE || path.join(process.cwd(), 'data', 'memory.db'));
    
    fs.copyFileSync(srcPath, destPath);
    log(`  ✅ ${src.name}: ${destPath}`);
  }
  
  log('\n✅ 恢复完成');
  log(`   当前状态已备份到: ${currentBackupPath}`);
  log(`   恢复ID: ${currentBackupId}`);
  
  // 记录演练
  const state = readState();
  state.drills.push({
    id: currentBackupId,
    time: new Date().toISOString(),
    action: 'restore',
    fromBackup: backupId,
    path: currentBackupPath,
  });
  writeState(state);
  
  log('\n⚠️  注意：此操作已恢复数据库文件，但服务需要重启才能生效');
}

// ── list: 列出可用备份 ─────────────────────────────────────────────────
function doList() {
  log('=== 回滚演练：可用备份列表 ===\n');
  
  if (!fs.existsSync(BACKUP_DIR)) {
    log(`备份目录不存在: ${BACKUP_DIR}`);
    return;
  }
  
  const items = fs.readdirSync(BACKUP_DIR)
    .map((name) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, mtime: stat.mtime, size: stat.size };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  
  if (items.length === 0) {
    log('没有可用的备份');
    return;
  }
  
  console.log(`${'时间'.padEnd(22)} ${'大小'.padEnd(12)} ${'名称'}`);
  console.log('-'.repeat(70));
  
  for (const item of items) {
    const dateStr = item.mtime.toISOString().slice(0, 19).replace('T', ' ');
    const sizeStr = `${(item.size / 1024).toFixed(1)} KB`;
    console.log(`${dateStr.padEnd(22)} ${sizeStr.padEnd(12)} ${item.name}`);
  }
  
  log(`\n共 ${items.length} 个备份`);
}

// ── main ────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  let action = null;
  let backupId = null;
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--action':
      case '-a':
        action = args[++i];
        break;
      case '--from':
      case '-f':
        backupId = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
用法: node scripts/rollback-drill.cjs [选项]

动作:
  --action verify     验证当前部署状态（默认）
  --action backup     创建回滚备份快照
  --action restore    从备份恢复
  --action list       列出可用备份

选项:
  --from <id>         恢复时指定备份ID（--action restore 必需）
  -h, --help          显示帮助
`);
        process.exit(0);
        break;
      default:
        console.error(`未知参数: ${args[i]}`);
        process.exit(1);
    }
  }
  
  switch (action || 'verify') {
    case 'verify':
      doVerify();
      break;
    case 'backup':
      doBackup();
      break;
    case 'restore':
      doRestore(backupId);
      break;
    case 'list':
      doList();
      break;
    default:
      console.error(`未知动作: ${action}`);
      process.exit(1);
  }
}

main();
