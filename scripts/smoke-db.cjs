#!/usr/bin/env node
/**
 * 真实 MySQL / PostgreSQL 冒烟（迁移上线前的最后一道验证）。
 *
 * 用法：
 *   DATABASE_URL='mysql://root:pass@localhost:3306/ah_smoke' node scripts/smoke-db.cjs
 *   DATABASE_URL='postgres://postgres:pass@localhost:5432/ah_smoke' node scripts/smoke-db.cjs
 *
 * 验证项（对应 store 层实际 SQL 形态）：
 *   1. 自愈建表（CREATE TABLE IF NOT EXISTS，含 TEXT 主键 / AUTOINCREMENT / REAL）
 *   2. 参数化写入 + 读取回读（含多字节中文与引号转义）
 *   3. INSERT OR IGNORE 幂等（重跑不重复）
 *   4. ON CONFLICT DO UPDATE upsert（MySQL 翻译为 ON DUPLICATE KEY UPDATE）
 *   5. 更新与行数统计
 * 全部通过退出码 0，任一失败非零。
 */
async function main() {
  const url = process.env.DATABASE_URL || '';
  const { dialectFromUrl, getDbAdapter } = require(path.join(__dirname, '..', 'backend', 'core', 'dist', 'index.js'));
  const dialect = dialectFromUrl(url);
  if (!dialect) {
    console.error('用法：DATABASE_URL=\'mysql://...|postgres://...\' node scripts/smoke-db.cjs');
    process.exit(2);
  }
  const db = getDbAdapter({ backend: dialect, url });
  console.log(`[smoke] 目标：${dialect}`);

  // 1) 自愈建表（重复跑也走 IF NOT EXISTS）
  await db.exec(
    'CREATE TABLE IF NOT EXISTS smoke_accounts (' +
      'id TEXT PRIMARY KEY, name TEXT, score REAL, seq INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME)'
  );
  console.log('✅ 1/5 自愈建表');

  // 2) 参数化写入 + 回读（中文 / 引号 / 浮点 / null）
  await db.exec('DELETE FROM smoke_accounts');
  await db
    .prepare('INSERT INTO smoke_accounts (id, name, score, ts) VALUES (?, ?, ?, ?)')
    .run('a1', "Bob's 中文🎉", 3.14, null);
  await db
    .prepare('INSERT INTO smoke_accounts (id, name, score, ts) VALUES (?, ?, ?, ?)')
    .run('a2', '张三', -0.5, null);
  const got = await db.prepare('SELECT id, name, score FROM smoke_accounts WHERE id = ?').get('a1');
  assert(got && got.name === "Bob's 中文🎉" && Math.abs(Number(got.score) - 3.14) < 1e-9, '回读不符: ' + JSON.stringify(got));
  console.log('✅ 2/5 参数化写入回读（中文/引号/浮点/null）');

  // 3) INSERT OR IGNORE 幂等
  await db
    .prepare('INSERT OR IGNORE INTO smoke_accounts (id, name, score, ts) VALUES (?, ?, ?, ?)')
    .run('a1', 'dup', 0, null);
  const n3 = Number((await db.prepare('SELECT COUNT(*) AS n FROM smoke_accounts').get()).n);
  assert.strictEqual(n3, 2, `OR IGNORE 后应仍 2 行，实际 ${n3}`);
  console.log('✅ 3/5 INSERT OR IGNORE 幂等');

  // 4) upsert（ON CONFLICT DO UPDATE）
  await db
    .prepare(
      'INSERT INTO smoke_accounts (id, name, score, ts) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET name=excluded.name, score=excluded.score'
    )
    .run('a1', 'updated', 9.99, null);
  const up = await db.prepare('SELECT name, score FROM smoke_accounts WHERE id = ?').get('a1');
  assert(up && up.name === 'updated' && Math.abs(Number(up.score) - 9.99) < 1e-9, 'upsert 未生效: ' + JSON.stringify(up));
  console.log('✅ 4/5 ON CONFLICT DO UPDATE upsert');

  // 5) 更新 + 行数
  await db.prepare('UPDATE smoke_accounts SET score = ? WHERE id = ?').run(1.0, 'a2');
  const n5 = Number((await db.prepare('SELECT COUNT(*) AS n FROM smoke_accounts').get()).n);
  assert.strictEqual(n5, 2);
  console.log('✅ 5/5 更新与行数统计');

  console.log(`\n[smoke] ✅ ${dialect} 全部通过`);
}

const path = require('path');
function assert(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error('[smoke] ❌ 失败：', e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
);
