import { LLM, Message, ToolCall, LLMResponse, TokenUsage } from './types';
import { type Verifier, type VerifyContext } from './verify';
import { ToolRegistry } from './tools';
import { Memory } from './memory';
import { resolveAndTrack, EntityTracker } from './coreference';
import {
  checkInput,
  checkOutput,
  checkStructuredOutput,
  checkTaskOutput,
  checkToolArgs,
  redactOutput,
  type GuardrailPolicy
} from './guardrails';
import { parsePlanOutput } from './plan';
import { CircuitBreaker, CircuitBreakerOpen } from './circuit-breaker';
import {
  withSpan,
  incCounter,
  recordError,
  structLog,
  logError,
  emitAlert,
  recordTokensTenant,
  recordCostTenant,
  incCounterTenant
} from './telemetry';
import { estimateCostDetailed } from './llm/pricing';
import { getTokenCacheStats } from './llm/token-cache-metrics';
import { estimateTokens, estimateToolsTokens } from './llm/token-estimator';
import { selectToolsForInput } from './tools';
import { hooks } from './hooks';

/** 上下文窗口上限（token）：用于「上下文用量」占比分母。
 *  已废弃按模型名硬编码的猜测表 —— 各模型真实 context_length 由前端从
 *  OpenRouter 模型目录获取并随 run 下发；此处仅保留 AH_CONTEXT_WINDOW
 *  显式覆盖与保守兜底（仅影响未携带窗口数据的旧客户端）。 */
const FALLBACK_CONTEXT_WINDOW = 128000;

/** 导出供 server（/api/state）向前端下发当前模型的上下文窗口上限。 */
export function contextWindowFor(model?: string): number {
  const env = Number(process.env.AH_CONTEXT_WINDOW);
  if (env > 0) return env;
  return FALLBACK_CONTEXT_WINDOW;
}

/**
 * Harness 在跑一轮 `run()` 期间发出的事件。
 * 这些事件让外部（CLI 进度条、Web UI、测试探针）无需侵入核心循环即可
 * 实时观察 LLM ↔ 工具 ↔ 记忆 的每一步。纯可选，不影响任何既有行为。
 */
