// RunContext —— runInner 的运行状态契约（H1 设计资产）。
//
// 背景（P1#21）：runInner（~1140 行）内约 40 个闭包变量互相交织，是「一个函数一个系统」。
// 拆分实际落地时采用了比「全量搬入容器」更稳的路径：自包含段以**显式参数 + 返回值**
// 外迁（避免一次数百行的引用改写 diff），含循环控制的段以**动作枚举**表达 continue/return。
// H1-H3 已完成，run-phases/ 现有 10 个模块：
//   signal-setup / time-budget / dynamic-tools / memory-setup / plan-finish / finalize
//   / output-gate / final-output / assistant-turn / loop-llm
// loop-tools（三阶段并发编排）经评估**有意保持内联**（并发池闭包共享状态的拆分风险
// 高于收益，见 harness.ts 段内决策注释）。
// 本文件保留的三类产物接口（RunSignalSetup/RunTimeBudget/StepToolsSelection）即各
// 阶段函数的返回契约；后续若引入更多阶段，沿用同一模式扩展。

/** 装配段产物：组合后的中止信号 + 清理函数。 */
export interface RunSignalSetup {
  /** 组合「外部取消」与「超时」的单一信号。 */
  signal: AbortSignal;
  /** run 结束（含提前 return）必须调用：清超时定时器 + 解绑外部 abort 监听。 */
  cleanup(): void;
}

/** 时间预算段产物（P4.8 治本三缺陷的计算部分）。 */
export interface RunTimeBudget {
  startedAt: number;
  runTimeoutMs: number;
  /** 绝对截止时刻；无超时配置时为 Infinity。 */
  deadlineAt: number;
  /** 软截止阈值（已强制收敛到总预算的 1/4 以内）。 */
  softDeadlineMs: number;
  /** 是否已进入软截止窗口（剩余预算不足以再跑完一轮工具 + LLM）。 */
  isPastSoftDeadline(): boolean;
  /** 单次工具调用超时（挂死工具不再拖垮整步）。 */
  toolCallTimeoutMs: number;
}

/** 动态工具选择段产物。 */
export interface StepToolsSelection {
  /** 发送给 LLM 的 schema 子集（执行始终走全量注册表）。 */
  tools: import('../types').ToolSchema[];
  /** 动态选择是否开启（DYNAMIC_TOOLS !== 'false'）——供「点名未发出工具」的兜底分支判断。 */
  dynamicOn: boolean;
}
