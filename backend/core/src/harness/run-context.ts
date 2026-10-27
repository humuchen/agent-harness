// RunContext —— runInner 的可变运行状态容器（H1 设计资产，H2 起逐步启用）。
//
// 背景（P1#21）：runInner（~1140 行）内约 40 个闭包变量互相交织，是「一个函数一个系统」。
// 本接口把全部状态显式化，字段注释即「写读矩阵」——每个字段标注谁写（W）谁读（R），
// 后续把 runInner 按阶段拆为 run-phases/ 模块函数时，阶段间仅经此容器通信，禁止互引。
//
// 搬移纪律（每批一个 commit，全测后合入）：
//   H2: setup / input-gate / finalize 外迁（边界最清晰）
//   H3: output-gate / plan-finish 外迁
//   H4: loop 拆分（loop-llm / loop-tools——最大风险，最后做）

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
