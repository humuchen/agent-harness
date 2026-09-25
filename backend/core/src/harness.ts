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
 */
import type { ToolCall, LLMResponse } from './types';
import type { VerifyContext } from './verify';
import { selectToolsForInput } from './tools';
import { Memory } from './memory';
import { resolveAndTrack, EntityTracker } from './coreference';
import {
  checkStructuredOutput,
  checkTaskOutput,
  checkInputAsync,
  checkOutputAsync,
  checkToolArgsAsync,
  redactOutput
} from './guardrails';
import { parsePlanOutput } from './plan';
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
import {
  GUARDRAIL_FALLBACK_PREFIX,
  PARTIAL_NOTICE,
  ERROR_PREFIX,
  CIRCUIT_BREAKER_PREFIX,
  MAX_STEPS_NOTICE
} from './workflow/step-output';

// ── 拆分子模块 ──────────────────────────────────────────────────────────
import type { HarnessEvent, HarnessOptions, ResolvedHarnessOptions } from './harness/types';
import { contextWindowFor, isContextOverflowError } from './harness/context-window';
import { stableToolKey } from './harness/tool-dedup';
import { nextId } from './harness/id';
import { sanitizeToolPairing, collectToolCalls } from './harness/message-sanitizer';
import { WRAP_UP_PROMPT, abortedMessage } from './harness/run-prompts';
import { buildUserContent } from './harness/content-blocks';
import { accountAndEmitUsage } from './harness/usage-accounting';
import { executeToolWithRace } from './harness/tool-executor';
import { runVerifyGate } from './harness/verify-gate';

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
      planTask: opts.planTask ?? false
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
   */
  async run(
    userInput: string,
    imageAttachments?: Array<{ url: string; name: string; type: string }>
  ): Promise<string> {
    return runWithEventSink(
      (e) => this.opts.onEvent?.(e as HarnessEvent),
      () => this.runInner(userInput, imageAttachments)
    );
  }

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
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort('external');
    if (this.opts.signal) {
      if (this.opts.signal.aborted) controller.abort('external');
      else
        this.opts.signal.addEventListener('abort', onExternalAbort, {
          once: true
        });
    }
    const timeout =
      this.opts.timeoutMs && this.opts.timeoutMs > 0
        ? setTimeout(() => controller.abort('timeout'), this.opts.timeoutMs)
        : null;
    const signal = controller.signal;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (this.opts.signal)
        this.opts.signal.removeEventListener('abort', onExternalAbort);
    };

    emit({ type: 'run:start', runId, input: userInput });
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
      emit({ type: 'run:end', runId, final: msg, steps: 0 });
      return msg;
    }

    const memory = this.opts.memory;

    // 若配置了持久化路径，先载入历史记忆（窗口 + 长期笔记）。
    if (memory.hasPersistence) {
      try {
        await memory.load();
      } catch {
        /* 首次运行无存档，忽略 */
      }
    }

    // 将长期记忆注入系统提示词，使模型能看到跨运行的上下文。
    const ctx = memory.systemContext();
    const sysContent =
      ctx && this.opts.systemPrompt
        ? `${this.opts.systemPrompt}\n\n${ctx}`
        : this.opts.systemPrompt;
    if (sysContent && !memory.history().some((m) => m.role === 'system')) {
      memory.add({ role: 'system', content: sysContent });
    }
    // 图片附件：转为 ContentBlock[] 传给 LLM；无图片时退化为纯文本。
    // （构造逻辑拆分至 harness/content-blocks.ts，行为契约见该模块注释：
    //  多模态路径 text 块取 userInput、纯文本路径取 resolvedInput，与拆分前一致。）
    memory.add({
      role: 'user',
      content: buildUserContent(userInput, resolvedInput, imageAttachments)
    });

    let final = MAX_STEPS_NOTICE;
    let steps = 0;
    // 自验证计数：本轮被护栏拦截次数（供 VerifyContext 使用）。
    let guardrailsBlocked = 0;
    // 输出护栏「合规内容类」拦截后，允许温和重试的次数（密钥/注入类不重试，直接兜底）。
    // 每轮 run 重置，避免跨轮累积；重试会注入纠正提示让模型重新生成合规内容。
    let guardrailRetriesLeft = 1;
    // 最近一次执行的工具调用结果（跨 runLoop 迭代保留），用于向输出护栏注入上下文，
    // 使规则能感知「上一步工具（如 project_kb_search）是否返回 found:false」等业务信号。
    let lastToolResult: { name: string; result: string } | null = null;
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

    // ── P4.8 时间预算治理：治「等很久 → 硬超时 → 无产出」三处结构性缺陷 ──────────
    // 症状：计划模式单步执行等待极长，随后 step 超时中止且没有任何产出。
    // 三个独立成因（均已复现）：
    //  (a) 工具执行是裸 await —— 工具挂死时看门狗 abort 无法生效，循环卡在 await 上，
    //      时间远超 step 预算后才返回（见下方工具调用竞速 + 单次工具超时）；
    //  (b) 到点后只返回固定提示文案 —— 已生成（甚至已流式产出）的内容被整体丢弃，
    //      且发生在验证重试期间时会把第一轮产出覆盖成超时提示（见 abortedResult）；
    //  (c) 验证重试不检查剩余预算 —— 第一轮用掉大半预算后仍启动完整第二轮，
    //      必然撞超时并销毁第一轮产出（见下方重试预算守卫）。
    const startedAt = Date.now();
    const runTimeoutMs =
      this.opts.timeoutMs && this.opts.timeoutMs > 0 ? this.opts.timeoutMs : 0;
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
    let wrapUpRequested = false;
    // 收尾提示是否已注入记忆（注入点固定在 LLM 调用前，与「跳过工具」判定解耦）。
    let wrapUpPromptPushed = false;
    let wrapUpRounds = 0;
    /** 是否已进入软截止窗口（剩余预算不足以再跑完一轮工具 + LLM）。 */
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
            wrapUpRequested = true;
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
          let stepToolCalls = 0;
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
          const useJevCompress =
            (process.env.JEV_CONTEXT_COMPRESS || 'off').toLowerCase() === 'on';
          const compressed = useJevCompress
            ? await memory.compressByImportance(budgetCap)
            : memory.fitToBudget(budgetCap);
          if (compressed) {
            structLog('info', 'proactive context compression applied before LLM send', {
              budgetCap,
              jev: useJevCompress,
              runId
            });
          }
          let messages = sanitizeToolPairing(memory.history());
          // 动态工具选择（默认开启，DYNAMIC_TOOLS=false 关闭）：按当前用户输入的相关性
          // 从全量工具中选出子集，降低简单输入（如问候）首呼时全量工具 schema 的固定开销。
          // 执行仍走全量注册表（this.opts.tools.call），仅「发送给 LLM 的 schema」做裁剪。
          const allSchemas = this.opts.tools.schemas();
          let stepTools = allSchemas;
          const dynamicOn = process.env.DYNAMIC_TOOLS !== 'false';
          if (dynamicOn && allSchemas.length > 0) {
            const latestUser = [...messages]
              .reverse()
              .find((m) => m.role === 'user');
            const input =
              typeof latestUser?.content === 'string' ? latestUser.content : '';
            const topK = Number(process.env.DYNAMIC_TOOL_TOPK ?? 8) || 8;
            // 把本 run 已用过的工具并入硬允许，保证多步任务后续步骤仍可调用。
            const allow = new Set(this.opts.allowTools ?? []);
            for (const t of usedTools) allow.add(t);
            const subset = selectToolsForInput(allSchemas, input, {
              allowTools: [...allow],
              topK
            });
            // 首轮发「相关性子集」而非全量：动态工具选择的核心收益。
            // 此前用 looksLikeTask（正则含几乎所有中文疑问词）判断回退全量，导致任何真实
            // 问答都发全量 schema，问候/寒暄之外的优化形同虚设——用户实测简单问答「工具」
            // 项高达 ~12968 tok，其中 ~92% 来自 MCP 工具的大 schema（内置工具仅 ~1151 tok）。
            // 安全网：若子集为空（输入与任何工具描述零关键词重叠），且输入不像问候/空，
            // 则回退全量——避免「模型看不到任何工具」导致真实任务彻底丧失工具能力；
            // 纯问候/空输入保持空子集（本就不需要工具）。已用过的工具（usedTools）恒在
            // allow 中，故子集不会为空，不会触发此回退。
            let chosen = subset;
            if (subset.length === 0) {
              const isGreeting =
                /^你好|^hello|^hi|^嗨|good.?morning|good.?afternoon|good.?evening|^\s*$/i.test(
                  input
                );
              if (!isGreeting) chosen = allSchemas;
            }
            stepTools = chosen;
          }
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

          // 用 Promise.race 让「中止」能打断一个永不 settles 的 LLM 调用，
          // 即使底层适配器未尊重 signal 也能及时退出。
          // token 级流式：开启 streamTokens 时透传 onToken/onReasoning 回调，
          // 适配器（支持 stream）会逐 delta 回调；同时记录是否真的收到了增量，
          // 以便在不支持流式的适配器（含 mock）下回退为「整段作为单 token」发出，
          // 保证聊天 UI 始终能拿到可渲染的增量事件。
          let streamedTokens = false;
          // P4.8：本步流式产出缓冲（硬中止时抢救用）——每次 LLM 调用前重置。
          streamBuffer = '';
          // 上下文溢出自愈：LLM 返回「超出上下文窗口」类错误（免费模型真实窗口常远小于
          // 配置/回退值 128K）时，逐步压缩历史后重试，而非让整轮运行失败、卡死无回应。
          const OVERFLOW_MAX_RETRIES = 4;
          let resp: LLMResponse | null = null;
          for (let llmAttempt = 0; llmAttempt <= OVERFLOW_MAX_RETRIES; llmAttempt++) {
            if (signal.aborted) return abortedResult();
            try {
              const llmCall = this.opts.llm(messages, stepTools, {
                signal,
                circuitBreaker: this.opts.circuitBreaker,
                ...(this.opts.streamTokens
                  ? {
                      onToken: (delta: string) => {
                        streamedTokens = true;
                        streamBuffer += delta; // P4.8：留存增量，供硬中止抢救
                        emit({ type: 'llm:token', step: steps, delta });
                      },
                      onReasoning: (delta: string) => {
                        emit({ type: 'llm:reasoning', step: steps, delta });
                      }
                    }
                  : {})
              });
              // 防御：abort/超时竞速获胜后，底层调用 rejection 无人接住会触发
              // unhandledRejection（Node ≥15 默认 crash）。挂一条兜底 catch，
              // 不影响竞速正常路径的异常传播（race 仍会收到原始 rejection）。
              void llmCall.catch(() => {});
              const raceResult = await withSpan('llm.call', () =>
                Promise.race([llmCall, abortPromise])
              );
              if (raceResult === '__aborted__') return abortedResult();
              resp = raceResult as LLMResponse;
              // 智能兜底：动态选择只发了子集时，模型可能「点名」一个未发出的工具。
              //  - 该工具在全量注册表 this.opts.tools 中存在（执行注册表始终全量）：直接交给
              //    下方执行分支即可，绝不可重发 schema 重试——否则会丢弃模型已给出的有效
              //    tool_call（曾经的实现因此让 builtin__jev_decide 等核心工具「点了名却没执行」）。
              //  - 该工具全量注册表中也不存在（模型幻觉的未知工具名）：扩展到全量 schema
              //    重试一次，让模型改选真实工具。至多扩展一次（扩展后 stepTools === allSchemas
              //    条件不再成立），不会死循环。
              const requestedOutside = (resp.tool_calls ?? []).filter(
                (tc) => !stepTools.find((s) => s.name === tc.name)
              );
              if (requestedOutside.length > 0 && dynamicOn && stepTools !== allSchemas) {
                const unknown = requestedOutside.filter(
                  (tc) => !allSchemas.find((s) => s.name === tc.name)
                );
                if (unknown.length > 0) {
                  stepTools = allSchemas;
                  structLog('info', 'model requested unknown tool(s); expanding to full schema and retrying', {
                    unknown: unknown.map((t) => t.name),
                    runId
                  });
                  continue;
                }
                // 否则：工具已注册但不在子集——不重发，直接执行（见上方说明）。
              }
              break;
            } catch (llmErr) {
              if (isContextOverflowError(llmErr) && llmAttempt < OVERFLOW_MAX_RETRIES) {
                this.overflowShrink = true;
                // 自适应收窄：有成功样本用「样本 × 0.6」，否则用当前历史估算的一半，逐次收敛。
                const basis =
                  this.maxAcceptedPrompt > 0 ? this.maxAcceptedPrompt : memory.historyTokens();
                const newBudget = Math.max(256, Math.floor(basis * 0.6));
                const shrank = memory.fitToBudget(newBudget);
                structLog('warn', 'context overflow, shrinking history and retrying LLM call', {
                  attempt: llmAttempt,
                  newBudget,
                  shrank,
                  runId
                });
                messages = sanitizeToolPairing(memory.history());
                continue;
              }
              throw llmErr;
            }
          }
          if (!resp) return abortedResult();

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

          // 计划模式 propose（P0）：输出能解析为合法计划 JSON 时，仅做密钥/注入扫描
          // （checkStructuredOutput），跳过业务自定义规则与上下文规则——结构化任务描述
          // 极易被领域合规正则（如医疗广告法关键词）误伤，导致计划永远生成失败。
          // 解析不出计划的输出（含中间工具调用轮次）仍走完整 checkOutput，行为不变。
          // 计划任务执行（planTask）：输出为面向用户的教学/执行内容，走 checkTaskOutput
          // ——「system prompt」等弱信号短语与宽松的密钥赋值样例正则会把架构讲解
          // 误拦成兜底话术（实测 stealth/ox-alpha 概念综述即被拦）；安全底线
          // （真实密钥格式 + 强信号注入短语）不放松。普通问答仍走完整 checkOutput。
          const structuredPlan = this.opts.planPropose
            ? parsePlanOutput(resp.content)
            : null;
          const outGuard = structuredPlan
            ? checkStructuredOutput(resp.content, this.opts.guardrailPolicy)
            : this.opts.planTask
            ? checkTaskOutput(resp.content, this.opts.guardrailPolicy)
            : await checkOutputAsync(
                resp.content,
                this.opts.guardrailPolicy,
                lastToolResult ? { recentTool: lastToolResult } : undefined
              );
          if (!outGuard.ok) {
            recordError('guardrail.output');
            structLog('warn', 'guardrail blocked', {
              phase: 'output',
              reason: outGuard.reason,
              runId
            });
            emit({
              type: 'guardrail:blocked',
              phase: 'output',
              reason: outGuard.reason ?? 'unknown'
            });
            guardrailsBlocked += 1;

            // 优雅兜底（三档，避免向用户暴露 [guardrail] blocked 方括号文本）：
            // 1) 拦截规则自带合规安全回复（如知识库查空的标准「建议预约面诊」话术）→ 直接采用，
            //    零额外 LLM 成本、零幻觉风险，体验最佳。
            if (outGuard.safeReply) return outGuard.safeReply;

            // 密钥 / 注入类拦截：重试无意义且可能再次泄露，直接走中性兜底。
            const isSecretOrInjection =
              !!outGuard.reason &&
              (outGuard.reason.includes('secret') ||
                outGuard.reason.includes('injection'));

            // 2) 合规内容类拦截（非密钥/注入）→ 温和重试一次：注入纠正提示让模型重新生成。
            //    计划模式 propose 下，纠正提示必须保持「只输出计划 JSON」的格式约束，
            //    否则模型会被带偏成合规话术，计划解析必然失败。
            if (!isSecretOrInjection && guardrailRetriesLeft > 0) {
              guardrailRetriesLeft -= 1;
              memory.add({
                role: 'user',
                content: this.opts.planPropose
                  ? '（系统提示）你上一条回复触发了内容安全护栏（原因：' +
                    (outGuard.reason ?? '合规校验未通过') +
                    '）。请重新生成：仍然只输出一个符合格式要求的 JSON 对象——' +
                    '需求清晰时输出计划 {"goal": string, "tasks": [{"id","title","steps","dependsOn","expectedOutput"}]}，' +
                    '需求不清时输出澄清 {"clarify": true, "goalDraft": string, "questions": string[]}。' +
                    '不要输出解释文字或 markdown 围栏；任务描述仅陈述有事实依据的内容，' +
                    '不要包含绝对化功效承诺、固定价格承诺或任何未经确认的信息。'
                  : '（系统提示）你上一条回复触发了内容安全护栏（原因：' +
                    (outGuard.reason ?? '合规校验未通过') +
                    '）。请重新组织回复：仅陈述有事实依据、经工具/知识库确认的内容；' +
                    '不要自行编造或补充任何未经确认的项目、功效、价格、恢复期或禁忌。' +
                    '若确实无法提供，请直接、礼貌地说明，并引导用户通过正规渠道（如预约面诊）咨询。'
              });
              continue;
            }

            // 3) 重试仍不通过 / 无 safeReply → 中性安全兜底，绝不暴露内部拦截文本。
            // P4.5：兜底话术前缀与 step-output 检测器共享同一常量（单源，防字面量漂移）。
            return GUARDRAIL_FALLBACK_PREFIX + '。如有进一步需求，建议您通过官方正规渠道咨询。';
          }

          // 流式回退：开启了 streamTokens 但适配器并未逐 delta 回调（mock / 不支持 stream），
          // 则把整段内容作为单个 token 发出，确保聊天 UI 仍能渲染（无打字动画，但内容完整）。
          if (this.opts.streamTokens && !streamedTokens && resp.content) {
            emit({ type: 'llm:token', step: steps, delta: resp.content });
          }

          emit({
            type: 'llm:response',
            step: steps,
            content: resp.content,
            toolCalls: resp.tool_calls,
            partial: resp.partial
          });
          // Hook: agent.post_llm — observe response after LLM call
          void hooks.execute('agent.post_llm', {
            runId,
            sessionKey: runId,
            tenantId: this.opts.tenantId,
            response: resp.content,
            toolCalls: resp.tool_calls,
            messages,
          });
          memory.add({
            role: 'assistant',
            content: resp.content,
            tool_calls: resp.tool_calls
          });

          if (!resp.tool_calls || resp.tool_calls.length === 0) {
            // 可选「完成自检」：开启且模型以空响应（疑似放弃）收尾时，注入提示继续
            // 循环直到 maxSteps，避免复杂任务被「空响应即结束」提前中断。非空回复
            // 一律视为真实最终答案，不二次质疑（避免干扰正常收尾、也避免额外成本）。
            if (
              this.opts.requireCompletion &&
              (!resp.content || !resp.content.trim()) &&
              steps < this.opts.maxSteps
            ) {
              memory.add({
                role: 'user',
                content:
                  '（系统提示）你还没有给出实质性结果，请继续完成任务；若需要信息，请调用工具。'
              });
              continue;
            }
            // 中段断流兜底：provider 空闲超时后返回的是部分内容（partial:true）。
            // 显式追加「生成中断」提示，让用户清楚这是被截断而非完整回答。
            // P4.5：中断标记与 step-output 检测器共享同一常量（引擎闸门 / 黑板注记认它）。
            if (resp.partial) {
              return (
                `${resp.content}\n\n` +
                `${PARTIAL_NOTICE}：与模型的连接空闲超时（可在服务端调高 LLM_STREAM_IDLE_TIMEOUT_MS）。` +
                '以上内容仅为已生成的部分结果，请重试以继续。'
              );
            }
            return resp.content;
          }

          // 执行每个请求的工具调用，并将结果以 tool 消息形式回传给 LLM。
          //
          // answeredIds 记录本轮已回传结果的 tool_call id。 assistant 消息在循环前
          // 就已带着全部 tool_calls 写入记忆，因此任何提前退出（预算截断 / 取消）
          // 都会留下「声明了调用却没有结果」的孤儿 tool_call —— provider 会直接
          // 400 拒绝下一次请求，且这份断裂历史会被持久化、污染后续会话。
          // 收尾时统一补齐占位结果，保证 tool_calls 与结果严格一一对应。
          const answeredIds = new Set<string>();
          const fillMissingToolResults = (reason: string): void => {
            for (const c of resp.tool_calls ?? []) {
              if (answeredIds.has(c.id)) continue;
              const content = `${reason}（tool_call_id=${c.id}）`;
              answeredIds.add(c.id);
              memory.add({
                role: 'tool',
                tool_call_id: c.id,
                name: c.name,
                content
              });
              emit({
                type: 'tool:result',
                step: steps,
                call: c,
                result: content,
                errored: true
              });
            }
          };

          // P4.8 软截止：预算已转紧（含「本轮 LLM 调用期间才转紧」）时不再启动新工具轮，
          // 免得把仅剩的预算烧在一轮必然跑不完的工具调用上。注意此处只置标志、不注入
          // 收尾提示 —— 提示统一在下一轮 LLM 调用前注入，避免打断 tool 配对。
          if (!wrapUpRequested && isPastSoftDeadline()) {
            wrapUpRequested = true;
            emit({
              type: 'warn',
              message: '时间预算已转紧：跳过本轮工具调用，要求模型立即收尾输出最终结果'
            });
          }
          if (wrapUpRequested) {
            fillMissingToolResults('[skipped] 时间预算即将耗尽，该工具未执行');
            wrapUpRounds += 1;
            if (resp.content && resp.content.trim()) return resp.content;
            if (wrapUpRounds >= 2) {
              // 模型连续两轮仍只调工具：用已产出内容兜底，避免走到硬超时把产出丢光。
              const salv = salvagePartial();
              if (salv) return salv;
              return MAX_STEPS_NOTICE;
            }
            continue;
          }

          for (const call of resp.tool_calls) {
            if (signal.aborted) {
              fillMissingToolResults('[aborted] 运行已取消，该工具未执行');
              return abortedResult();
            }
            // 加固：单 step 工具调用预算上限（默认不限制）。达到上限后截断剩余 tool_calls。
            if (maxCallsPerStep > 0 && stepToolCalls >= maxCallsPerStep) {
              emit({
                type: 'warn',
                message: `step ${steps} 工具调用已达上限 ${maxCallsPerStep}，截断剩余 tool_calls`
              });
              break;
            }
            stepToolCalls++;
            // 加固：同 run 内「同名 + 相同归一化参数」去重，复用首次结果，避免重复执行。
            if (toolDedupOn) {
              const dkey = makeDedupKey(call);
              const cached = toolDedupCache.get(dkey);
              if (cached) {
                emit({
                  type: 'tool:deduped',
                  step: steps,
                  call,
                  result: cached.result,
                  errored: cached.errored
                });
                memory.add({
                  role: 'tool',
                  tool_call_id: call.id,
                  name: call.name,
                  content: cached.result
                });
                answeredIds.add(call.id);
                lastToolResult = { name: call.name, result: cached.result };
                continue;
              }
            }
            // 记录已用工具，供后续步骤动态选择时并入硬允许集（见本步 llm:call 前）。
            usedTools.add(call.name);
            const argGuard = await checkToolArgsAsync(
              call.name,
              call.arguments,
              this.opts.guardrailPolicy
            );
            let result: unknown;
            let errored = false;
            if (!argGuard.ok) {
              result = `guardrail blocked: ${argGuard.reason}`;
              errored = true;
              recordError('guardrail.tool');
              structLog('warn', 'guardrail blocked', {
                phase: 'tool',
                tool: call.name,
                reason: argGuard.reason,
                runId
              });
              emit({
                type: 'guardrail:blocked',
                phase: 'tool',
                tool: call.name,
                reason: argGuard.reason ?? 'unknown'
              });
              guardrailsBlocked += 1;
            } else {
              emit({ type: 'tool:start', step: steps, call });
            // Hook: agent.pre_tool — observe tool call before execution
            void hooks.execute('agent.pre_tool', {
              runId,
              sessionKey: runId,
              tenantId: this.opts.tenantId,
              toolCall: { name: call.name, arguments: call.arguments },
            });
              try {
                // P4.8：工具执行纳入「中止 + 单次超时」竞速（机制拆分至
                // harness/tool-executor.ts）。此前这里是裸 await —— 工具挂死时看门狗
                // abort 无法生效，整个 step 会一直阻塞到该工具自己返回。现在：
                //  - 运行被中止（超时/取消）→ 立即放弃等待并走中止路径（内容不再丢）；
                //  - 单次工具超过 AGENT_TOOL_TIMEOUT_MS → 以「工具超时」作为工具结果
                //    回传，模型可改道或基于已有信息继续，而不是拖垮整步；
                //  - 超时经工具级独立 AbortController 真实中止工具执行（含落地子进程）。
                const raced = await executeToolWithRace({
                  call,
                  signal,
                  abortPromise,
                  toolCallTimeoutMs,
                  tools: this.opts.tools,
                  traceId: this.opts.traceId,
                  sessionId: this.opts.sessionId,
                  networkPolicy: this.opts.guardrailPolicy?.network
                });
                if (raced.kind === 'aborted') {
                  fillMissingToolResults('[aborted] 运行已取消，该工具未执行');
                  return abortedResult();
                }
                if (raced.kind === 'err') {
                  // 工具 promise 已被转成已决值，此处恢复异常语义，
                  // 走下方统一 catch 转为工具错误文本回传模型。
                  throw raced.error;
                }
                if (raced.kind === 'timeout') {
                  result =
                    `tool error: 工具执行超时（>${Math.round(toolCallTimeoutMs / 1000)}s 无返回，` +
                    '已中止该工具执行；请改用其它方式获取信息，或基于已有信息继续）';
                  errored = true;
                } else {
                  result = raced.value;
                }
              } catch (e) {
                // 将错误作为工具结果返回，以便模型自行修复。
                result = `tool error: ${
                  e instanceof Error ? e.message : String(e)
                }`;
                errored = true;
              }
            }
            incCounter('tool.call');
            if (errored) recordError(`tool.${call.name}`);
            let resultStr =
              typeof result === 'string' ? result : JSON.stringify(result);
            // 工具结果截断：降低「工具原文逐字重发」带来的上下文膨胀与 token 成本。
            const cap = this.opts.maxToolResultChars;
            if (cap && cap > 0 && resultStr.length > cap) {
              resultStr =
                resultStr.slice(0, cap) +
                `\n…[工具结果已截断：原长 ${resultStr.length} 字符，仅保留前 ${cap} 字符]`;
            }
            emit({
              type: 'tool:result',
              step: steps,
              call,
              result: resultStr,
              errored
            });
            // Hook: agent.post_tool — observe tool result after execution
            void hooks.execute('agent.post_tool', {
              runId,
              sessionKey: runId,
              tenantId: this.opts.tenantId,
              toolResult: { output: resultStr, errored },
              toolCall: { name: call.name, arguments: call.arguments },
            });
            memory.add({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: resultStr
            });
            answeredIds.add(call.id);
            // 记录最近一次工具结果，供下一轮输出护栏感知业务上下文（如 kb 查空信号）。
            lastToolResult = { name: call.name, result: resultStr };
            // 加固：将真实执行结果写入去重缓存，供后续相同调用复用。
            if (toolDedupOn) {
              toolDedupCache.set(makeDedupKey(call), {
                result: resultStr,
                errored
              });
            }
          }
          // 收尾补齐：被「单步调用预算」截断的 tool_calls 也要有结果占位，
          // 否则 assistant 会带着孤儿 tool_call 进入下一轮请求与持久化存档。
          fillMissingToolResults('[skipped] 本步工具调用已达上限，该调用未执行');
        }
        // 计划 propose 收尾（P5 优化）：预算耗尽时调研往往已消耗大量 token，若直接返回
        // MAX_STEPS_NOTICE，服务端解析不出计划 JSON，整轮调研白烧、用户只能从头重试。
        // 这里补一次「强制收尾」LLM 调用（不带工具，逼模型立即产出），基于已获取的
        // 信息直接输出计划/澄清 JSON；仅当收尾调用失败或仍无内容时才回退默认提示。
        if (this.opts.planPropose && !signal.aborted) {
          try {
            memory.add({
              role: 'user',
              content:
                '（系统提示）规划预算已用尽，请立即停止调研。基于以上已获取的信息直接输出最终结果：' +
                '需求清晰时输出计划 JSON（信息不足的任务在 expectedOutput 中显式标注数据缺口），' +
                '需求不清时输出澄清 JSON（{"clarify": true, "goalDraft": string, "questions": string[]}）。' +
                '只输出一个 JSON 对象，不要任何其他文字。'
            });
            const finResp = await this.opts.llm(
              sanitizeToolPairing(memory.history()),
              [],
              { signal, circuitBreaker: this.opts.circuitBreaker }
            );
            if (finResp?.content && finResp.content.trim()) {
              memory.add({ role: 'assistant', content: finResp.content });
              return finResp.content;
            }
          } catch {
            // 收尾调用失败（网络/熔断等）：回退到默认 MAX_STEPS_NOTICE。
          }
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
          guardrailsBlocked,
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

    // 运行结束，若有持久化路径则落盘（best-effort）。
    if (memory.hasPersistence) {
      try {
        await memory.save();
      } catch {
        /* 存档失败不应影响已产出的结果 */
      }
    }

    // 输出侧 PII 脱敏：无论正常结束、超时还是异常，最终返回给用户的内容都经过打码。
    final = redactOutput(final, this.opts.guardrailPolicy);
    incCounterTenant('agent.run.end', this.opts.tenantId);
    cleanup();
    // Hook: agent.post_run — normal completion
    void hooks.execute('agent.post_run', {
      runId,
      sessionKey: runId,
      tenantId: this.opts.tenantId,
      final,
      steps,
      tokens: undefined,
      cost: undefined,
    });
    emit({ type: 'run:end', runId, final, steps });
    return final;
  }
}
