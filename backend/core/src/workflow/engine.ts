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
import type { StepDef, StepRun, StepTraceNode, WorkflowDef, WorkflowRun } from './types';
import { type WorkflowStore, VolatileWorkflowStore } from './store';
import { inspectStepOutput } from './step-output';

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
}

/** 单 step 调用链路节点数上限（R5 体积护栏）：超出截断保留早期调用，防止检查点膨胀。 */
export const STEP_TRACE_MAX_NODES = 500;
/** 调用链路单节点 detail 长度上限（截断存储，避免单条长产出拖垮检查点）。 */
export const STEP_TRACE_DETAIL_MAX = 500;

/** 引擎对外发出的工作流事件（供 SSE / 可观测消费）。 */
export type WorkflowEvent =
  | { type: 'wf:start'; workflowId: string; runId: string }
  | { type: 'wf:step:start'; workflowId: string; stepId: string; agentId?: string; teamId?: string }
  | { type: 'wf:step:done'; workflowId: string; stepId: string; output?: unknown }
  | { type: 'wf:step:failed'; workflowId: string; stepId: string; error: string }
  | { type: 'wf:compensate:start'; workflowId: string; stepId: string }
  | { type: 'wf:compensate:done'; workflowId: string; stepId: string }
  /** P3：审批门暂停 —— 当前波次内存在未批准的 requireApproval step，run 进入 awaiting。 */
  | { type: 'wf:awaiting-approval'; workflowId: string; runId?: string; stepIds: string[]; run: WorkflowRun }
  | { type: 'wf:done'; workflowId: string; runId?: string; run: WorkflowRun }
  | { type: 'wf:failed'; workflowId: string; runId?: string; run: WorkflowRun };

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
}

export class DagEngine {
  /** 进程内单调自增序号（用于 genRunId 生成同进程内不重复的 runId）。 */
  private static _seq = 0;
  private readonly registry: AgentRegistry;
  private readonly teamManager: TeamManager | null;
  private readonly store: WorkflowStore;
  private readonly executor: StepExecutor;
  private readonly onEvent?: (e: WorkflowEvent) => void;

  constructor(opts: DagEngineOptions) {
    if (!opts.executor) {
      throw new Error('DagEngine requires an injected `executor` (core does not construct harnesses).');
    }
    this.registry = opts.registry ?? getAgentRegistry();
    this.teamManager = opts.teamManager ?? getTeamManager();
    this.store = opts.store ?? new VolatileWorkflowStore();
    this.executor = opts.executor;
    this.onEvent = opts.onEvent;
  }

  private emit(e: WorkflowEvent): void {
    this.onEvent?.(e);
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
    return `无效产出（${insp.issue}）${insp.detail ? `：${insp.detail}` : ''}`;
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
    const stepStates = new Set(['pending', 'running', 'done', 'failed', 'compensated', 'skipped']);
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
    const set = new Set(step.dependsOn ?? []);
    for (const src of Object.values(step.inputMapping ?? {})) {
      const m = /^steps\.([A-Za-z0-9_-]+)/.exec(src);
      if (m) set.add(m[1]!);
    }
    return [...set];
  }

