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
  const turns = await readTranscript(runKey);
  if (!turns.length) return 0;
  for (const t of turns) await appendLeadMessage(leadId, t.role, t.text, runKey);
  // P0 隐私 + P1 去重：归集完成后即删除该 run 的记录——此前注释声称「去重」但无实现，
  // 同一 run 多次 qualify 会把消息翻倍落库；删除后天然幂等，且减少医疗对话的无限留存
  // （从未归集的无关对话由保留期清理兜底，见 pruneOldTranscripts）。
  await dbCall(async () => {
    (await getDb())
      .prepare('DELETE FROM ma_transcript WHERE run_key = ?')
      .run(runKey);
  }, '清理已归集对话记录');
  return turns.length;
}

/**
 * 清理 N 天前的运行期对话记录（保留期兜底；返回删除行数）。
 * 由插件 onStart 调度周期执行（MA_TRANSCRIPT_RETENTION_DAYS，默认 30 天，0 = 禁用）。
 */
export async function pruneOldTranscripts(retentionDays: number): Promise<number> {
  if (!retentionDays || retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  return await dbCall(async () => {
    const r = (await getDb())
      .prepare('DELETE FROM ma_transcript WHERE created_at < ?')
      .run(cutoff);
    return Number((r as { changes?: number }).changes ?? 0);
  }, '清理过期对话记录');
}
