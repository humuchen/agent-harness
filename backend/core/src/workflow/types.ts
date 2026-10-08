/**
 * 工作流编排（统一基座平台 P1-⑤）核心类型。
 *
 * 设计目标：把「多 agent 协同」表达成一个可序列化的 DAG（DAG + 补偿 + 检查点续跑），
 * 让异构 agent（本地 / A2A 远端）像普通 harness 一样被调度，而执行内核不变。
 *
 * 约定（与 agent/router/tenant 一致）：
 * - 全部字段可 JSON 序列化（WorkflowDef / WorkflowRun 要经 redis / 文件存盘、HTTP 传输）。
 * - 所有跨切面字段（tenantId / traceId）可选；缺省即退化为「无工作流元数据」的普通运行。
 * - agentRef 既可是已注册 agent 的 id（字符串），也可是内联 AgentCard（同进程 / A2A 自描述）。
 */

import type { AgentCard } from '../agents/types';
import type { Team } from '../teams';
import type { OutputIssue } from './step-output';

/**
 * 单个 step 的运行态。
 * P1 C5：compensate-failed = 补偿动作执行失败（副作用既未回滚也不会被视为已处理），
 * 非终态 —— resume 时会重试补偿，成功后转为 compensated。
 */
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'compensated' | 'compensate-failed' | 'skipped' | 'awaiting';
/** 整个工作流的运行态。 */
export type WorkflowState = 'pending' | 'running' | 'done' | 'failed' | 'compensated' | 'awaiting';

/** 单个步骤定义（DAG 中的一个节点）。 */
export interface StepDef {
  /** 步骤唯一 id（同工作流内唯一），也是 inputMapping 取上游输出的 key。 */
  id: string;
  /**
   * 目标 agent：字符串 id（经 AgentRegistry 解析）或内联 AgentCard（同进程 / A2A 自描述）。
   * 引擎不关心 agent 是本地还是远端 —— 执行由注入的 executor 决定（本地 harness / HttpA2A）。
   */
  agentRef: string | AgentCard;
  /**
   * 目标团队：字符串 id（经 TeamManager 解析）。
   * 当 `teamRef` 非空时，引擎会通过 TeamManager 按团队协作模式派发任务，
   * 而非直接使用 `agentRef`。`agentRef` 与 `teamRef` 二选一，`teamRef` 优先。
   */
  teamRef?: string;
  /**
   * 输入映射：把「全局初始输入 / 上游 step 输出 / 字面量」映射到本 step 的运行输入。
   * 取值语法（value）：
   *   - `input`        → 工作流的全局初始输入；
   *   - `steps.<id>`   → 同工作流中 id 为 <id> 的 step 的输出；
   *   - 其它字符串      → 作为字面量直接注入。
   * 若为空 / 不填，则本 step 输入 = 工作流全局初始输入。
   */
  inputMapping?: Record<string, string>;
  /** 依赖的 step id（DAG 边）。无依赖则可在首轮并行执行。不允许成环（引擎会抛错）。 */
  dependsOn?: string[];
  /**
   * @deprecated 已弃用。请使用 `onRolling` 替代。
   * 补偿指令（用于失败时回滚）：
   *   - 若等于同 def 内另一个 step 的 id → 失败时逆序执行该 step 作为补偿动作；
   *   - 若为其它的非空字符串 → 作为字面指令交由同一 agent（executor 的 compensate 标志）执行回滚。
   * 不填则无补偿（仅标记该 step 为 compensated）。
   * 引擎自动兼容该字段，但新代码应迁移至 `onRolling`。
   */
  compensate?: string;
  /**
   * 失败补偿（onFailure 回滚）：本 step 失败（或其所在工作流失败）时，逆序执行这些 step 作为回滚动作。
   * 取值：同 def 内另一个 step 的 id（补偿 step 受 DAG 拓扑约束排序执行），
   * 或字面量回滚指令（复用本 step 的 agent 执行，executor 据 ctx.compensate 标志走回滚分支）。
   * 用于替代旧 `compensate: string` 单值字段（现已弃用，引擎仍兼容）。
   */
  onRolling?: string[];

  /**
   * 条件分支（P2）：本 step 是否执行的前置条件。
   * - 若为空 / 不填 → 正常执行（向后兼容）
   * - 若为字符串表达式 → 在运行时求值，结果为 falsy 则跳过本 step
   *   支持语法：
   *   - `steps.<id>.output` → 引用上游 step 的输出
   *   - `steps.<id>.state`  → 引用上游 step 的执行状态（'done' | 'failed'）
   *   - 字面量布尔值（'true' / 'false'）
   * 条件不满足时，本 step 标记为 'skipped'，下游依赖本 step 的 step 会被跳过。
   */
  condition?: string;
  /**
   * P3 人工审批门：标记为 true 的 step 在执行前会暂停整个工作流（run.state → 'awaiting'），
   * 直至调用方把 stepId 写入 `WorkflowRun.approvals` 并 resume 后才放行执行。
   * 未标记的 step 行为与旧版完全一致（零回归面）。
   */
  requireApproval?: boolean;