export type HarnessEvent =
  | { type: 'run:start'; runId: string; input: string }
  | { type: 'run:tools'; tools: { name: string; description: string }[] }
  | {
      type: 'guardrail:blocked';
      phase: 'input' | 'output' | 'tool';
      reason: string;
      tool?: string;
    }
  | { type: 'step:start'; step: number; maxSteps: number }
  | { type: 'llm:call'; step: number; messageCount: number; toolCount: number }
  | {
      type: 'llm:response';
      step: number;
      content: string;
      toolCalls: ToolCall[];
    }
  /** token 级流式增量（打字机效果）。仅当 HarnessOptions.streamTokens 开启且适配器支持时发出。 */
  | { type: 'llm:token'; step: number; delta: string }
  /** 推理过程增量（思考折叠块）。部分推理模型在 delta.reasoning 中逐段返回。 */
  | { type: 'llm:reasoning'; step: number; delta: string }
  | { type: 'tool:start'; step: number; call: ToolCall }
  | {
      type: 'tool:result';
      step: number;
      call: ToolCall;
      result: string;
      errored: boolean;
    }
  /** 加固：工具调用去重命中。同 run 内出现「同名 + 相同归一化参数」的重复请求时，
   *  直接复用首次结果而不真正执行，emit 此事件（而非 tool:start），用于 UI 标记「复用缓存」并计入可观测。 */
  | {
      type: 'tool:deduped';
      step: number;
      call: ToolCall;
      result: string;
      errored: boolean;
    }
  | {
      type: 'run:cost';
      step: number;
      model?: string;
      usage: TokenUsage;
      stepCost: number;
      cumulativeTokens: number;
      cumulativeCost: number;
      priced?: boolean;
      estTokens?: {
        system: number;
        tools: number;
        history: number;
        completion: number;
      };
    }
  /** 上下文用量（精确）：以 provider 返回的 usage（prompt/completion）为权威总量，
   *  按各组件序列化 token 占比把 prompt 拆到五类（系统/工具/对话/MCP/技能），
   *  供前端「上下文用量」浮层展示精确占比。仅当拿到 provider usage 时发出。 */
  | {
      type: 'llm:usage';
      step: number;
      model?: string;
      window: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      breakdown: {
        system: number;
        tools: number;
        messages: number;
        mcp: number;
        skills: number;
        completion: number;
      };
    }
  | {
      type: 'run:token-cache';
      step: number;
      model?: string;
      interface: string;
      queries: number;
      hits: number;
      hitRate: number;
      cachedTokens: number;
      promptTokens: number;
      tokenHitRate: number;
      byModel: Record<
        string,
        { queries: number; hits: number; hitRate: number }
      >;
    }
  /** 统一基座平台元数据：把本次 run 关联到「智能体 / 工作流 / 租户 / 追踪」维度（P0/P1）。
   *  纯旁路观测通道，不修改任何业务逻辑；仅当调用方传入相关字段时才发出。 */
  | {
      type: 'run:meta';
      runId: string;
      agentId?: string;
      workflowId?: string;
      traceId?: string;
      tenantId?: string;
      decidedBy?: string;
    }
  | {
      type: 'budget:exceeded';
      kind: 'tokens' | 'cost';
      limit: number;
      used: number;
    }
  | { type: 'run:end'; runId: string; final: string; steps: number }
  | {
      type: 'verify:result';
      attempt: number;
      passed: boolean;
      score: number;
      reasons: string[];
    }
  /** 计划模式（P0）：plan-propose run 收尾时由服务端解析模型输出并补发此旁路事件。
   *  payload 为已通过结构/依赖校验的执行计划；解析失败不发此事件（发 warn 回退）。 */
  | { type: 'plan:proposed'; plan: import('./plan').ExecutionPlan }
  /** 旁路告警（如工具调用预算截断），不影响主流程，仅供可观测。 */
  | { type: 'warn'; message: string }
  | { type: 'error'; message: string };

export interface HarnessOptions {
  llm: LLM;
  tools: ToolRegistry;
  memory?: Memory;
  systemPrompt?: string;

  // 对 Agent 循环步数的安全上限（工具调用 -> LLM -> 工具调用 ...）。
  maxSteps?: number;

  // 整体运行超时（毫秒）。超时后中止循环并返回超时提示，避免长时间挂起。
  timeoutMs?: number;

  // 外部取消信号；触发后中止运行（例如用户关闭 UI、进程收到 SIGTERM）。
  signal?: AbortSignal;

  // 可选的事件回调：在循环每一步（LLM 调用 / 工具调用 / 护栏拦截）发生时触发。
  // 用于进度展示、可视化与测试断言，不修改任何业务逻辑。
  onEvent?: (e: HarnessEvent) => void;

  // 用于成本计价的模型标识（harness 不直接调 LLM 配置，需调用方传入用于查单价表）。
  // 缺省时仍会按响应里的 resp.model 计价；两者都无则按未知模型默认价（默认 0）。
  model?: string;

  // 该模型的真实上下文窗口上限（token）：llm:usage 事件据此下发「上下文用量」分母。
  // 由调用方从权威来源（OpenRouter 模型目录 context_length / AH_CONTEXT_WINDOW）解析后传入；
  // 未传时回落保守基线（FALLBACK_CONTEXT_WINDOW），不再按模型名猜测。
  contextWindow?: number;

  // 单次 run 的 token 预算上限（累计 total_tokens）。超出即中止并返回预算超限提示。
  tokenBudget?: number;

  // 单次 run 的成本预算上限（美元，按模型单价估算）。超出即中止。
  costBudget?: number;

  // 单次 run 的工具结果字符上限（超出截断并标注）。降低「工具原文逐字重发」带来的
  // 上下文膨胀与 token 成本。未配置（undefined）则不截断；UI 默认 16000。
  maxToolResultChars?: number;

  // 可选「完成自检」：开启后，若模型以空响应（疑似放弃）收尾，注入提示继续循环
  // 直到 maxSteps，避免复杂任务被「空响应即结束」提前中断。默认关闭（避免额外成本）。
  requireCompletion?: boolean;

