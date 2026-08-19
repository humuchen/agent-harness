/**
 * SQLite数据库迁移工具
 *
 * 功能:
 * - Schema版本管理
 * - 增量迁移
 * - 迁移回滚(可选)
 * - 迁移状态查询
 *
 * 使用方式:
 *   node scripts/db-migrate.cjs up          # 执行所有待执行迁移
 *   node scripts/db-migrate.cjs down         # 回滚最后一次迁移
 *   node scripts/db-migrate.cjs status       # 查看迁移状态
 *   node scripts/db-migrate.cjs create name  # 创建新迁移文件
 */

// 使用插件目录的数据库(如果有)
const PluginDB = (() => {
  try {
    return require('better-sqlite3');
  } catch {
    // 如果根目录没有,尝试插件目录
    try {
      return require('./plugins/medical-aesthetics-lead/node_modules/better-sqlite3');
    } catch {
      console.error('❌ 缺少依赖: better-sqlite3');
      console.error('   安装方式: pnpm add better-sqlite3');
      process.exit(1);
    }
  }
})();

const Database = PluginDB;
const fs = require('fs');
const path = require('path');

// 配置
const DB_PATH = process.env.DB_PATH || './data/ma-lead/ma-lead.db';
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || './migrations';

// 确保目录存在
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
if (!fs.existsSync(MIGRATIONS_DIR)) {
  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
}

// 初始化数据库
const db = new Database(DB_PATH);

// 启用WAL模式
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * 创建迁移版本表
 */
function createMigrationsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      execution_time_ms INTEGER,
      checksum TEXT
    );
  `);
}

/**
 * 获取当前版本
 */
function getCurrentVersion() {
  createMigrationsTable();
  const row = db
    .prepare('SELECT MAX(version) as version FROM schema_migrations')
    .get();
  return row?.version || 0;
}

/**
 * 获取所有迁移文件
 */
function getMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.match(/^\d+_/))
    .sort();

  return files
    .map((file) => {
      const match = file.match(/^(\d+)_(.+)\.(up|down)\.sql$/);
      if (!match) return null;

      return {
        version: parseInt(match[1], 10),
        name: match[2],
        direction: match[3],
        file,
        path: path.join(MIGRATIONS_DIR, file)
      };
    })
    .filter(Boolean);
}

/**
 * 获取待执行的迁移
 */
function getPendingMigrations() {
  const currentVersion = getCurrentVersion();
  const migrations = getMigrations();

  // 获取up方向的迁移
  const upMigrations = migrations.filter((m) => m.direction === 'up');

  return upMigrations.filter((m) => m.version > currentVersion);
}

/**
 * 执行迁移
 */
function runMigration(migration) {
  const sql = fs.readFileSync(migration.path, 'utf-8');
  const checksum = require('crypto')
    .createHash('md5')
    .update(sql)
    .digest('hex');

  const startTime = Date.now();

  try {
    // 在事务中执行
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, execution_time_ms, checksum) VALUES (?, ?, ?, ?)'
      ).run(
        migration.version,
        migration.name,
        Date.now() - startTime,
        checksum
      );
    })();

    return {
      success: true,
      version: migration.version,
      name: migration.name,
      time: Date.now() - startTime
    };
  } catch (error) {
    return {
      success: false,
      version: migration.version,
      name: migration.name,
      error: error.message,
      time: Date.now() - startTime
    };
  }
}

/**
 * 向上迁移(执行所有待执行迁移)
 */
function migrateUp(targetVersion = null) {
  console.log('🚀 开始向上迁移...\n');

  const pending = getPendingMigrations();
  if (pending.length === 0) {
    console.log('✅ 数据库已是最新版本');
    return;
  }

  if (targetVersion) {
    console.log(`📍 目标版本: ${targetVersion}`);
  }

  const results = [];
  let currentVersion = getCurrentVersion();

  for (const migration of pending) {
    if (targetVersion && migration.version > targetVersion) {
      break;
    }

    console.log(`⏳ 执行迁移 ${migration.version}_${migration.name}...`);
    const result = runMigration(migration);

    if (result.success) {
      console.log(`   ✅ 完成 (${result.time}ms)`);
      currentVersion = migration.version;
    } else {
      console.log(`   ❌ 失败: ${result.error}`);
      console.log('\n⚠️  迁移失败,停止后续迁移');
      break;
    }

    results.push(result);
  }

  console.log(`\n📊 迁移报告:`);
  console.log(`   当前版本: ${getCurrentVersion()}`);
  console.log(`   成功: ${results.filter((r) => r.success).length}`);
  console.log(`   失败: ${results.filter((r) => !r.success).length}`);
}

/**
 * 向下迁移(回滚最后一次迁移)
 */
function migrateDown() {
  console.log('⬇️  开始回滚最后一次迁移...\n');

  const currentVersion = getCurrentVersion();
  if (currentVersion === 0) {
    console.log('✅ 没有可回滚的迁移');
    return;
  }

  // 查找对应的down迁移
  const migrations = getMigrations();
  const downMigration = migrations.find(
    (m) => m.direction === 'down' && m.version === currentVersion
  );

  if (!downMigration) {
    console.log(`❌ 未找到版本 ${currentVersion} 的回滚脚本`);
    console.log(
      `   请在 ${MIGRATIONS_DIR} 目录创建 ${currentVersion}_*.down.sql`
    );
    return;
  }

  console.log(`⏳ 回滚迁移 ${downMigration.version}_${downMigration.name}...`);

  const sql = fs.readFileSync(downMigration.path, 'utf-8');
  const startTime = Date.now();

  try {
    db.transaction(() => {
      db.exec(sql);
      db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(
        currentVersion
      );
    })();

    console.log(`   ✅ 回滚完成 (${Date.now() - startTime}ms)`);
    console.log(`\n📊 当前版本: ${getCurrentVersion()}`);
  } catch (error) {
    console.log(`   ❌ 回滚失败: ${error.message}`);
  }
}

/**
 * 显示迁移状态
 */
function showStatus() {
  console.log('📋 迁移状态\n');

  createMigrationsTable();

  const currentVersion = getCurrentVersion();
  console.log(`当前版本: ${currentVersion}`);

  const applied = db
    .prepare(
      'SELECT version, name, applied_at, execution_time_ms FROM schema_migrations ORDER BY version'
    )
    .all();

  if (applied.length > 0) {
    console.log('\n已应用的迁移:');
    for (const row of applied) {
      console.log(
        `  ✅ ${row.version}_${row.name} (${row.execution_time_ms}ms) - ${row.applied_at}`
      );
    }
  }

  const pending = getPendingMigrations();
  if (pending.length > 0) {
    console.log('\n待执行的迁移:');
    for (const m of pending) {
      console.log(`  ⏳ ${m.version}_${m.name}`);
    }
  } else {
    console.log('\n✅ 没有待执行的迁移');
  }
}

/**
 * 创建新迁移文件
 */
function createMigration(name) {
  const version = Date.now(); // 使用时间戳作为版本号
  const upFile = `${version}_${name}.up.sql`;
  const downFile = `${version}_${name}.down.sql`;

  const upPath = path.join(MIGRATIONS_DIR, upFile);
  const downPath = path.join(MIGRATIONS_DIR, downFile);

  if (fs.existsSync(upPath)) {
    console.log(`❌ 迁移文件已存在: ${upFile}`);
    return;
  }

  // 创建up迁移模板
  fs.writeFileSync(
    upPath,
    `-- 迁移: ${name}\n-- 版本: ${version}\n-- 向上迁移\n\n-- 在这里编写SQL\n-- 例如:\n-- ALTER TABLE users ADD COLUMN email TEXT;\n-- CREATE INDEX idx_users_email ON users(email);\n`
  );

  // 创建down迁移模板
  fs.writeFileSync(
    downPath,
    `-- 回滚: ${name}\n-- 版本: ${version}\n-- 向下回滚\n\n-- 在这里编写回滚SQL\n-- 例如:\n-- DROP INDEX IF EXISTS idx_users_email;\n-- ALTER TABLE users DROP COLUMN email;\n`
  );

  console.log(`✅ 已创建迁移文件:`);
  console.log(`   Up:   ${upFile}`);
  console.log(`   Down: ${downFile}`);
  console.log(`\n📝 请编辑文件添加SQL语句`);
}

/**
 * 显示帮助
 */
function showHelp() {
  console.log(`
SQLite数据库迁移工具

用法:
  node db-migrate.cjs <command> [options]

命令:
  up [version]     向上迁移(可选指定目标版本)
  down             回滚最后一次迁移
  status           查看迁移状态
  create <name>    创建新迁移文件
  help             显示帮助

示例:
  node db-migrate.cjs up                    # 执行所有待执行迁移
  node db-migrate.cjs up 5                  # 迁移到版本5
  node db-migrate.cjs down                  # 回滚最后一次迁移
  node db-migrate.cjs status                # 查看状态
  node db-migrate.cjs create add-email      # 创建迁移文件

环境变量:
  DB_PATH              数据库路径 (默认: ./data/ma-lead/ma-lead.db)
  MIGRATIONS_DIR       迁移文件目录 (默认: ./migrations)

迁移文件命名规则:
  {version}_{name}.up.sql   - 向上迁移
  {version}_{name}.down.sql - 向下回滚

示例:
  001_create_users.up.sql
  001_create_users.down.sql
  002_add_email_index.up.sql
  002_add_email_index.down.sql
`);
}

// 主程序
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
        console.log('   示例: node db-migrate.cjs create add-email');
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
  db.close();
}
