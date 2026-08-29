/**
 * 运行期对话记录仓储。
 *
 * 与线索消息物理隔离：无关对话只落 ma_transcript（按 run_key），**绝不创建线索**，
 * 因此不会污染看板。只有模型真正调用 lead_qualify 时，才把该 run 的 transcript
 * 归集（去重）到已存在的线索上（见 lead-service.attachRunTranscript）。
 */

import { getDb, getDbAsync, dbCall, allRows, getRow, runStmt, type SqliteDatabase } from '../infra/db';
import { appendLeadMessage, leadExists, getMessages } from './lead-repo';

/** 落一条运行期对话记录（不建线索）。 */
export async function appendTranscript(runKey: string, role: string, text: string): Promise<void> {
  if (!runKey) return;
  await dbCall(async () => {
    (await getDb())
      .prepare('INSERT INTO ma_transcript (run_key, role, text, created_at) VALUES (?, ?, ?, ?)')
      .run(runKey, role, String(text ?? '').slice(0, 4000), Date.now());
  }, '写入对话记录');
}

/** 读取某 run 的对话记录。 */
export async function readTranscript(runKey: string): Promise<{ role: string; text: string; t: number }[]> {
  return await dbCall(async () => {
    const rows = await allRows((await getDb()).prepare('SELECT role, text, created_at FROM ma_transcript WHERE run_key = ? ORDER BY id ASC LIMIT 200'), runKey);
    return rows.map((r) => ({ role: String(r.role), text: String(r.text), t: Number(r.created_at) }));
  }, '读取对话记录');
}

/**
 * 把某 run 的对话记录归集到已存在的线索（去重）。线索不存在则跳过（绝不建档）。
 * 返回归集条数。
 */
export async function attachRunTranscript(leadId: string, runKey: string): Promise<number> {
  if (!leadId || !runKey) return 0;
  if (!leadExists(leadId)) return 0;
  const turns = readTranscript(runKey);
  if (!turns.length) return 0;
  for (const t of turns) appendLeadMessage(leadId, t.role, t.text, runKey);
  return turns.length;
}
