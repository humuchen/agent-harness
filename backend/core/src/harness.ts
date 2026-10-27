/**
 * AgentHarness —— LLM ↔ 工具 ↔ 记忆 主循环（聚合门面）。
 *
 * P1-2 拆分说明（纯结构解耦，行为与对外接口零变化）：
 * 此前本文件承载了类型契约、上下文窗口工具、去重 key、消息净化、用量记账、
 * 工具执行竞速、验证门禁等全部职责（~1830 行）。现按职责拆分为 harness/ 子模块，
 * 本文件保留：
 *   1. 对外 API 聚合与 re-export（AgentHarness / contextWindowFor /
 *      HarnessEvent / HarnessOptions / sanitizeToolPairing —— 导入路径不变，
 *      13 个测试文件与 index.ts 的 `export * from './harness'` 契约不受影响）；
 *   2. AgentHarness 类与 runInner 主循环骨架（run 启动/中止装配、输入护栏、
 *      记忆装配、主循环 LLM 调用与溢出自愈、输出护栏、计划模式收尾、持久化）。
 *
 * 子模块清单（依赖方向：harness.ts → harness/*，harness/* → 上层模块，无环）：
 *   - harness/types.ts            事件与选项类型契约（零运行时逻辑）
 *   - harness/context-window.ts   上下文窗口解析 + 溢出错误识别（纯函数）
 *   - harness/tool-dedup.ts       工具调用去重 key（纯函数）
 *   - harness/id.ts               run id 生成（模块级计数器）
 *   - harness/message-sanitizer.ts tool 配对净化 + 工具调用收集（纯变换）
 *   - harness/run-prompts.ts      软截止收尾提示 + 中止文案（纯常量/函数）
 *   - harness/content-blocks.ts   多模态用户消息构造（纯函数）
 *   - harness/usage-accounting.ts LLM 用量记账与 run:cost/llm:usage 事件
 *   - harness/tool-executor.ts    单工具执行「中止+超时」竞速
 *   - harness/verify-gate.ts      运行期自动验证门禁（含自愈重试）
 *   - harness/run-phases/tool-round.ts 单步工具轮三阶段并发编排（H3 段迁出）
 */
import type { ToolCall } from './types';
import type { VerifyContext } from './verify';
import { Memory } from './memory';
import { resolveAndTrack, EntityTracker } from './coreference';
import { checkInputAsync } from './guardrails';
import {
  withSpan,
  incCounter,
  recordError,
  structLog,
  logError,
  emitAlert,
  incCounterTenant
} from './telemetry';
import { hooks } from './hooks';
import { runWithEventSink } from './run-events';
import { bindRunId } from './run-user';
import {
  PARTIAL_NOTICE,
  ERROR_PREFIX,
  CIRCUIT_BREAKER_PREFIX,
  MAX_STEPS_NOTICE
} from './workflow/step-output';

// ── 拆分子模块 ──────────────────────────────────────────────────────────
import type { HarnessEvent, HarnessOptions, ResolvedHarnessOptions } from './harness/types';
import { contextWindowFor } from './harness/context-window';
import { stableToolKey } from './harness/tool-dedup';
import { nextId } from './harness/id';
import { sanitizeToolPairing, collectToolCalls } from './harness/message-sanitizer';
import { WRAP_UP_PROMPT, abortedMessage } from './harness/run-prompts';
import { accountAndEmitUsage } from './harness/usage-accounting';
import { executeToolRound } from './harness/run-phases/tool-round';
import type { ToolRoundState } from './harness/run-phases/tool-round';
import { runVerifyGate } from './harness/verify-gate';
import { setupRunSignal } from './harness/run-phases/signal-setup';
import { computeTimeBudget } from './harness/run-phases/time-budget';
import { selectStepTools } from './harness/run-phases/dynamic-tools';
import { setupRunMemory } from './harness/run-phases/memory-setup';
import { planProposeFinalize } from './harness/run-phases/plan-finish';
import { finalizeRun } from './harness/run-phases/finalize';
import { runOutputGate } from './harness/run-phases/output-gate';
import { emitAssistantTurn } from './harness/run-phases/assistant-turn';
import { resolveFinalOutput } from './harness/run-phases/final-output';
import { callLlmWithSelfHeal } from './harness/run-phases/loop-llm';

// ── 对外 API re-export（导入路径与拆分前完全一致）────────────────────────
export { contextWindowFor } from './harness/context-window';
export { sanitizeToolPairing } from './harness/message-sanitizer';
export type { HarnessEvent, HarnessOptions } from './harness/types';

