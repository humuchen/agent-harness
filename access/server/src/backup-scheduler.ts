/**
 * 数据库备份调度器（P0-E）：定时执行 scripts/backup-db.cjs，防止生产环境零备份。
 * 使用 node:child_process 直接调用，不依赖外部 cron，进程内 setInterval 驱动。
 *
 * 环境变量：
 *   AH_BACKUP_INTERVAL_MS  备份间隔（毫秒），默认 86400000（24h）
 *   AH_BACKUP_DIR          备份目录（默认 /var/lib/agent-harness/backups）
 *   AH_BACKUP_KEEP_DAYS    保留天数（默认 30）
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _meta = (globalThis as any).import?.meta;
const BACKUP_SCRIPT = join(
  dirname(_meta?.url ? fileURLToPath(_meta.url) : __dirname),
  '..', '..', 'scripts', 'backup-db.cjs'
);
const INTERVAL_MS = Number(process.env.AH_BACKUP_INTERVAL_MS) || 86_400_000; // 24h
const BACKUP_DIR  = process.env.AH_BACKUP_DIR          || '/var/lib/agent-harness/backups';
const KEEP_DAYS   = Number(process.env.AH_BACKUP_KEEP_DAYS) || 30;

let timer: ReturnType<typeof setInterval> | null = null;

/** 执行一次备份。失败仅记日志，不抛异常（避免影响主进程）。 */
function runOneBackup(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [
      BACKUP_SCRIPT, '--action', 'backup', '--dir', BACKUP_DIR, '--keep', String(KEEP_DAYS)
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('close', (code) => {
      if (code === 0) { console.log(`[backup] 成功 → ${BACKUP_DIR}`); resolve(); }
      else { const e = new Error(`[backup] 失败 code=${code}: ${stderr.trim()}`); console.error(e.message); reject(e); }
    });
    proc.on('error', (e) => { console.error('[backup] 启动失败:', e.message); reject(e); });
  });
}

/**
 * 启动定时备份，首次立即执行，之后按 INTERVAL_MS 间隔执行。
 * 返回停止函数。
 */
export function scheduleBackup(): () => void {
  runOneBackup().catch((e) => console.error('[backup] 首次失败:', e.message));
  timer = setInterval(() => { runOneBackup().catch((e) => console.error('[backup] 定时失败:', e.message)); }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log(`[backup] 定时备份已启用: 间隔=${INTERVAL_MS / 1000}s, 目录=${BACKUP_DIR}, 保留=${KEEP_DAYS}天`);
  return () => { if (timer) { clearInterval(timer); timer = null; console.log('[backup] 已停止'); } };
}

export function stopBackup(): void { if (timer) { clearInterval(timer); timer = null; } }
