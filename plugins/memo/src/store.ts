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
export function saveNote(text: string, tag?: string): MemoNote {
  const notes = loadAll();
  const note: MemoNote = { id: randomUUID(), text, tag, createdAt: Date.now() };
  notes.unshift(note);
  saveAll(notes);
  return note;
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
