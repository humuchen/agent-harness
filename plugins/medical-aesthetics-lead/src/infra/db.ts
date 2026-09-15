/**
 * 真实关系库接入（通过统一 db-adapter，支持 sqlite / turso 双后端）。
 *
 * 这是本次重构的核心：把原来「散落 JSON 文件 + 内存扫目录聚合」换成**真实数据库 + 真实 SQL**。
 * - 线索、项目知识库、院区、号源、预约单、CRM 发件箱、入站消息全部落表；
 * - 看板漏斗/渠道/等级分布改由 SQL 聚合（GROUP BY）产出，不再在 Node 里遍历文件；
 * - 号源占用走**事务 + 条件更新**，天然防超卖（见 schedule-repo）。
 *
 * 后端切换：
 *   - DB_BACKEND=sqlite（默认）：node:sqlite 内置，零 npm 依赖
 *   - DB_BACKEND=turso：@libsql/client/node（Turso 云端 SQLite）
 *   - 自动回退：turso 初始化失败时降级为本地 sqlite
 */

import { dirname } from 'node:path';
import { getConfig } from '../config';
import { MaError } from './errors';
import { getDbAdapter, DbAdapter } from '@agent-harness/core';

/** node:sqlite 预编译语句的最小接口（始终返回 Promise，由包装层兼容 sqlite 同步 / turso 异步）。 */
export interface SqliteStatement {
  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  get(...params: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(...params: unknown[]): Promise<Record<string, unknown>[]>;
}

/** node:sqlite 数据库的最小接口。 */
export interface SqliteDatabase {
  exec(sql: string): Promise<void>;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type MaybePromise<T> = T | Promise<T>;

let db: SqliteDatabase | null = null;
let dbReady: Promise<SqliteDatabase> | null = null;

/** 表结构定义（幂等 DDL，每次启动执行；新增列走 migrate() 增量）。 */
const SCHEMA = `
-- 客资线索：业务系统记录（system of record）
CREATE TABLE IF NOT EXISTS ma_lead (
  lead_id         TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'default',
  channel         TEXT NOT NULL,
  intent          TEXT,
  project         TEXT,
  budget          TEXT,
  city            TEXT,
  grade           TEXT,
  stage           TEXT NOT NULL DEFAULT 'new',
  reached         TEXT NOT NULL DEFAULT 'new',
  stage_updated_at INTEGER NOT NULL DEFAULT 0,
  name            TEXT,
  phone           TEXT,
  wechat          TEXT,
  consent_at      INTEGER,
  clinic_id       TEXT,
  clinic_name     TEXT,
  booking_date    TEXT,
  booking_time    TEXT,
  appointment_id  TEXT,
  handed_off      INTEGER NOT NULL DEFAULT 0,
  handoff_reason  TEXT,
  consulted_by    TEXT,
  crm_id          TEXT,
  crm_sync_state  TEXT NOT NULL DEFAULT 'pending',
  crm_synced_at   INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_lead_tenant_stage   ON ma_lead(tenant_id, stage);
CREATE INDEX IF NOT EXISTS ix_lead_tenant_updated ON ma_lead(tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_lead_channel        ON ma_lead(tenant_id, channel);
CREATE INDEX IF NOT EXISTS ix_lead_handoff        ON ma_lead(tenant_id, handed_off, consulted_by);

-- 线索对话消息（已归属线索）
CREATE TABLE IF NOT EXISTS ma_lead_message (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     TEXT NOT NULL,
  run_id      TEXT,
  role        TEXT NOT NULL,
  text        NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_msg_lead ON ma_lead_message(lead_id, id);

-- 线索阶段变更历史（运营分析用：漏斗留存耗时、阶段到达率）
CREATE TABLE IF NOT EXISTS ma_lead_stage_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     TEXT NOT NULL,
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  from_stage  TEXT NOT NULL,
  to_stage    TEXT NOT NULL,
  changed_at  INTEGER NOT NULL,
  operated_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_log_lead ON ma_lead_stage_log(lead_id, changed_at);
CREATE INDEX IF NOT EXISTS ix_log_tenant ON ma_lead_stage_log(tenant_id, changed_at);

-- 运行期对话记录（尚未归属线索；lead_qualify 时按 run_key 归集到线索）
CREATE TABLE IF NOT EXISTS ma_transcript (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key     TEXT NOT NULL,
  role        TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_transcript_run ON ma_transcript(run_key, id);

-- 项目知识库：内容由运营经导入接口写入 / 由外部 KB 服务同步落库，源码不内置任何语料
CREATE TABLE IF NOT EXISTS ma_project (
  project_id        TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL DEFAULT 'default',
  name              TEXT NOT NULL,
  category          TEXT,
  aliases           TEXT,
  summary           TEXT NOT NULL,
  indications       TEXT,
  contraindications TEXT,
  recovery          TEXT,
  price_range       TEXT,
  faq               TEXT,
  source            TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  updated_at        INTEGER NOT NULL,
  -- P0 结构化扩编：经营 / 检索增强字段
  intent_tags       TEXT,
  combo_with        TEXT,
  audience          TEXT,
  seasonality       TEXT,
  duration_min      INTEGER,
  pain_level        INTEGER,
  downtime_days     TEXT,
  course_sessions   TEXT,
  avg_price_tier    TEXT,
  -- P1 合规内建
  compliant_copy       TEXT,
  compliance_reviewed  INTEGER NOT NULL DEFAULT 0,
  -- P1.5 活动关联（用于未活跃客户提醒）
  activity_title       TEXT,
  activity_id          TEXT,
  -- P1 语义检索（JSON 数组文本；未配置嵌入服务时为 NULL）
  embedding         TEXT
);
CREATE INDEX IF NOT EXISTS ix_project_tenant ON ma_project(tenant_id, active);

-- 意图 → 项目 映射（knowledge/domain/intent-map.json 落库；支撑意图归一检索）
CREATE TABLE IF NOT EXISTS ma_project_intent (
  intent      TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  weight      INTEGER NOT NULL DEFAULT 1,
  keywords    TEXT,
  PRIMARY KEY (intent, project_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS ix_intent_tenant ON ma_project_intent(tenant_id, intent);

-- 院区（权威来源可为 HIS；本表为查询副本）
CREATE TABLE IF NOT EXISTS ma_clinic (
  clinic_id  TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL DEFAULT 'default',
  name       TEXT NOT NULL,
  city       TEXT,
  address    TEXT,
  phone      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_clinic_city ON ma_clinic(tenant_id, city, active);

-- 号源：capacity/booked 支持并发占用；UNIQUE 约束保证同院区同时段唯一
CREATE TABLE IF NOT EXISTS ma_slot (
  slot_id    TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL DEFAULT 'default',
  clinic_id  TEXT NOT NULL,
  slot_date  TEXT NOT NULL,
  slot_time  TEXT NOT NULL,
  capacity   INTEGER NOT NULL DEFAULT 1,
  booked     INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'open',
  doctor     TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, clinic_id, slot_date, slot_time)
);
CREATE INDEX IF NOT EXISTS ix_slot_lookup ON ma_slot(tenant_id, clinic_id, slot_date, status);

-- 号源缓存（HIS 同步用，TTL 缓存避免抖动）
CREATE TABLE IF NOT EXISTS slot_cache (
  clinic_id  TEXT NOT NULL,
  date       TEXT NOT NULL,
  tenant_id  TEXT NOT NULL DEFAULT 'default',
  slots_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, clinic_id, date)
);

-- 预约单
CREATE TABLE IF NOT EXISTS ma_appointment (
  appointment_id TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL DEFAULT 'default',
  lead_id        TEXT NOT NULL,
  clinic_id      TEXT NOT NULL,
  slot_id        TEXT NOT NULL,
  slot_date      TEXT NOT NULL,
  slot_time      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'booked',
  external_id    TEXT,
  external_status TEXT,
  arrived_at     INTEGER,
  completed_at   INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_appt_lead ON ma_appointment(lead_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_appt_slot_active
  ON ma_appointment(slot_id, lead_id) WHERE status = 'booked';

-- CRM 同步发件箱：至少一次投递，避免上游抖动丢客资
CREATE TABLE IF NOT EXISTS ma_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL DEFAULT 'default',
  topic           TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload         TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_retry_at   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_outbox_due ON ma_outbox(state, next_retry_at);

-- 渠道入站消息（webhook 落库，去重 + 可重放）
CREATE TABLE IF NOT EXISTS ma_inbound_message (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL DEFAULT 'default',
  channel      TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  lead_key     TEXT NOT NULL,
  text         TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'received',
  run_id       TEXT,
  error        TEXT,
  received_at  INTEGER NOT NULL,
  processed_at INTEGER,
  UNIQUE(tenant_id, channel, external_id)
);
CREATE INDEX IF NOT EXISTS ix_inbound_state ON ma_inbound_message(state, received_at);
`;

/**
 * 取得（并按需初始化）数据库连接。进程内单例。
 * 首次调用会建目录、开 WAL、执行幂等 DDL。
 * 返回 Promise（Turso HTTP 模式下初始化为异步，需 await）。
 */
export async function getDb(): Promise<SqliteDatabase> {
  if (db) return db;
  if (dbReady) return dbReady;
  dbReady = (async () => {
    const cfg = getConfig();
    const adapter = getDbAdapter({
      file: cfg.db.file,
      pragmas: {
        journalMode: 'wal',
        busyTimeoutMs: cfg.db.busyTimeoutMs,
        foreignKeys: true,
      },
    });
    // 包装适配器：将同步返回值包装为 Promise，使接口统一为 async
    const wrapped: SqliteDatabase = {
      exec: (sql: string): Promise<void> => {
        const r = adapter.exec(sql);
        return r instanceof Promise ? r : Promise.resolve();
      },
      prepare: (sql: string) => {
        const stmt = adapter.prepare(sql);
        return {
          run: (...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }> => {
            const r = stmt.run(...params);
            return r instanceof Promise ? r : Promise.resolve(r);
          },
          get: (...params: unknown[]): Promise<Record<string, unknown> | undefined> => {
            const r = stmt.get(...params);
            return r instanceof Promise ? r : Promise.resolve(r);
          },
          all: (...params: unknown[]): Promise<Record<string, unknown>[]> => {
            const r = stmt.all(...params);
            return r instanceof Promise ? r : Promise.resolve(r);
          },
        };
      },
      close: () => adapter.close?.(),
    };
    await wrapped.exec(SCHEMA);
    await runMigrations(wrapped);
    db = wrapped;
    return db;
  })().catch((e) => {
    dbReady = null;
    const cfg = getConfig();
    throw new MaError('DB_ERROR', `客资库初始化失败（${cfg.db.file}）：${(e as Error).message}`, {
      file: cfg.db.file,
    });
  });
  return dbReady;
}

/**
 * 幂等迁移：为已存在（由旧 schema 创建）的库补列，避免 ALTER 重复执行报错。
 * 仅在列确实缺失时执行，全新库因 CREATE TABLE 已含该列而跳过。
 */
async function runMigrations(conn: SqliteDatabase): Promise<void> {
  // --- ma_lead analytics columns ---
  const leadResult = await conn.prepare(`PRAGMA table_info(ma_lead)`).all();
  const leadCols = (leadResult as Record<string, unknown>[]).map((r) => String(r.name));
  if (!leadCols.includes('stage_updated_at')) {
    await conn.exec(`ALTER TABLE ma_lead ADD COLUMN stage_updated_at INTEGER NOT NULL DEFAULT 0;`);
  }

  // --- ma_appointment analytics columns ---
  const apptResult = await conn.prepare(`PRAGMA table_info(ma_appointment)`).all();
  const apptCols = (apptResult as Record<string, unknown>[]).map((r) => String(r.name));
  if (!apptCols.includes('external_status')) {
    await conn.exec(`ALTER TABLE ma_appointment ADD COLUMN external_status TEXT;`);
  }
  if (!apptCols.includes('arrived_at')) {
    await conn.exec(`ALTER TABLE ma_appointment ADD COLUMN arrived_at INTEGER;`);
  }
  if (!apptCols.includes('completed_at')) {
    await conn.exec(`ALTER TABLE ma_appointment ADD COLUMN completed_at INTEGER;`);
  }

  // --- ma_lead_stage_log (analytics stage transition log) ---
  await conn.exec(`
    CREATE TABLE IF NOT EXISTS ma_lead_stage_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id     TEXT NOT NULL,
      tenant_id   TEXT NOT NULL DEFAULT 'default',
      from_stage  TEXT NOT NULL,
      to_stage    TEXT NOT NULL,
      changed_at  INTEGER NOT NULL,
      operated_by TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_log_lead ON ma_lead_stage_log(lead_id, changed_at);
    CREATE INDEX IF NOT EXISTS ix_log_tenant ON ma_lead_stage_log(tenant_id, changed_at);
  `);

  const projResult = await conn.prepare(`PRAGMA table_info(ma_project)`).all();
  const projCols = (projResult as Record<string, unknown>[]).map((r) => String(r.name));
  const projAdd: Record<string, string> = {
    intent_tags: 'TEXT',
    combo_with: 'TEXT',
    audience: 'TEXT',
    seasonality: 'TEXT',
    duration_min: 'INTEGER',
    pain_level: 'INTEGER',
    downtime_days: 'TEXT',
    course_sessions: 'TEXT',
    avg_price_tier: 'TEXT',
    compliant_copy: 'TEXT',
    compliance_reviewed: 'INTEGER NOT NULL DEFAULT 0',
    embedding: 'TEXT',
    activity_title: 'TEXT',
    activity_id: 'TEXT',
  };
  for (const [col, type] of Object.entries(projAdd)) {
    if (!projCols.includes(col)) {
      await conn.exec(`ALTER TABLE ma_project ADD COLUMN ${col} ${type};`);
    }
  }
  await conn.exec(`
    CREATE TABLE IF NOT EXISTS ma_project_intent (
      intent      TEXT NOT NULL,
      project_id  TEXT NOT NULL,
      tenant_id   TEXT NOT NULL DEFAULT 'default',
      weight      INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (intent, project_id, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS ix_intent_tenant ON ma_project_intent(tenant_id, intent);
  `);
}

/** 异步版 runMigrations（Turso HTTP 模式）。 */
async function runMigrationsAsync(conn: SqliteDatabase): Promise<void> {
  // --- ma_lead analytics columns ---
  const leadResult = await conn.prepare(`PRAGMA table_info(ma_lead)`).all();
  const leadCols = (leadResult as Record<string, unknown>[]).map((r) => String(r.name));
  if (!leadCols.includes('stage_updated_at')) {
    await conn.exec(`ALTER TABLE ma_lead ADD COLUMN stage_updated_at INTEGER NOT NULL DEFAULT 0;`);
  }

  // --- ma_appointment analytics columns ---
  const apptResult = await conn.prepare(`PRAGMA table_info(ma_appointment)`).all();
  const apptCols = (apptResult as Record<string, unknown>[]).map((r) => String(r.name));
  if (!apptCols.includes('external_status')) {
    await conn.exec(`ALTER TABLE ma_appointment ADD COLUMN external_status TEXT;`);
  }
  if (!apptCols.includes('arrived_at')) {
    await conn.exec(`ALTER TABLE ma_appointment ADD COLUMN arrived_at INTEGER;`);
  }
  if (!apptCols.includes('completed_at')) {
    await conn.exec(`ALTER TABLE ma_appointment ADD COLUMN completed_at INTEGER;`);
  }

  // --- ma_lead_stage_log (analytics stage transition log) ---
  await conn.exec(`
    CREATE TABLE IF NOT EXISTS ma_lead_stage_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id     TEXT NOT NULL,
      tenant_id   TEXT NOT NULL DEFAULT 'default',
      from_stage  TEXT NOT NULL,
      to_stage    TEXT NOT NULL,
      changed_at  INTEGER NOT NULL,
      operated_by TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_log_lead ON ma_lead_stage_log(lead_id, changed_at);
    CREATE INDEX IF NOT EXISTS ix_log_tenant ON ma_lead_stage_log(tenant_id, changed_at);
  `);

  const projResult = await conn.prepare(`PRAGMA table_info(ma_project)`).all();
  const projCols = (projResult as Record<string, unknown>[]).map((r) => String(r.name));
  const projAdd: Record<string, string> = {
    intent_tags: 'TEXT',
    combo_with: 'TEXT',
    audience: 'TEXT',
    seasonality: 'TEXT',
    duration_min: 'INTEGER',
    pain_level: 'INTEGER',
    downtime_days: 'TEXT',
    course_sessions: 'TEXT',
    avg_price_tier: 'TEXT',
    compliant_copy: 'TEXT',
    compliance_reviewed: 'INTEGER NOT NULL DEFAULT 0',
    embedding: 'TEXT',
    activity_title: 'TEXT',
    activity_id: 'TEXT',
  };
  for (const [col, type] of Object.entries(projAdd)) {
    if (!projCols.includes(col)) {
      await conn.exec(`ALTER TABLE ma_project ADD COLUMN ${col} ${type};`);
    }
  }
  await conn.exec(`
    CREATE TABLE IF NOT EXISTS ma_project_intent (
      intent      TEXT NOT NULL,
      project_id  TEXT NOT NULL,
      tenant_id   TEXT NOT NULL DEFAULT 'default',
      weight      INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (intent, project_id, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS ix_intent_tenant ON ma_project_intent(tenant_id, intent);
  `);
}

/**
 * 异步预热数据库连接（Turso HTTP 模式下 exec/all 为异步，须 await 初始化完成）。
 * 首次调用会建目录、开 WAL、执行幂等 DDL + 迁移；其后直接返回缓存实例。
 * 与 getDb() 等价（getDb 自身即返回 Promise），仅为语义清晰的预热入口。
 */
export async function getDbAsync(): Promise<SqliteDatabase> {
  return getDb();
}

/** 关闭连接（插件 onUnload / 测试清理）。 */
export function closeDb(): void {
  try {
    db?.close();
  } catch {
    /* 关闭失败不阻断卸载 */
  }
  db = null;
  dbReady = null; // 关键：同时清空初始化句柄，否则下次 getDb() 会返回已关闭的旧连接（测试隔离 / 重载后必现 "database is not open"）
}

/** 包装 DB 异常为 MaError('DB_ERROR')。支持同步和异步函数。 */
export async function dbCall<T>(fn: () => T | Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MaError) throw e;
    throw new MaError('DB_ERROR', `${what} 失败：${(e as Error).message}`);
  }
}

