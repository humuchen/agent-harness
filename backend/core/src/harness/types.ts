/**
 * Harness 类型定义（P1-2：从 harness.ts 拆出）。
 *
 * 本模块只承载类型契约，零运行时逻辑：
 *   - HarnessEvent：run 期间发出的事件联合类型（CLI 进度条 / Web UI / 测试探针观察用）
 *   - HarnessOptions：AgentHarness 构造选项
 *   - ResolvedHarnessOptions：默认值填充后的解析结果（onEvent 永不为空）
 *
 * harness.ts 保留为聚合门面并 re-export 这些类型，外部导入路径（'./harness'、
 * '@agent-harness/core'）与行为完全不变。
 */
import type { LLM, ToolCall, TokenUsage } from '../types';
import type { Verifier } from '../verify';
import type { ToolRegistry } from '../tools';
import type { Memory } from '../memory';
import type { GuardrailPolicy } from '../guardrails';
import type { CircuitBreaker } from '../circuit-breaker';

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
      /** 是否为「与模型连接空闲超时」截断的部分响应（中段断流兜底）。前端据此显示「生成中断」提示。 */
      partial?: boolean;
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
      /** 自上次用量上报以来是否发生过上下文压缩（历史淘汰）：用于前端「已压缩」指示。 */
      compressed?: boolean;
      breakdown: {
        system: number;
        tools: number;
        messages: number;
        mcp: number;
        skills: number;
        completion: number;
        /** 本次供应商侧缓存命中 token，前端可展示节省量。 */
        cached?: number;
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
      /**
       * 软性未通过（P4.7）：只告警、不阻断 —— 产出原样保留、不追加 [verify:failed]、
       * step 不判失败。见 verify.ts 的 VerifyOutcome.soft。
       */
      soft?: boolean;
    }

  /** 计划模式（P0）：plan-propose run 收尾时由服务端解析模型输出并补发此旁路事件。
   *  payload 为已通过结构/依赖校验的执行计划；解析失败不发此事件（发 warn 回退）。 */
  | { type: 'plan:proposed'; plan: import('../plan').ExecutionPlan }

  /** 计划模式（P0）：需求不清时由服务端解析澄清 JSON 补发的旁路事件，等用户确认目标后再 propose。 */
  | { type: 'plan:clarify'; clarify: import('../plan').PlanClarify }

  /** 计划模式（P0）：propose 阶段进度（理解需求 → 调研中 → 生成计划），供前端展示真实进展。 */
  | { type: 'plan:phase'; phase: string; ts: number }

  /** TypeSafe AI Jev 决策模型调用旁路事件：子系统直连路径（注入门禁/上下文压缩等）与
   *  builtin__jev_decide 工具路径统一经 run-events 通道上报，让「typesafe 后台有调用量」
   *  在 run 调用链可观测。仅当 jevDecide 的 HTTP 调用发生在 run 异步链路内时发出。
   *  注意：caller==='tool' 的调用已有 tool:start/tool:result 节点，前端不重复建节点。 */
  | {
      type: 'jev:call';
      /** 调用方标签：'tool'(LLM 工具路径) / 'injection-gate' / 'context-compress' / 'router' 等。 */
      caller: string;
      ok: boolean;
      /** 本次 HTTP 调用耗时（ms）。 */
      latencyMs: number;
      /** 本次提问数（一次 systemone 调用可携带多个问题）。 */
      questions?: number;
      /**
       * 逐问题规格（问题名 -> 问题定义），用于调用链节点展开「问题」记录。
       * 与 questions(数量) 并存：后者供聚合统计，前者供单条回溯。
       */
      questionSpec?: Record<string, unknown>;
      /**
       * 归一化后的逐问题决策输出（问题名 -> { type, choice?, probabilities?, score?, noul?, confidence?, criteria? }），
       * 用于调用链节点展开「输出记录」。失败时缺省（节点改显 error）。
       */
      answers?: Record<string, unknown>;
      /** TypeSafe 侧 usage（若响应体携带）；未携带则缺省，成本体系暂不计入。 */
      tokens?: { input: number; output: number };
      /** ok=false 时的错误摘要（HTTP 状态或网络错误信息，不含密钥）。 */
      error?: string;
    }

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
  /**
   * P1（leadId 注入防护）：会话标识（服务端 sessionKey，如 conversationId）。
   * 随工具调用 ctx 透传给插件工具，供「session→业务实体」服务端绑定校验——
   * 插件据此拒绝跨会话写他人档案（如医美插件 leadId 强制与首绑一致）。
   * 缺省不透传（工具侧无法绑定时保持既有行为）。
   */
  sessionId?: string;

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

// 经默认值填充后的解析结果类型：onEvent 永不为空。
export interface ResolvedHarnessOptions {
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
  // P1（leadId 注入防护）：随工具 ctx 透传的会话标识（见 HarnessOptions.sessionId）。
  sessionId?: string;
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
