// 时间预算计算（P4.8 治「等很久 → 硬超时 → 无产出」三处结构性缺陷的计算部分）。
// P1#21 自 runInner 迁出，数值与语义逐字等价（isPastSoftDeadline 闭包改为返回方法）。

/** 时间预算段产物，见 harness/run-context.ts 的 RunTimeBudget。 */
export interface RunTimeBudget {
  startedAt: number;
  runTimeoutMs: number;
  deadlineAt: number;
  softDeadlineMs: number;
  isPastSoftDeadline(): boolean;
  toolCallTimeoutMs: number;
}

/**
 * @param timeoutMs 运行级超时（opts.timeoutMs；0/undefined = 不限时 → deadlineAt=Infinity）。
 */
export function computeTimeBudget(timeoutMs: number | undefined): RunTimeBudget {
  const startedAt = Date.now();
  const runTimeoutMs =
    timeoutMs && timeoutMs > 0 ? timeoutMs : 0;
  const deadlineAt = runTimeoutMs > 0 ? startedAt + runTimeoutMs : Infinity;
  // 软截止：剩余预算低于该阈值时主动要求模型收尾（替代硬超时砍掉产出）。置 0 关闭。
  // 缺省 90s，并强制收敛到总预算的 1/4 以内 —— 否则「总超时 60s 而软截止 90s」会让
  // 收尾指令在第一步就触发，等于剥夺模型的正常执行过程。
  const softDeadlineCfg = Math.max(
    0,
    Number(process.env.AGENT_SOFT_DEADLINE_MS ?? 90_000) || 0
  );
  const softDeadlineMs =
    runTimeoutMs > 0 ? Math.min(softDeadlineCfg, Math.floor(runTimeoutMs / 4)) : softDeadlineCfg;
  const isPastSoftDeadline = (): boolean =>
    softDeadlineMs > 0 &&
    Number.isFinite(deadlineAt) &&
    Date.now() >= deadlineAt - softDeadlineMs;
  // 单次工具调用超时：挂死的工具不再拖垮整步 —— 超时即放弃等待，把「工具超时」
  // 作为工具结果回传，模型可据此改道或基于已有信息继续。置 0 关闭。缺省 5 分钟。
  const toolCallTimeoutMs = Math.max(
    0,
    Number(process.env.AGENT_TOOL_TIMEOUT_MS ?? 300_000) || 0
  );
  return { startedAt, runTimeoutMs, deadlineAt, softDeadlineMs, isPastSoftDeadline, toolCallTimeoutMs };
}