  /**
   * 有效拓扑依赖 = 输出消费依赖 ∪ condition 对 steps.<id>.state/output 的引用。
   * 全部参与拓扑分层，消除「引用了 steps.<id> 但未声明 dependsOn」导致同波次并行的竞态
   * （旧行为：引用落到未落定的上游 → 条件/映射取到 undefined → 静默误判）。
   */
  private effectiveDeps(def: WorkflowDef, step: StepDef): string[] {
    const byId = new Map(def.steps.map((s) => [s.id, s]));
    const set = new Set(this.outputDeps(step));
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
    };
    // 拓扑合法性 fail-fast：环 / 未知依赖 / 重复 stepId 在 try 之外抛错，
    // 使 run() 以 reject 形式暴露（而非吞成 state=failed），符合「校验错误即失败」。
    this.validateWorkflow(def);
    // 并发护栏：store 按 def.id 存单检查点。若已存在「另一 runId 且仍在 running」的检查点，
    // 说明同 def 有并发运行在进行 —— 拒绝启动（fail-fast），避免互相覆盖检查点导致续跑错乱。
    const existing = await this.store.get(def.id);
    if (existing && existing.state === 'running' && existing.runId && existing.runId !== runId) {
      throw new Error(
        `workflow "${def.id}" already has a running execution (runId=${existing.runId}); ` +
          `concurrent run rejected to avoid checkpoint overwrite — resume it or wait for it to finish`,
      );
    }
    await this.store.save(run);
    this.emit({ type: 'wf:start', workflowId: def.id, runId });

