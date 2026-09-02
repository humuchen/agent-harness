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

/** 单个 step 的运行态。 */
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'compensated' | 'skipped';

/** 整个工作流的运行态。 */
export type WorkflowState = 'pending' | 'running' | 'done' | 'failed' | 'compensated';

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
   * 补偿指令（用于失败时回滚）：
   *   - 若等于同 def 内另一个 step 的 id → 失败时逆序执行该 step 作为补偿动作；
   *   - 若为其它的非空字符串 → 作为字面指令交由同一 agent（executor 的 compensate 标志）执行回滚。
   * 不填则无补偿（仅标记该 step 为 compensated）。
   */
  compensate?: string;
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
}

/** 工作流定义（DAG）。 */
export interface WorkflowDef {
  id: string;
  steps: StepDef[];
  /** 全局租户标识（P0.3）：透传给每个 step 的执行上下文，用于记忆分区与护栏策略。 */
  tenantId?: string;
  /** 全局追踪 id：贯穿所有 step 的 agent 调用，OTel span 跨 agent 关联。 */
  traceId?: string;
}

/** 单个 step 的运行态快照（随工作流进度持久化）。 */
export interface StepRun {
  id: string;
  state: StepState;
  /** 实际喂给 agent 的输入（已按 inputMapping 解析）。 */
  input?: unknown;
  /** agent 的执行结果（用于下游 inputMapping 取值与补偿输入）。 */
  output?: unknown;
  error?: string;
  /** 实际选中的 agent id（agentRef 为字符串时解析结果）。 */
  agentId?: string;
  /** 团队 id（当 teamRef 非空时记录）。 */
  teamId?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** 一次工作流执行的完整快照（可序列化、可续跑、可审计）。 */
export interface WorkflowRun {
  def: WorkflowDef;
  state: WorkflowState;
  /** stepId → 运行态。 */
  steps: Record<string, StepRun>;
  startedAt?: number;
  finishedAt?: number;
  /** 失败时的根因信息。 */
  error?: string;
}
