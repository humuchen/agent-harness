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
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
  `);
  _db = database;
  return _db;
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
