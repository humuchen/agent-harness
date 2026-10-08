/**
 * 工作流 DAG 引擎（P1-⑤ 核心）。
 *
 * 职责：把 `WorkflowDef`（DAG）调度成一组 step 执行，并负责
 *   - 拓扑分层（依赖无关的 step 同一波次并行）；
 *   - 失败补偿（已完成 step 逆序执行 compensate，解决「副作用无回滚」）；
 *   - 检查点续跑（每 step 状态落盘到 WorkflowStore，`resume()` 从断点继续）。
 *
 * 关键解耦：引擎**不**直接构造 harness / 调用 LLM。真正的「执行一个 step」由注入的
 * `StepExecutor` 完成（server 端用 `assembleAgent(card) + harness.run`，测试端用 mock）。
 * 这样核心保持轻量、可测、与 HTTP/LLM 装配解耦 —— 与「agent 是挂在 harness 上的装配配方」
 * 的整体设计一致。
 */

import { getAgentRegistry, type AgentRegistry } from '../agents/registry';
import type { AgentCard } from '../agents/types';
import { getTeamManager, type TeamManager } from '../teams';
import type { Team } from '../teams';
import { WORKFLOW_HISTORY_MAX, WORKFLOW_SNAPSHOT_MAX, SNAPSHOT_OUTPUT_MAX, type SpawnSpec, type StepDef, type StepRun, type StepTraceNode, type WorkflowDef, type WorkflowHistoryEntry, type WorkflowRun, type WorkflowSnapshot } from './types';
import { type WorkflowStore, VolatileWorkflowStore } from './store';
import { inspectStepOutput } from './step-output';
import { validateAgainstSchema } from '../json-schema';

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

/** 单 step 调用链路节点数上限（R5 体积护栏）：超出截断保留早期调用，防止检查点膨胀。 */
export const STEP_TRACE_MAX_NODES = 500;
/** 调用链路单节点 detail 长度上限（截断存储，避免单条长产出拖垮检查点）。 */
export const STEP_TRACE_DETAIL_MAX = 500;

/** P6 重试退避上限毫秒（指数退避封顶，防止 retries 较大时等待失控）。 */
export const RETRY_BACKOFF_MAX_MS = 8_000;
/** P6 重试次数上限（StepDef.retries 收敛，防配置失误打出无界循环）。 */
export const STEP_RETRIES_MAX = 10;
/** P6 动态 fan-out：单个 dynamic step 单次产出的 spawn 数上限（防产出异常打爆 DAG）。 */
export const MAX_DYNAMIC_SPAWN = 50;
/** P6-B subgraph 嵌套深度硬上限（配合 activeChain 环检测，防 defRef 互相引用打爆调用栈）。 */
export const MAX_SUBGRAPH_DEPTH = 5;
/** P6 重试退避基数缺省毫秒（StepDef.retryBackoffMs 缺省值）。 */
const RETRY_BACKOFF_DEFAULT_MS = 500;

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

export class DagEngine {
  /** 进程内单调自增序号（用于 genRunId 生成同进程内不重复的 runId）。 */
  private static _seq = 0;
  private readonly registry: AgentRegistry;
  private readonly teamManager: TeamManager | null;
  private readonly store: WorkflowStore;
  private readonly executor: StepExecutor;
  private readonly onEvent?: (e: WorkflowEvent) => void;
  /** P6-B subgraph：嵌套深度与 defRef 调用链（executeNested 透传，根引擎为 0/空）。 */
  private readonly nestingDepth: number;
  private readonly activeChain: string[];

  constructor(opts: DagEngineOptions) {
    if (!opts.executor) {
      throw new Error('DagEngine requires an injected `executor` (core does not construct harnesses).');
    }
    this.registry = opts.registry ?? getAgentRegistry();
    this.teamManager = opts.teamManager ?? getTeamManager();
    this.store = opts.store ?? new VolatileWorkflowStore();
    this.executor = opts.executor;
    this.onEvent = opts.onEvent;
    this.nestingDepth = opts.nestingDepth ?? 0;
    this.activeChain = opts.activeChain ?? [];
  }

  private emit(e: WorkflowEvent): void {
    this.onEvent?.(e);
  }

  /**
   * P6-C6 状态增量帧：step 当前状态的单帧快照（幂等冗余，消费方可忽略）。
   * 在每个状态跃迁点（start/done/failed/retry/skipped/awaiting/compensated/物化）调用。
   */
  private emitStepUpdate(run: WorkflowRun, stepId: string): void {
    const sr = run.steps[stepId];
    if (!sr) return;
    let outputBytes: number | undefined;
    if (sr.output !== undefined) {
      outputBytes =
        typeof sr.output === 'string' ? sr.output.length : JSON.stringify(sr.output)?.length ?? 0;
    }
    this.emit({
      type: 'wf:step:update',
      workflowId: run.def.id,
      runId: run.runId,
      stepId,
      state: sr.state,
      ...(sr.attempts ? { attempts: sr.attempts } : {}),
      ...(outputBytes !== undefined ? { outputBytes } : {}),
    });
  }

  /**
   * P6-B subgraph 嵌套复用：把 defRef 指向的嵌套工作流跑完并返回其 WorkflowRun 作为
   * 本 step 产出。三种情形：检查点 done → 幂等复用；非终态（pending/failed/awaiting
   * 后续由审批路由处理）→ resume 续跑；环（activeChain 重复）或超深 → 明确失败。
   * 嵌套引擎共享同一 store / executor / 注册表；其 wf:* 事件以
   * `<父workflowId>><嵌套defId>` 前缀透传（编排时间线可区分层级）。
   */
  private async executeNested(defRef: string, input: unknown, ctx: RunContext): Promise<unknown> {
    if (this.activeChain.includes(defRef)) {
      throw new Error(
        `subgraph 引用环：${[...this.activeChain, defRef].join(' → ')}（defRef 不可互相引用）`
      );
    }
    const depth = this.nestingDepth + 1;
    if (depth > MAX_SUBGRAPH_DEPTH) {
      throw new Error(`subgraph 嵌套深度超过上限 ${MAX_SUBGRAPH_DEPTH}（当前链：${this.activeChain.join(' → ') || '根'} → ${defRef}）`);
    }
    const checkpoint = await this.store.get(defRef);
    const nestedDef = checkpoint?.def;
    if (!nestedDef || !Array.isArray(nestedDef.steps) || nestedDef.steps.length === 0) {
      throw new Error(
        `subgraph defRef 无法解析："${defRef}"（store 中不存在该工作流的检查点；defRef 指向的工作流需先经 POST /api/workflows 落过检查点）`
      );
    }
    const nested = new DagEngine({
      store: this.store,
      executor: this.executor,
      registry: this.registry,
      teamManager: this.teamManager,
      onEvent: (e) => {
        // 嵌套层事件透传（父级 wf:step:* 不受影响——workflowId 已改写为带层级前缀）。
        if (e.type.startsWith('wf:')) {
          this.emit({ ...e, workflowId: `${ctx.workflowId}>${defRef}` } as WorkflowEvent);
        }
      },
      nestingDepth: depth,
      activeChain: [...this.activeChain, defRef]
    });
    if (checkpoint.state === 'done') return checkpoint; // 幂等复用（嵌套已完成）
    const result = await nested.resume(defRef, ctx.signal);
    // 嵌套失败必须传播为父 step 失败（WorkflowRun 是对象，产出闸门对对象恒判 ok，
    // 不在此检查则「嵌套失败」会被静默当成功写黑板）。awaiting（嵌套含审批门）当前
    // 版本同样按失败处置：跨层审批穿透是独立设计，不混入本特性。
    if (result.state !== 'done') {
      const firstErr = Object.values(result.steps ?? {}).find(
        (s) => s && typeof s === 'object' && 'state' in s && (s as { state?: string }).state === 'failed'
      )?.error;
      throw new Error(
        `subgraph "${defRef}" 嵌套执行未完成（state=${result.state}）` +
          `${firstErr ? `：${firstErr}` : ''}${result.error ? ` / ${result.error}` : ''}`
      );
    }
    return result;
  }

  /**
   * P6 统一 step 执行入口：defRef（嵌套 subgraph）优先，否则走注入的 executor。
   * retry 循环与 run/resume 两路径共用，保证闸门 / 重试 / trace 语义一致。
   */
  private executeStepCall(step: StepDef, input: unknown, ctx: RunContext): Promise<unknown> {
    if (step.defRef) return this.executeNested(step.defRef, input, ctx);
    return this.executor(step, input, ctx);
  }