  // 运行期自动验证门禁（P0-2）：产出最终答案后自动调用验证器。未通过时若仍有重试额度，
  // 注入自检提示重跑循环（自愈）；否则在最终结果前加 [verify:failed] 标记。不设置则关闭门禁。
  verify?: Verifier;

  // 验证未通过时的最大自动重试次数（每次重跑一个完整 maxSteps 预算的循环）。默认 0（仅校验不重试）。
  verifyMaxRetries?: number;

  // 验证未通过且仍有重试额度时，是否注入自检提示重跑（默认：在 verifyMaxRetries>0 时开启）。
  verifySelfCorrect?: boolean;

  // P0.3 租户隔离：per-run 护栏策略覆盖。传入后，输入/输出/工具参数校验与脱敏均使用
  // 该策略而非全局默认。缺省（undefined）则沿用全局 default（向后兼容：零租户行为不变）。
  guardrailPolicy?: GuardrailPolicy;

  // P0/P1 统一基座平台元数据：把本次 run 关联到「目标智能体 / 工作流 / 追踪 id / 租户」。
  // 仅用于 run:meta 事件观测与可观测关联，不影响任何业务逻辑；全部可选、向后兼容。
  agentId?: string;
  workflowId?: string;
  traceId?: string;
  tenantId?: string;

  /** 路由决策来源（explicit / domain / classify / fallback），供可观测区分。 */
  decidedBy?: string;

  /**
   * 是否启用 token 级流式：开启后 LLM 调用会透传 onToken/onReasoning 回调，
   * harness 据此发出 llm:token / llm:reasoning 事件（打字机效果 + 思考折叠块）。
   * 默认 false，不改变既有非流式行为；服务端 assembleAgent 对 real 模式默认开启。
   */
  streamTokens?: boolean;

  /**
   * 动态工具选择：硬允许集（来自 AgentCard.assembly.tools 或核心环境工具）。
   * 与「按意图动态裁剪」配合——这些工具无条件发给 LLM，永不裁掉；其余工具按
   * 当前用户输入的相关性择优发送（见 selectToolsForInput）。缺省为空，表示无硬约束。
   */
  allowTools?: string[];

  // 加固：工具调用去重。开启后，对「同名 + 相同归一化参数」的重复工具调用，直接复用首次结果
  //（emit tool:deduped 而非 tool:start），不真正重新执行，从而砍掉冗余调用、降低 token 成本与上下文膨胀。
  // 默认 false（完全不介入），向后兼容，不破坏任何既有行为。
  enableToolDedup?: boolean;

  // 加固：单 step 内工具调用预算上限。每 step 真实执行达到上限后，剩余 tool_calls 被截断并 emit warn。
  // 0 或不传表示不限制（保持现状），用于兜底「模型单轮并行请求过多工具」的场景。
  maxToolCallsPerStep?: number;

  // 计划模式 propose（P0）：开启后，若模型最终输出能解析为合法计划 JSON，则输出校验
  // 走 checkStructuredOutput（仅密钥/注入扫描），跳过业务自定义规则——结构化任务描述
  // 极易被领域合规正则（如医疗广告法）误伤，且拦截后的合规话术重试会破坏 JSON 格式。
  // 缺省 false（行为与之前完全一致，向后兼容）。
  planPropose?: boolean;

  // 计划任务执行（P0）：计划模式逐任务派发的 run。输出为面向用户的学习/执行内容，
  // 常规架构讲解必然包含「system prompt」「apiKey=…示例」等字样 —— medium 敏感度的
  // 弱信号注入短语与密钥赋值样例正则会把正常教学内容误拦成「无法提供回复」。
  // 开启后输出校验降级为「真实密钥格式 + 强信号注入短语」扫描（checkTaskOutput），
  // 跳过弱信号短语、业务自定义规则与上下文规则；安全底线（真密钥 / 注入攻击）不放松。
  // 缺省 false（行为与之前完全一致，向后兼容）。
  planTask?: boolean;