export class AgentHarness {
  private opts: ResolvedHarnessOptions;
  /** 指代消解实体追踪器（COREF_ENABLED=true 时启用） */
  private _corefTracker?: EntityTracker;
  private _corefTurn = 0;
  // 自适应上下文预算：观测到模型实际接受过的最大 prompt（token）。用于在窗口元数据
  // 虚高（免费模型 context_length 取不到 → 回落 128K）时仍能压得动历史，避免「按 128K
  // 算预算、真实只有 32K」导致护栏永不触发、模型 400 / 无回应。
  private maxAcceptedPrompt = 0;
  // 上一次发送前估算的 prompt token（用于溢出后把预算压到其 0.6 倍自救）。
  private lastSendEstimate = 0;
  // 上一次发送是否因上下文溢出失败，需在下一次发送前强制缩预算。
  private overflowShrink = false;
  // 上下文溢出自愈重试计数（整轮上限，防死循环）。
  private contextRetry = 0;

  constructor(opts: HarnessOptions) {
    this.opts = {
      maxSteps: 12,
      memory: new Memory(),
      systemPrompt: 'You are a helpful assistant with access to tools.',
      onEvent: () => {},
      maxToolResultChars: opts.maxToolResultChars,
      requireCompletion: opts.requireCompletion ?? false,
      verify: opts.verify,
      verifyMaxRetries: opts.verifyMaxRetries ?? 0,
      verifySelfCorrect:
        opts.verifySelfCorrect ?? (opts.verifyMaxRetries ?? 0) > 0,
      guardrailPolicy: opts.guardrailPolicy,
      ...opts,
      enableToolDedup: opts.enableToolDedup ?? false,
      maxToolCallsPerStep: opts.maxToolCallsPerStep ?? 0,
      planPropose: opts.planPropose ?? false,
      planTask: opts.planTask ?? false,
      // P2-1：护栏温和重试上限（每轮 run 重置），缺省 1 与历史行为一致。
      guardrailMaxRetries: opts.guardrailMaxRetries ?? 1
    };
    // 初始化指代消解追踪器（若开启）
    if (process.env.COREF_ENABLED === 'true') {
      this._corefTracker = new EntityTracker();
    }
  }

  /** 向长期记忆追加一条笔记（会随下次运行的系统提示词注入给模型）。 */
  remember(note: string): void {
    this.opts.memory.remember(note);
  }

  /** 读取当前长期记忆笔记列表。 */
  notes(): string[] {
    return this.opts.memory.notes();
  }

  /**
   * 运行入口：先把子系统旁路事件通道（run-events ALS）接到 onEvent，再进入主循环。
   * Jev 决策模型等在 run 链路内的直连调用（护栏门禁 / 上下文压缩 / 内置工具）经此汇入事件流，
   * 对外事件行为与既往完全一致（sink 仅新增事件，不改动既有事件序列）。
   *
   * P1 并发修复：同一实例此前无并发互斥——runInner 会重置实例级自适应预算字段、
   * load/save 同一 Memory 窗口（后 save 覆盖先 save）、递增共享的指代消解 turn 计数，
   * 并发 run 时互相覆盖产生状态错乱。现默认按到达顺序**串行排队**（同一会话的并发
   * 输入按序处理，语义最接近单会话现实）；server 接入层每 run 新建实例，不受影响。
   * HARNESS_CONCURRENT_RUN=fail 可改为 fail-fast（显式拒绝并发，返回明确错误）。
   */
  async run(
    userInput: string,
    imageAttachments?: Array<{ url: string; name: string; type: string }>
  ): Promise<string> {
    const failFast =
      (process.env.HARNESS_CONCURRENT_RUN ?? '').trim().toLowerCase() === 'fail';
    if (failFast && this.runPending > 0) {
      return Promise.reject(
        new Error('AgentHarness: 并发 run 被拒绝（HARNESS_CONCURRENT_RUN=fail；同一实例的上一次 run 尚未结束）')
      );
    }
    this.runPending++;
    const gate = this.runChain.then(() =>
      runWithEventSink(
        (e) => this.opts.onEvent?.(e as HarnessEvent),
        () => this.runInner(userInput, imageAttachments)
      )
    );
    // 链上吞错传播：某个 run 失败不得阻塞后续排队的 run（错误仍由 gate 返回给本次调用方）。
    this.runChain = gate.then(
      () => {
        this.runPending--;
      },
      () => {
        this.runPending--;
      }
    );
    return gate;
  }

  /** 串行化链：所有 run 按到达顺序在此排队（run() 内部维护）。 */
  private runChain: Promise<void> = Promise.resolve();
  /** 已接收（含排队中）尚未结束的 run 数，fail-fast 模式据此拒绝并发。 */
  private runPending = 0;

