/**
 * 备忘存储：零依赖 JSON 文件持久化（原子 rename 防半写）。
 * 数据目录：MEMO_DATA_DIR（绝对路径优先）> cwd/data/memo。
 * 每次调用时惰性读取目录环境变量，便于测试注入临时目录。
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 单条备忘。 */
export interface MemoNote {
  id: string;
  text: string;
  tag?: string;
  createdAt: number;
  /** 提醒触发时间（epoch ms）；未设置则无提醒。 */
  remindAt?: number;
  /** 是否已触发过提醒（防重复提醒）。 */
  notified?: boolean;
  /**
   * 提醒被前端确认（ack）落盘的时间（epoch ms）。
   * 与 notified 的区别：notified 只表达「已提醒过」，notifiedAt 额外记录「何时确认」，
   * 供看板渲染「提醒历史」——否则错过的提醒无从回查，用户只能干等下一次 fire。
   */
  notifiedAt?: number;
}

/** 解析并确保数据目录存在。 */
function dataDir(): string {
  const dir = process.env.MEMO_DATA_DIR
    ? resolve(process.env.MEMO_DATA_DIR)
    : resolve(process.cwd(), 'data', 'memo');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dbFile(): string {
  return join(dataDir(), 'notes.json');
}

/** 读取全部备忘（文件损坏时回退为空，不抛错）。 */
function loadAll(): MemoNote[] {
  const f = dbFile();
  if (!existsSync(f)) return [];
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as MemoNote[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 原子写回全部备忘（tmp + rename）。 */
function saveAll(notes: MemoNote[]): void {
  const f = dbFile();
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(notes, null, 2), 'utf8');
  renameSync(tmp, f);
}

/** 新增一条备忘（新条目排最前）。 */
export function saveNote(text: string, tag?: string, remindAt?: number): MemoNote {
  const notes = loadAll();
  const note: MemoNote = {
    id: randomUUID(),
    text,
    tag,
    createdAt: Date.now(),
    remindAt,
    notified: remindAt == null ? undefined : false,
  };
  notes.unshift(note);
  saveAll(notes);
  return note;
}

/**
 * 解析提醒时间：接受 epoch ms（number）或 ISO 字符串。
 * 返回 epoch ms；非法 / 过去时间返回 null（调用方据此忽略提醒）。
 */
export function resolveRemindAt(raw: unknown, iso?: unknown): number | null {
  let ms: number | null = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    ms = raw;
  } else if (typeof iso === 'string' && iso.trim()) {
    const t = Date.parse(iso.trim());
    if (Number.isFinite(t)) ms = t;
  }
  if (ms == null || !Number.isFinite(ms)) return null;
  // 只接受未来时间；过去时间视为无效。
  return ms > Date.now() ? Math.floor(ms) : null;
}

/** 列出备忘（可选按 tag 过滤，按写入倒序，limit 上限 200）。 */
export function listNotes(tag?: string, limit = 50): MemoNote[] {
  const notes = loadAll();
  const filtered = tag ? notes.filter((n) => n.tag === tag) : notes;
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  return filtered.slice(0, n);
}

/** 删除一条备忘；id 不存在返回 false。 */
export function deleteNote(id: string): boolean {
  const notes = loadAll();
  const next = notes.filter((n) => n.id !== id);
  if (next.length === notes.length) return false;
  saveAll(next);
  return true;
}

/** 待提醒项：remindAt 已到（≤ now）且尚未 notified 的备忘。 */
export function pendingReminders(now = Date.now()): MemoNote[] {
  return loadAll().filter((n) => n.remindAt != null && !n.notified && n.remindAt <= now);
}

/** 即将到来的提醒（remindAt 在未来），按时间升序，limit 上限 50。 */
export function upcomingReminders(limit = 50): MemoNote[] {
  const fut = loadAll()
    .filter((n) => n.remindAt != null && n.remindAt > Date.now())
    .sort((a, b) => (a.remindAt ?? 0) - (b.remindAt ?? 0));
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 50));
  return fut.slice(0, n);
}

/**
 * 标记某条备忘已提醒（notified=true），并写入 ack 时间戳，避免重复提醒；
 * 返回是否真的发生变更（幂等：重复 ack 返回 false）。
 */
export function markNotified(id: string): boolean {
  const notes = loadAll();
  let changed = false;
  for (const n of notes) {
    if (n.id === id && !n.notified) {
      n.notified = true;
      n.notifiedAt = Date.now();
      changed = true;
    }
  }
  if (changed) saveAll(notes);
  return changed;
}

/**
 * 提醒历史：已触发过提醒的备忘，按确认时间倒序（最近触发的在前），limit 上限 50。
 *
 * 兼容历史数据：早期版本的备忘只有 notified 而无 notifiedAt（ack 时未记时间），
 * 这里用 `notifiedAt ?? remindAt ?? createdAt` 兜底排序，保证老数据也能出现在历史里，
 * 不会因为缺字段就整体消失。
 */
export function reminderHistory(limit = 20): MemoNote[] {
  const done = loadAll()
    .filter((n) => n.notified && n.remindAt != null)
    .sort((a, b) => sortKey(b) - sortKey(a));
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 20));
  return done.slice(0, n);
}

/** 提醒历史的排序键：优先 ack 时间，回退提醒时间，最后回退创建时间。 */
function sortKey(n: MemoNote): number {
  return n.notifiedAt ?? n.remindAt ?? n.createdAt;
}
