/**
 * store-safety.ts — 存储数据文件损坏的统一处置策略（P2 数据韧性）。
 *
 * 三件事缺一不可：
 *   1. 告警日志（structLog error + emitAlert，经去重窗口进 webhook/文件双 sink）；
 *   2. 坏文件隔离改名（`<file>.corrupt-<ts>`，保留现场供人工恢复/取证）；
 *   3. 调用方以「空状态」继续（而非静默丢弃或启动崩溃循环）。
 *
 * 背景：此前各 store 各自为政——核心记忆 / 工作流检查点 / AgentCard 损坏时
 * catch 后静默当空数据（数据静默丢失且无任何告警，损坏与「从无数据」不可区分）；
 * RAG 索引损坏则启动即抛错进入崩溃循环。本模块把两条极端路径收敛为同一策略。
 *
 * 只处理「JSON 解析失败」类损坏；文件不存在（ENOENT）是正常空态，由调用方
 * 在读取阶段先行判断，不得进入本模块（否则每次冷启动都会误报）。
 */

import { existsSync, renameSync } from 'node:fs';
import { structLog, emitAlert } from './telemetry';

/**
 * 隔离一个损坏的数据文件并发出告警。
 * @param filePath 损坏文件绝对/相对路径
 * @param store    存储标识（如 'memory' / 'workflow' / 'agents' / 'rag'），仅用于日志定位
 * @param err      触发隔离的原始错误（JSON.parse 异常等）
 * @returns 隔离后的新路径；隔离失败（权限/只读盘）返回 null——告警中会说明
 */
export function quarantineCorruptFile(
  filePath: string,
  store: string,
  err: unknown
): string | null {
  const detail = err instanceof Error ? err.message : String(err);
  let quarantined: string | null = null;
  try {
    if (existsSync(filePath)) {
      quarantined = `${filePath}.corrupt-${Date.now()}`;
      renameSync(filePath, quarantined);
    }
  } catch (renameErr) {
    // 隔离失败也不能退回静默：损坏文件留在原位，下一次读取会再次进入本路径并告警。
    structLog('error', 'store.corrupt.quarantine_failed', {
      store,
      file: filePath,
      error: renameErr instanceof Error ? renameErr.message : String(renameErr),
    });
  }
  structLog('error', 'store.corrupt', {
    store,
    file: filePath,
    error: detail,
    quarantined,
    note: '已按空状态继续；如需恢复请基于 .corrupt-* 文件人工修复',
  });
  // 告警走统一链路（去重窗口 + webhook/文件双 sink）；emitAlert 为 async，空转即可。
  void emitAlert('error', 'store.corrupt', `${store} 数据文件损坏：${detail}`, {
    store,
    file: filePath,
    quarantined,
  }).catch(() => {});
  return quarantined;
}