  /**
   * P6 步骤级重试：执行失败（抛错 / 产出闸门或 outputSchema 校验失败）后的最大重试次数。
   * 指数退避（retryBackoffMs 基数），仅重试瞬时类失败——外部取消（signal aborted）不重试。
   * 缺省 0 = 不重试（存量零回归）。
   */
  retries?: number;
  /** 重试退避基数毫秒（第 n 次重试前等待 base * 2^(n-1)，上限 RETRY_BACKOFF_MAX_MS）。缺省 500。 */
  retryBackoffMs?: number;

  /**
   * P6 动态 fan-out（运行期扇出，对标 LangGraph Send API 的静态 DAG 等价物）：
   * true 时，本 step 成功且产出为含 `spawn` 数组的对象（每项为 SpawnSpec）时，
   * 引擎在本波次完成后把 spawn 项物化为真实 StepDef（id 自动加 `<父id>.` 前缀，
   * dependsOn 强制含父 step），参与后续波次调度、补偿与检查点续跑。
   * 所在波次失败（fail-fast）时未物化的 spawn 丢弃（与「失败不扩散副作用」一致）。
   * 单个 step 最多物化 MAX_DYNAMIC_SPAWN 个子任务。
   */
  dynamic?: boolean;

  /**
   * P6-B subgraph 嵌套复用：引用「已在 WorkflowStore 落过检查点」的另一工作流 def id
   * （POST /api/workflows 即落检查点）。引擎执行本 step 时以嵌套 DagEngine 跑该 def：
   * - 检查点非终态 → resume 续跑（嵌套检查点独立，input 取其自身 initialInput）；
   * - 已 done → 幂等复用该 run 作为产出。
   * 本 step 的 output = 嵌套 WorkflowRun（可序列化；下游取嵌套单步产出需穿透
   * `steps.<本step>.output.steps.<嵌套stepId>.output`）。与 agentRef/teamRef 互斥
   * （defRef 优先）；补偿语义为不透明 step（嵌套工作流的回滚由其自身 def 的
   * onRolling 承担）。防递归：activeChain 环检测 + MAX_SUBGRAPH_DEPTH 硬上限。
   */
  defRef?: string;

  /**
   * P6 产出 schema（JSON-Schema 子集，validateAgainstSchema 校验）：
   * 产出（executor 返回值）不符合 schema 时按失败处置（step failed + 补偿 + 级联，
   * 错误信息含具体路径），与 failOnInvalidOutput 同型但更严格。
   * 仅显式声明的 step 受影响（存量零回归）。
   */
  outputSchema?: Record<string, unknown>;

  /**
   * 运行期物化字面量输入（仅动态 fan-out 子任务使用，手工 def 不用）：
   * spawn 项携带的 `input` 落在此字段；无 inputMapping 时 resolveInput 直接返回它，
   * 有 inputMapping 时以 mapping 为准（literalInput 忽略）。可 JSON 序列化。
   */
  literalInput?: unknown;
}

/**
 * P6 动态 fan-out 的子任务规格（父 step 产出 `spawn` 数组的元素形态）。
 * 全部字段可 JSON 序列化；agentRef 缺省继承父 step 的 agentRef。
 */
export interface SpawnSpec {
  /** 子任务 id（同父内唯一即可，引擎物化时加 `<父id>.` 前缀避免与全局 stepId 冲突）。 */
  id: string;
  /** 目标 agent（缺省继承父 step 的 agentRef）。 */
  agentRef?: string | AgentCard;
  /** 字面量输入（物化后落在子 StepDef.literalInput；与 inputMapping 二选一，均缺省取父产出）。 */
  input?: unknown;
  /** 输入映射（与静态 StepDef 同语法，可引用任意已存在 step 的产出，含父 step）。 */
  inputMapping?: Record<string, string>;
  /** 额外依赖（引擎自动追加父 step id；引用未知 step 时物化失败 → run failed）。 */
  dependsOn?: string[];
  /** 子任务是否需要人工审批（同静态 requireApproval 语义）。 */
  requireApproval?: boolean;
  /** 子任务重试次数（同静态 retries 语义）。 */
  retries?: number;
}

