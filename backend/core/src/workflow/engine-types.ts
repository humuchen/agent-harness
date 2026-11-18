/**
 * workflow 引擎类型定义（P2-6 从 engine.ts 拆分）。
 *
 * 纯类型声明，零运行时——与 guardrails/types.ts 同款拆分范式：
 * 类型先行外迁，engine.ts 仅保留 DagEngine 类与编排逻辑。
 * engine.ts re-export 保持 `from './engine'` 导入点零改动兼容。
 */
import type { AgentRegistry } from '../agents/registry.js';
import type { TeamManager } from '../teams/index.js';
import type { StepDef, StepRun, StepTraceNode, WorkflowRun } from './types.js';
import type { WorkflowStore } from './store.js';

/** 执行单个 step 的回调（注入，解耦 harness/LLM 装配）。 */
export type StepExecutor = (
  step: StepDef,
  input: unknown,
  ctx: RunContext,
) => Promise<unknown>;

/** step 执行上下文（透传给 executor，并贯穿 traceId / 租户 / 上游输出）。 */
export interface RunContext {
  workflowId: string;
  tenantId?: string;
  traceId?: string;
  /** 已完成 step 的输出，按 stepId 索引（供 inputMapping 取值）。 */
  outputs: Record<string, unknown>;
  /** 外部取消信号（停机 / 断线）。 */
  signal?: AbortSignal;
  /** 本次执行是否为「补偿」语义（executor 据以调用回滚工具 / 走回滚分支）。 */
  compensate?: boolean;
  /**
   * P2.5 调用链路捕获通道：executor 在本 step 执行期间把捕获到的 harness 事件序列
   * （LLM 调用 / 工具 / 护栏 / 校验 / 收尾）写入此字段；引擎在 step 收尾（成功或失败）
   * 将其合并进 `StepRun.trace` 并随检查点持久化。旧 executor 不写 → 引擎合并 undefined →
   * trace 缺省，零回归。引擎按节点上限截断（保早期调用），避免检查点膨胀。
   */
  trace?: StepTraceNode[];
  /**
   * P6-D outputSchema 修正环：产出 schema 校验失败时，引擎把错误信息写入本字段并
   * 触发重试；executor（如 workflow-executor 的 prompt 装配）可读取它向 LLM 注入
   * 「上次产出不合规，请修正」的定向指令——比整步盲重跑更省 token、成功率更高。
   * 产出通过校验后由引擎清除。仅声明 outputSchema 的 step 会写入（存量零回归）。
   */
  schemaFeedback?: string;
}

/** 引擎对外发出的工作流事件（供 SSE / 可观测消费）。 */
export type WorkflowEvent =
  | { type: 'wf:start'; workflowId: string; runId: string }
  | { type: 'wf:step:start'; workflowId: string; stepId: string; agentId?: string; teamId?: string }
  | { type: 'wf:step:done'; workflowId: string; stepId: string; output?: unknown }
  | { type: 'wf:step:failed'; workflowId: string; stepId: string; error: string }
  /** P6 步骤级重试：第 attempt 次重试前的通知（error 为上一次失败原因）。 */
  | { type: 'wf:step:retry'; workflowId: string; stepId: string; attempt: number; error: string }
  /** P6 动态 fan-out：dynamic step 成功后物化的子任务 id 列表（已写入 def 与检查点）。 */
  | { type: 'wf:step:spawned'; workflowId: string; stepId: string; spawned: string[] }
  /**
   * P6-C6 状态增量：step 状态任意变迁（running/done/failed/retry/skipped/awaiting/
   * compensated/pending-物化）后的单帧快照 —— 外部看板无需拼装多类事件即可重建
   * 「某 step 现在什么样」。幂等冗余（与 wf:step:* 同源），消费方可忽略。
   */
  | {
      type: 'wf:step:update';
      workflowId: string;
      runId?: string;
      stepId: string;
      state: StepRun['state'];
      attempts?: number;
      /** 产出体量（字符串长度或 JSON 序列化长度；仅 output 已落时携带）。 */
      outputBytes?: number;
    }
  | { type: 'wf:compensate:start'; workflowId: string; stepId: string }
  | { type: 'wf:compensate:done'; workflowId: string; stepId: string }
  /** P3：审批门暂停 —— 当前波次内存在未批准的 requireApproval step，run 进入 awaiting。 */
  | { type: 'wf:awaiting-approval'; workflowId: string; runId?: string; stepIds: string[]; run: WorkflowRun }
  | { type: 'wf:done'; workflowId: string; runId?: string; run: WorkflowRun }
  | { type: 'wf:failed'; workflowId: string; runId?: string; run: WorkflowRun }
  | {
      /** P6 方案一 A：回滚到指定快照完成（恢复态已落盘，调用方随后 /resume 重放）。 */
      type: 'wf:rollback';
      workflowId: string;
      runId?: string;
      snapshotId: string;
      run: WorkflowRun;
    };

export interface DagEngineOptions {
  /** 注册表：解析 agentRef（字符串 id）。缺省用共享单例。 */
  registry?: AgentRegistry;
  /** 团队管理器：解析 teamRef（字符串 id）。缺省用共享单例。 */
  teamManager?: TeamManager | null;
  /** 存储后端：检查点 / 续跑 / 审计。缺省 Volatile。 */
  store?: WorkflowStore;
  /** 必填：执行单个 step 的回调（本地 harness / A2A / mock）。 */
  executor: StepExecutor;
  /** 引擎级事件回调（SSE / 可观测）。 */
  onEvent?: (e: WorkflowEvent) => void;
  /**
   * P6-B subgraph：嵌套深度与 defRef 调用链（内部透传，应用代码不传）。
   * executeNested 每下钻一层 +1 并把当前 defRef 追加进 chain；chain 内重复即环。
   */
  nestingDepth?: number;
  activeChain?: string[];
}
