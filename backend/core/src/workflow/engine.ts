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
import type { StepDef, StepRun, WorkflowDef, WorkflowRun } from './types';
import { type WorkflowStore, VolatileWorkflowStore } from './store';

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
}

/** 引擎对外发出的工作流事件（供 SSE / 可观测消费）。 */
export type WorkflowEvent =
  | { type: 'wf:start'; workflowId: string }
  | { type: 'wf:step:start'; workflowId: string; stepId: string; agentId?: string }
  | { type: 'wf:step:done'; workflowId: string; stepId: string; output?: unknown }
  | { type: 'wf:step:failed'; workflowId: string; stepId: string; error: string }
  | { type: 'wf:compensate:start'; workflowId: string; stepId: string }
  | { type: 'wf:compensate:done'; workflowId: string; stepId: string }
  | { type: 'wf:done'; workflowId: string; run: WorkflowRun }
  | { type: 'wf:failed'; workflowId: string; run: WorkflowRun };

export interface DagEngineOptions {
  /** 注册表：解析 agentRef（字符串 id）。缺省用共享单例。 */
  registry?: AgentRegistry;
  /** 存储后端：检查点 / 续跑 / 审计。缺省 Volatile。 */
  store?: WorkflowStore;
  /** 必填：执行单个 step 的回调（本地 harness / A2A / mock）。 */
  executor: StepExecutor;
  /** 引擎级事件回调（SSE / 可观测）。 */
  onEvent?: (e: WorkflowEvent) => void;
}

export class DagEngine {
  private readonly registry: AgentRegistry;
  private readonly store: WorkflowStore;
  private readonly executor: StepExecutor;
  private readonly onEvent?: (e: WorkflowEvent) => void;

  constructor(opts: DagEngineOptions) {
    if (!opts.executor) {
      throw new Error('DagEngine requires an injected `executor` (core does not construct harnesses).');
    }
    this.registry = opts.registry ?? getAgentRegistry();
    this.store = opts.store ?? new VolatileWorkflowStore();
    this.executor = opts.executor;
    this.onEvent = opts.onEvent;
  }

  private emit(e: WorkflowEvent): void {
    this.onEvent?.(e);
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
  }

  /** agentRef 解析为 AgentCard（字符串 → 注册表查询；内联对象 → 直接用）。 */
  private async resolveCard(ref: string | AgentCard): Promise<AgentCard> {
    if (typeof ref !== 'string') return ref;
    const card = await this.registry.get(ref);
    if (!card) throw new Error(`unknown agentRef: ${ref}`);
    return card;
  }

