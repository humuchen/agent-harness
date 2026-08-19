/**
 * 真实关系库接入（node:sqlite，Node 22+ 内置，零 npm 依赖）。
 *
 * 这是本次重构的核心：把原来「散落 JSON 文件 + 内存扫目录聚合」换成**真实数据库 + 真实 SQL**。
 * - 线索、项目知识库、院区、号源、预约单、CRM 发件箱、入站消息全部落表；
 * - 看板漏斗/渠道/等级分布改由 SQL 聚合（GROUP BY）产出，不再在 Node 里遍历文件；
 * - 号源占用走**事务 + 条件更新**，天然防超卖（见 schedule-repo）。
 *
 * 类型说明：@types/node@20 尚无 node:sqlite 声明，故以 require + 最小接口断言接入
 * （与 core/src/memory-store.ts 的处理方式一致）。运行期若 node 不支持会抛出清晰错误。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig } from '../config';
import { MaError } from './errors';

/** node:sqlite 预编译语句的最小接口。 */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** node:sqlite 数据库的最小接口。 */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

let db: SqliteDatabase | null = null;

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
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_msg_lead ON ma_lead_message(lead_id, id);

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
 */
export function getDb(): SqliteDatabase {
  if (db) return db;
  const cfg = getConfig();
  try {
    mkdirSync(dirname(cfg.db.file), { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqlite = require('node:sqlite') as { DatabaseSync: new (p: string) => SqliteDatabase };
    const conn = new sqlite.DatabaseSync(cfg.db.file);
    // WAL：读写并发更好；busy_timeout：多副本共享卷时等待锁而非立即失败
    conn.exec(`PRAGMA journal_mode = WAL;`);
    conn.exec(`PRAGMA busy_timeout = ${cfg.db.busyTimeoutMs};`);
    conn.exec(`PRAGMA foreign_keys = ON;`);
    conn.exec(SCHEMA);
    runMigrations(conn);
    db = conn;
    return db;
  } catch (e) {
    throw new MaError('DB_ERROR', `客资库初始化失败（${cfg.db.file}）：${(e as Error).message}`, {
      file: cfg.db.file,
    });
  }
}

/**
 * 幂等迁移：为已存在（由旧 schema 创建）的库补列，避免 ALTER 重复执行报错。
 * 仅在列确实缺失时执行，全新库因 CREATE TABLE 已含该列而跳过。
 */
function runMigrations(conn: SqliteDatabase): void {
  const apptCols = (conn
    .prepare(`PRAGMA table_info(ma_appointment)`)
    .all() as Record<string, unknown>[]).map((r) => String(r.name));
  if (!apptCols.includes('external_status')) {
    conn.exec(`ALTER TABLE ma_appointment ADD COLUMN external_status TEXT;`);
  }
  // ma_project 新列增量迁移（P0 结构化 + P1 合规/语义）
  const projCols = (conn
    .prepare(`PRAGMA table_info(ma_project)`)
    .all() as Record<string, unknown>[]).map((r) => String(r.name));
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
  };
  for (const [col, type] of Object.entries(projAdd)) {
    if (!projCols.includes(col)) {
      conn.exec(`ALTER TABLE ma_project ADD COLUMN ${col} ${type};`);
    }
  }
  // ma_project_intent 表增量创建（旧库可能没有）
  conn.exec(`
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

/** 关闭连接（插件 onUnload / 测试清理）。 */
export function closeDb(): void {
  try {
    db?.close();
  } catch {
    /* 关闭失败不阻断卸载 */
  }
  db = null;
}

/** 包装 DB 异常为 MaError('DB_ERROR')。 */
export function dbCall<T>(fn: () => T, what: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MaError) throw e;
    throw new MaError('DB_ERROR', `${what} 失败：${(e as Error).message}`);
  }
}

/**
 * 在事务中执行。用于「号源占用 + 建预约单 + 推进线索阶段」这类必须原子的操作。
 * 抛错自动 ROLLBACK。SQLite 单写者模型下配合 IMMEDIATE 拿写锁，避免并发下的写冲突。
 */
export function inTransaction<T>(fn: (conn: SqliteDatabase) => T): T {
  const conn = getDb();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(conn);
    conn.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* rollback 失败也要把原始错误上抛 */
    }
    if (e instanceof MaError) throw e;
    throw new MaError('DB_ERROR', `事务执行失败：${(e as Error).message}`);
  }
}

/** 健康检查：真实执行一次查询，返回各表行数（看板/运维用）。 */
export function dbHealth(): Record<string, unknown> {
  try {
    const conn = getDb();
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
      const row = conn.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get();
      counts[t] = Number(row?.c ?? 0);
    }
    return { ok: true, file: getConfig().db.file, counts };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