/** 规范化 prepare().all()：直接 await。兼容 sqlite 同步 / turso 异步。 */
export async function allRows(stmt: { all: (...p: any[]) => MaybePromise<Record<string, unknown>[]> }, ...params: any[]): Promise<Record<string, unknown>[]> {
  return await stmt.all(...params);
}

export async function getRow(stmt: { get: (...p: any[]) => MaybePromise<Record<string, unknown> | undefined> }, ...params: any[]): Promise<Record<string, unknown> | undefined> {
  return await stmt.get(...params);
}

export async function runStmt(stmt: { run: (...p: any[]) => MaybePromise<{ changes: number; lastInsertRowid: number | bigint }> }, ...params: any[]): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
  return await stmt.run(...params);
}

/**
 * 在事务中执行。用于「号源占用 + 建预约单 + 推进线索阶段」这类必须原子的操作。
 * 抛错自动 ROLLBACK。SQLite 单写者模型下配合 IMMEDIATE 拿写锁，避免并发下的写冲突。
 * 支持异步函数（Turso HTTP 模式下 exec 为异步）。
 */
export async function inTransaction<T>(fn: (conn: SqliteDatabase) => T | Promise<T>): Promise<T> {
  const conn = await getDb();
  await conn.exec('BEGIN IMMEDIATE');
  try {
    const out = await fn(conn);
    await conn.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      await conn.exec('ROLLBACK');
    } catch {
      /* rollback 失败也要把原始错误上抛 */
    }
    if (e instanceof MaError) throw e;
    throw new MaError('DB_ERROR', `事务执行失败：${(e as Error).message}`);
  }
}

/** 健康检查：真实执行一次查询，返回各表行数（看板/运维用）。 */
export async function dbHealth(): Promise<Record<string, unknown>> {
  try {
    const conn = await getDb();
    const counts: Record<string, number> = {};
    for (const t of [
      'ma_lead',
      'ma_project',
      'ma_clinic',
      'ma_slot',
      'ma_appointment',
      'ma_outbox',
      'ma_inbound_message',
    ]) {
      const row = await conn.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get();
      counts[t] = Number(row?.c ?? 0);
    }
    return { ok: true, file: getConfig().db.file, counts };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
