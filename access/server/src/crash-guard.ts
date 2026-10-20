/**
 * 进程级崩溃防护（P0-2：从 server.ts 抽出）。
 *
 * 防止未捕获异常导致整进程裸崩（防御性，不替代正常的错误边界）。
 * - uncaughtException：可能使事件循环处于非法状态，记录后安全退出，
 *   交由守护进程（k8s/Render）重启。
 * - unhandledRejection：仅记录，不退出，避免单个被拒 Promise 拖垮在线服务。
 *
 * 从 server.ts 抽出的目的：
 *   1) 让崩溃防护逻辑可独立测试与审计；
 *   2) server.ts 聚焦 HTTP 路由编排，进程级兜底是横切关注点。
 */
import { logError, emitAlert } from '@agent-harness/core';
import { isBenignStreamError } from './http-helpers';

/**
 * 安装进程级崩溃防护：uncaughtException 安全退出，unhandledRejection 仅记录。
 * 应在进程启动早期调用一次。
 */
export function installCrashGuard(): void {
  const fatal = (where: string, err: unknown) => {
    const e = err as { message?: string; stack?: string };
    logError('crash.guard', err, { where });
    emitAlert(
      'fatal',
      'crash.guard',
      `${where}: ${e?.message ?? String(err)}`,
      { where, stack: e?.stack }
    );
    console.error(`[fatal] ${where}:`, e?.message ?? err, '\n', e?.stack ?? '');
  };
  process.on('uncaughtException', (err) => {
    // 白名单放行：SSE/响应流写入失败（write after end、连接重置等）只说明
    // 「往已关闭的连接写数据没写成」，不表示进程状态非法。此时 exit(1) 会让
    // 平台重启服务，把一条无害的 SSE 竞态放大成**全部在途请求 503**
    // （线上「agent 跑一半就 503」的放大路径）。仅记录告警，不退出。
    // 其余未知异常维持原语义：记录后安全退出，交由守护进程重启。
    if (isBenignStreamError(err)) {
      fatal('benign-stream', err);
      return;
    }
    fatal('uncaughtException', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    fatal('unhandledRejection', reason);
  });
}
