/**
 * 备忘存储：统一数据库适配器（SQLite node:sqlite / Turso，经 @agent-harness/core getDbAdapter）。
 *
 * 演进说明（落库 + 用户绑定）：
 * - 早期版本为零依赖 JSON 文件（data/memo/notes.json，原子 rename 防半写）。
 *   现改为落库（memo_notes 表），支持后续数据管理（按用户查询/统计/清理）。
 * - 每条备忘归属一个 owner（= 登录用户 sub / 用户名）：所有读写函数均接收 owner
 *   并按其过滤，跨用户不可互见；删除也按 (owner, id) 双条件收口，杜绝越权删除。
 * - 旧 JSON 数据无归属：首次建表时若检测到 notes.json 且表为空，自动导入到
 *   'legacy' 桶（不丢数据，但任何登录用户不可见；管理员可在库中改写 owner 归还），
 *   然后把原文件改名 notes.json.migrated 防止重复导入。
 * - 库文件落点：MEMO_DATA_DIR 设置时为 <dir>/memo.db（测试注入/独立部署），
 *   否则走平台统一库（DB_BACKEND/DB_SQLITE_FILE/TURSO_* 由 db-adapter 收敛，默认 data/app.db）。
 * - 全部函数为 async：本地 sqlite 同步返回，Turso 后端返回 Promise，调用方 await 无感切换。
 */

import { getDbAdapter, type DbAdapter } from '@agent-harness/core';
import { mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 旧 JSON 数据的兜底桶（仅服务端保留，登录用户不可见；与 chat-sessions 的 legacy 语义一致）。 */
export const LEGACY_OWNER = 'legacy';

/** 单条备忘（owner = 归属登录用户）。 */
export interface MemoNote {
  id: string;
  owner: string;
  text: string;
  tag?: string;
  createdAt: number;
  /** 提醒触发时间（epoch ms）；未设置则无提醒。 */
  remindAt?: number;
  /** 是否已触发过提醒（防重复提醒）。 */
  notified?: boolean;
  /**
   * 提醒被前端确认（ack）落库的时间（epoch ms）。
   * 与 notified 的区别：notified 只表达「已提醒过」，notifiedAt 额外记录「何时确认」，
   * 供看板渲染「提醒历史」——否则错过的提醒无从回查，用户只能干等下一次 fire。
   */
  notifiedAt?: number;
}

/** 解析库文件路径：MEMO_DATA_DIR（绝对路径优先，测试注入）> 平台默认库。 */
function dbFile(): string | undefined {
  if (process.env.MEMO_DATA_DIR) {
    const dir = resolve(process.env.MEMO_DATA_DIR);
    mkdirSync(dir, { recursive: true });
    return join(dir, 'memo.db');
  }
  // 未显式指定 → 交由 db-adapter 统一收敛（DB_SQLITE_FILE > data/app.db；Turso 由 TURSO_URL 决定）。
  return process.env.DB_SQLITE_FILE || undefined;
}

let schemaReady: Promise<DbAdapter> | null = null;
let schemaDirKey: string | null = null;

/** 惰性取库 + 幂等建表 + 旧 JSON 迁移。
 *  MEMO_DATA_DIR 变化时（测试逐用例注入临时目录）重建：不同目录 = 不同库。 */
function ensureDb(): Promise<DbAdapter> {
  const dirKey = process.env.MEMO_DATA_DIR ? resolve(process.env.MEMO_DATA_DIR) : null;
  if (!schemaReady || dirKey !== schemaDirKey) {
    schemaDirKey = dirKey;
    schemaReady = (async () => {
      const db = getDbAdapter({ file: dbFile() });
      await db.exec(`
        CREATE TABLE IF NOT EXISTS memo_notes (
          id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          text TEXT NOT NULL,
          tag TEXT,
          created_at INTEGER NOT NULL,
          remind_at INTEGER,
          notified INTEGER,
          notified_at INTEGER
        );
      `);
      try {
        await db.exec('CREATE INDEX IF NOT EXISTS idx_memo_notes_owner ON memo_notes(owner, created_at);');
        await db.exec('CREATE INDEX IF NOT EXISTS idx_memo_notes_remind ON memo_notes(remind_at, notified);');
      } catch {
        /* 索引建失败不致命（Turso 老版本可能不支持 IF NOT EXISTS 的部分形态） */
      }
      await migrateLegacyJson(db);
      return db;
    })();
  }
  return schemaReady;
}

/** 行 → MemoNote（布尔字段从 0/1 还原；NULL → undefined）。 */
function rowToNote(r: Record<string, unknown>): MemoNote {
  return {
    id: String(r.id),
    owner: String(r.owner),
    text: String(r.text),
    tag: r.tag == null ? undefined : String(r.tag),
    createdAt: Number(r.created_at),
    remindAt: r.remind_at == null ? undefined : Number(r.remind_at),
    notified: r.notified == null ? undefined : !!Number(r.notified),
    notifiedAt: r.notified_at == null ? undefined : Number(r.notified_at),
  };
}

/**
 * 旧 notes.json 一次性迁移：表为空且旧文件存在时，导入为 legacy 桶后改名 .migrated。
 * 任何一步失败都静默跳过（迁移不阻断正常读写；文件仍在，下次可重试）。
 */
async function migrateLegacyJson(db: DbAdapter): Promise<void> {
  try {
    const dir = process.env.MEMO_DATA_DIR
      ? resolve(process.env.MEMO_DATA_DIR)
      : resolve(process.cwd(), 'data', 'memo');
    const f = join(dir, 'notes.json');
    if (!existsSync(f)) return;
    const row = (await db.prepare('SELECT COUNT(*) AS c FROM memo_notes').get()) as
      | { c: number | bigint }
      | undefined;
    if (row && Number(row.c) > 0) return; // 库里已有数据：不覆盖，仅保留旧文件
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as Array<Partial<MemoNote>>;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      renameSync(f, `${f}.migrated`);
      return;
    }
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO memo_notes (id, owner, text, tag, created_at, remind_at, notified, notified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const n of parsed) {
      await stmt.run(
        String(n.id ?? randomUUID()),
        LEGACY_OWNER,
        String(n.text ?? ''),
        n.tag ?? null,
        Number(n.createdAt ?? Date.now()),
        n.remindAt ?? null,
        n.notified == null ? null : n.notified ? 1 : 0,
        n.notifiedAt ?? null
      );
    }
    renameSync(f, `${f}.migrated`);
  } catch {
    /* 迁移失败不致命：旧文件保留，下次启动重试 */
  }
}