/** 工作流定义（DAG）。 */
export interface WorkflowDef {
  id: string;
  steps: StepDef[];
  /** 全局租户标识（P0.3）：透传给每个 step 的执行上下文，用于记忆分区与护栏策略。 */
  tenantId?: string;
  /** 全局追踪 id：贯穿所有 step 的 agent 调用，OTel span 跨 agent 关联。 */
  traceId?: string;
  /**
   * P4.5 产出有效性闸门：开启后，step 产出经 inspectStepOutput 判定为无效
   * （空 / 中断标记 / 护栏兜底话术）时，该 step 标记 failed（走补偿与级联，同真失败），
   * 而非把无效产出写入黑板并标记 done。缺省 false（存量工作流零回归）；
   * 仅计划桥生成的 def（planToWorkflowDef）默认开启。
   */
  failOnInvalidOutput?: boolean;
  /**
   * P5 执行顺序：parallel（缺省）= 拓扑波次内并行（存量语义）；serial = 拓扑序逐 step
   * 「单步发送」串行执行（上一 step 完成后才派发下一个）。
   * 计划桥（planToWorkflowDef）自 2026-09-20 起「按 DAG 形状自动决策」：最大拓扑波宽
   * > 1 → parallel（带 maxConcurrency 有界并发），纯链状计划 → serial（并行无收益，
   * 且串行保持「思考流 ↔ 当前任务」一一对应）。显式传入仍优先。手工工作流不受影响。
   */
  execMode?: 'parallel' | 'serial';
  /**
   * parallel 波次内最大并发 step 数（正整数；缺省 / 非法 = 不限并发，存量语义零回归）。
   * 计划桥生成的 def 自动携带缺省上限（PLAN_WAVE_CONCURRENCY_DEFAULT），保护 BYOK
   * 速率限制与 token 预算不被同波任务同时打满。serial 模式忽略该字段。
   */
  maxConcurrency?: number;
}

/**
 * P2.5 每 step 调用链路节点：step 执行期间发生的关键事件（LLM 调用 / 工具 / 护栏 / 校验 / 收尾）
 * 的紧凑结构化记录，随检查点持久化，供「执行详情」抽屉回放（此前只有耗时）。
 *
 * 纪律（与 R5 黑板体积护栏一致）：
 * - 节点数有上限（引擎 mergeTrace 超上限截断，保早期调用）；
 * - detail 截断存储；token 级流式增量（llm:token / llm:reasoning）不落盘；
 * - 不落任何凭据：仅记模型名，modelBaseUrl / apiKeys 永不写入（BYOK 红线）。
 */
export interface StepTraceNode {
  /** 源事件类型（run:start / agent:step / llm:call / llm:response / tool:start / tool:result /
   *  guardrail:blocked / verify:result / budget:exceeded / run:cost / run:end / tool:deduped → 归一 tool:result）。 */
  type: string;
  /** agent 内部 step 序号（harness 自身步数，非工作流 stepId）。 */
  step?: number;
  /** 捕获时间（epoch ms），回放可算相对时间轴。 */
  ts: number;
  /** 一行摘要（工具名 / 「LLM 调用」/ 结论标签）。 */
  label?: string;
  /** 关键详情（响应摘要 / 工具参数 / 错误原因 / 校验理由，截断存储）。 */
  detail?: string;
  /** ok | error | blocked。 */
  status?: 'ok' | 'error' | 'blocked';
  /** 快速元数据（model / tokens / cost / 命中缓存 等）。 */
  meta?: Record<string, string>;
}

/** 单个 step 的运行态快照（随工作流进度持久化）。 */
export interface StepRun {
  id: string;
  state: StepState;
  /** 实际喂给 agent 的输入（已按 inputMapping 解析）。 */
  input?: unknown;
  /** agent 的执行结果（用于下游 inputMapping 取值与补偿输入）。 */
  output?: unknown;
  /**
   * 补偿输入（P2 加固）：执行补偿动作时实际交给 executor 的输入。
   * 落盘后 resume 重试失败补偿时可直接复用，避免补偿上下文丢失。
   */
  compensateInput?: unknown;
  error?: string;
  /** 实际选中的 agent id（agentRef 为字符串时解析结果）。 */
  agentId?: string;
  /** 团队 id（当 teamRef 非空时记录）。 */
  teamId?: string;
  startedAt?: number;
  finishedAt?: number;
  /**
   * P2.5 调用链路：本 step 执行期间捕获的关键事件序列（LLM 调用 / 工具 / 护栏 / 校验 / 收尾），
   * 由 executor 经 `RunContext.attachTrace` 附挂，引擎按节点上限合并并随检查点持久化。
   * 旧 executor（不附挂）与旧检查点（无该字段）行为零回归。
   */
  trace?: StepTraceNode[];
  /**
   * P4.5 产出有效性分类：inspectStepOutput 的 issue（仅 issue != 'ok' 时写入），
   * 随检查点持久化供审计 / 执行详情抽屉展示。是否阻断由 def.failOnInvalidOutput 决定。
   */
  outputIssue?: Exclude<OutputIssue, 'ok'>;
  /**
   * P6 步骤级重试：已执行的额外重试次数（不含首次；0/缺省 = 未重试或未启用重试）。
   * 随检查点持久化，供执行详情抽屉展示与审计。
   */
  attempts?: number;
}

