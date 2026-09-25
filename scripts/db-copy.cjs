#!/usr/bin/env node
/**
 * 数据库搬迁工具（双后端互拷）：sqlite 本地文件 ↔ Turso 远端库。
 *
 * 背景：DB_BACKEND 切换（sqlite ↔ turso）时所有表经 CREATE TABLE IF NOT EXISTS
 * 自愈建表，但**存量数据不迁移**——本工具补上这块：按表拷贝 schema + 数据 + 索引，
 * 并做行数校验。
 *
 * 用法：
 *   # 本地 → Turso（TURSO_URL/TURSO_TOKEN 从 env 读取）
 *   node scripts/db-copy.cjs --from file:./data/app.db --to turso
 *   # Turso → 本地
 *   node scripts/db-copy.cjs --from turso --to file:./data/restored.db
 *   # 本地 → 本地（备份/克隆）
 *   node scripts/db-copy.cjs --from file:./data/app.db --to file:/tmp/backup.db
 *
 * 常用参数：
 *   --tables a,b,c   仅拷贝指定表（缺省全部用户表）
 *   --exclude a,b    排除指定表
 *   --truncate       拷贝前清空目标表（缺省 INSERT OR IGNORE：跳过已存在行，可安全重跑）
 *   --batch N        每条 INSERT 的行数（缺省 100；减少网络往返）
 *   --dry-run        只列出表与行数，不写入
 *
 * 行为约定：
 *   - schema：目标端 CREATE TABLE IF NOT EXISTS（语句取自源端 sqlite_master）；
 *   - 索引：非自动索引（sql 非空）在数据之后创建，IF NOT EXISTS 幂等；
 *   - 视图/触发器不拷贝（按需手工处理）；
 *   - 表按名称序拷贝；SQLite 缺省不启用外键强制，无需拓扑排序；
 *   - 大整数（lastInsertRowid 类）按原值透传；BLOB 以 Uint8Array 透传；
 *   - 结束输出每表行数对照（源 vs 目标），行数不一致以非零码退出。
 *
 * 生产切换建议顺序（runbook）：
 *   1. 停写（或选低峰）：确保源库不再有新写入；
 *   2. node scripts/db-copy.cjs --from file:<源库> --to turso          # 搬数据
 *   3. 复核输出中每表行数一致（源=目标）；
 *   4. 设 DB_BACKEND=turso + TURSO_URL/TURSO_TOKEN → 重启服务；
 *   5. 观察启动日志「后端：Turso (remote)」与各 store 建表日志；保留源库文件作回滚锚点。
 */

const path = require('path');

// 复用核心 DB 适配器（与 db-migrate.cjs 同款加载方式，避免依赖 workspace 解析）
let core;
const coreDist = path.join(__dirname, '..', 'backend', 'core', 'dist', 'index.js');
try {
  core = require(coreDist);
} catch (e) {
  console.error('❌ 无法加载 @agent-harness/core 编译产物（' + coreDist + '）：请先 pnpm --filter @agent-harness/core run build');
  process.exit(1);
}

// ─── CLI 解析 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { batch: 100, tables: null, exclude: null, truncate: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--tables') out.tables = argv[++i];
    else if (a === '--exclude') out.exclude = argv[++i];
    else if (a === '--batch') out.batch = Math.max(1, Number(argv[++i]) || 100);
    else if (a === '--truncate') out.truncate = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`未知参数：${a}（--help 查看用法）`);
      process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`数据库搬迁工具（sqlite ↔ turso 互拷）
用法：
  node scripts/db-copy.cjs --from <dsn> --to <dsn> [options]
DSN：
  file:<path>   本地 SQLite 文件
  turso         远端 Turso（读 env TURSO_URL / TURSO_TOKEN）
示例：
  node scripts/db-copy.cjs --from file:./data/app.db --to turso
  node scripts/db-copy.cjs --from turso --to file:./data/restored.db --tables accounts,chat_history
参数：
  --tables a,b   仅拷贝指定表    --exclude a,b   排除指定表
  --truncate     拷贝前清空目标表（缺省 INSERT OR IGNORE，可安全重跑）
  --batch N      每条 INSERT 行数（缺省 100）
  --dry-run      仅列出表与行数`);
}