/** 新增一条备忘（归属 owner）。 */
export async function saveNote(
  owner: string,
  text: string,
  tag?: string,
  remindAt?: number
): Promise<MemoNote> {
  const db = await ensureDb();
  const note: MemoNote = {
    id: randomUUID(),
    owner,
    text,
    tag,
    createdAt: Date.now(),
    remindAt,
    notified: remindAt == null ? undefined : false,
  };
  await db
    .prepare(
      'INSERT INTO memo_notes (id, owner, text, tag, created_at, remind_at, notified) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      note.id,
      note.owner,
      note.text,
      note.tag ?? null,
      note.createdAt,
      note.remindAt ?? null,
      note.notified == null ? null : note.notified ? 1 : 0
    );
  return note;
}

/**
 * 提醒时区：AI 传「不带时区」的 ISO（如 2026-09-01T09:28:00）时，按此时区解释为用户
 * 所在的墙上时间（默认 Asia/Shanghai，可用 REMINDER_TZ 覆盖）。
 *
 * 背景 bug：Render 等 UTC 服务器上 Date.parse('2026-09-01T09:28:00') 按服务器时区(UTC)
 * 解析，09:28 的提醒实际被存成 17:28 (GMT+8)，晚 8 小时才触发；而看板按 UTC 渲染又把
 * 17:28 显示回 "09:28"，双重错位互相抵消，问题被掩盖。
 */
const DISPLAY_TZ = process.env.REMINDER_TZ?.trim() || 'Asia/Shanghai';

/** ISO 字符串是否已带时区（Z 或 ±HH:MM / ±HHMM 结尾）。 */
function isTzAware(s: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
}

/** 计算某 UTC 时刻在目标时区的偏移（ms）＝ 目标时区墙上时间 − UTC。 */
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  // hour 可能出现 "24"（某些 ICU 的午夜形态），归一化为 0。
  const hour = Number(p.hour) % 24;
  const wall = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hour,
    Number(p.minute),
    Number(p.second)
  );
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/** 把「不带时区」的 ISO 字符串按目标时区解析为 epoch ms（先按 UTC 解出墙上时间再减偏移）。 */
function parseNaiveInZone(iso: string, tz: string): number {
  const t = Date.parse(`${iso}Z`);
  if (!Number.isFinite(t)) return NaN;
  return t - tzOffsetMs(t, tz);
}

/**
 * 解析提醒时间：接受 epoch ms（number）或 ISO 字符串。
 * ISO 已带时区（Z / ±HH:MM）→ 直接解析；不带时区 → 按 DISPLAY_TZ 的墙上时间解析。
 * 返回 epoch ms；非法 / 过去时间返回 null（调用方据此忽略提醒）。
 */
