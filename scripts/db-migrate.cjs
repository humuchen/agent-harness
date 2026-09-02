/**
 * 统一数据库迁移入口（单点来源）。
 *
 * 与核心 framework 的 DB 层对齐：复用 @agent-harness/core 的 getDbAdapter
 * （node:sqlite，零额外 npm 依赖；DB_BACKEND=turso 时切云端 SQLite），
 * 不再硬编码 better-sqlite3。所有接入层 DB（accounts / custom-models / mcp /
 * chat-history / memory 等）运行时已用 CREATE TABLE IF NOT EXISTS 自愈建表；
 * 本脚本面向「需要版本化、可回滚、可审计 schema 演进」的场景（如 leads 业务库），
 * 通过 migrations/*.sql 统一管理。
 *
 * 用法：
 *   node scripts/db-migrate.cjs up            # 执行所有待执行迁移
 *   node scripts/db-migrate.cjs down          # 回滚最后一次迁移
 *   node scripts/db-migrate.cjs status         # 查看迁移状态
 *   node scripts/db-migrate.cjs create name    # 创建新迁移文件
 *
 * 环境变量：
 *   DB_PATH         数据库文件路径（默认 ./data/app.db，与 DB_SQLITE_FILE 一致）
 *   MIGRATIONS_DIR  迁移目录（默认 ./migrations）
 *   DB_BACKEND      sqlite | turso（默认 sqlite；turso 需 TURSO_URL/TURSO_TOKEN）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 复用核心 DB 适配器（已编译产物）。避免重复造轮子 / 依赖漂移。
// 通过仓库相对路径直接加载 dist，避免依赖 node 的 workspace 包解析（脚本在任意 cwd 均可运行）。
let getDbAdapter;
const coreDist = path.join(__dirname, '..', 'backend', 'core', 'dist', 'index.js');
try {
  ({ getDbAdapter } = require(coreDist));
} catch (e) {
  console.error('❌ 无法加载 @agent-harness/core 的编译产物（' + coreDist + '）：请先 pnpm --filter @agent-harness/core run build');
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH || process.env.DB_SQLITE_FILE || './data/app.db';
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || './migrations';

if (!fs.existsSync(MIGRATIONS_DIR)) fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });

const db = getDbAdapter({ file: DB_PATH });

function createMigrationsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now')),
      execution_time_ms INTEGER,
      checksum TEXT
    );
  `);
}

function getCurrentVersion() {
  createMigrationsTable();
  const row = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get();
  return row && row.version ? Number(row.version) : 0;
}

function getMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.match(/^\d+_/))
    .sort()
    .map((file) => {
      const m = file.match(/^(\d+)_(.+)\.(up|down)\.sql$/);
      if (!m) return null;
      return {
        version: parseInt(m[1], 10),
        name: m[2],
        direction: m[3],
        file,
        path: path.join(MIGRATIONS_DIR, file)
      };
    })
    .filter(Boolean);
}

function getPendingMigrations() {
  const current = getCurrentVersion();
  return getMigrations()
    .filter((m) => m.direction === 'up' && m.version > current)
    .sort((a, b) => a.version - b.version);
}

function runMigration(migration) {
  const sql = fs.readFileSync(migration.path, 'utf8');
  const checksum = crypto.createHash('md5').update(sql).digest('hex');
  const start = Date.now();
  try {
    db.exec(sql);
    db.prepare(
      'INSERT INTO schema_migrations (version, name, execution_time_ms, checksum) VALUES (?, ?, ?, ?)'
    ).run(migration.version, migration.name, Date.now() - start, checksum);
    return { success: true, version: migration.version, name: migration.name, time: Date.now() - start };
  } catch (error) {
    return { success: false, version: migration.version, name: migration.name, error: error.message, time: Date.now() - start };
  }
}

function migrateUp(targetVersion = null) {
  console.log('🚀 开始向上迁移...\n');
  const pending = getPendingMigrations();
  if (pending.length === 0) {
    console.log('✅ 数据库已是最新版本');
    return;
  }
  const results = [];
  for (const migration of pending) {
    if (targetVersion && migration.version > targetVersion) break;
    console.log(`⏳ 执行迁移 ${migration.version}_${migration.name}...`);
    const result = runMigration(migration);
    if (result.success) {
      console.log(`   ✅ 完成 (${result.time}ms)`);
    } else {
      console.log(`   ❌ 失败: ${result.error}`);
      console.log('\n⚠️ 迁移失败，停止后续迁移');
      break;
    }
    results.push(result);
  }
  console.log(`\n📊 迁移报告: 当前版本=${getCurrentVersion()}, 成功=${results.filter((r) => r.success).length}, 失败=${results.filter((r) => !r.success).length}`);
}

function migrateDown() {
  console.log('⬇️ 开始回滚最后一次迁移...\n');
  const current = getCurrentVersion();
  if (current === 0) {
    console.log('✅ 没有可回滚的迁移');
    return;
  }
  const down = getMigrations().find((m) => m.direction === 'down' && m.version === current);
  if (!down) {
    console.log(`❌ 未找到版本 ${current} 的回滚脚本（请在 ${MIGRATIONS_DIR} 创建 ${current}_*.down.sql）`);
    return;
  }
  const sql = fs.readFileSync(down.path, 'utf8');
  const start = Date.now();
  try {
    db.exec(sql);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(current);
    console.log(`   ✅ 回滚完成 (${Date.now() - start}ms)，当前版本=${getCurrentVersion()}`);
  } catch (error) {
    console.log(`   ❌ 回滚失败: ${error.message}`);
  }
}

function showStatus() {
  console.log('📋 迁移状态\n');
  createMigrationsTable();
  const current = getCurrentVersion();
  console.log(`当前版本: ${current}`);
  const applied = db.prepare('SELECT version, name, applied_at, execution_time_ms FROM schema_migrations ORDER BY version').all();
  if (applied.length > 0) {
    console.log('\n已应用:');
    for (const r of applied) console.log(`  ✅ ${r.version}_${r.name} (${r.execution_time_ms}ms) - ${r.applied_at}`);
  }
  const pending = getPendingMigrations();
  if (pending.length > 0) {
    console.log('\n待执行:');
    for (const m of pending) console.log(`  ⏳ ${m.version}_${m.name}`);
  } else {
    console.log('\n✅ 没有待执行的迁移');
  }
}

function createMigration(name) {
  const version = Date.now();
  const upFile = `${version}_${name}.up.sql`;
  const downFile = `${version}_${name}.down.sql`;
  const upPath = path.join(MIGRATIONS_DIR, upFile);
  const downPath = path.join(MIGRATIONS_DIR, downFile);
  if (fs.existsSync(upPath)) {
    console.log(`❌ 迁移文件已存在: ${upFile}`);
    return;
  }
  fs.writeFileSync(upPath, `-- 迁移: ${name}\n-- 版本: ${version}\n\n-- 在这里编写 SQL\n`);
  fs.writeFileSync(downPath, `-- 回滚: ${name}\n-- 版本: ${version}\n\n-- 在这里编写回滚 SQL\n`);
  console.log(`✅ 已创建迁移文件: Up=${upFile}, Down=${downFile}`);
}

function showHelp() {
  console.log(`
统一数据库迁移工具（复用 @agent-harness/core DB 适配器）

用法:
  node db-migrate.cjs <command> [options]

命令:
  up [version]     向上迁移（可选目标版本）
  down             回滚最后一次迁移
  status           查看迁移状态
  create <name>    创建新迁移文件
  help             显示帮助

环境变量:
  DB_PATH          数据库文件路径（默认 ./data/app.db）
  DB_BACKEND       sqlite | turso（默认 sqlite）
  MIGRATIONS_DIR   迁移目录（默认 ./migrations）
`);
}

const command = process.argv[2] || 'help';
const args = process.argv.slice(3);
try {
  switch (command) {
    case 'up':
      migrateUp(args[0] ? parseInt(args[0], 10) : null);
      break;
    case 'down':
      migrateDown();
      break;
    case 'status':
      showStatus();
      break;
    case 'create':
      if (!args[0]) {
        console.log('❌ 请提供迁移名称');
        process.exit(1);
      }
      createMigration(args[0]);
      break;
    case 'help':
    default:
      showHelp();
  }
} catch (error) {
  console.error('❌ 迁移失败:', error);
  process.exit(1);
} finally {
  try { db.close && db.close(); } catch {}
}
