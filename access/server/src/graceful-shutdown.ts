/**
 * 优雅停机（P0-2：从 server.ts 抽出）。
 *
 * 停机宽限：先中止在飞任务，给其最多该时长退出，再关 MCP 与监听。
 *
 * 从 server.ts 抽出的目的：
 *   1) 让停机逻辑可独立测试（此前与 server.ts 的 2297 行代码耦合）；
 *   2) 通过依赖注入解耦模块级变量，使停机流程可被编排层组合。
 */

/** 优雅停机所需的依赖（由调用方注入）。 */
export interface ShutdownDeps {
  /** 运行队列：abortAll 中止在飞任务，stop 停止轮询并关后端连接。 */
  runQueue: { abortAll(reason: string): void; stop(): void };
  /** MCP 管理器：shutdown 关闭 stdio/SSE 长连接。 */
  mcpManager: { shutdown(): Promise<void> };
  /** HTTP 服务器实例：close 停止接受新连接。 */
  server: { close(cb?: () => void): void };
}

/** 停机处理器 + 状态查询（路由层据此拒绝停机期间的新请求）。 */
export interface ShutdownHandler {
  /** 执行优雅停机，幂等（重复调用不重复执行）。 */
  shutdown(): Promise<void>;
  /** 是否已进入停机流程。路由层据此拒绝新请求。 */
  isShuttingDown(): boolean;
}

/**
 * 创建优雅停机处理器。
 *
 * 流程：
 *   1) 中止所有在飞/排队任务（job 级 AbortController）
 *   2) 停止领取轮询并关闭共享后端（redis）连接
 *   3) 宽限期内让在飞任务退出；超时后不再等待
 *   4) 关闭 MCP 连接
 *   5) 停止接受新连接，等待已建立的连接关闭
 *   6) 兜底强制退出
 *
 * @param deps 依赖注入
 * @param graceMs 宽限期毫秒（默认读 env RUN_SHUTDOWN_GRACE_MS 或 5000）
 * @returns ShutdownHandler（含 shutdown 函数与 isShuttingDown 状态查询）
 */
export function createShutdownHandler(
  deps: ShutdownDeps,
  graceMs: number = Number(process.env.RUN_SHUTDOWN_GRACE_MS ?? 5000) || 5000
): ShutdownHandler {
  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[ui] 收到停机信号，开始优雅停机…');

    // 1) 中止所有在飞/排队任务，释放 worker 与 LLM/MCP 占用。
    deps.runQueue.abortAll('shutdown');

    // 1b) 停止领取轮询并关闭共享后端（redis）连接，避免进程退出后空转。
    deps.runQueue.stop();

    // 2) 宽限期内让在飞任务尽快退出；超时后不再等待。
    await new Promise<void>((resolve) => setTimeout(resolve, graceMs));

    // 3) 关闭 MCP 连接（stdio 子进程 / SSE 长连接），避免资源泄漏。
    await deps.mcpManager.shutdown().catch(() => {});

    // 4) 停止接受新连接，等待已建立的连接（如健康检查）关闭。
    deps.server.close(() => {
      console.log('[ui] 已停止接受新连接。');
      process.exit(0);
    });

    // 兜底：若 server.close 因长连接迟迟不结束，强制退出。
    setTimeout(() => process.exit(0), 3000).unref();
  }

  return {
    shutdown,
    isShuttingDown: () => shuttingDown,
  };
}