export function resolveRemindAt(raw: unknown, iso?: unknown): number | null {
  let ms: number | null = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    ms = raw;
  } else if (typeof iso === 'string' && iso.trim()) {
    const s = iso.trim();
    const t = isTzAware(s) ? Date.parse(s) : parseNaiveInZone(s, DISPLAY_TZ);
    if (Number.isFinite(t)) ms = t;
  }
  if (ms == null || !Number.isFinite(ms)) return null;
  // 只接受未来时间；过去时间视为无效。
  return ms > Date.now() ? Math.floor(ms) : null;
}

/** 列出某用户的备忘（可选按 tag 过滤，按写入倒序，limit 上限 200）。 */
export async function listNotes(owner: string, tag?: string, limit = 50): Promise<MemoNote[]> {
  const db = await ensureDb();
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  const rows = tag
    ? await db
        .prepare(
          'SELECT * FROM memo_notes WHERE owner = ? AND tag = ? ORDER BY created_at DESC LIMIT ?'
        )
        .all(owner, tag, n)
    : await db
        .prepare('SELECT * FROM memo_notes WHERE owner = ? ORDER BY created_at DESC LIMIT ?')
        .all(owner, n);
  return (rows as Record<string, unknown>[]).map(rowToNote);
}

/** 删除某用户的一条备忘；(owner, id) 不匹配返回 false（越权删除视同不存在）。 */
export async function deleteNote(owner: string, id: string): Promise<boolean> {
  const db = await ensureDb();
  const r = await db
    .prepare('DELETE FROM memo_notes WHERE owner = ? AND id = ?')
    .run(owner, id);
  return Number(r.changes) > 0;
}

/** 待提醒项（全用户，调度器用）：remindAt 已到（≤ now）且尚未 notified 的备忘。 */
export async function pendingReminders(now = Date.now()): Promise<MemoNote[]> {
  const db = await ensureDb();
  const rows = await db
    .prepare(
      'SELECT * FROM memo_notes WHERE remind_at IS NOT NULL AND notified = 0 AND remind_at <= ? ORDER BY remind_at ASC'
    )
    .all(now);
  return (rows as Record<string, unknown>[]).map(rowToNote);
}

/** 某用户的即将到来的提醒（remindAt 在未来），按时间升序，limit 上限 50。 */
export async function upcomingReminders(owner: string, limit = 50): Promise<MemoNote[]> {
  const db = await ensureDb();
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 50));
  const rows = await db
    .prepare(
      'SELECT * FROM memo_notes WHERE owner = ? AND remind_at IS NOT NULL AND remind_at > ? ORDER BY remind_at ASC LIMIT ?'
    )
    .all(owner, Date.now(), n);
  return (rows as Record<string, unknown>[]).map(rowToNote);
}

/**
 * 标记某用户的备忘已提醒（notified=true）并写入 ack 时间戳，避免重复提醒；
 * 返回是否真的发生变更（幂等：重复 ack 返回 false）。
 */
export async function markNotified(owner: string, id: string): Promise<boolean> {
  const db = await ensureDb();
  const r = await db
    .prepare(
      'UPDATE memo_notes SET notified = 1, notified_at = ? WHERE owner = ? AND id = ? AND notified = 0'
    )
    .run(Date.now(), owner, id);
  return Number(r.changes) > 0;
}

/**
 * 提醒历史：某用户已触发过提醒（已 ack）的备忘，按确认时间倒序，limit 上限 50。
 *
 * 排序键：优先 ack 时间（notified_at），回退提醒时间（remind_at），最后回退创建时间。
 * （兼容历史数据的语义在 SQL 内用 COALESCE 表达；老 JSON 数据迁移后 notified_at 可能缺省。）
 */
export async function reminderHistory(owner: string, limit = 20): Promise<MemoNote[]> {
  const db = await ensureDb();
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 20));
  const rows = await db
    .prepare(
      `SELECT * FROM memo_notes
       WHERE owner = ? AND notified = 1 AND remind_at IS NOT NULL
       ORDER BY COALESCE(notified_at, remind_at, created_at) DESC
       LIMIT ?`
    )
    .all(owner, n);
  return (rows as Record<string, unknown>[]).map(rowToNote);
}

// ─── 数据管理（查询 / 统计 / 批量清理）──────────────────────────────────────────
// 全部以 owner 收口：跨用户不可互见、越权删除被静默忽略（与 listNotes/deleteNote 一致）。