  // 可选自定义去重 key 生成器；不传则使用内置 stableToolKey（name + 参数 key 排序后 JSON）。
  toolDedupKey?: (call: ToolCall) => string;
}

/** 把工具名 + 参数归一化为稳定字符串，用于去重比较（参数 key 排序，忽略字段顺序差异）。 */
function stableToolKey(call: ToolCall): string {
  let args: unknown = call.arguments;
  try {
    if (typeof args === 'string') args = JSON.parse(args as string);
  } catch {
    /* 保留原字符串 */
  }
  let norm: unknown = args;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(args as Record<string, unknown>).sort()) {
      sorted[k] = (args as Record<string, unknown>)[k];
    }
    norm = sorted;
  }
  let argStr: string;
  try {
    argStr = JSON.stringify(norm);
  } catch {
    argStr = String(args);
  }
  return `${call.name}::${argStr}`;
}

// 经默认值填充后的解析结果类型：onEvent 永不为空。
interface ResolvedHarnessOptions {
  llm: LLM;
  tools: ToolRegistry;
  memory: Memory;
  systemPrompt: string; // 注意：systemPrompt 实际不经过 Memory 持久化窗口，见下
  maxSteps: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent: (e: HarnessEvent) => void;
  model?: string;
  // 真实上下文窗口上限（token，可选）：llm:usage 分母。见 HarnessOptions.contextWindow。
  contextWindow?: number;
  tokenBudget?: number;
  costBudget?: number;
  maxToolResultChars?: number;
  requireCompletion: boolean;
  verify?: Verifier;
  verifyMaxRetries: number;
  verifySelfCorrect: boolean;
  guardrailPolicy?: GuardrailPolicy;
  // P0/P1 统一基座平台元数据（仅观测用，不影响业务逻辑）。
  agentId?: string;
  workflowId?: string;
  traceId?: string;
  tenantId?: string;
  decidedBy?: string;
  // token 级流式开关：开启后 LLM 调用透传 onToken/onReasoning，harness 发出
  // llm:token / llm:reasoning 事件（打字机效果 + 思考折叠块）。默认 false。
  streamTokens?: boolean;
  // 动态工具选择：硬允许集（永远发给 LLM，不被按意图裁剪）。
  allowTools?: string[];
  // 加固：工具调用去重开关与单 step 预算（见 HarnessOptions 注释）。
  enableToolDedup: boolean;
  maxToolCallsPerStep: number;
  toolDedupKey?: (call: ToolCall) => string;
  // 计划模式 propose（见 HarnessOptions 注释）。
  planPropose: boolean;
  // 计划任务执行（见 HarnessOptions 注释）。
  planTask: boolean;
  // P1-10: 可选熔断器（CircuitBreaker）。LLM 持续 5xx 时自动熔断，避免逐个请求硬等超时。
  // 未传则不启用（向后兼容）。开启后，熔断打开时抛出 CircuitBreakerOpen，调用方可捕获决定重试策略。
  circuitBreaker?: CircuitBreaker;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

export class AgentHarness {
  private opts: ResolvedHarnessOptions;
  /** 指代消解实体追踪器（COREF_ENABLED=true 时启用） */
  private _corefTracker?: EntityTracker;
  private _corefTurn = 0;

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