/** 解析 DSN 为 adapter 实例与可读标签。支持 file:<path> | turso | mysql | postgres。 */
function openDsn(dsn, side) {
  if (!dsn) {
    console.error(`❌ 缺少 --${side}（file:<path> | turso | mysql | postgres）`);
    process.exit(2);
  }
  if (dsn === 'turso' || dsn === 'mysql' || dsn === 'postgres') {
    if (dsn === 'turso') {
      if (!process.env.TURSO_URL) {
        console.error(`❌ --${side} turso 需要环境变量 TURSO_URL（及 TURSO_TOKEN）`);
        process.exit(2);
      }
      const adapter = core.getDbAdapter({ backend: 'turso', file: ':memory:' });
      return { adapter, label: `turso(${process.env.TURSO_URL})`, dialect: 'sqlite' };
    }
    const url = process.env.DATABASE_URL;
    if (!url || core.dialectFromUrl(url) !== dsn) {
      console.error(`❌ --${side} ${dsn} 需要环境变量 DATABASE_URL（${dsn}://...）`);
      process.exit(2);
    }
    const adapter = core.getDbAdapter({ backend: dsn, url });
    return { adapter, label: `${dsn}(${url.replace(/\/\/[^@]*@/, '//***@')})`, dialect: dsn };
  }
  const m = /^file:(.+)$/.exec(dsn);
  if (!m || !m[1]) {
    console.error(`❌ --${side} DSN 非法：${dsn}（应为 file:<path> | turso | mysql | postgres）`);
    process.exit(2);
  }
  const adapter = core.getDbAdapter({ backend: 'sqlite', file: m[1] });
  return { adapter, label: `sqlite(${m[1]})`, dialect: 'sqlite' };
}

// ─── 表枚举与传输（多方言）────────────────────────────────────────────────────

