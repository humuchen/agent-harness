/**
 * 数据库连接（通过统一 db-adapter，支持 sqlite / turso 双后端）。
 * 表结构：会话 / 工单 / 知识库。首次连接自动建表（IF NOT EXISTS）。
 *
 * 后端切换：
 *   - DB_BACKEND=sqlite（默认）：node:sqlite 内置，零 npm 依赖
 *   - DB_BACKEND=turso：@libsql/client/node（Turso 云端 SQLite）
 *   - 自动回退：turso 初始化失败时降级为本地 sqlite
 */
import { dirname } from 'node:path';
import { getConfig } from '../config';
import { getDbAdapter, DbAdapter } from '@agent-harness/core';

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

let _db: SqliteDatabase | null = null;

/** 取得（并惰化建表）连接。 */
export function getDb(): SqliteDatabase {
  if (_db) return _db;
  const { db } = getConfig();
  // 使用统一适配器（自动按 DB_BACKEND 环境变量选择 sqlite 或 turso）
  const adapter = getDbAdapter({
    file: db.file,
    pragmas: {
      journalMode: 'wal',
      busyTimeoutMs: db.busyTimeoutMs,
    },
  });
  const database = adapter as unknown as SqliteDatabase;
  database.exec(`
    CREATE TABLE IF NOT EXISTS cs_session (
      session_id   TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL DEFAULT 'default',
      channel      TEXT,
      customer_id  TEXT,
      status       TEXT NOT NULL DEFAULT 'open',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cs_ticket (
      ticket_id    TEXT PRIMARY KEY,
      session_id   TEXT,
      tenant_id    TEXT NOT NULL DEFAULT 'default',
      subject      TEXT NOT NULL,
      channel      TEXT,
      priority     TEXT NOT NULL DEFAULT 'normal',
      status       TEXT NOT NULL DEFAULT 'open',
      assignee     TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      sla_due_at   TEXT,
      rating       INTEGER,
      rating_comment TEXT,
      rated_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS cs_kb (
      kb_id     INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      question  TEXT NOT NULL,
      answer    TEXT NOT NULL,
      category  TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cs_kb_tenant ON cs_kb(tenant_id);

    -- 客服提醒表：agent 分析产出的待处理提醒项
    CREATE TABLE IF NOT EXISTS cs_reminder (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL DEFAULT 'default',
      lead_id        TEXT NOT NULL,
      name           TEXT,
      phone          TEXT,
      project        TEXT,
      last_visit     TEXT,
      days_since     INTEGER,
      activity_title TEXT,
      activity_id    TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      source_slot    INTEGER,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, lead_id, source_slot)
    );
    CREATE INDEX IF NOT EXISTS idx_cs_reminder_status ON cs_reminder(tenant_id, status, created_at DESC);

    -- 增强坐席池：人工坐席档案（在线状态 + 负载），handoff 最闲优先自动指派。
    CREATE TABLE IF NOT EXISTS cs_agent_seat (
      seat_id         TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL DEFAULT 'default',
      name            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'offline',
      active_sessions INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cs_seat_tenant_status ON cs_agent_seat(tenant_id, status, active_sessions);
  `);
  ensureTicketColumns(database);
  ensureSessionColumns(database);
  _db = database;
  return _db;
}

/**
 * 存量库自愈迁移：cs_ticket 增列（sla_due_at / rating / rating_comment / rated_at）。
 * 以「SELECT 探测 → 失败即 ALTER」实现（不依赖 PRAGMA，对 turso 后端同样成立）。
 */
function ensureTicketColumns(db: SqliteDatabase): void {
  const columns: Array<[string, string]> = [
    ['sla_due_at', 'sla_due_at TEXT'],
    ['rating', 'rating INTEGER'],
    ['rating_comment', 'rating_comment TEXT'],
    ['rated_at', 'rated_at TEXT'],
  ];
  ensureColumns(db, 'cs_ticket', columns);
}

/** 存量库自愈迁移：cs_session 增 assigned_seat（坐席池指派）。 */
function ensureSessionColumns(db: SqliteDatabase): void {
  ensureColumns(db, 'cs_session', [['assigned_seat', 'assigned_seat TEXT']]);
}

/** 通用列自愈：SELECT 探测失败即 ALTER（并发竞态下列已存在则忽略）。 */
function ensureColumns(db: SqliteDatabase, table: string, columns: Array<[string, string]>): void {
  for (const [column, ddl] of columns) {
    try {
      db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).get();
    } catch {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      } catch {
        /* 列已存在则忽略 */
      }
    }
  }
}

/** 关闭连接（onStop / 测试用）。 */
export function closeDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore */
    }
    _db = null;
  }
}