    const outputs: Record<string, unknown> = {};
    const skipped = new Set<string>(); // 被条件跳过的 step id
    const defById = new Map(def.steps.map((s) => [s.id, s]));
    const approved = new Set(run.approvals ?? []); // P3：已批准放行的 step
    try {
      for (const wave of this.topoWaves(def)) {
        if (signal?.aborted) throw new Error('workflow aborted');
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
          for (const id of gated) run.steps[id] = { id, state: 'awaiting' };
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
              // P4.5 产出有效性闸门：无效产出（空 / 中断 / 护栏兜底）不再「静默成功」——
              // 开启 def.failOnInvalidOutput 时按失败处置（进下方 catch → failed + 补偿 + 级联），
              // 未开启仅记录 outputIssue（存量零回归）。
              const gateError = this.inspectOutputGate(def, sr, result);
              if (gateError) throw new Error(gateError);
              sr.state = 'done';
              sr.finishedAt = Date.now();
              outputs[id] = result;
              this.mergeStepTrace(sr, ctx); // P2.5 调用链路落检查点（缺省 no-op）
              await this.store.save(run);
              this.emit({ type: 'wf:step:done', workflowId: def.id, stepId: id, output: result });
            } catch (e: any) {
              const errMsg: string = e?.message ?? String(e);
              sr.state = 'failed';
              sr.error = errMsg;
              this.mergeStepTrace(sr, ctx); // P2.5：失败 step 的链路是排障关键信息
              await this.store.save(run);
              this.emit({ type: 'wf:step:failed', workflowId: def.id, stepId: id, error: errMsg });
              throw e;
            }
        };
        if (def.execMode === 'serial') {
          for (const id of wave) await runWaveStep(id);
        } else {
          await this.runWaveParallel(def, wave, runWaveStep);
        }
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
          // 补偿失败：记录但不阻断其余补偿（避免雪崩）；保留 compensateInput 供重试。
          run.steps[compId] = { id: compId, ...run.steps[compId], state: 'compensated', error: e2?.message ?? String(e2), compensateInput: run.steps[step.id]?.output };
          this.mergeStepTrace(run.steps[compId]!, ctx); // P2.5：失败的补偿链路是排障关键信息
        }
        await this.store.save(run);
        this.emit({ type: 'wf:compensate:done', workflowId: def.id, stepId: compId });
      }

      for (const cmd of literalCmds) {
        // 字面量回滚指令：复用触发 step 的 agent（executor 据 ctx.compensate 走回滚分支）。
        if (run.steps[step.id]?.state === 'compensated') break; // 上一轮已补偿过（幂等护栏）
        this.emit({ type: 'wf:compensate:start', workflowId: def.id, stepId: step.id });
        try {
          await this.resolveCard(step.agentRef); // 校验 agentRef 可解析（不可解析则抛出，落入 catch 记录）
          const result = await this.executor(step, cmd, ctx);
          run.steps[step.id] = { id: step.id, ...run.steps[step.id], state: 'compensated', output: result, compensateInput: cmd };
          this.mergeStepTrace(run.steps[step.id]!, ctx); // P2.5
        } catch (e2: any) {
          run.steps[step.id] = { id: step.id, ...run.steps[step.id], state: 'compensated', error: e2?.message ?? String(e2), compensateInput: cmd };
          this.mergeStepTrace(run.steps[step.id]!, ctx); // P2.5
        }
        await this.store.save(run);
        this.emit({ type: 'wf:compensate:done', workflowId: def.id, stepId: step.id });
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
    await this.store.save(run);
    this.emit({ type: 'wf:start', workflowId, runId });

    let stepFailed = false;
    const defById = new Map(run.def.steps.map((s) => [s.id, s]));
    const approved = new Set(run.approvals ?? []); // P3：已批准放行的 step（approve 路由写入检查点后随 resume 生效）
    const skippedIds = new Set(
      run.def.steps.filter((s) => run.steps[s.id]?.state === 'skipped').map((s) => s.id)
    );
    for (const wave of this.topoWaves(run.def)) {
      if (signal?.aborted) break;
      // P3 审批门（与 run() 同语义）：未批准的 requireApproval step 使 run 再次暂停；
      // 已批准（写入 run.approvals）或已被级联跳过的 step 放行。
      const gated = wave.filter((id) => {
        const step = defById.get(id)!;
        if (!step.requireApproval || approved.has(id)) return false;
        if (this.outputDeps(step).some((d) => skippedIds.has(d))) return false;
        return true;
      });
      if (gated.length > 0) {
        for (const id of gated) run.steps[id] = { id, state: 'awaiting' };
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
          if (sr?.state === 'done' || sr?.state === 'skipped' || sr?.state === 'compensated') return;
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
            // P4.5 产出有效性闸门（与 run() 同语义）：分类非 ok 记录 outputIssue，
            // 且 run.def.failOnInvalidOutput 开启时按失败处置（进 catch → stepFailed + 级联 + 补偿）。
            const gateError = this.inspectOutputGate(run.def, run.steps[id], result);
            if (gateError) throw new Error(gateError);
            run.steps[id] = { ...run.steps[id], state: 'done', output: result, finishedAt: Date.now() };
            outputs[id] = result;
            this.mergeStepTrace(run.steps[id], ctx); // P2.5 续跑 step 的链路同样落检查点
            this.emit({ type: 'wf:step:done', workflowId, stepId: id, output: result });
          } catch (e: any) {
            run.steps[id] = { ...run.steps[id], state: 'failed', error: e?.message ?? String(e) };
            this.mergeStepTrace(run.steps[id], ctx); // P2.5：失败 step 的链路是排障关键信息
            this.emit({ type: 'wf:step:failed', workflowId, stepId: id, error: e?.message ?? String(e) });
            stepFailed = true;
          }
          await this.store.save(run);
      };
      if (run.def.execMode === 'serial') {
        for (const id of wave) await resumeWaveStep(id);
      } else {
        await this.runWaveParallel(run.def, wave, resumeWaveStep);
      }
      if (stepFailed) break;
    }

    if (signal?.aborted && !stepFailed) {
      run.state = 'failed';
      run.error = 'workflow aborted';
    }

    if (stepFailed) {
      // 与 run() 一致：任一 step 失败 → 整个 run 标记 failed 并执行补偿（逆序 onRolling / 旧 compensate）。
      run.state = 'failed';
      run.error = run.error ?? 'step failed during resume';
      run.finishedAt = Date.now();
      await this.store.save(run);
      await this.compensate(run.def, run, outputs, signal);
      this.emit({ type: 'wf:failed', workflowId, run });
      return run;
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
    const raw = def.maxConcurrency;
    const limit =
      typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
        ? Math.floor(raw)
        : Infinity;
    if (limit >= wave.length) {
      await Promise.all(wave.map(runStep));
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
              await runStep(id);
            } catch (e) {
              failed = true;
              throw e;
            }
          }
        })()
      );
    }
    await Promise.all(workers);
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