function qid(name, dialect) {
  const n = String(name).replace(/"/g, '""');
  return dialect === 'mysql' ? '`' + n.replace(/`/g, '``') + '`' : `"${n}"`;
}

function listTables(adapter, dialect) {
  const { sql, params } = core.listTablesSql(dialect);
  const rows = adapter.prepare(sql).all(...params);
  return rows.map((r) => ({ name: String(r.name), sql: r.sql == null ? '' : String(r.sql || '') }));
}

function listIndexes(adapter, dialect) {
  // 索引 DDL 仅 sqlite 源可导（sqlite_master.sql）；mysql/pg 源跳过（目标端自愈建表不含索引，需手工补）
  if (dialect !== 'sqlite') return [];
  const rows = adapter.prepare(
    "SELECT name, sql, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name"
  ).all();
  return rows.map((r) => ({ name: String(r.name), sql: String(r.sql), table: String(r.tbl_name) }));
}

function tableColumns(adapter, dialect, table) {
  const { sql, params } = core.tableColumnsSql(dialect, table);
  const rows = adapter.prepare(sql).all(...params);
  return rows.map((r) => String(r.name));
}

function countRows(adapter, dialect, table) {
  const r = adapter.prepare(`SELECT COUNT(*) AS n FROM ${qid(table, dialect)}`).get();
  return Number(r && r.n);
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function copyTable(src, dst, table, opts, srcDialect, dstDialect) {
  const name = table.name;
  const cols = tableColumns(src, srcDialect, name);
  if (cols.length === 0) {
    console.log(`  ⚠️ ${name}: 无法读取列信息，跳过`);
    return { copied: 0, skipped: true };
  }
  const colList = cols.map((c) => qid(c, dstDialect)).join(', ');
  const placeholders = cols.map(() => '?').join(', ');

  // 目标建表（幂等）：sqlite DDL 经目标适配器翻译为对应方言；仅 sqlite 源携带 DDL
  // （mysql/pg 源的 information_schema 无原始 DDL，目标端由各 store 自愈建表）
  if (table.sql) {
    const ddl = table.sql.replace(/^CREATE\s+TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
    await dst.exec(ddl);
  }

  const total = countRows(src, srcDialect, name);
  if (opts.truncate) {
    await dst.exec(`DELETE FROM ${qid(name, dstDialect)}`);
  }

  let copied = 0;
  const BATCH = Math.max(1, opts.batch);
  for (let offset = 0; offset < total; offset += BATCH) {
    const rows = src
      .prepare(`SELECT ${cols.map((c) => qid(c, srcDialect)).join(', ')} FROM ${qid(name, srcDialect)} LIMIT ${BATCH} OFFSET ${offset}`)
      .all();
    if (rows.length === 0) break;
    // 多行合并为一条 INSERT（减少 turso/mysql/pg 网络往返）；insert or ignore 保证重跑幂等
    // （INSERT OR IGNORE 由目标适配器按方言翻译：MySQL INSERT IGNORE / PG ON CONFLICT DO NOTHING）
    for (const group of chunks(rows, Math.max(1, Math.floor(900 / cols.length)) || 1)) {
      const valuesSql = group.map(() => `(${placeholders})`).join(', ');
      const args = [];
      for (const row of group) {
        for (const c of cols) {
          const v = row[c];
          args.push(v === undefined ? null : v);
        }
      }
      await dst
        .prepare(`INSERT OR IGNORE INTO ${qid(name, dstDialect)} (${colList}) VALUES ${valuesSql}`)
        .run(...args);
      copied += group.length;
    }
    process.stdout.write(`  ${name}: ${copied}/${total}\r`);
  }
  if (total > 0) process.stdout.write(`  ${name}: ${copied}/${total}\n`);
  else console.log(`  ${name}: 0 行，跳过数据传输`);
  return { copied, skipped: false };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.from || !opts.to) {
    printHelp();
    process.exit(opts.help ? 0 : 2);
  }
  const src = openDsn(opts.from, 'from');
  const dst = openDsn(opts.to, 'to');
  console.log(`[db-copy] 源：${src.label}`);
  console.log(`[db-copy] 目标：${dst.label}${opts.truncate ? '（truncate 模式）' : '（INSERT OR IGNORE 幂等）'}`);

  const tables = listTables(src.adapter, src.dialect);
  const include = opts.tables ? new Set(opts.tables.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const exclude = opts.exclude ? new Set(opts.exclude.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const selected = tables.filter(
    (t) => (!include || include.has(t.name)) && (!exclude || !exclude.has(t.name))
  );
  const ignoredByFilter = tables.length - selected.length;
  if (selected.length === 0) {
    console.log('[db-copy] 源库没有可拷贝的表');
    return;
  }
  console.log(`[db-copy] 共 ${tables.length} 张表，选中 ${selected.length}${ignoredByFilter ? `（过滤 ${ignoredByFilter}）` : ''}`);

  if (opts.dryRun) {
    for (const t of selected) {
      console.log(`  ${t.name}: ${countRows(src.adapter, src.dialect, t.name)} 行`);
    }
    console.log('[db-copy] dry-run 结束（未写入）');
    return;
  }

  // 1) schema + 数据（sqlite 源的 DDL 经目标适配器按方言翻译；INSERT OR IGNORE 同样按方言翻译）
  const results = [];
  for (const t of selected) {
    const r = await copyTable(src.adapter, dst.adapter, t, opts, src.dialect, dst.dialect);
    results.push({ table: t.name, ...r, srcCount: countRows(src.adapter, src.dialect, t.name), dstCount: countRows(dst.adapter, dst.dialect, t.name) });
  }

  // 2) 索引（仅 sqlite 源可导出 DDL；数据之后创建，非自动索引才建）
  for (const idx of listIndexes(src.adapter, src.dialect)) {
    if (selected.some((t) => t.name === idx.table)) {
      try {
        await dst.adapter.exec(idx.sql);
      } catch (e) {
        console.warn(`  ⚠️ 索引 ${idx.name} 创建失败（继续）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 3) 校验
  let mismatch = 0;
  console.log('\n[db-copy] 行数校验（源 vs 目标）：');
  for (const r of results) {
    const ok = r.srcCount === r.dstCount;
    if (!ok) mismatch += 1;
    console.log(`  ${ok ? '✅' : '❌'} ${r.table}: 源 ${r.srcCount} / 目标 ${r.dstCount}${ok ? '' : '（不一致）'}`);
  }
  if (mismatch > 0) {
    console.error(`\n[db-copy] ❌ ${mismatch} 张表行数不一致（INSERT OR IGNORE 跳过冲突行时属预期；truncate 模式下不应出现）`);
    process.exit(1);
  }
  console.log('\n[db-copy] ✅ 搬迁完成，行数全部一致');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[db-copy] ❌ 失败：', e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
);