/**
 * P6-D9-lite 跃迁历史条目（time travel 审计的最小可用形态）：
 * 每次关键生命周期跃迁（分叉重跑 / 失败收敛 / 续跑）追加一条，随检查点持久化，
 * 保留最近 WORKFLOW_HISTORY_MAX 条。不做全量快照链（那是完整版 time travel 的范围）。
 */
export interface WorkflowHistoryEntry {
  /** 跃迁时间（epoch ms）。 */
  ts: number;
  /** 跃迁类型：'rerun'（分叉重跑重置）/ 'failed'（失败收敛）/ 'resumed'（续跑开始）。 */
  action: string;
  /** 动作说明（如重跑起点 step id / 失败原因）。 */
  detail?: string;
  /** 跃迁前的 step 状态快照（stepId → state），支撑「当时长什么样」的审计回放。 */
  prevStates: Record<string, string>;
}

/** 历史条目上限（防检查点膨胀；超出丢最旧）。 */
export const WORKFLOW_HISTORY_MAX = 20;

/**
 * P6 方案一 A：run 内嵌状态快照（time travel 的回放锚点，见
 * docs/05-analysis/p6-gap-remediation-eval.md §方案一）。
 * 与 history（仅状态名）不同，snapshot 记录**完整 steps**（含产出；产出超
 * SNAPSHOT_OUTPUT_MAX 时省略并标记 outputOmitted），rollbackToSnapshot 据此把
 * run 恢复到该时点后走 /resume 重放。
 */
export interface WorkflowSnapshot {
  id: string;
  ts: number;
  /** 捕获时机：'wave'（波次收敛）/ 'awaiting'（进入审批暂停）/ 'failed'（失败收敛）。 */
  action: string;
  /** 该时点已完成波次序号（展示用）。 */
  wave: number;
  /** 完整 steps 快照。 */
  steps: Record<string, StepRun>;
  /** 产出被省略的 step id 集合（rollback 时这些 step 强制重置 pending 重跑）。 */
  outputOmitted?: string[];
}

/** 快照产出截断阈值：单 step 产出超过该字符数则不进快照（rollback 后该 step 重跑）。 */
export const SNAPSHOT_OUTPUT_MAX = 65_536;
/** 快照条目上限（防检查点膨胀；超出丢最旧）。 */
export const WORKFLOW_SNAPSHOT_MAX = 50;

/** 一次工作流执行的完整快照（可序列化、可续跑、可审计）。 */
export interface WorkflowRun {
  def: WorkflowDef;
  state: WorkflowState;
  /**
   * 本次运行的唯一 id（def.id 相同的多次并发运行靠它区分 / SSE 去重）。
   * 由引擎在 run() 启动时生成；store 仍按 def.id 存「最新检查点」，
   * 但事件与快照携带 runId，消费端可识别并丢弃非本次运行的推送。
   */
  runId?: string;
  /** stepId → 运行态。 */
  steps: Record<string, StepRun>;
  startedAt?: number;
  finishedAt?: number;
  /** 失败时的根因信息。 */
  error?: string;
  /**
   * 全局初始输入（随检查点持久化）：resume 时 inputMapping 含 `input` 的 step
   * （如计划桥 goal:'input'）依赖它解析输入；不落盘则审批门暂停后续跑拿到 undefined。
   * 旧检查点无该字段时 resume 退回 undefined（与旧行为一致，零回归）。
   */
  initialInput?: unknown;
  /**
   * P3 人工审批门：已批准放行的 step id 列表（随检查点持久化）。
   * resume 时，`requireApproval` step 若在此列表中则跳过审批门直接执行。
   */
  approvals?: string[];
  /**
   * P6-D9-lite 跃迁历史（分叉重跑 / 失败收敛 / 续跑），随检查点持久化；
   * 旧快照无该字段 → 从空开始累积（零回归）。
   */
  history?: WorkflowHistoryEntry[];
  /**
   * P6 方案一 A 状态快照链（波次收敛 / awaiting / failed 时捕获，上限
   * WORKFLOW_SNAPSHOT_MAX 丢最旧），rollbackToSnapshot 据此把 run 恢复到任意时点。
   * 旧快照无该字段 → 从空开始累积（零回归）。
   */
  snapshots?: WorkflowSnapshot[];
}