  private async runInner(
    userInput: string,
    imageAttachments?: Array<{ url: string; name: string; type: string }>
  ): Promise<string> {
    const runId = nextId('run');
    // 事件通道防御：调用方传入的 onEvent 抛错（如 SSE 写失败）不得影响主流程，
    // 也不得从 run:meta / run:end 等发射点把异常冒出 run()。对齐 run-events.ts
    // 旁路通道「观测异常不影响业务」的容错约定。
    const emit = (e: HarnessEvent) => {
      try {
        this.opts.onEvent?.(e);
      } catch {
        // 观测通道失败：吞掉，不影响 run 主流程
      }
    };

    // 组合「超时」与「外部取消」为单一信号：任一触发即中止本次运行。
    // H1：装配逻辑迁至 harness/run-phases/signal-setup.ts（逐字等价）。
    const { signal, cleanup } = setupRunSignal(this.opts.signal, this.opts.timeoutMs);

    // P0（插件事件归属）：沿本次 run 的异步链路绑定 runId（AsyncLocalStorage），
    // 插件工具执行期可用 getRunId() 精确归属当前 run（如按 run 归集对话），
    // 替代并发下会互相覆盖的进程级单例。
    bindRunId(runId);
    emit({ type: 'run:start', runId, input: userInput, agentId: this.opts.agentId });
    incCounterTenant('agent.run.start', this.opts.tenantId);

    // 重置自适应上下文预算状态（每轮运行独立，避免跨 run 串扰）。
    this.maxAcceptedPrompt = 0;
    this.lastSendEstimate = 0;
    this.overflowShrink = false;
    this.contextRetry = 0;

    // Hook: agent.pre_run — 可用于审计/日志/记录
    void hooks.execute('agent.pre_run', {
      runId,
      sessionKey: runId,
      tenantId: this.opts.tenantId,
      prompt: userInput,
    });

    // P0/P1：把本次 run 关联到「智能体 / 工作流 / 追踪 / 租户」维度，供 UI / OTel 跨 agent 关联。
    // 仅为旁路观测；任一字段缺失（默认）都不发，零租户/无工作流行为完全不变。
    if (
      this.opts.agentId ||
      this.opts.workflowId ||
      this.opts.traceId ||
      this.opts.tenantId ||
      this.opts.decidedBy
    ) {
      emit({
        type: 'run:meta',
        runId,
        agentId: this.opts.agentId,
        workflowId: this.opts.workflowId,
        traceId: this.opts.traceId,
        tenantId: this.opts.tenantId,
        decidedBy: this.opts.decidedBy
      });
    }

    // 可选指代消解：在输入进入护栏/记忆之前展开代词（COREF_ENABLED=true 时生效）
    let resolvedInput = userInput;
    if (process.env.COREF_ENABLED === 'true' && this._corefTracker) {
      const turn = this._corefTurn++;
      const { resolved } = resolveAndTrack(resolvedInput, this._corefTracker, turn);
      if (resolved !== resolvedInput) {
        emit({ type: 'warn', message: `[coref] expanded: ${userInput} → ${resolved}` });
      }
      resolvedInput = resolved;
    }

    const guard = await checkInputAsync(
      resolvedInput,
      this.opts.guardrailPolicy,
      // 计划任务派发：输入（任务标题/步骤/预期产出的拼接文本）与输出侧 checkTaskOutput
      // 对称地降级为强信号注入检测 —— 任务步骤合理提到「system prompt」等词不应拦截。
      this.opts.planTask === true,
      // 同时标记此为计划任务输入：放行 PLAN_MAX_INPUT_LENGTH 长度上限，
      // 避免长计划需求文档被通用 maxInputLength 长度闸拦死（Fix A）。
      this.opts.planTask === true
    );
    if (!guard.ok) {
      recordError('guardrail.input');
      structLog('warn', 'guardrail blocked', {
        phase: 'input',
        reason: guard.reason,
        runId
      });
      const blockedReason = guard.reason ?? 'unknown';
      emit({
        type: 'guardrail:blocked',
        phase: 'input',
        reason: blockedReason
      });
      // 注意：此早期返回发生在 verify 门禁之前，不进入 runLoop，故不计入 guardrailsBlocked
      // （verify 上下文只统计循环内发生的拦截；此处直接以 guardrail 消息结束本轮）。
      // 内部原因已通过上方 emit('guardrail:blocked') 记入调用链路 / 服务端日志；
      // 返回给用户的终态文案须中性、不泄露内部合规判定细节（如「知识库未收录」等）。
      // 长度超限与内容安全拦截语义不同：前者是工程限制、后者才是合规拦截，必须区分文案，
      // 避免用户把「输入过长」误读为「被内容安全策略拦截」且无任何产出。
      const isLengthLimit =
        typeof blockedReason === 'string' && blockedReason.startsWith('input too long');
      const msg = isLengthLimit
        ? `输入过长（${blockedReason}），本次未执行。请精简内容至长度上限以内后重试；计划类任务可联系管理员调高 plan 输入长度上限。`
        : '抱歉，您的输入触发了内容安全策略，本次未能发送。如有疑问，请通过官方正规渠道咨询。';
      cleanup();
      // Hook: agent.post_run — guardrail early return path
      void hooks.execute('agent.post_run', {
        runId,
        sessionKey: runId,
        tenantId: this.opts.tenantId,
        final: msg,
        steps: 0,
      });
      emit({ type: 'run:end', runId, final: msg, steps: 0, agentId: this.opts.agentId });
      return msg;
    }

    const memory = this.opts.memory;

    // 记忆装配（H1 后半：迁至 run-phases/memory-setup.ts，逐字等价）：
    // 持久化载入 → 长期记忆注入系统提示词 → 用户消息入窗（多模态 ContentBlock）。
    await setupRunMemory({
      memory,
      systemPrompt: this.opts.systemPrompt,
      userInput,
      resolvedInput,
      imageAttachments
    });

    let final = MAX_STEPS_NOTICE;
    let steps = 0;
    // 输出护栏「合规内容类」拦截后，允许温和重试的次数（密钥/注入类不重试，直接兜底）。
    // P2-1：改为可配置（opts.guardrailMaxRetries，缺省 1 保持历史行为），每轮 run 重置，
    // 避免跨轮累积；重试会注入纠正提示让模型重新生成合规内容。
    let guardrailRetriesLeft = Math.max(0, Math.floor(this.opts.guardrailMaxRetries));
    // 本次 run 累计的 token 用量与成本（用于预算熔断与 run:cost 事件）。
    let runTokens = 0;
    let runCost = 0;
    let budgetExceededFlag = false;
    // 动态工具选择：记录本 run 已实际调用过的工具名，后续步骤将其并入硬允许集，
    // 保证多步任务后续步骤仍可复用已用工具，避免「选错漏发」导致质量退化。
    const usedTools = new Set<string>();
    // 加固：工具调用去重缓存与单 step 预算。仅当 opts 显式开启时生效，默认完全不介入。
    const toolDedupOn = !!this.opts.enableToolDedup;
    const toolDedupCache = new Map<
      string,
      { result: string; errored: boolean }
    >();
    const maxCallsPerStep =
      this.opts.maxToolCallsPerStep && this.opts.maxToolCallsPerStep > 0
        ? this.opts.maxToolCallsPerStep
        : 0;
    const makeDedupKey = (call: ToolCall): string =>
      this.opts.toolDedupKey
        ? this.opts.toolDedupKey(call)
        : stableToolKey(call);
    const tokenBudget = this.opts.tokenBudget;
    const costBudget = this.opts.costBudget;
    const budgetExceeded = (kind: 'tokens' | 'cost'): string => {
      budgetExceededFlag = true;
      const limit = kind === 'tokens' ? tokenBudget! : costBudget!;
      const used = kind === 'tokens' ? runTokens : runCost;
      incCounter('budget.exceeded');
      structLog('warn', 'budget exceeded, aborting run', {
        kind,
        limit,
        used,
        runId
      });
      emit({ type: 'budget:exceeded', kind, limit, used });
      return `[budget] ${kind} exceeded: used ${used} / limit ${limit}`;
    };

    // 工具轮跨迭代保留状态（P1#21 拆分：随 executeToolRound 逐轮传入/写回，
    // 替代原 runLoop 闭包局部变量——lastToolResult / stepToolCalls / wrapUpRequested /
    // wrapUpRounds / guardrailsBlocked，见 harness/run-phases/tool-round.ts）。
    const toolRoundState: ToolRoundState = {
      lastToolResult: null,
      stepToolCalls: 0,
      wrapUpRequested: false,
      wrapUpRounds: 0,
      guardrailsBlocked: 0
    };

    // ── P4.8 时间预算治理：治「等很久 → 硬超时 → 无产出」三处结构性缺陷 ──────────
    // 症状：计划模式单步执行等待极长，随后 step 超时中止且没有任何产出。
    // 三个独立成因（均已复现）：
    //  (a) 工具执行是裸 await —— 工具挂死时看门狗 abort 无法生效，循环卡在 await 上，
    //      时间远超 step 预算后才返回（见下方工具调用竞速 + 单次工具超时）；
    //  (b) 到点后只返回固定提示文案 —— 已生成（甚至已流式产出）的内容被整体丢弃，
    //      且发生在验证重试期间时会把第一轮产出覆盖成超时提示（见 abortedResult）；
    //  (c) 验证重试不检查剩余预算 —— 第一轮用掉大半预算后仍启动完整第二轮，
    //      必然撞超时并销毁第一轮产出（见下方重试预算守卫）。
    // H1：计算部分迁至 harness/run-phases/time-budget.ts（数值与语义逐字等价）。
    const { runTimeoutMs, deadlineAt, softDeadlineMs, isPastSoftDeadline, toolCallTimeoutMs } =
      computeTimeBudget(this.opts.timeoutMs);
    // 收尾提示是否已注入记忆（注入点固定在 LLM 调用前，与「跳过工具」判定解耦）。
    let wrapUpPromptPushed = false;
    // 中止竞速用的一次性 promise（run 级共用，避免每步新增监听器）。
    const abortPromise = new Promise<'__aborted__'>((resolve) => {
      if (signal.aborted) return resolve('__aborted__');
      signal.addEventListener('abort', () => resolve('__aborted__'), {
        once: true
      });
    });
    // 本次 run 已流式产出的内容（每次 LLM 调用前重置）；硬中止时据此抢救部分产出。
    let streamBuffer = '';
    /** 抢救「已生成但未成为最终答案」的内容：优先流式缓冲，其次记忆里最后一条 assistant。 */
    const salvagePartial = (): string => {
      if (streamBuffer.trim()) return streamBuffer.trim();
      const hist = memory.history();
      for (let i = hist.length - 1; i >= 0; i--) {
        const m = hist[i];
        if (!m) continue;
        if (
          m.role === 'assistant' &&
          typeof m.content === 'string' &&
          m.content.trim()
        ) {
          return m.content.trim();
        }
      }
      return '';
    };
    /** 硬中止（超时 / 取消）时的返回值：有实质产出则连内容一起返回，不再只回固定提示。 */
    const abortedResult = (): string => {
      const notice = abortedMessage(signal);
      const salvaged = salvagePartial();
      // 过短的内容（模型刚开口就被砍）不值得冒充「部分产出」，仍回提示文案。
      if (salvaged.length < 40) return notice;
      const reason =
        (signal as { reason?: unknown }).reason === 'timeout'
          ? `本次运行超出时间预算（${Math.round(runTimeoutMs / 1000)}s）被中止`
          : '本次运行被取消';
      return (
        `${salvaged}\n\n${PARTIAL_NOTICE}：${reason}。` +
        '以上为已生成的部分结果（内容已保留，可据此继续或仅重跑剩余部分）。'
      );
    };
    // 把主循环抽成函数，便于「验证失败后自动重试」复用同一 maxSteps 预算重跑。
    const runLoop = (): Promise<string> =>
      withSpan('agent.run', async () => {
        for (let step = 0; step < this.opts.maxSteps; step++) {
          // 进入下一步前先检查取消信号，避免对已中止的运行继续消耗工具/LLM。
          if (signal.aborted) {
            return abortedResult();
          }
          // 软截止收尾（P4.8）：剩余预算不足时注入收尾指令，让模型基于已有信息直接给
          // 最终结果 —— 把「硬超时砍掉产出」变成「主动收尾交付」，这是「等很久之后
          // 什么都没有」的主要治本手段。
          // 注入点固定在「LLM 调用之前」：保证 assistant(tool_calls)→tool 的配对不被
          // 中间插入的 user 消息打断（否则部分 provider 直接 400）。
          if (!wrapUpPromptPushed && isPastSoftDeadline()) {
            toolRoundState.wrapUpRequested = true;
            wrapUpPromptPushed = true;
            memory.add({ role: 'user', content: WRAP_UP_PROMPT });
            emit({
              type: 'warn',
              message: `时间预算剩余不足 ${Math.round(
                softDeadlineMs / 1000
              )}s：已要求模型立即收尾输出最终结果（避免硬超时丢弃已产出内容）`
            });
          }
          // 若上一步溢出触发了异步（LLM）摘要，先落地摘要节点，保证本轮喂给模型的
          // 历史已包含压缩结果（同步摘要器此步为 no-op，无额外开销）。
          await memory.flushSummary();
          // 预算熔断：token / cost 任一超限即中止（在发起下一次 LLM 调用前）。
          if (tokenBudget && runTokens > tokenBudget)
            return budgetExceeded('tokens');
          if (costBudget && runCost > costBudget) return budgetExceeded('cost');
          steps = step + 1;
          // 加固：每 step 重置工具调用计数（配合 maxToolCallsPerStep 预算截断）。
          toolRoundState.stepToolCalls = 0;
          emit({
            type: 'step:start',
            step: steps,
            maxSteps: this.opts.maxSteps
          });

          // 主动上下文压缩（主流做法：发送前按真实 payload 估算封顶，而非被动等
          // 调用失败再补救）。免费模型真实窗口常远小于回退值 128K，故同时用「已成功
          // 接收的最大 prompt × 安全系数」做自适应硬上限，避免 100% 卡死无回应。
          const cw =
            this.opts.contextWindow && this.opts.contextWindow > 0
              ? this.opts.contextWindow
              : contextWindowFor(this.opts.model);
          const proactiveBudget = Math.floor(cw * 0.8 * 0.85); // 目标占用≈窗口的 68%
          const adaptiveCap =
            this.overflowShrink && this.maxAcceptedPrompt > 0
              ? Math.floor(this.maxAcceptedPrompt * 0.7)
              : Infinity;
          const budgetCap = Math.min(proactiveBudget, adaptiveCap);
          // 上下文压缩：默认走确定性预算剪枝（fitToBudget）；开启 JEV_CONTEXT_COMPRESS 时，
          // 在预算剪枝之「后」用 Jev 重要性打分优先淘汰低分消息（旧逻辑为兜底，Jev 缺配/出错回落）。
          // 压缩方案2（Token 成本优化）：发送前先折叠陈旧工具结果——不等预算击穿、
          // 每步主动执行，把「N 组之前」的超长 tool 结果压为首尾摘要，与预算剪枝互补。
          const folded = memory.foldStaleToolResults();
          const useJevCompress =
            (process.env.JEV_CONTEXT_COMPRESS || 'off').toLowerCase() === 'on';
          const compressed = useJevCompress
            ? await memory.compressByImportance(budgetCap)
            : memory.fitToBudget(budgetCap);
          if (compressed || folded) {
            structLog('info', 'proactive context compression applied before LLM send', {
              budgetCap,
              jev: useJevCompress,
              folded,
              runId
            });
          }
          let messages = sanitizeToolPairing(memory.history());
          // 动态工具选择（默认开启，DYNAMIC_TOOLS=false 关闭）：按当前用户输入的相关性
          // 从全量工具中选出子集，降低简单输入（如问候）首呼时全量工具 schema 的固定开销。
          // 执行仍走全量注册表（this.opts.tools.call），仅「发送给 LLM 的 schema」做裁剪。
          // H1：选择逻辑迁至 harness/run-phases/dynamic-tools.ts（逐字等价）。
          const allSchemas = this.opts.tools.schemas();
          // stepTools 为 let：模型「点名未知工具」时兜底分支会扩展到全量 schema 重试一次（见下方）。
          const selection = selectStepTools({
            allSchemas,
            messages,
            usedTools,
            allowTools: this.opts.allowTools
          });
          let stepTools = selection.tools;
          const dynamicOn = selection.dynamicOn;
          // Hook: agent.pre_llm — observe messages before LLM call
          void hooks.execute('agent.pre_llm', {
            runId,
            sessionKey: runId,
            tenantId: this.opts.tenantId,
            messages,
          });
          emit({
            type: 'llm:call',
            step: steps,
            messageCount: messages.length,
            toolCount: stepTools.length
          });

          // 单步 LLM 调用 + 溢出自愈 + 智能兜底（H3：迁至 run-phases/loop-llm.ts，
          // 逐字等价）。abort 竞速 / 未知工具扩展 / 溢出收窄的循环控制以状态对象表达；
          // 实例字段（overflowShrink / maxAcceptedPrompt）经返回值写回。
          // 中止路径：先写回 streamBuffer（抢救文案依赖它），再 return abortedResult()。
          // P4.8：本步流式产出缓冲（硬中止时抢救用）——每次 LLM 调用前重置。
          streamBuffer = '';
          const llmState = await callLlmWithSelfHeal({
            llm: this.opts.llm,
            circuitBreaker: this.opts.circuitBreaker,
            streamTokens: this.opts.streamTokens,
            messages,
            stepTools,
            allSchemas,
            dynamicOn,
            signal,
            abortPromise,
            memory,
            overflowShrink: this.overflowShrink,
            maxAcceptedPrompt: this.maxAcceptedPrompt,
            steps,
            runId,
            emit,
            abortedResult
          });
          messages = llmState.messages;
          stepTools = llmState.stepTools;
          const streamedTokens = llmState.streamedTokens;
          streamBuffer = llmState.streamBuffer;
          this.overflowShrink = llmState.overflowShrink;
          this.maxAcceptedPrompt = llmState.maxAcceptedPrompt;
          if (llmState.aborted) return abortedResult();
          const resp = llmState.resp;
          if (!resp) {
            // P2-1：走到这里 = 重试循环耗尽或适配器返回空响应 —— 这是「模型调用失败」，
            // 不是「运行被取消」。旧实现一律 abortedResult() 把失败伪装成取消，
            // 调用方/用户看到的文案与真实原因不符。仅当确实收到中止信号才走取消语义；
            // 其余按失败抛出（外层既有 catch 落 failed + 事件，语义与模型抛错一致）。
            if (signal.aborted) return abortedResult();
            throw new Error(`llm returned no response after retries (step=${steps})`);
          }

          // 用量记账与事件发射（拆分至 harness/usage-accounting.ts，语句顺序逐字保留）：
          // 记录自适应预算上限、token/成本记账、无单价诊断、占比拆解，
          // 以及 run:cost / llm:usage / run:token-cache 三类旁路事件。
          // 三个累加量经返回值写回（原为闭包局部变量与实例字段）。
          const accounted = accountAndEmitUsage({
            resp,
            messages,
            stepTools,
            steps,
            runTokens,
            runCost,
            maxAcceptedPrompt: this.maxAcceptedPrompt,
            memory,
            emit,
            tenantId: this.opts.tenantId,
            contextWindow: this.opts.contextWindow,
            model: this.opts.model,
            runId
          });
          runTokens = accounted.runTokens;
          runCost = accounted.runCost;
          this.maxAcceptedPrompt = accounted.maxAcceptedPrompt;
          // 累加后立即检查预算：超限则中止，不再进入工具执行 / 下一轮。
          if (tokenBudget && runTokens > tokenBudget)
            return budgetExceeded('tokens');
          if (costBudget && runCost > costBudget) return budgetExceeded('cost');

          // 输出护栏门禁（H2：迁至 run-phases/output-gate.ts，语义逐字等价）。
          // 三种口径（计划 propose 结构化扫描 / 计划任务 checkTaskOutput / 普通
          // checkOutputAsync）与三档优雅兜底（safeReply / 温和重试 / 中性兜底）在
          // 模块内实现；continue/return 以动作枚举表达，调用方按 kind 分派。
          const gate = await runOutputGate({
            content: resp.content,
            planPropose: this.opts.planPropose,
            planTask: this.opts.planTask,
            guardrailPolicy: this.opts.guardrailPolicy,
            recentTool: toolRoundState.lastToolResult,
            guardrailRetriesLeft,
            memory,
            emit,
            runId
          });
          guardrailRetriesLeft = gate.guardrailRetriesLeft;
          toolRoundState.guardrailsBlocked += gate.guardrailsBlocked;
          if (gate.action.kind === 'final') return gate.action.text;
          if (gate.action.kind === 'continue') continue;

          // 助手回合事件链 + 终态判定（H2 第二批：迁至 run-phases/assistant-turn.ts
          // 与 final-output.ts，逐字等价；continue/final 以动作枚举分派，
          // 'tools' 穿透到下方工具编排——与拆分前「if 块全 return、顺序落到编排」一致）。
          emitAssistantTurn({
            resp,
            streamedTokens,
            streamTokensEnabled: this.opts.streamTokens,
            steps,
            runId,
            tenantId: this.opts.tenantId,
            messages,
            memory,
            emit
          });
          const fin = resolveFinalOutput({
            content: resp.content,
            toolCalls: resp.tool_calls,
            partial: resp.partial,
            requireCompletion: this.opts.requireCompletion,
            steps,
            maxSteps: this.opts.maxSteps,
            memory
          });
          if (fin.kind === 'continue') continue;
          if (fin.kind === 'final') return fin.text;

          // 执行每个请求的工具调用，并将结果以 tool 消息形式回传给 LLM。
          //
          // 【P1#21 拆分】三阶段并发编排（准备→有界并发→原序回填）迁至
          // harness/run-phases/tool-round.ts：跨 runLoop 迭代保留的游标/计数
          // （lastToolResult / stepToolCalls / wrapUpRequested / wrapUpRounds /
          // guardrailsBlocked）经 toolRoundState 对象读写，轮内并发池状态
          // （planned/done/answeredIds/cursor）留在模块局部，行为与拆分前逐字等价。
          // abort/护栏拦截/去重/截断语义由既有专项测试覆盖（harness*.test.cjs 的
          // 工具循环 + 并发 + 去重 + 中止用例）。
          const round = await executeToolRound({
            resp,
            memory,
            emit,
            signal,
            abortPromise,
            toolCallTimeoutMs,
            tools: this.opts.tools,
            guardrailPolicy: this.opts.guardrailPolicy,
            tenantId: this.opts.tenantId,
            sessionId: this.opts.sessionId,
            traceId: this.opts.traceId,
            runId,
            steps,
            maxCallsPerStep,
            toolDedupOn,
            toolDedupCache,
            makeDedupKey,
            usedTools,
            maxToolResultChars: this.opts.maxToolResultChars,
            isPastSoftDeadline,
            salvagePartial,
            state: toolRoundState
          });
          if (round.kind === 'aborted') return abortedResult();
          if (round.kind === 'final') return round.text;


        }
        // 计划 propose 收尾（P5 优化）：预算耗尽时补一次「无工具」强制收尾调用。
        // H1 后半：迁至 run-phases/plan-finish.ts（逐字等价；失败/无内容回退默认提示）。
        if (this.opts.planPropose && !signal.aborted) {
          const finalized = await planProposeFinalize({
            memory,
            llm: this.opts.llm,
            circuitBreaker: this.opts.circuitBreaker,
            signal,
            abortPromise,
            runId
          });
          if (finalized !== null) return finalized;
        }
        return MAX_STEPS_NOTICE;
      });

    try {
      final = await runLoop();
    } catch (e) {
      // P1-10: 熔断打开时直接返回错误，不触发通用告警（避免告警风暴）
      const breakerName = (e as { name?: string } | null)?.name;
      if (breakerName === 'CircuitBreakerOpen') {
        const msg = e instanceof Error ? e.message : 'circuit breaker open';
        emit({ type: 'error', message: msg });
        final = `${CIRCUIT_BREAKER_PREFIX} ${msg}`;
      } else {
        logError('agent.run', e, { runId });
        const errMsg = e instanceof Error ? e.message : String(e);
        emitAlert('error', 'agent.run', errMsg, { runId });
        emit({ type: 'error', message: errMsg });
        final = `${ERROR_PREFIX} ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    // 运行期自动验证门禁（P0-2）：产出后自动校验；未通过可重试（self-correction）或标记。
    //
    // P4.8：**被中止的运行不再跑校验**。原因：中止意味着产出已知不完整（超时/取消），
    // 对它做「完整性断言」既无意义、又产生两个副作用 —— ① 白等一轮校验；② 计划默认
    // 门禁的 notContains(PARTIAL_NOTICE) 会给已抢救回来的部分产出再加上 [verify:failed]
    // 前缀，把「超时中断」误标成「验证失败」，掩盖真实的失败原因与已保留的内容。
    // 中止路径的语义由产出有效性闸门（inspectStepOutput → partial）如实承担。
    //
    // 门禁主体拆分至 harness/verify-gate.ts。final 同步约定：buildCtx 闭包读取本作用域
    // 的 final；门禁内每次更新 final 都经 onFinalUpdate 写回本作用域，保证后续
    // verify(buildCtx()) 读到最新产出（与拆分前单变量闭包语义一致）。
    if (this.opts.verify && !signal.aborted) {
      final = await runVerifyGate({
        verify: this.opts.verify,
        verifyMaxRetries: this.opts.verifyMaxRetries,
        verifySelfCorrect: this.opts.verifySelfCorrect,
        buildCtx: (): VerifyContext => ({
          input: userInput,
          final,
          steps,
          toolCalls: collectToolCalls(memory.history()),
          guardrailsBlocked: toolRoundState.guardrailsBlocked,
          budgetExceeded: budgetExceededFlag
        }),
        runLoop,
        deadlineAt,
        runTimeoutMs,
        emit,
        memory,
        runId,
        initialFinal: final,
        onFinalUpdate: (nextFinal) => {
          final = nextFinal;
        }
      });
    }

    // 运行收尾（H1 后半：迁至 run-phases/finalize.ts，逐字等价）：
    // 持久化落盘 → 输出侧 PII 脱敏 → 计数/hook/run:end → 返回脱敏后的最终文本。
    return await finalizeRun({
      memory,
      runId,
      tenantId: this.opts.tenantId,
      agentId: this.opts.agentId,
      guardrailPolicy: this.opts.guardrailPolicy,
      final,
      steps,
      cleanup,
      emit
    });
  }
}