  /**
   * P2.5 调用链路合并：把 executor 经 `ctx.trace` 附挂的 harness 事件序列合并进
   * `StepRun.trace`（节点数上限截断，保早期调用；detail 已在采集端按
   * STEP_TRACE_DETAIL_MAX 截断，此处对超长 detail 再兜底一次）。
   *
   * 零回归：ctx.trace 缺省（旧 executor / 测试 mock）时直接 no-op，StepRun 不写 trace 字段。
   * 成功 / 失败 / 补偿三条路径统一调用 —— 失败 step 的链路正是排障最需要的关键信息。
   */
  private mergeStepTrace(sr: StepRun, ctx: RunContext): void {
    const nodes = ctx.trace;
    if (!nodes || nodes.length === 0) return;
    const kept = nodes.slice(0, STEP_TRACE_MAX_NODES);
    sr.trace = kept.map((n) => {
      if (typeof n.detail === 'string' && n.detail.length > STEP_TRACE_DETAIL_MAX) {
        return { ...n, detail: n.detail.slice(0, STEP_TRACE_DETAIL_MAX) + '…' };
      }
      return n;
    });
  }

  /**
   * P4.5 产出有效性闸门（step 成功出口）：检视 executor 返回值。
   * - 分类非 ok 时始终记录到 sr.outputIssue（审计 / 抽屉可见，不因闸门开关丢失）；
   * - 仅当 def.failOnInvalidOutput 开启且分类非 ok → 返回失败原因（调用方据此按
   *   失败路径处置：run() 抛出进既有 catch（failed + 补偿 + 级联）；resume() 置
   *   stepFailed 并级联），消灭「无效产出被当成功写黑板」。
   * - 缺省（存量 def 未开闸门）返回 undefined → 行为与旧版逐字一致（零回归）。
   */
  private inspectOutputGate(def: WorkflowDef, sr: StepRun, result: unknown): string | undefined {
    const insp = inspectStepOutput(result);
    if (insp.issue === 'ok') return undefined;
    sr.outputIssue = insp.issue;
    if (!def.failOnInvalidOutput) return undefined;
    // 排障增强：闸门文案默认只有通用 detail（如「step 运行抛异常（[error] 前缀）」），
    // 真实异常消息只存在于 step.output 开头（harness return '[error] <msg>'），根因被吞、
    // 用户只能看到「无效产出（failed）」却不知道错在哪。这里把产出开头截成单行片段
    // 附进失败信息（空产出无片段 → 文案与旧版逐字一致，测试 includes 断言不受影响）。
    let snippet = '';
    if (typeof result === 'string') {
      const t = result.trim().replace(/\s+/g, ' ');
      snippet = t.length > 160 ? `${t.slice(0, 160)}…` : t;
    }
    return (
      `无效产出（${insp.issue}）${insp.detail ? `：${insp.detail}` : ''}` +
      (snippet ? `（产出开头：${snippet}）` : '')
    );
  }

  /**
   * P6 产出 schema 闸门：StepDef.outputSchema 声明时对产出做 JSON-Schema 子集校验。
   * 失败返回可读错误（含路径），由调用方按失败处置（重试 / failed + 补偿 + 级联）；
   * 同时把 outputIssue 标记为 failed 供审计 / 抽屉展示。未声明 outputSchema 时为 no-op（零回归）。
   */
  private checkOutputSchema(step: StepDef, sr: StepRun, result: unknown): string | undefined {
    if (!step.outputSchema) return undefined;
    const v = validateAgainstSchema(result, step.outputSchema);
    if (v.ok) return undefined;
    sr.outputIssue = 'failed';
    return (
      `产出不符合 outputSchema：${v.errors.slice(0, 5).join('; ')}` +
      (v.errors.length > 5 ? `（等 ${v.errors.length} 处）` : '')
    );
  }

  /**
   * P6 动态 fan-out（入队）：dynamic step 成功且产出含 `spawn` 数组时入队。
   * 实际物化在所在波次收敛后统一执行（drainSpawns）——波内其它 step 失败（fail-fast）
   * 时不物化，与「失败不扩散副作用」一致。
   */
  private queueSpawns(
    parent: StepDef,
    result: unknown,
    queue: Array<{ parent: StepDef; result: unknown }>
  ): void {
    if (parent.dynamic !== true) return;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return;
    if (!Array.isArray((result as Record<string, unknown>).spawn)) return;
    queue.push({ parent, result });
  }

  /**
   * P6 动态 fan-out（物化）：把队列中的 spawn 项转换为真实 StepDef 并追加进 def 与
   * run.steps（def 与 run.def 为同一对象引用，save(run) 即持久化新步骤 → resume 可续）。
   * 物化后重新过静态校验（重复 id / 未知引用 / 环），失败抛错 → run failed（fail-fast）。
   * 返回物化的子任务总数（0 = 无 spawn，调用方零开销）。
   */
  private drainSpawns(
    def: WorkflowDef,
    run: WorkflowRun,
    queue: Array<{ parent: StepDef; result: unknown }>
  ): number {
    if (queue.length === 0) return 0;
    const pending = queue.splice(0, queue.length);
    const spawnedByParent = new Map<string, string[]>();
    let added = 0;
    for (const { parent, result } of pending) {
      for (const child of this.extractSpawns(parent, result)) {
        if (def.steps.some((s) => s.id === child.id)) {
          throw new Error(`spawned step id 冲突："${child.id}"（父 step "${parent.id}" 产出的 spawn id 须在同父内唯一）`);
        }
        def.steps.push(child);
        run.steps[child.id] = { id: child.id, state: 'pending' };
        this.emitStepUpdate(run, child.id);
        const list = spawnedByParent.get(parent.id) ?? [];
        list.push(child.id);
        spawnedByParent.set(parent.id, list);
        added += 1;
      }
    }
    if (added > 0) {
      // 物化后的 def 重新过静态校验（重复 id / 未知引用 / 环）——topoWaves 抛错 → 外层 catch → run failed。
      // run.def 与 def 为同一对象引用，调用方随后 save(run) 即把新步骤持久化进检查点（resume 可续）。
      this.validateWorkflow(def);
      for (const [parentId, ids] of spawnedByParent) {
        this.emit({ type: 'wf:step:spawned', workflowId: def.id, stepId: parentId, spawned: ids });
      }
    }
    return added;
  }