  /**
   * 拓扑分层：返回若干「波次」，每波次内的 step 互相无依赖、可并行。
   * 遇环或缺依赖（dependsOn 指向不存在的 step）抛错（fail-fast，避免静默死锁）。
   */
  private topoWaves(def: WorkflowDef): string[][] {
    const byId = new Map(def.steps.map((s) => [s.id, s]));
    for (const s of def.steps) {
      for (const d of s.dependsOn ?? []) {
        if (!byId.has(d)) throw new Error(`step "${s.id}" depends on unknown step "${d}"`);
      }
    }
    const remaining = new Set(def.steps.map((s) => s.id));
    const done = new Set<string>();
    const waves: string[][] = [];
    while (remaining.size > 0) {
      const wave: string[] = [];
      for (const id of remaining) {
        const deps = byId.get(id)!.dependsOn ?? [];
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

  /** 按 inputMapping 解析本 step 的实际输入。 */
  private resolveInput(step: StepDef, initialInput: unknown, outputs: Record<string, unknown>): unknown {
    const map = step.inputMapping;
    if (!map || Object.keys(map).length === 0) return initialInput;
    const out: Record<string, unknown> = {};
    for (const [key, src] of Object.entries(map)) {
      if (src === 'input') out[key] = initialInput;
      else if (src.startsWith('steps.')) out[key] = outputs[src.slice('steps.'.length)];
      else out[key] = src; // 字面量
    }
    return out;
  }

  /** 完整运行一个工作流（DAG 并行 + 失败补偿）。 */
  async run(def: WorkflowDef, initialInput?: unknown, signal?: AbortSignal): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      def,
      state: 'running',
      steps: Object.fromEntries(def.steps.map((s) => [s.id, { id: s.id, state: 'pending' } as StepRun])),
      startedAt: Date.now(),
    };
    // 拓扑合法性 fail-fast：环 / 未知依赖 / 重复 stepId 在 try 之外抛错，
    // 使 run() 以 reject 形式暴露（而非吞成 state=failed），符合「校验错误即失败」。
    this.validateWorkflow(def);
    await this.store.save(run);
    this.emit({ type: 'wf:start', workflowId: def.id });

    const outputs: Record<string, unknown> = {};
    try {
      for (const wave of this.topoWaves(def)) {
        if (signal?.aborted) throw new Error('workflow aborted');
        await Promise.all(
          wave.map(async (id) => {
            const step = def.steps.find((s) => s.id === id)!;
            const input = this.resolveInput(step, initialInput, outputs);
            const card = await this.resolveCard(step.agentRef);
            const sr: StepRun = { id, state: 'running', agentId: card.id, input, startedAt: Date.now() };
            run.steps[id] = sr;
            await this.store.save(run);
            this.emit({ type: 'wf:step:start', workflowId: def.id, stepId: id, agentId: card.id });

            const ctx: RunContext = {
              workflowId: def.id,
              tenantId: def.tenantId,
              traceId: def.traceId,
              outputs,
              signal,
            };
            try {
              const result = await this.executor(step, input, ctx);
              sr.output = result;
              sr.state = 'done';
              sr.finishedAt = Date.now();
              outputs[id] = result;
              await this.store.save(run);
              this.emit({ type: 'wf:step:done', workflowId: def.id, stepId: id, output: result });
            } catch (e: any) {
              // 单 step 失败：先持久化该 step 的 failed 状态（避免停在 running），
              // 再向外抛出以触发补偿事务。
              const errMsg: string = e?.message ?? String(e);
              sr.state = 'failed';
              sr.error = errMsg;
              await this.store.save(run);
              this.emit({ type: 'wf:step:failed', workflowId: def.id, stepId: id, error: errMsg });
              throw e;
            }
          })
        );
      }
      run.state = 'done';
      run.finishedAt = Date.now();
      await this.store.save(run);
      this.emit({ type: 'wf:done', workflowId: def.id, run });
      return run;
    } catch (e: any) {
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

  /** 失败补偿：已完成 step 逆序执行 compensate（解决「副作用无回滚」）。 */
  private async compensate(
    def: WorkflowDef,
    run: WorkflowRun,
    outputs: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<void> {
    const completed = def.steps.filter((s) => run.steps[s.id]?.state === 'done');
    // 逆序：后完成的先补偿（与提交顺序相反，保证回滚一致性）。
    for (const step of [...completed].reverse()) {
      const comp = step.compensate;
      if (!comp) continue;
      const compStep = def.steps.find((s) => s.id === comp);

      this.emit({ type: 'wf:compensate:start', workflowId: def.id, stepId: compStep ? compStep.id : step.id });
      const ctx: RunContext = {
        workflowId: def.id,
        tenantId: def.tenantId,
        traceId: def.traceId,
        outputs,
        signal,
        compensate: true,
      };
      try {
        if (compStep) {
          // 补偿动作是另一个 step：用其 agent 执行，输入取该 step 已完成的 output。
          const card = await this.resolveCard(compStep.agentRef);
          const result = await this.executor(compStep, run.steps[compStep.id]?.output, ctx);
          run.steps[compStep.id] = {
            ...run.steps[compStep.id],
            state: 'compensated',
            output: result,
            finishedAt: Date.now(),
          };
        } else {
          // 补偿指令为字面量：复用同一 agent（executor 据 compensate 标志回滚）。
          const card = await this.resolveCard(step.agentRef);
          const result = await this.executor(step, comp, ctx);
          run.steps[step.id] = { ...run.steps[step.id], state: 'compensated', output: result };
        }
      } catch (e2: any) {
        // 补偿失败：记录但不阻断其余补偿（避免雪崩）。
        const sid = compStep ? compStep.id : step.id;
        run.steps[sid] = { ...run.steps[sid], state: 'compensated', error: e2?.message ?? String(e2) };
      }
      await this.store.save(run);
      this.emit({ type: 'wf:compensate:done', workflowId: def.id, stepId: compStep ? compStep.id : step.id });
    }
  }

  /** 从检查点续跑：仅执行未完成（非 done）的 step，已完成的输出直接复用。 */
  async resume(workflowId: string, signal?: AbortSignal): Promise<WorkflowRun> {
    const run = await this.store.get(workflowId);
    if (!run) throw new Error(`workflow not found: ${workflowId}`);
    if (run.state === 'done') return run;

    const outputs: Record<string, unknown> = {};
    for (const s of run.def.steps) {
      if (run.steps[s.id]?.state === 'done') outputs[s.id] = run.steps[s.id].output;
    }

    run.state = 'running';
    await this.store.save(run);
    this.emit({ type: 'wf:start', workflowId });

    for (const wave of this.topoWaves(run.def)) {
      if (signal?.aborted) break;
      await Promise.all(
        wave.map(async (id) => {
          const sr = run.steps[id];
          if (sr?.state === 'done') return; // 已完成，跳过
          const step = run.def.steps.find((s) => s.id === id)!;
          const input = this.resolveInput(step, undefined, outputs);
          const card = await this.resolveCard(step.agentRef);
          run.steps[id] = { id, state: 'running', agentId: card.id, input, startedAt: Date.now() };
          await this.store.save(run);
          this.emit({ type: 'wf:step:start', workflowId, stepId: id, agentId: card.id });

          const ctx: RunContext = {
            workflowId,
            tenantId: run.def.tenantId,
            traceId: run.def.traceId,
            outputs,
            signal,
          };
          try {
            const result = await this.executor(step, input, ctx);
            run.steps[id] = { ...run.steps[id], state: 'done', output: result, finishedAt: Date.now() };
            outputs[id] = result;
            this.emit({ type: 'wf:step:done', workflowId, stepId: id, output: result });
          } catch (e: any) {
            run.steps[id] = { ...run.steps[id], state: 'failed', error: e?.message ?? String(e) };
            this.emit({ type: 'wf:step:failed', workflowId, stepId: id, error: e?.message ?? String(e) });
          }
          await this.store.save(run);
        })
      );
    }
    run.state = 'done';
    run.finishedAt = Date.now();
    await this.store.save(run);
    this.emit({ type: 'wf:done', workflowId, run });
    return run;
  }
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
