/**
 * node:sqlite 连接（零依赖，进程内关系库）。
 * 表结构：会话 / 工单 / 知识库。首次连接自动建表（IF NOT EXISTS）。
 *
 * node:sqlite 的 TS 类型在 @types/node@20 尚未提供，故按 ma-lead 同款做法用
 * 动态 require + 本地接口，绕开类型声明缺口（运行时 Node 22+ 自带该模块）。
 */
import { join, resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getConfig } from '../config';

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
let _ctor: (new (file: string) => SqliteDatabase) | null = null;

/** 懒加载 node:sqlite 构造器（动态 require，避免静态类型缺口）。 */
function sqliteCtor(): new (file: string) => SqliteDatabase {
  if (!_ctor) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req: NodeRequire = require;
    _ctor = (req('node:sqlite') as { DatabaseSync: new (file: string) => SqliteDatabase }).DatabaseSync;
  }
  return _ctor;
}

/** 取得（并惰化建表）连接。 */
export function getDb(): SqliteDatabase {
  if (_db) return _db;
  const { db } = getConfig();
  // node:sqlite 不会自动创建父目录；缺目录时 ensure（含多副本共享卷场景）。
  mkdirSync(dirname(db.file), { recursive: true });
  const Ctor = sqliteCtor();
  const database = new Ctor(db.file);
  database.exec(`PRAGMA journal_mode = WAL;`);
  database.exec(`PRAGMA busy_timeout = ${db.busyTimeoutMs};`);
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