/** 数据管理检索条件：标签过滤 + 关键词（文本模糊匹配）+ 分页 + 排序。 */
export interface NoteQuery {
  tag?: string;
  /** 关键词：对 text 做 LIKE 模糊匹配（大小写取决于数据库 collation，sqlite 默认不区分 ASCII 大小写）。 */
  q?: string;
  limit?: number;
  offset?: number;
  /** 排序：newest=按创建时间倒序（默认），oldest=正序，remind=按提醒时间升序（无提醒排最后）。 */
  sort?: 'newest' | 'oldest' | 'remind';
}

/** 数据管理检索：分页 + 关键词 + 标签过滤 + 排序，返回 {items, total}（total 不受分页影响，便于前端算页数）。 */
export async function searchNotes(
  owner: string,
  q: NoteQuery = {}
): Promise<{ items: MemoNote[]; total: number }> {
  const db = await ensureDb();
  const cond: string[] = ['owner = ?'];
  const params: unknown[] = [owner];
  if (q.tag) {
    cond.push('tag = ?');
    params.push(q.tag);
  }
  if (q.q) {
    cond.push('text LIKE ?');
    params.push(`%${q.q}%`);
  }
  const where = cond.join(' AND ');
  const totalRow = (await db
    .prepare(`SELECT COUNT(*) AS c FROM memo_notes WHERE ${where}`)
    .get(...params)) as { c: number | bigint } | undefined;
  const total = Number(totalRow?.c ?? 0);
  const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50) || 50));
  const offset = Math.max(0, Math.floor(q.offset ?? 0) || 0);
  // 排序键白名单（仅允许已知键拼入 SQL，杜绝注入）。
  const orderBy =
    q.sort === 'oldest'
      ? 'created_at ASC'
      : q.sort === 'remind'
        ? 'CASE WHEN remind_at IS NULL THEN 1 ELSE 0 END, remind_at ASC'
        : 'created_at DESC';
  const rows = await db
    .prepare(`SELECT * FROM memo_notes WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { items: (rows as Record<string, unknown>[]).map(rowToNote), total };
}

/** 数据管理统计：总数 / 带标签数 / 含提醒数 / 已触发历史数（均按 owner 收口）。 */
export async function noteStats(owner: string): Promise<{
  total: number;
  tagged: number;
  withReminder: number;
  history: number;
}> {
  const db = await ensureDb();
  const one = async (sql: string, ...p: unknown[]): Promise<number> => {
    const row = (await db.prepare(sql).get(...p)) as { c: number | bigint } | undefined;
    return Number(row?.c ?? 0);
  };
  const [total, tagged, withReminder, history] = await Promise.all([
    one('SELECT COUNT(*) AS c FROM memo_notes WHERE owner = ?', owner),
    one("SELECT COUNT(*) AS c FROM memo_notes WHERE owner = ? AND tag IS NOT NULL AND tag != ?", owner, ''),
    one('SELECT COUNT(*) AS c FROM memo_notes WHERE owner = ? AND remind_at IS NOT NULL', owner),
    one(
      'SELECT COUNT(*) AS c FROM memo_notes WHERE owner = ? AND notified = 1 AND remind_at IS NOT NULL',
      owner
    ),
  ]);
  return { total, tagged, withReminder, history };
}

/**
 * 数据管理批量删除：按 owner + ids 收口，越权/不存在的 id 静默忽略，返回实际删除条数。
 * ids 经参数化绑定（IN 占位符），不拼 SQL 字符串，杜绝注入。
 */
export async function deleteNotes(owner: string, ids: string[]): Promise<number> {
  const safe = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  if (safe.length === 0) return 0;
  const db = await ensureDb();
  const ph = safe.map(() => '?').join(', ');
  const r = await db
    .prepare(`DELETE FROM memo_notes WHERE owner = ? AND id IN (${ph})`)
    .run(owner, ...safe);
  return Number(r.changes);
}

/** 数据管理清空：删除当前用户全部备忘（owner  scoped），返回删除条数。前端需二次确认。 */
export async function deleteAllOwnerNotes(owner: string): Promise<number> {
  const db = await ensureDb();
  const r = await db.prepare('DELETE FROM memo_notes WHERE owner = ?').run(owner);
  return Number(r.changes);
}

/** 数据管理：当前用户用过的去重标签列表（按字母升序，供看板标签过滤下拉）。 */
export async function noteTags(owner: string): Promise<string[]> {
  const db = await ensureDb();
  const rows = await db
    .prepare(
      "SELECT DISTINCT tag FROM memo_notes WHERE owner = ? AND tag IS NOT NULL AND tag != ? ORDER BY tag ASC"
    )
    .all(owner, '');
  return (rows as Record<string, unknown>[])
    .map((r) => String(r.tag))
    .filter(Boolean);
}