  async run(
    userInput: string,
    imageAttachments?: Array<{ url: string; name: string; type: string }>
  ): Promise<string> {
    const runId = nextId('run');
    const emit = (e: HarnessEvent) => this.opts.onEvent?.(e);

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

    const guard = checkInput(
      resolvedInput,
      this.opts.guardrailPolicy,
      // 计划任务派发：输入（任务标题/步骤/预期产出的拼接文本）与输出侧 checkTaskOutput
      // 对称地降级为强信号注入检测 —— 任务步骤合理提到「system prompt」等词不应拦截。
      this.opts.planTask === true
    );
    if (!guard.ok) {
      recordError('guardrail.input');
      structLog('warn', 'guardrail blocked', {
        phase: 'input',
        reason: guard.reason,
        runId
      });
      emit({
        type: 'guardrail:blocked',
        phase: 'input',
        reason: guard.reason ?? 'unknown'
      });
      // 注意：此早期返回发生在 verify 门禁之前，不进入 runLoop，故不计入 guardrailsBlocked
      // （verify 上下文只统计循环内发生的拦截；此处直接以 guardrail 消息结束本轮）。
      const msg = `[guardrail] blocked: ${guard.reason}`;
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
    if (imageAttachments && imageAttachments.length > 0) {
      const contentBlocks: Array<
        | { type: 'text'; text?: string }
        | { type: 'image_url'; image_url?: { url: string } }
      > = [];
      if (userInput) contentBlocks.push({ type: 'text', text: userInput });
      for (const img of imageAttachments) {
        contentBlocks.push({ type: 'image_url', image_url: { url: img.url } });
      }
      memory.add({ role: 'user', content: contentBlocks as any });
    } else {
      memory.add({ role: 'user', content: resolvedInput });
    }

    let final = '[agent] reached max steps without a final answer';
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
    // 把主循环抽成函数，便于「验证失败后自动重试」复用同一 maxSteps 预算重跑。
    const runLoop = (): Promise<string> =>
      withSpan('agent.run', async () => {
        for (let step = 0; step < this.opts.maxSteps; step++) {
          // 进入下一步前先检查取消信号，避免对已中止的运行继续消耗工具/LLM。
          if (signal.aborted) {
            return abortedMessage(signal);
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

          const messages = memory.history();
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
            // 安全网：若输入看起来是真实任务（含疑问、较长、或出现常见任务词），
            // 直接回退全量工具，避免漏发必要工具导致质量退化；
            // 问候/寒暄/极短输入则保持最小子集，保留优化收益。
            const taskIndicators =
              /[?？]|什么|怎么|如何|为什么|多少|查询|获取|搜索|查一下|查找|计算|天气|时间|日期|文件|代码|运行|测试|执行|创建|销毁|环境|状态|结果|最新|新闻|资讯/;
            const looksLikeTask =
              input.length >= 8 || taskIndicators.test(input);
            stepTools = looksLikeTask ? allSchemas : subset;
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
          const llmPromise = this.opts.llm(messages, stepTools, {
            signal,
            circuitBreaker: this.opts.circuitBreaker,
            ...(this.opts.streamTokens
              ? {
                  onToken: (delta: string) => {
                    streamedTokens = true;
                    emit({ type: 'llm:token', step: steps, delta });
                  },
                  onReasoning: (delta: string) => {
                    emit({ type: 'llm:reasoning', step: steps, delta });
                  }
                }
              : {})
          });
          const abortedFlag = new Promise<'__aborted__'>((resolve) => {
            if (signal.aborted) return resolve('__aborted__');
            signal.addEventListener('abort', () => resolve('__aborted__'), {
              once: true
            });
          });
          const raceResult = await withSpan('llm.call', () =>
            Promise.race([llmPromise, abortedFlag])
          );
          if (raceResult === '__aborted__') {
            return abortedMessage(signal);
          }
          const resp: LLMResponse = raceResult;
          recordTokensTenant(resp.usage, this.opts.tenantId);

          // 成本记账：按实际使用模型（响应优先，回落配置 model）查单价表估算，
          // 累加进 per-run 与全局指标，并发出 run:cost 事件供 UI 实时展示。
          const costModel = resp.model ?? this.opts.model;
          const estimate = estimateCostDetailed(costModel, resp.usage);
          const stepCost = estimate.cost;
          runCost += stepCost;
          runTokens += resp.usage?.total_tokens ?? 0;
          recordCostTenant(stepCost, costModel, this.opts.tenantId);
          // 未找到单价且未配置默认价时发出诊断日志，便于排查「cost 始终为 0」的根因。
          if (
            !estimate.found &&
            stepCost === 0 &&
            (resp.usage?.prompt_tokens || resp.usage?.completion_tokens)
          ) {
            structLog(
              'warn',
              'model pricing not found, cost estimate is zero',
              {
                model: costModel,
                usage: resp.usage,
                runId
              }
            );
          }
          // 本地拆解四项占比（启发式估算，仅用于链路可视化；权威值仍以 provider 的 usage 为准）。
          // 系统在「系统提示」项，工具 schema 在「工具」项，其余消息累计为「历史」，
          // 模型本次输出（含 tool_calls 参数）计入「输出」项，便于定位高 token 消耗的固定开销来源。
          let estSystem = 0;
          let estHistory = 0;
          for (const m of messages) {
            const c =
              typeof m.content === 'string'
                ? m.content
                : JSON.stringify(m.content ?? '');
            if (m.role === 'system') estSystem += estimateTokens(c);
            else estHistory += estimateTokens(c);
          }
          const estTools = estimateToolsTokens(stepTools);
          // 把工具拆分为「内置工具」与「MCP 工具（名称含 '__' 前缀）」，分别计入
          // 「工具及子智能体」与「连接器及 MCP」两类，使上下文用量拆分更贴近真实构成。
          let estMcp = 0;
          for (const t of stepTools) {
            if (t.name.includes('__'))
              estMcp += estimateTokens(`${t.name} ${t.description ?? ''}`);
          }
          const estToolsBuiltin = estTools - estMcp;
          const estSkills = 80; // 技能注册基线（粗估）
          let completionText = resp.content ?? '';
          if (resp.tool_calls) {
            for (const tc of resp.tool_calls) {
              completionText +=
                ' ' +
                (typeof tc.arguments === 'string'
                  ? tc.arguments
                  : JSON.stringify(tc.arguments ?? {}));
            }
          }
          const estCompletion = estimateTokens(completionText);
          // 仅在拿到 usage 时发出 run:cost（mock / 不返回用量的响应不刷屏）。
          if (resp.usage) {
            emit({
              type: 'run:cost',
              step: steps,
              model: costModel,
              usage: resp.usage,
              stepCost,
              cumulativeTokens: runTokens,
              cumulativeCost: runCost,
              priced: estimate.found,
              estTokens: {
                system: estSystem,
                tools: estTools,
                history: estHistory,
                completion: estCompletion
              },
              ...(this.opts.tenantId ? { tenantId: this.opts.tenantId } : {})
            });
            // 上下文用量（精确）：以 provider 的 usage 为权威总量，按各组件序列化 token
            // 占比把 prompt 拆到五类（系统/工具/对话/MCP/技能），供前端浮层展示精确占比。
            const promptTokens = resp.usage.prompt_tokens ?? 0;
            const completionTokens = resp.usage.completion_tokens ?? 0;
            const window =
              this.opts.contextWindow && this.opts.contextWindow > 0
                ? this.opts.contextWindow
                : contextWindowFor(costModel);
            const promptEst =
              estSystem + estToolsBuiltin + estHistory + estMcp + estSkills;
            const scale = promptEst > 0 ? promptTokens / promptEst : 0;
            emit({
              type: 'llm:usage',
              step: steps,
              model: costModel,
              window,
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
              breakdown: {
                system: Math.round(estSystem * scale),
                tools: Math.round(estToolsBuiltin * scale),
                messages: Math.round(estHistory * scale),
                mcp: Math.round(estMcp * scale),
                skills: Math.round(estSkills * scale),
                completion: completionTokens
              }
            });
          }
          // Token 缓存命中率：仅在本次 run 真正发生过缓存查询时发出
          // （PROMPT_CACHE 开启且供应商返回 cached_tokens）。数据来自全局统计快照，
          // 随链路一并下发，便于在调用链 trace 中排查缓存/鉴权相关性能问题。
          const tcStats = getTokenCacheStats();
          if (tcStats.queries > 0) {
            emit({
              type: 'run:token-cache',
              step: steps,
              model: costModel,
              interface: 'prompt-cache',
              queries: tcStats.queries,
              hits: tcStats.hits,
              hitRate: tcStats.hitRate,
              cachedTokens: tcStats.cachedTokens,
              promptTokens: tcStats.promptTokens,
              tokenHitRate: tcStats.tokenHitRate,
              byModel: tcStats.byModel,
              ...(this.opts.tenantId ? { tenantId: this.opts.tenantId } : {})
            });
          }
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
            : checkOutput(
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
                    '）。请重新生成：仍然只输出一个符合格式要求的计划 JSON 对象' +
                    '（{"goal": string, "tasks": [{"id","title","steps","dependsOn","expectedOutput"}]}），' +
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
            return '抱歉，我暂时无法提供该内容的回复。如有进一步需求，建议您通过官方正规渠道咨询。';
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
            toolCalls: resp.tool_calls
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
            return resp.content;
          }

          // 执行每个请求的工具调用，并将结果以 tool 消息形式回传给 LLM。
          for (const call of resp.tool_calls) {
            if (signal.aborted) {
              return abortedMessage(signal);
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
                lastToolResult = { name: call.name, result: cached.result };
                continue;
              }
            }
            // 记录已用工具，供后续步骤动态选择时并入硬允许集（见本步 llm:call 前）。
            usedTools.add(call.name);
            const argGuard = checkToolArgs(
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
                result = await withSpan(`tool.${call.name}`, async () =>
                  this.opts.tools.call(call.name, call.arguments, { traceId: this.opts.traceId })
                );
              } catch (e: any) {
                // 将错误作为工具结果返回，以便模型自行修复。
                result = `tool error: ${e?.message ?? String(e)}`;
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
        }
        return '[agent] reached max steps without a final answer';
      });

    try {
      final = await runLoop();
    } catch (e: any) {
      // P1-10: 熔断打开时直接返回错误，不触发通用告警（避免告警风暴）
      if (e?.name === 'CircuitBreakerOpen') {
        const msg = e.message ?? 'circuit breaker open';
        emit({ type: 'error', message: msg });
        final = `[circuit-breaker] ${msg}`;
      } else {
        logError('agent.run', e, { runId });
        emitAlert('error', 'agent.run', e?.message ?? String(e), { runId });
        emit({ type: 'error', message: e?.message ?? String(e) });
        final = `[error] ${e?.message ?? String(e)}`;
      }
    }

    // 运行期自动验证门禁（P0-2）：产出后自动校验；未通过可重试（self-correction）或标记。
    if (this.opts.verify) {
      const buildCtx = (): VerifyContext => ({
        input: userInput,
        final,
        steps,
        toolCalls: collectToolCalls(memory.history()),
        guardrailsBlocked,
        budgetExceeded: budgetExceededFlag
      });
      let attempt = 0;
      let outcome = await this.opts.verify(buildCtx());
      emit({
        type: 'verify:result',
        attempt,
        passed: outcome.passed,
        score: outcome.score,
        reasons: outcome.reasons
      });
      while (!outcome.passed && attempt < this.opts.verifyMaxRetries) {
        attempt += 1;
        if (this.opts.verifySelfCorrect) {
          // 注入自检提示，让模型根据失败原因修正后重新跑一轮（自动重试 / 自愈）。
          memory.add({
            role: 'user',
            content:
              '（系统提示）上一轮运行未通过自动验证：' +
              outcome.reasons.join('；') +
              '。请审视并修正你的回答与步骤，然后重新给出最终结果。'
          });
          try {
            final = await runLoop();
          } catch (e: any) {
            logError('agent.run.retry', e, { runId });
            final = `[error] ${e?.message ?? String(e)}`;
          }
          outcome = await this.opts.verify(buildCtx());
          emit({
            type: 'verify:result',
            attempt,
            passed: outcome.passed,
            score: outcome.score,
            reasons: outcome.reasons
          });
        } else {
          break;
        }
      }
      if (!outcome.passed) {
        final = `[verify:failed] ${outcome.reasons.join('; ')}\n\n${final}`;
      }
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

/** 根据中止原因生成人类可读的结果提示。 */
function abortedMessage(signal: AbortSignal): string {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason === 'timeout') return '[timeout] run exceeded time limit';
  if (reason === 'external') return '[aborted] run cancelled by caller';
  return '[aborted] run cancelled';
}

/** 从对话历史收集所有工具调用（供验证上下文统计）。 */
function collectToolCalls(messages: Message[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) out.push(...m.tool_calls);
  }
  return out;
}