  /**
   * P6 动态 fan-out（规格 → StepDef）：id 加 `<父id>.` 前缀防冲突；agentRef 缺省继承父；
   * dependsOn 强制含父 id；literalInput 承载 spec.input。校验失败抛错（run failed）。
   */
  private extractSpawns(parent: StepDef, result: unknown): StepDef[] {
    if (parent.dynamic !== true) return [];
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const raw = (result as Record<string, unknown>).spawn;
    if (!Array.isArray(raw) || raw.length === 0) return [];
    if (raw.length > MAX_DYNAMIC_SPAWN) {
      throw new Error(`step "${parent.id}" 的 spawn 数量 ${raw.length} 超过上限 ${MAX_DYNAMIC_SPAWN}`);
    }
    return raw.map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`step "${parent.id}" spawn[${i}] 非对象（须为 SpawnSpec）`);
      }
      const spec = item as SpawnSpec;
      const rawId = typeof spec.id === 'string' ? spec.id.trim() : '';
      if (!rawId || !/^[\w.-]+$/.test(rawId)) {
        throw new Error(`step "${parent.id}" spawn[${i}].id 非法（仅允许字母数字._-）："${rawId}"`);
      }
      const dependsOn = [...new Set([...(spec.dependsOn ?? []), parent.id])];
      const child: StepDef = {
        id: `${parent.id}.${rawId}`,
        agentRef: spec.agentRef ?? parent.agentRef,
        dependsOn,
        dynamic: false, // 子任务不再级联扇出（防失控递归；如需链式 spawn 请显式声明多级 dynamic step）
      };
      if (spec.inputMapping) child.inputMapping = spec.inputMapping;
      if (spec.requireApproval) child.requireApproval = true;
      if (spec.retries !== undefined) child.retries = spec.retries;
      if (spec.input !== undefined) child.literalInput = spec.input;
      return child;
    });
  }

  /**
   * P6 step 分叉重跑（time travel 简版）：把指定 step 及其全部下游重置为 pending
   * （清空产出 / 错误 / 链路），run 置回 pending；随后 resume 即从该 step 重新执行。
   * 持久化由调用方负责（引擎方法内 save；独立函数 resetRunForRerun 为纯函数）。
   */
  async resetForRerun(workflowId: string, stepId: string): Promise<WorkflowRun> {
    const run = await this.store.get(workflowId);
    if (!run) throw new Error(`workflow not found: ${workflowId}`);
    const updated = resetRunForRerun(run, stepId);
    await this.store.save(updated);
    return updated;
  }

  /**
   * P6 方案一 A：回滚到指定快照（time travel 回放锚点）。恢复 steps/outputs 后
   * state → pending 落盘，调用方随后走既有 /resume 重放（上游 done 产出复用；
   * 产出超限被省略的 step 自动重跑）。运行中拒绝（与 rerun 同语义）。
   */
  async rollback(workflowId: string, snapshotId: string): Promise<WorkflowRun> {
    const run = await this.store.get(workflowId);
    if (!run) throw new Error(`workflow not found: ${workflowId}`);
    const updated = rollbackToSnapshot(run, snapshotId);
    await this.store.save(updated);
    this.emit({
      type: 'wf:rollback',
      workflowId,
      runId: updated.runId,
      snapshotId,
      run: updated,
    });
    return updated;
  }

  /** 生成运行唯一 id：时间戳 + 单调自增 + 随机后缀，无需引入 uuid 依赖。 */
  private genRunId(): string {
    DagEngine._seq = (DagEngine._seq ?? 0) + 1;
    const rand = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
    return `${Date.now().toString(36)}-${DagEngine._seq}-${rand}`;
  }

  /**
   * 静态校验工作流定义（拓扑合法性）。遇环 / 未知依赖 / 重复 stepId 直接抛错。
   * server 端在 `POST /api/workflows` 时优先调用，做到 fail-fast（不进入异步执行才失败）。
   */
  validateWorkflow(def: WorkflowDef): void {
    const ids = new Set<string>();
    for (const s of def.steps) {
      if (ids.has(s.id)) throw new Error(`duplicate step id: ${s.id}`);
      ids.add(s.id);
    }
    this.topoWaves(def);
    this.validateReferences(def);
  }

  /**
   * 静态校验 steps.<id> 引用（fail-fast，在 POST /api/workflows 阶段拦截）：
   * - inputMapping 值：`input` / 字面量 / `steps.<id>`（可带 `.output` 后缀，语义相同）；
   * - condition：`true`/`false` 字面量，或 `steps.<id>.output` / `steps.<id>.state [==|!= '<StepState>']`；
   * - onRolling / compensate：仅允许引用已存在的 step id（字面量回滚指令已废弃，
   *   旧数据若仍携带会在此报错，促使迁移为独立补偿 step）。
   * 未知引用在运行前即拒绝，避免静默取到 undefined 输入 / 条件误判。
   */
  private validateReferences(def: WorkflowDef): void {
    const ids = new Set(def.steps.map((s) => s.id));
    const stepStates = new Set(['pending', 'running', 'done', 'failed', 'compensated', 'compensate-failed', 'skipped']);
    for (const s of def.steps) {
      for (const [key, src] of Object.entries(s.inputMapping ?? {})) {
        if (src === 'input') continue;
        // 字面量常量（非 steps. 前缀）：resolveInput 按 else 分支原样注入，无需校验。
        // 与 types.ts「取值语法」一致：仅 steps. 前缀须匹配 steps.<id>(.output) 且引用已知 step。
        if (!src.startsWith('steps.')) continue;
        const m = /^steps\.([A-Za-z0-9_-]+)(\.output)?$/.exec(src);
        if (!m) {
          throw new Error(
            `step "${s.id}" inputMapping["${key}"] = "${src}" 无法解析：` +
              `steps. 前缀取值须为 steps.<id>(.output)；其它字符串按字面量常量注入（非 steps. 前缀）`,
          );
        }
        if (!ids.has(m[1]!)) throw new Error(`step "${s.id}" inputMapping["${key}"] 引用了未知 step "${m[1]!}"`);
      }
      if (s.condition) {
        const c = s.condition.trim();
        if (c === 'true' || c === 'false') continue;
        const out = /^steps\.([A-Za-z0-9_-]+)\.output$/.exec(c);
        if (out) {
          if (!ids.has(out[1]!)) throw new Error(`step "${s.id}" condition 引用了未知 step "${out[1]}"`);
          continue;
        }
        const st = /^steps\.([A-Za-z0-9_-]+)\.state(\s*(==|!=)\s*['"]?(\w+)['"]?)?$/.exec(c);
        if (st) {
          if (!ids.has(st[1]!)) throw new Error(`step "${s.id}" condition 引用了未知 step "${st[1]}"`);
          const expected = st[4] ?? 'done';
          if (!stepStates.has(expected)) {
            throw new Error(`step "${s.id}" condition 使用了未知 step 状态 "${expected}"（合法值：${[...stepStates].join(' / ')}）`);
          }
          continue;
        }
        throw new Error(
          `step "${s.id}" condition "${c}" 无法解析：支持 "true"/"false"、steps.<id>.output、steps.<id>.state [==|!= '<状态>']`,
        );
      }
      for (const c of s.onRolling ?? []) {
        // 允许两种形态：已定义的补偿 step id，或字面量回滚指令（复用本 step 的 agent 执行）。
        if (typeof c !== 'string' || c.trim() === '') {
          throw new Error(`step "${s.id}" onRolling 必须是非空字符串（step id 或回滚指令）`);
        }
      }
      if (s.compensate !== undefined && (typeof s.compensate !== 'string' || s.compensate.trim() === '')) {
        throw new Error(`step "${s.id}" compensate 必须是非空字符串（已废弃：建议迁移到 onRolling）`);
      }
      // P6 重试参数：负数 / 非有限数直接拒绝（fail-fast，避免运行期静默按 0 处理掩盖配置错误）。
      if (s.retries !== undefined && (typeof s.retries !== 'number' || !Number.isFinite(s.retries) || s.retries < 0)) {
        throw new Error(`step "${s.id}" retries 须为非负数（当前：${String(s.retries)}）`);
      }
      if (
        s.retryBackoffMs !== undefined &&
        (typeof s.retryBackoffMs !== 'number' || !Number.isFinite(s.retryBackoffMs) || s.retryBackoffMs < 0)
      ) {
        throw new Error(`step "${s.id}" retryBackoffMs 须为非负数（当前：${String(s.retryBackoffMs)}）`);
      }
    }
  }

  /** agentRef 解析为 AgentCard（字符串 → 注册表查询；内联对象 → 直接用）。 */
  private async resolveCard(ref: string | AgentCard): Promise<AgentCard> {
    if (typeof ref !== 'string') return ref;
    const card = await this.registry.get(ref);
    if (!card) throw new Error(`unknown agentRef: ${ref}`);
    return card;
  }

  /** teamRef 解析为 Team（字符串 → TeamManager 查询）。缺省返回 null。 */
  private async resolveTeam(ref?: string): Promise<Team | null> {
    if (!ref) return null;
    if (!this.teamManager) return null;
    return this.teamManager.get(ref) ?? null;
  }

  /**
   * 输出消费依赖：显式 dependsOn ∪ inputMapping 中对 steps.<id> 的引用。
   * 这些 step 需要上游的 output 落定；上游被 skip 时本 step 必须级联跳过（否则会拿到 undefined 输入）。
   */
  private outputDeps(step: StepDef): string[] {
    return outputDepsOf(step);
  }

  /**
   * 有效拓扑依赖 = 输出消费依赖 ∪ condition 对 steps.<id>.state/output 的引用。
   * 全部参与拓扑分层，消除「引用了 steps.<id> 但未声明 dependsOn」导致同波次并行的竞态
   * （旧行为：引用落到未落定的上游 → 条件/映射取到 undefined → 静默误判）。
   */
  private effectiveDeps(def: WorkflowDef, step: StepDef): string[] {
    return effectiveDepsOf(def, step);
  }

  /**
   * 拓扑分层：返回若干「波次」，每波次内的 step 互相无依赖、可并行。
   * 依赖 = 显式 dependsOn + 隐式引用（inputMapping / condition），见 effectiveDeps()。
   * 遇环或缺依赖抛错（fail-fast，避免静默死锁）。
   */
  private topoWaves(def: WorkflowDef): string[][] {
    const depsOf = new Map<string, string[]>();
    for (const s of def.steps) depsOf.set(s.id, this.effectiveDeps(def, s));

    const remaining = new Set(def.steps.map((s) => s.id));
    const done = new Set<string>();
    const waves: string[][] = [];
    while (remaining.size > 0) {
      const wave: string[] = [];
      for (const id of remaining) {
        const deps = depsOf.get(id) ?? [];
        if (deps.every((d) => done.has(d))) wave.push(id);
      }
      if (wave.length === 0) {
        throw new Error('workflow contains a dependency cycle (or unsatisfiable dependsOn)');
      }
      for (const id of wave) {
        done.add(id);
        remaining.delete(id);
      }
      waves.push(wave);
    }
    return waves;
  }

  /** 按 inputMapping 解析本 step 的实际输入（literalInput 仅在无 inputMapping 时生效）。 */
  private resolveInput(step: StepDef, initialInput: unknown, outputs: Record<string, unknown>): unknown {
    const map = step.inputMapping;
    if (!map || Object.keys(map).length === 0) {
      // P6 动态 fan-out：spawn 物化的子任务携带的字面量输入优先于全局初始输入。
      return step.literalInput !== undefined ? step.literalInput : initialInput;
    }
    const out: Record<string, unknown> = {};
    for (const [key, src] of Object.entries(map)) {
      if (src === 'input') out[key] = initialInput;
      else if (src.startsWith('steps.')) out[key] = outputs[src.slice('steps.'.length)];
      else out[key] = src; // 字面量
    }
    return out;
  }

  /**
   * 完整运行一个工作流（DAG 并行 + 失败补偿 + 条件分支）。
   */
  async run(def: WorkflowDef, initialInput?: unknown, signal?: AbortSignal): Promise<WorkflowRun> {
    const runId = this.genRunId();
    const run: WorkflowRun = {
      def,
      state: 'running',
      runId,
      steps: Object.fromEntries(def.steps.map((s) => [s.id, { id: s.id, state: 'pending' } as StepRun])),
      startedAt: Date.now(),
      // 全局初始输入随检查点持久化：审批门暂停 / 失败后 resume 时，
      // inputMapping 含 `input` 的 step 才能拿到真实目标（而非 undefined）。
      initialInput,
    };
    // 拓扑合法性 fail-fast：环 / 未知依赖 / 重复 stepId 在 try 之外抛错，
    // 使 run() 以 reject 形式暴露（而非吞成 state=failed），符合「校验错误即失败」。
    this.validateWorkflow(def);
    // 并发护栏：store 按 def.id 存单检查点。若已存在「另一 runId 且仍在 running」的检查点，
    // 说明同 def 有并发运行在进行 —— 拒绝启动（fail-fast），避免互相覆盖检查点导致续跑错乱。
    // P1 C4：优先走 store.claim() 原子占位（检查+写入在存储侧一次完成，无 await 间隙）；
    // 旧自定义 store 未实现 claim 时回落两步 get+save（保留原行为，零回归）。
    if (typeof this.store.claim === 'function') {
      const claimed = await this.store.claim(run);
      if (!claimed) {
        const existing = await this.store.get(def.id);
        throw new Error(
          `workflow "${def.id}" already has a running execution (runId=${existing?.runId ?? 'unknown'}); ` +
            `concurrent run rejected to avoid checkpoint overwrite — resume it or wait for it to finish`,
        );
      }
    } else {
      const existing = await this.store.get(def.id);
      if (existing && existing.state === 'running' && existing.runId && existing.runId !== runId) {
        throw new Error(
          `workflow "${def.id}" already has a running execution (runId=${existing.runId}); ` +
            `concurrent run rejected to avoid checkpoint overwrite — resume it or wait for it to finish`,
        );
      }
      await this.store.save(run);
    }
    this.emit({ type: 'wf:start', workflowId: def.id, runId });

    const outputs: Record<string, unknown> = {};
    const skipped = new Set<string>(); // 被条件跳过的 step id
    const approved = new Set(run.approvals ?? []); // P3：已批准放行的 step
    // P6 动态 fan-out：波次收敛后统一物化的 spawn 队列（所在波次失败时不物化，见 drainSpawns）。
    const spawnQueue: Array<{ parent: StepDef; result: unknown }> = [];
    // P6 方案一 A：当前波次序号提到 try 外 —— 失败收敛的快照（catch 内）需要它。
    let wi = 0;
    try {
      // P6 调度循环：波次列表仅在发生物化（drainSpawns > 0）时重算——无 spawn 时与旧
      // `for (const wave of this.topoWaves(def))` 的波次序列逐字一致（topoWaves 确定性）。
      let waves = this.topoWaves(def);
      wi = 0;
      while (wi < waves.length) {
        const wave = waves[wi]!;
        if (signal?.aborted) throw new Error('workflow aborted');
        // def 可能被动态 fan-out 物化扩充：每轮取最新映射（审批门过滤据此看到新步骤）。
        const defById = new Map(def.steps.map((s) => [s.id, s]));
        // P3 审批门（波次边界）：当前波次内存在「requireApproval 且未批准」的 step 时，
        // 整个 run 暂停进入 awaiting（不落 failed、不执行补偿）。这些 step 标记 awaiting，
        // 同波次其它 step 保持 pending；批准后 resume 放行整波次。未标记的 def 行为不变。
        // 级联跳过预判：输出依赖已被跳过的 step 本波次必然 skipped，不参与审批门。
        const gated = wave.filter((id) => {
          const step = defById.get(id)!;
          if (!step.requireApproval || approved.has(id)) return false;
          if (this.outputDeps(step).some((d) => skipped.has(d))) return false;
          return true;
        });
        if (gated.length > 0) {
          // P6 方案一 A：进入审批暂停前快照（回滚锚点 —— 审批前状态可整体回退）。
          pushRunSnapshot(run, 'awaiting', wi + 1);
          for (const id of gated) {
            run.steps[id] = { id, state: 'awaiting' };
            this.emitStepUpdate(run, id);
          }
          run.state = 'awaiting';
          delete run.finishedAt;
          await this.store.save(run);
          this.emit({ type: 'wf:awaiting-approval', workflowId: def.id, runId, stepIds: gated, run });
          return run;
        }
        // P5 串行执行模式：def.execMode==='serial' 时波次内逐个 await（单步发送语义：
        // 上一 step 完成后才派发下一个），缺省 parallel 波次内并行（存量零回归）。
        // 串行只改调度顺序，验证门禁 / 补偿 / 审批门 / 检查点语义与并行完全一致。
        const runWaveStep = async (id: string): Promise<void> => {
            const step = def.steps.find((s) => s.id === id)!;

            // P2 条件分支：级联跳过 —— 若本 step 的「输出消费依赖」（dependsOn / inputMapping
            // 引用）中有被跳过的上游，则自动跳过，避免等待一个永远不会产出的 output 而死锁。
            // 注意：仅 condition 里引用 steps.<id>.state 不构成级联跳过的理由
            // （state == 'skipped' 的 fallback 分支正是要在上游被跳过时执行）。
            const depSkipped = this.outputDeps(step).some((d) => skipped.has(d));
            if (depSkipped) {
              skipped.add(id);
              run.steps[id] = { id, state: 'skipped' };
              await this.store.save(run);
              this.emit({ type: 'wf:step:start', workflowId: def.id, stepId: id });
              this.emit({ type: 'wf:step:done', workflowId: def.id, stepId: id });
              this.emitStepUpdate(run, id);
              return;
            }
            if (step.condition) {
              const conditionMet = await this.evaluateCondition(step.condition, initialInput, outputs, run.steps);
              if (!conditionMet) {
                skipped.add(id);
                run.steps[id] = { id, state: 'skipped' };
                await this.store.save(run);
                this.emit({ type: 'wf:step:start', workflowId: def.id, stepId: id });
                this.emit({ type: 'wf:step:done', workflowId: def.id, stepId: id });
                this.emitStepUpdate(run, id);
                return;
              }
            }

            const input = this.resolveInput(step, initialInput, outputs);
            // P1-④：teamRef 声明后必须可解析，否则 fail-fast（旧行为静默回落 agentRef，掩盖配置错误）
            const team = await this.resolveTeam(step.teamRef);
            if (step.teamRef && !team) {
              throw new Error(
                `workflow step "${id}": unknown teamRef "${step.teamRef}"（teamRef 与 agentRef 二选一，teamRef 解析失败不再回落 agentRef）`,
              );
            }
            const card = await this.resolveCard(step.agentRef);
            if (team) {
              this.emit({ type: 'wf:step:start', workflowId: def.id, stepId: id, teamId: team.id });
            }
            const sr: StepRun = { id, state: 'running', agentId: card.id, input, startedAt: Date.now(), teamId: team?.id };
            run.steps[id] = sr;
            await this.store.save(run);
            this.emit({ type: 'wf:step:start', workflowId: def.id, stepId: id, agentId: card.id });
            this.emitStepUpdate(run, id);

            const ctx: RunContext = {
              workflowId: def.id,
              tenantId: def.tenantId,
              traceId: def.traceId,
              outputs,
              signal,
            };
            // P6 步骤级重试：抛错 / 产出闸门 / outputSchema 校验失败都算一次失败尝试，
            // 在 retries 预算内指数退避重试（外部取消不重试）；超出预算走既有失败路径
            // （failed + 补偿 + 级联），retries 缺省 0 时与旧版逐字一致。
            const maxRetries = normalizeRetries(step);
            const backoffBase = normalizeBackoff(step);
            let attempt = 0;
            for (;;) {
              try {
                // P6-B：defRef（嵌套 subgraph）优先，否则走注入的 executor（见 executeStepCall）。
                const result = await this.executeStepCall(step, input, ctx);
                sr.output = result;
                // P4.5 产出有效性闸门：无效产出（空 / 中断 / 护栏兜底）不再「静默成功」——
                // 开启 def.failOnInvalidOutput 时按失败处置（进下方 catch → failed + 补偿 + 级联），
                // 未开启仅记录 outputIssue（存量零回归）。
                const gateError = this.inspectOutputGate(def, sr, result);
                if (gateError) throw new Error(gateError);
                // P6 产出 schema 闸门：声明 outputSchema 的 step 产出不合规即失败（opt-in）。
                // 失败时把错误写入 ctx.schemaFeedback —— 重试的 executor 可注入定向修正指令。
                const schemaError = this.checkOutputSchema(step, sr, result);
                if (schemaError) {
                  ctx.schemaFeedback = schemaError;
                  throw new Error(schemaError);
                }
                ctx.schemaFeedback = undefined;
                sr.state = 'done';
                sr.finishedAt = Date.now();
                outputs[id] = result;
                this.mergeStepTrace(sr, ctx); // P2.5 调用链路落检查点（缺省 no-op）
                await this.store.save(run);
                this.emit({ type: 'wf:step:done', workflowId: def.id, stepId: id, output: result });
                this.emitStepUpdate(run, id);
                this.queueSpawns(step, result, spawnQueue); // P6 动态 fan-out 入队（波次收敛后物化）
                break;
              } catch (e: any) {
                const errMsg: string = e?.message ?? String(e);
                if (attempt < maxRetries && !ctx.signal?.aborted) {
                  attempt += 1;
                  sr.attempts = attempt;
                  this.emit({ type: 'wf:step:retry', workflowId: def.id, stepId: id, attempt, error: errMsg });
                  this.emitStepUpdate(run, id);
                  await this.store.save(run);
                  await sleepMs(Math.min(backoffBase * 2 ** (attempt - 1), RETRY_BACKOFF_MAX_MS));
                  if (!ctx.signal?.aborted) continue; // 退避期间未被取消 → 重试
                }
                sr.state = 'failed';
                sr.error = errMsg;
                this.mergeStepTrace(sr, ctx); // P2.5：失败 step 的链路是排障关键信息
                await this.store.save(run);
                this.emit({ type: 'wf:step:failed', workflowId: def.id, stepId: id, error: errMsg });
                this.emitStepUpdate(run, id);
                throw e;
              }
            }
        };
        if (def.execMode === 'serial') {
          for (const id of wave) await runWaveStep(id);
        } else {
          await this.runWaveParallel(def, wave, runWaveStep);
        }
        wi += 1;
        // P6 方案一 A：波次收敛 → 状态快照（time travel 回放锚点）。
        pushRunSnapshot(run, 'wave', wi);
        // P6 动态 fan-out：波次收敛后物化 spawn（失败已 fail-fast 抛出，不会走到这里）。
        if (this.drainSpawns(def, run, spawnQueue) > 0) {
          waves = this.topoWaves(def); // 新步骤参与调度（引用 / 环非法时抛错 → run failed）
          const nextIdx = waves.findIndex((w) =>
            w.some((x) => {
              const st = run.steps[x]?.state ?? 'pending';
              return st === 'pending' || st === 'running' || st === 'awaiting';
            })
          );
          if (nextIdx < 0) break;
          wi = nextIdx;
        }
      }
      run.state = 'done';
      run.finishedAt = Date.now();
      await this.store.save(run);
      this.emit({ type: 'wf:done', workflowId: def.id, run });
      return run;
    } catch (e: any) {
      // P6-D9-lite：失败收敛前记录跃迁历史（当时各 step 状态 + 失败原因）。
      pushRunHistory(run, 'failed', e?.message ?? String(e));
      // P6 方案一 A：失败收敛快照（回滚锚点 —— 失败现场可整体回退重放）。
      pushRunSnapshot(run, 'failed', wi);
      run.error = e?.message ?? String(e);
      run.state = 'failed';
      run.finishedAt = Date.now();
      await this.store.save(run);
      // 补偿：对已完成（done）的 step 逆序执行补偿动作。
      await this.compensate(def, run, outputs, signal);
      this.emit({ type: 'wf:failed', workflowId: def.id, run });
      return run;
    }
  }

  /**
   * 求值条件表达式（P2）。
   * 支持的语法：
   * - `steps.<id>.output` → 引用上游 step 的输出（truthy 则通过）
   * - `steps.<id>.state`  → 裸写，等价于 `steps.<id>.state == 'done'`
   * - `steps.<id>.state == 'done'` / `steps.<id>.state != 'failed'` / `... != 'skipped'` → 显式状态比较
   * - `true` / `false`    → 字面量
   *
   * 状态取值来源为真实的 `run.steps`（StepRun.state），而非 outputs 近似：
   * 被跳过（skipped）的 step 没有 output，旧实现会让条件恒为 falsy，导致依赖链静默死锁。
   */
  private async evaluateCondition(
    condition: string,
    initialInput: unknown,
    outputs: Record<string, unknown>,
    runSteps: Record<string, StepRun>
  ): Promise<boolean> {
    const cond = condition.trim();

    // 字面量
    if (cond === 'true') return true;
    if (cond === 'false') return false;

    // 引用上游输出：steps.<id>.output（id 允许连字符，与 stepId 命名一致）
    const outputMatch = /^steps\.([A-Za-z0-9_-]+)\.output$/.exec(cond);
    if (outputMatch) {
      const stepId = outputMatch[1]!;
      const val = outputs[stepId];
      return !!val;
    }

    // 引用上游状态：steps.<id>.state [==|!= '<state>']（id 允许连字符）
    const stateMatch = /^steps\.([A-Za-z0-9_-]+)\.state(\s*(==|!=)\s*['"]?(\w+)['"]?)?$/.exec(cond);
    if (stateMatch) {
      const stepId = stateMatch[1]!;
      const op = stateMatch[3] ?? '==';
      const expected = stateMatch[4] ?? 'done';
      const actual = runSteps[stepId]?.state ?? 'pending';
      return op === '==' ? actual === expected : actual !== expected;
    }

    // 默认：通过（兼容旧格式）
    return true;
  }

  /** 失败补偿：已完成 step 逆序执行 onRolling（或旧 compensate）所显式声明的补偿 step。 */
  private async compensate(
    def: WorkflowDef,
    run: WorkflowRun,
    outputs: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<void> {
    const completed = def.steps.filter((s) => run.steps[s.id]?.state === 'done');
    const stepById = new Map(def.steps.map((s) => [s.id, s]));
    // 逆序：后完成的先补偿（与提交顺序相反，保证回滚一致性）。
    for (const step of [...completed].reverse()) {
      // onRolling 优先，兼容旧 compensate 单值字段。
      const declared = step.onRolling ?? (step.compensate ? [step.compensate] : []);
      if (declared.length === 0) continue;
      // 区分：声明的是「已定义的补偿 step id」还是「字面量回滚指令」。
      const compStepIds = declared.filter((c) => stepById.has(c));
      const literalCmds = declared.filter((c) => !stepById.has(c));
      // 多个补偿 step 之间若存在 dependsOn，按拓扑序执行（先被依赖者），避免乱序回滚。
      const ordered = this.sortCompensations(compStepIds, def);

      const ctx: RunContext = {
        workflowId: def.id,
        tenantId: def.tenantId,
        traceId: def.traceId,
        outputs,
        signal,
        compensate: true,
      };

      for (const compId of ordered) {
        const compStep = stepById.get(compId)!;
        // 已成功补偿过（前次 run / resume 残留）的 step 不重复回滚（幂等护栏）。
        // P1 C5：compensate-failed 不在终态之列 —— 会在此被重试。
        if (run.steps[compId]?.state === 'compensated') continue;
        this.emit({ type: 'wf:compensate:start', workflowId: def.id, stepId: compId });
        try {
          // 补偿 step：用其自身 agent 执行；补偿 step 通常未执行过（无自身 output），
          // 因此输入取「触发 step 的输出」（副作用现场），同时落盘 compensateInput
          // 供 resume 重试失败补偿时复用（P2 加固 #8）。
          await this.resolveCard(compStep.agentRef);
          const compInput = run.steps[step.id]?.output;
          const result = await this.executor(compStep, compInput, ctx);
          run.steps[compId] = { id: compId, ...run.steps[compId], state: 'compensated', output: result, compensateInput: compInput, finishedAt: Date.now() };
          this.mergeStepTrace(run.steps[compId]!, ctx); // P2.5 补偿 step 链路同样落检查点
        } catch (e2: any) {
          // P1 C5：补偿失败改标 compensate-failed（非终态），不再冒充 compensated ——
          // 旧行为把失败补偿标成终态，resume 视其为已完成直接跳过，
          // 副作用既没回滚也不会补执行。保留 compensateInput 供 resume 重试。
          run.steps[compId] = { id: compId, ...run.steps[compId], state: 'compensate-failed', error: e2?.message ?? String(e2), compensateInput: run.steps[step.id]?.output };
          this.mergeStepTrace(run.steps[compId]!, ctx); // P2.5：失败的补偿链路是排障关键信息
        }
        await this.store.save(run);
        this.emit({ type: 'wf:compensate:done', workflowId: def.id, stepId: compId });
        this.emitStepUpdate(run, compId);
      }

      for (const cmd of literalCmds) {
        // 字面量回滚指令：复用触发 step 的 agent（executor 据 ctx.compensate 走回滚分支）。
        // P1 C5：幂等护栏只挡 compensated，compensate-failed 会被重试。
        if (run.steps[step.id]?.state === 'compensated') break;
        this.emit({ type: 'wf:compensate:start', workflowId: def.id, stepId: step.id });
        try {
          await this.resolveCard(step.agentRef); // 校验 agentRef 可解析（不可解析则抛出，落入 catch 记录）
          const result = await this.executor(step, cmd, ctx);
          run.steps[step.id] = { id: step.id, ...run.steps[step.id], state: 'compensated', output: result, compensateInput: cmd };
          this.mergeStepTrace(run.steps[step.id]!, ctx); // P2.5
        } catch (e2: any) {
          // P1 C5：同上 —— 失败补偿标 compensate-failed，纳入 resume 重试。
          run.steps[step.id] = { id: step.id, ...run.steps[step.id], state: 'compensate-failed', error: e2?.message ?? String(e2), compensateInput: cmd };
          this.mergeStepTrace(run.steps[step.id]!, ctx); // P2.5
        }
        await this.store.save(run);
        this.emit({ type: 'wf:compensate:done', workflowId: def.id, stepId: step.id });
        this.emitStepUpdate(run, step.id);
      }
    }
  }

  /** 对补偿 step 按 dependsOn 约束逆序排序（避免补偿间死锁）。 */
  private sortCompensations(ids: string[], def: WorkflowDef): string[] {
    const byId = new Map(def.steps.map((s) => [s.id, s]));
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const deps = byId.get(id)?.dependsOn ?? [];
      for (const d of deps) {
        if (ids.includes(d)) visit(d);
      }
      result.push(id);
    };

    for (const id of ids) visit(id);
    return result;
  }

  /** 从检查点续跑：仅执行未完成（非 done）的 step，已完成的输出直接复用。 */
  async resume(workflowId: string, signal?: AbortSignal): Promise<WorkflowRun> {
    const run = await this.store.get(workflowId);
    if (!run) throw new Error(`workflow not found: ${workflowId}`);
    if (run.state === 'done') return run;
    // 并发护栏：检查点属于另一 runId 且仍在 running（进程可能尚未结束）时拒绝续跑，
    // 避免两个执行体对同一 def.id 的检查点互相覆盖。
    const live = await this.store.get(workflowId);
    if (live && live.state === 'running' && live.runId && live.runId !== run.runId) {
      throw new Error(
        `workflow "${workflowId}" checkpoint belongs to a different running execution (runId=${live.runId}); ` +
          `concurrent resume rejected to avoid checkpoint overwrite`,
      );
    }

    const outputs: Record<string, unknown> = {};
    for (const s of run.def.steps) {
      if (run.steps[s.id]?.state === 'done') outputs[s.id] = run.steps[s.id]?.output;
    }

    // 续跑保持同一 runId（这是原运行的恢复，不是新运行）；旧快照无 runId 时补齐。
    const runId = run.runId ?? this.genRunId();
    run.runId = runId;
    run.state = 'running';
    // P1 C4：resume 同样走原子占位（同 runId 重取放行，异 runId 在跑则拒绝）。
    // 旧的 get+check 是同源读取自比较、恒为真，等于没有并发护栏。
    if (typeof this.store.claim === 'function') {
      const claimed = await this.store.claim(run);
      if (!claimed) {
        throw new Error(
          `workflow "${workflowId}" checkpoint belongs to a different running execution (runId=${runId}); ` +
            `concurrent resume rejected to avoid checkpoint overwrite`,
        );
      }
    } else {
      const live = await this.store.get(workflowId);
      if (live && live.state === 'running' && live.runId && live.runId !== runId) {
        throw new Error(
          `workflow "${workflowId}" checkpoint belongs to a different running execution (runId=${live.runId}); ` +
            `concurrent resume rejected to avoid checkpoint overwrite`,
        );
      }
      await this.store.save(run);
    }
    this.emit({ type: 'wf:start', workflowId, runId });
    // P6-D9-lite：续跑同样是一次生命周期跃迁（断点恢复 / 审批放行 / 分叉重跑执行），记入历史。
    pushRunHistory(run, 'resumed', runId);

    let stepFailed = false;
    // 恢复全局初始输入（run() 时随检查点持久化）：inputMapping 含 `input` 的 step
    // 续跑时才能解析真实目标；旧检查点无该字段时为 undefined（与旧行为一致）。
    const initialInput = run.initialInput;
    const approved = new Set(run.approvals ?? []); // P3：已批准放行的 step（approve 路由写入检查点后随 resume 生效）
    const skippedIds = new Set(
      run.def.steps.filter((s) => run.steps[s.id]?.state === 'skipped').map((s) => s.id)
    );
    // P6 动态 fan-out：resume 路径的 spawn 队列（检查点中已物化的子任务是普通 pending step，
    // 由下方调度循环自然执行；此处只处理「本次 resume 期间父 step 才完成」的 spawn）。
    const spawnQueue: Array<{ parent: StepDef; result: unknown }> = [];
    // P6 调度循环（与 run() 同构）：波次列表仅在物化发生时重算，无 spawn 时序列与旧版一致。
    let waves = this.topoWaves(run.def);
    let wi = 0;
    while (wi < waves.length) {
      const wave = waves[wi]!;
      if (signal?.aborted) break;
      const defById = new Map(run.def.steps.map((s) => [s.id, s]));
      // P3 审批门（与 run() 同语义）：未批准的 requireApproval step 使 run 再次暂停；
      // 已批准（写入 run.approvals）或已被级联跳过的 step 放行。
      const gated = wave.filter((id) => {
        const step = defById.get(id)!;
        if (!step.requireApproval || approved.has(id)) return false;
        if (this.outputDeps(step).some((d) => skippedIds.has(d))) return false;
        return true;
      });
      if (gated.length > 0) {
        // P6 方案一 A：进入审批暂停前快照（与 run() 同语义）。
        pushRunSnapshot(run, 'awaiting', wi + 1);
        for (const id of gated) {
          run.steps[id] = { id, state: 'awaiting' };
          this.emitStepUpdate(run, id);
        }
        run.state = 'awaiting';
        delete run.finishedAt;
        await this.store.save(run);
        this.emit({ type: 'wf:awaiting-approval', workflowId, runId, stepIds: gated, run });
        return run;
      }
      // P5 串行执行模式（与 run() 同语义）：serial 时波次内逐个 await，缺省并行。
      const resumeWaveStep = async (id: string): Promise<void> => {
          const sr = run.steps[id];
          // 终态 step 不重跑：done（已完成）、skipped（条件不满足，保持跳过）、
          // compensated（补偿动作已执行，回滚不应重复）。
          // P1 C5：compensate-failed 也不按普通 step 重跑 —— 它是补偿动作，
          // 重跑走 compensate() 的补偿语义（带 ctx.compensate），而非无回滚上下文的正常执行。
          if (sr?.state === 'done' || sr?.state === 'skipped' || sr?.state === 'compensated' || sr?.state === 'compensate-failed') return;
          const step = run.def.steps.find((s) => s.id === id)!;
          // 与 run() 同语义补齐（修复 resume 语义残缺）：
          // ① 级联跳过 —— 输出消费依赖已被跳过的上游时自动跳过，否则会执行
          //    「等待一个永远不会产出的 output」的 step（fallback 分支之外的照跑）；
          // ② 条件求值 —— run() 中因 condition 不满足而从未执行的 pending step，
          //    续跑时必须同样评估，而不是无条件真实执行。
          const depSkipped = this.outputDeps(step).some((d) => skippedIds.has(d));
          if (depSkipped) {
            skippedIds.add(id);
            run.steps[id] = { id, state: 'skipped' };
            await this.store.save(run);
            this.emit({ type: 'wf:step:start', workflowId, stepId: id });
            this.emit({ type: 'wf:step:done', workflowId, stepId: id });
            this.emitStepUpdate(run, id);
            return;
          }
          if (step.condition) {
            const conditionMet = await this.evaluateCondition(step.condition, initialInput, outputs, run.steps);
            if (!conditionMet) {
              skippedIds.add(id);
              run.steps[id] = { id, state: 'skipped' };
              await this.store.save(run);
              this.emit({ type: 'wf:step:start', workflowId, stepId: id });
              this.emit({ type: 'wf:step:done', workflowId, stepId: id });
              this.emitStepUpdate(run, id);
              return;
            }
          }
          const input = this.resolveInput(step, initialInput, outputs);
          const card = await this.resolveCard(step.agentRef);
          run.steps[id] = { id, state: 'running', agentId: card.id, input, startedAt: Date.now() };
          await this.store.save(run);
          this.emit({ type: 'wf:step:start', workflowId, stepId: id, agentId: card.id });
          this.emitStepUpdate(run, id);

          const ctx: RunContext = {
            workflowId,
            tenantId: run.def.tenantId,
            traceId: run.def.traceId,
            outputs,
            signal,
          };
          // P6 步骤级重试（与 run() 同语义）：失败尝试在 retries 预算内指数退避重试。
          const maxRetries = normalizeRetries(step);
          const backoffBase = normalizeBackoff(step);
          let attempt = 0;
          for (;;) {
            try {
              // P6-B：defRef（嵌套 subgraph）优先，否则走注入的 executor（见 executeStepCall）。
              const result = await this.executeStepCall(step, input, ctx);
              // P4.5 产出有效性闸门（与 run() 同语义）：分类非 ok 记录 outputIssue，
              // 且 run.def.failOnInvalidOutput 开启时按失败处置（进 catch → stepFailed + 级联 + 补偿）。
              const gateError = this.inspectOutputGate(run.def, run.steps[id], result);
              if (gateError) throw new Error(gateError);
              // P6 产出 schema 闸门（与 run() 同语义，opt-in）：失败写入 ctx.schemaFeedback
              // 供重试时 executor 注入定向修正指令。
              const schemaError = this.checkOutputSchema(step, run.steps[id], result);
              if (schemaError) {
                ctx.schemaFeedback = schemaError;
                throw new Error(schemaError);
              }
              ctx.schemaFeedback = undefined;
              run.steps[id] = { ...run.steps[id], state: 'done', output: result, finishedAt: Date.now() };
              outputs[id] = result;
              this.mergeStepTrace(run.steps[id], ctx); // P2.5 续跑 step 的链路同样落检查点
              this.emit({ type: 'wf:step:done', workflowId, stepId: id, output: result });
              this.emitStepUpdate(run, id);
              this.queueSpawns(step, result, spawnQueue); // P6 动态 fan-out 入队（波次收敛后物化）
              break;
            } catch (e: any) {
              const errMsg: string = e?.message ?? String(e);
              if (attempt < maxRetries && !ctx.signal?.aborted) {
                attempt += 1;
                run.steps[id] = { ...run.steps[id], attempts: attempt };
                this.emit({ type: 'wf:step:retry', workflowId, stepId: id, attempt, error: errMsg });
                this.emitStepUpdate(run, id);
                await this.store.save(run);
                await sleepMs(Math.min(backoffBase * 2 ** (attempt - 1), RETRY_BACKOFF_MAX_MS));
                if (!ctx.signal?.aborted) continue;
              }
              run.steps[id] = { ...run.steps[id], state: 'failed', error: errMsg };
              this.mergeStepTrace(run.steps[id], ctx); // P2.5：失败 step 的链路是排障关键信息
              this.emit({ type: 'wf:step:failed', workflowId, stepId: id, error: errMsg });
              this.emitStepUpdate(run, id);
              stepFailed = true;
              break;
            }
          }
          await this.store.save(run);
      };
      if (run.def.execMode === 'serial') {
        for (const id of wave) await resumeWaveStep(id);
      } else {
        await this.runWaveParallel(run.def, wave, resumeWaveStep);
      }
      wi += 1;
      // P6 方案一 A：波次收敛 → 状态快照（与 run() 同语义）。
      pushRunSnapshot(run, 'wave', wi);
      // P6 动态 fan-out：仅波次无失败时物化（失败即收敛 failed，与 run() 语义一致）。
      if (!stepFailed && this.drainSpawns(run.def, run, spawnQueue) > 0) {
        waves = this.topoWaves(run.def);
        const nextIdx = waves.findIndex((w) =>
          w.some((x) => {
            const st = run.steps[x]?.state ?? 'pending';
            return st === 'pending' || st === 'running' || st === 'awaiting';
          })
        );
        if (nextIdx < 0) break;
        wi = nextIdx;
      }
      if (stepFailed) break;
    }

    if (signal?.aborted && !stepFailed) {
      run.state = 'failed';
      run.error = 'workflow aborted';
    }

    if (stepFailed) {
      // 与 run() 一致：任一 step 失败 → 整个 run 标记 failed 并执行补偿（逆序 onRolling / 旧 compensate）。
      // P6-D9-lite：失败收敛前记录跃迁历史。
      pushRunHistory(run, 'failed', run.error ?? 'step failed during resume');
      // P6 方案一 A：失败收敛快照（回滚锚点）。
      pushRunSnapshot(run, 'failed', wi);
      run.state = 'failed';
      run.error = run.error ?? 'step failed during resume';
      run.finishedAt = Date.now();
      await this.store.save(run);
      await this.compensate(run.def, run, outputs, signal);
      // P1 C5：本轮补偿若仍有失败，step 保持 compensate-failed（非终态），
      // 下次 resume 会经下方「无新失败但存在补偿失败」分支继续重试。
      this.emit({ type: 'wf:failed', workflowId, run });
      return run;
    }
    // P1 C5：无新失败但存在此前补偿失败的 step → 重试补偿（不重跑业务 step）。
    // 旧行为只在 stepFailed 时才补偿，历史 compensate-failed 会被永久搁置。
    const hasCompFailed = run.def.steps.some((s) => run.steps[s.id]?.state === 'compensate-failed');
    if (hasCompFailed) {
      await this.compensate(run.def, run, outputs, signal);
      const stillCompFailed = run.def.steps.some((s) => run.steps[s.id]?.state === 'compensate-failed');
      if (stillCompFailed) {
        run.state = 'failed';
        run.error = run.error ?? 'compensation failed during resume (retry pending)';
        run.finishedAt = Date.now();
        await this.store.save(run);
        this.emit({ type: 'wf:failed', workflowId, run });
        return run;
      }
    }
    run.state = 'done';
    run.finishedAt = Date.now();
    await this.store.save(run);
    this.emit({ type: 'wf:done', workflowId, run });
    return run;
  }

  /**
   * 波次并行执行（带可选并发上限，P5 自动串/并决策的健壮性配套）。
   *
   * - `def.maxConcurrency` 为正整数时走**工作池**模式：保序取任务、完成一个补一个；
   *   缺省 / 非法值 = `Promise.all` 全并发（存量手工工作流零回归）。
   * - 失败语义与全并发一致：
   *   - run() 路径 `runStep` 抛错（fail-fast）→ 首个异常经 Promise.all 传播给引擎 catch
   *     （补偿 + wf:failed）；此后工作池**不再拉起新任务**（在途 step 自然跑完并落检查点，
   *     resume 时按已完成状态跳过，不浪费已产出的结果）。
   *   - resume 路径 `runStep` 不抛错（内部以 stepFailed 标记），池会把波次内剩余任务
   *     正常消费完 —— 与原 Promise.all 语义一致（收集完本波再收敛 failed）。
   * - 单线程事件循环保证波次内并发 step 对 `outputs` 的写入互不竞争（key 各异）；
   *   跨波依赖仍由 topoWaves 顺序保证（本波全部完成才进下一波）。
   */
  private async runWaveParallel(
    def: WorkflowDef,
    wave: string[],
    runStep: (id: string) => Promise<void>
  ): Promise<void> {
    // 全局并发上限（默认 16），防止未设 maxConcurrency 的工作流触发无界 fan-out，
    // 一次性拉起成百上千个 step / LLM 调用压垮事件循环与下游配额（P0 修复）。
    const GLOBAL_CAP = Math.max(1, Number(process.env.WF_MAX_CONCURRENCY) || 16);
    const raw = def.maxConcurrency;
    const requested =
      typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : GLOBAL_CAP;
    const limit = Math.min(requested, GLOBAL_CAP);
    // 追踪所有已派发 step 的 promise：失败传播前等待在途 step 收敛，
    // 否则补偿（读 completed 快照）与「迟到完成写检查点」并发 —— 补偿快照缺漏
    // 迟到完成者，且 resume 会把它们当已跳过，副作用既没回滚也不会补执行。
    const inflight: Promise<void>[] = [];
    const tracked = (id: string): Promise<void> => {
      const p = runStep(id);
      inflight.push(p);
      // 全部路径都会 await p；此条仅为防极端时序下 rejection 无人接住。
      void p.catch(() => {});
      return p;
    };
    const settleInflight = async () => {
      await Promise.allSettled(inflight);
    };
    if (limit >= wave.length) {
      try {
        await Promise.all(wave.map(tracked));
      } finally {
        await settleInflight();
      }
      return;
    }
    let next = 0;
    let failed = false;
    const workerCount = Math.min(limit, wave.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(
        (async () => {
          while (next < wave.length) {
            if (failed) break; // fail-fast：不再拉起新任务（在途的自然跑完）
            const id = wave[next++];
            if (id === undefined) break; // noUncheckedIndexedAccess 防御
            try {
              await tracked(id);
            } catch (e) {
              failed = true;
              throw e;
            }
          }
        })()
      );
    }
    try {
      await Promise.all(workers);
    } finally {
      await settleInflight();
    }
  }
}

// ─── P6 模块级纯函数（依赖抽取 / 重试参数 / 分叉重跑）────────────────────────

/** 单 step 的输出消费依赖（显式 dependsOn ∪ inputMapping 的 steps.<id> 引用）。 */
function outputDepsOf(step: StepDef): string[] {
  const set = new Set(step.dependsOn ?? []);
  for (const src of Object.values(step.inputMapping ?? {})) {
    const m = /^steps\.([A-Za-z0-9_-]+)/.exec(src);
    if (m) set.add(m[1]!);
  }
  return [...set];
}

/** 有效拓扑依赖 = 输出消费依赖 ∪ condition 对 steps.<id>.state/output 的引用（未知引用抛错）。 */
function effectiveDepsOf(def: WorkflowDef, step: StepDef): string[] {
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const set = new Set(outputDepsOf(step));
  if (step.condition) {
    const m = /^steps\.([A-Za-z0-9_-]+)\.(?:output|state)/.exec(step.condition.trim());
    if (m) set.add(m[1]!);
  }
  for (const d of set) {
    if (!byId.has(d)) {
      throw new Error(`step "${step.id}" references unknown step "${d}" (dependsOn/inputMapping/condition)`);
    }
  }
  return [...set];
}

/** P6 retries 归一：非法 / 缺省 → 0（不重试）；上限 STEP_RETRIES_MAX。 */
function normalizeRetries(step: StepDef): number {
  const r = step.retries;
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 1) return 0;
  return Math.min(Math.floor(r), STEP_RETRIES_MAX);
}

/** P6 退避基数归一：非法 → 缺省 500ms。 */
function normalizeBackoff(step: StepDef): number {
  const b = step.retryBackoffMs;
  return typeof b === 'number' && Number.isFinite(b) && b >= 0 ? b : RETRY_BACKOFF_DEFAULT_MS;
}

/** 可中断休眠（重试退避；到点即返回，取消检查由调用方负责）。 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * P6-D9-lite 跃迁历史：追加一条「跃迁前状态快照」到 run.history（随检查点持久化，
 * 保留最近 WORKFLOW_HISTORY_MAX 条）。time travel 审计的最小可用形态 ——
 * 「分叉重跑前长什么样 / 失败时各 step 处于什么状态」可回溯。
 */
export function pushRunHistory(run: WorkflowRun, action: string, detail?: string): void {
  const prevStates: Record<string, string> = {};
  for (const [id, sr] of Object.entries(run.steps)) {
    prevStates[id] = sr?.state ?? 'pending';
  }
  const entry: WorkflowHistoryEntry = {
    ts: Date.now(),
    action,
    prevStates,
    ...(detail ? { detail } : {}),
  };
  run.history = [...(run.history ?? []), entry].slice(-WORKFLOW_HISTORY_MAX);
}

/** 快照 id 序号（进程内单调；与 ts 组合保证唯一）。 */
let snapSeq = 0;

/**
 * P6 方案一 A：捕获状态快照（波次收敛 / awaiting / failed 时调用）。
 * steps 做 JSON 深拷贝（引擎后续对 StepRun 的原地变异 —— mergeStepTrace 写 sr.trace、
 * 字段更新 —— 不得污染已入快照的对象）；产出超 SNAPSHOT_OUTPUT_MAX 的 step 省略产出
 * 并记入 outputOmitted（rollback 时强制重置 pending 重跑，杜绝截断产出污染黑板）。
 * 返回快照 id。
 */
export function pushRunSnapshot(run: WorkflowRun, action: string, wave: number): string {
  const id = `snap_${Date.now().toString(36)}_${++snapSeq}`;
  const steps: Record<string, StepRun> = {};
  const omitted: string[] = [];
  for (const [sid, sr] of Object.entries(run.steps)) {
    if (!sr) continue;
    const out = sr.output;
    if (out !== undefined) {
      const size = typeof out === 'string' ? out.length : (JSON.stringify(out)?.length ?? 0);
      if (size > SNAPSHOT_OUTPUT_MAX) {
        omitted.push(sid);
        const copy = JSON.parse(JSON.stringify({ ...sr, output: undefined })) as StepRun;
        steps[sid] = copy;
        continue;
      }
    }
    steps[sid] = JSON.parse(JSON.stringify(sr)) as StepRun;
  }
  const snap: WorkflowSnapshot = {
    id,
    ts: Date.now(),
    action,
    wave,
    steps,
    ...(omitted.length ? { outputOmitted: omitted } : {}),
  };
  run.snapshots = [...(run.snapshots ?? []), snap].slice(-WORKFLOW_SNAPSHOT_MAX);
  return id;
}

/**
 * P6 方案一 A：把 run 恢复到指定快照时点（纯函数，随引擎 rollback / 服务端
 * POST /:id/rollback 暴露）。语义：
 * - steps 恢复为快照内容（产出被省略的 step 重置 pending 重跑，杜绝截断产出进黑板）；
 * - 快照之后新增的 step（动态物化子任务）重置 pending —— 其依赖父步已恢复 done，
 *   resume 会按 def 拓扑直接执行它们（父不再重跑、spawn 不重放，物化 id 已在 def）；
 * - state → pending，清 error/finishedAt，随后走既有 /resume 重放；
 * - 跃迁历史记 'rollback'（重置前的状态留档）。
 */
export function rollbackToSnapshot(run: WorkflowRun, snapshotId: string): WorkflowRun {
  if (run.state === 'running') {
    throw new Error(
      `workflow "${run.def.id}" 正在运行（runId=${run.runId ?? 'unknown'}），不可回滚——先 cancel 再重试`
    );
  }
  const snap = (run.snapshots ?? []).find((s) => s.id === snapshotId);
  if (!snap) {
    const n = (run.snapshots ?? []).length;
    throw new Error(`快照不存在："${snapshotId}"（该 run 共 ${n} 份快照）`);
  }
  pushRunHistory(run, 'rollback', `to ${snapshotId}`);
  const restored: Record<string, StepRun> = {};
  for (const [sid, sr] of Object.entries(snap.steps)) {
    restored[sid] = snap.outputOmitted?.includes(sid)
      ? { id: sid, state: 'pending' }
      : (JSON.parse(JSON.stringify(sr)) as StepRun);
  }
  for (const sid of Object.keys(run.steps)) {
    if (!restored[sid]) restored[sid] = { id: sid, state: 'pending' };
  }
  run.steps = restored;
  run.state = 'pending';
  delete run.error;
  delete run.finishedAt;
  return run;
}

/**
 * P6 step 分叉重跑：计算 stepId 及其全部传递下游（沿 effectiveDeps 反向可达集，含自身）。
 * 未知 stepId 抛错。纯函数，供 resetRunForRerun 与 server 路由复用。
 */
export function downstreamSteps(def: WorkflowDef, stepId: string): string[] {
  const byId = new Set(def.steps.map((s) => s.id));
  if (!byId.has(stepId)) throw new Error(`workflow "${def.id}" 不存在 step "${stepId}"`);
  const dependents = new Map<string, Set<string>>();
  for (const s of def.steps) {
    for (const d of effectiveDepsOf(def, s)) {
      let set = dependents.get(d);
      if (!set) {
        set = new Set<string>();
        dependents.set(d, set);
      }
      set.add(s.id);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>([stepId]);
  const queue: string[] = [stepId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    out.push(cur);
    for (const nxt of dependents.get(cur) ?? []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        queue.push(nxt);
      }
    }
  }
  return out;
}

/**
 * P6 分叉重跑（纯函数）：把 stepId 及其全部下游重置为 pending（清空产出 / 错误 / 链路 /
 * attempts），run 置回 pending 并清除 error / finishedAt；调用方随后 save + resume 即从
 * 该 step 重新执行（上游 done 产出原样复用）。running 态拒绝（先 cancel）。
 * 注意：下游中此前被补偿（compensated）的 step 一并重置 —— 分叉重跑意味着其副作用将重新产生。
 */
export function resetRunForRerun(run: WorkflowRun, stepId: string): WorkflowRun {
  if (run.state === 'running') {
    throw new Error(`workflow "${run.def.id}" 正在运行（runId=${run.runId ?? 'unknown'}），不可分叉重跑——先 cancel 再重试`);
  }
  const targets = downstreamSteps(run.def, stepId);
  // P6-D9-lite：重置前先记「跃迁前状态」历史（rerun 起点 + 当时的全部 step 状态）。
  pushRunHistory(run, 'rerun', `from ${stepId}`);
  for (const id of targets) {
    run.steps[id] = { id, state: 'pending' };
  }
  run.state = 'pending';
  delete run.error;
  delete run.finishedAt;
  return run;
}

/** 便捷函数：用共享存储 + 注入 executor 跑一次工作流。 */
export async function runWorkflow(
  def: WorkflowDef,
  executor: StepExecutor,
  initialInput?: unknown,
  opts: { store?: WorkflowStore; onEvent?: (e: WorkflowEvent) => void; signal?: AbortSignal } = {}
): Promise<WorkflowRun> {
  const engine = new DagEngine({ store: opts.store, executor, onEvent: opts.onEvent });
  return engine.run(def, initialInput, opts.signal);
}
