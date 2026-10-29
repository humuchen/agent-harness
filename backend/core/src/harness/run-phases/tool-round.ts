/**
 * 单步工具轮编排（P1#21 H3 段：自 runInner 迁出）。
 *
 * 三阶段并发编排（压缩方案5）：
 *   1) 按序准备：abort / 单步上限 / 去重 / 护栏 / schema 分类，产出执行计划（保序）；
 *   2) 有界并发：仅「需真实执行」的调用并发跑（AH_TOOL_CONCURRENCY，默认 4，
 *      设 1 退化为串行）；事件语义不变（tool:start/tool:result 与实际执行绑定）；
 *   3) 按原序回填：memory 中 tool 结果顺序与 tool_calls 严格一致，
 *      不给严格 provider 制造乱序配对。
 *
 * 拆分说明（原「有意保持内联」决策的落地方案）：
 * 原内联段参数面 >15 的根因是「跨 runLoop 迭代保留的游标/计数」与「轮内并发池状态」
 * 混在同一个闭包里。现把跨迭代字段（lastToolResult / wrapUpRequested / wrapUpRounds /
 * guardrailsBlocked / stepToolCalls）收敛为调用方持有的 ToolRoundState 可变对象，
 * 轮内状态（planned / done / answeredIds / cursor）保留为函数局部——两层各自封闭，
 * 参数面回到一个 input 对象 + 一个 state 对象。行为与拆分前逐字等价；
 * abort/护栏拦截/去重/截断语义由既有专项测试覆盖（harness*.test.cjs 的工具循环 +
 * 并发 + 去重 + 中止用例）。
 */
import type { LLMResponse, ToolCall } from '../../types';
import type { Memory } from '../../memory';
import type { ToolRegistry } from '../../tools';
import type { GuardrailPolicy } from '../../guardrails';
import { checkToolArgsAsync } from '../../guardrails';
import { incCounter, recordError, structLog } from '../../telemetry';
import { hooks } from '../../hooks';
import type { HarnessEvent } from '../types';
import { executeToolWithRace } from '../tool-executor';
import { MAX_STEPS_NOTICE } from '../../workflow/step-output';
import { estimateTokens } from '../../llm/token-estimator';

/** 跨 runLoop 迭代保留的工具轮状态（调用方创建并逐轮传入同一对象，函数内写回）。 */
export interface ToolRoundState {
  /** 最近一次执行的工具调用结果（跨 runLoop 迭代保留），用于向输出护栏注入上下文，
   *  使规则能感知「上一步工具（如 project_kb_search）是否返回 found:false」等业务信号。 */
  lastToolResult: { name: string; result: string } | null;
  /** 本 step 已发起的工具调用数（单步预算截断；调用方在每步开始时重置为 0）。 */
  stepToolCalls: number;
  /** P4.8 软截止标志：预算转紧后不再启动新工具轮（LLM 调用前的收尾注入也会置位）。 */
  wrapUpRequested: boolean;
  /** 收尾轮数：模型连续两轮仍只调工具时以已产出内容兜底，避免硬超时丢光产出。 */
  wrapUpRounds: number;
  /** 本次 run 被护栏拦截次数（含工具参数侧；供 VerifyContext 统计）。 */
  guardrailsBlocked: number;
}

export interface ToolRoundInput {
  /** 当前步 LLM 响应（tool_calls 的宿主）。 */
  resp: LLMResponse;
  memory: Memory;
  emit: (e: HarnessEvent) => void;
  /** run 级取消信号（超时/外部取消）。 */
  signal: AbortSignal;
  /** run 级中止竞速 promise（中止时 resolve '__aborted__'）。 */
  abortPromise: Promise<'__aborted__'>;
  /** 单次工具超时毫秒（0 = 不限时）。 */
  toolCallTimeoutMs: number;
  /** 全量工具注册表（执行始终走全量，与「发送给 LLM 的子集」无关）。 */
  tools: ToolRegistry;
  /** per-run 护栏策略（工具参数校验 + network 出网管控）。 */
  guardrailPolicy?: GuardrailPolicy;
  /** 工具 ctx / hooks 载荷：租户与链路标识。 */
  tenantId?: string;
  sessionId?: string;
  traceId?: string;
  runId: string;
  steps: number;
  /** 单 step 工具调用预算上限（0 = 不限制）。 */
  maxCallsPerStep: number;
  /** 同 run 内「同名 + 相同归一化参数」去重开关。 */
  toolDedupOn: boolean;
  toolDedupCache: Map<string, { result: string; errored: boolean }>;
  makeDedupKey: (call: ToolCall) => string;
  /** 本 run 已实际调用过的工具名（动态工具选择的硬允许集输入；函数内追加）。 */
  usedTools: Set<string>;
  /** 工具结果字符上限（超出截断并标注；undefined/0 = 不截断）。 */
  maxToolResultChars?: number;
  /** 工具结果 token 上限（超出按 token 估算截断并标注；undefined/0 = 不截断）。
   *  与字符级上限并存：两者同时配置时取先命中者（token 级更贴近真实计费口径）。 */
  maxToolResultTokens?: number;
  /** P4.8 软截止判定（调用方闭包，依赖 run 级 deadline）。 */
  isPastSoftDeadline: () => boolean;
  /** 抢救「已生成但未成为最终答案」的内容（调用方闭包，依赖 run 级 streamBuffer）。 */
  salvagePartial: () => string;
  /** 跨轮保留状态（调用方持有）。 */
  state: ToolRoundState;
}

export type ToolRoundOutcome =
  /** 运行被取消（准备/执行期任一中止出口命中）：调用方 `return abortedResult()`。 */
  | { kind: 'aborted' }
  /** 收尾兜底产出（wrap-up 内容 / 已抢救内容 / 默认提示）：调用方直接返回该文本。 */
  | { kind: 'final'; text: string }
  /** 正常完成本步工具轮（结果已全部回填）：调用方 continue 下一循环。 */
  | { kind: 'continue' };

/**
 * 执行当前步的全部 tool_calls 并把结果回填进记忆。
 * 返回判别联合，调用方按 kind 分派（aborted/final/continue），语义与拆分前一致。
 */
export async function executeToolRound(
  input: ToolRoundInput
): Promise<ToolRoundOutcome> {
  const {
    resp,
    memory,
    emit,
    signal,
    abortPromise,
    toolCallTimeoutMs,
    tools,
    guardrailPolicy,
    tenantId,
    sessionId,
    traceId,
    runId,
    steps,
    maxCallsPerStep,
    toolDedupOn,
    toolDedupCache,
    makeDedupKey,
    usedTools,
    maxToolResultChars,
    maxToolResultTokens,
    isPastSoftDeadline,
    salvagePartial,
    state
  } = input;

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
  if (!state.wrapUpRequested && isPastSoftDeadline()) {
    state.wrapUpRequested = true;
    emit({
      type: 'warn',
      message: '时间预算已转紧：跳过本轮工具调用，要求模型立即收尾输出最终结果'
    });
  }
  if (state.wrapUpRequested) {
    fillMissingToolResults('[skipped] 时间预算即将耗尽，该工具未执行');
    state.wrapUpRounds += 1;
    if (resp.content && resp.content.trim()) return { kind: 'final', text: resp.content };
    if (state.wrapUpRounds >= 2) {
      // 模型连续两轮仍只调工具：用已产出内容兜底，避免走到硬超时把产出丢光。
      const salv = salvagePartial();
      if (salv) return { kind: 'final', text: salv };
      return { kind: 'final', text: MAX_STEPS_NOTICE };
    }
    return { kind: 'continue' };
  }

  // ── 压缩方案5（Token 成本优化）：同批 tool_calls 有界并发执行 ─────────────
  // 原实现逐个 await：同一轮 N 次抓取的墙钟时间 = 各次之和，而模型一轮发出的
  // 多个调用本就语义独立（OpenAI parallel_tool_calls 语义）。改为三阶段：
  //   1) 按序准备：abort / 上限 / 去重 / 护栏分类，产出执行计划（保序）；
  //   2) 有界并发：仅「需真实执行」的调用并发跑（AH_TOOL_CONCURRENCY，默认 4，
  //      设 1 退化为串行）；事件语义不变（start/result 与实际执行绑定）；
  //   3) 按原序回填：memory 中 tool 结果顺序与 tool_calls 严格一致，
  //      不给严格 provider 制造乱序配对。
  // 中止语义：任一调用竞速到 aborted → 停止取新任务，先按原序回填已完成项
  // （与串行版「已完成结果保留」一致），再对未完成项补占位并中止整轮。
  interface PlannedToolCall {
    call: ToolCall;
    kind: 'skipped' | 'dedup' | 'execute';
    /** 预置结果：dedup 缓存命中 / 护栏拦截，不真正执行工具。 */
    preset?: { result: unknown; errored: boolean };
  }
  const planned: PlannedToolCall[] = [];
  let preparedAborted = false;
  for (const call of resp.tool_calls) {
    if (signal.aborted) {
      preparedAborted = true;
      break;
    }
    // 加固：单 step 工具调用预算上限（默认不限制）。达到上限后截断剩余 tool_calls。
    if (maxCallsPerStep > 0 && state.stepToolCalls >= maxCallsPerStep) {
      emit({
        type: 'warn',
        message: `step ${steps} 工具调用已达上限 ${maxCallsPerStep}，截断剩余 tool_calls`
      });
      planned.push({ call, kind: 'skipped' });
      continue;
    }
    state.stepToolCalls++;
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
        planned.push({
          call,
          kind: 'dedup',
          preset: { result: cached.result, errored: cached.errored }
        });
        continue;
      }
    }
    // 记录已用工具，供后续步骤动态选择时并入硬允许集（见本步 llm:call 前）。
    usedTools.add(call.name);
    const argGuard = await checkToolArgsAsync(call.name, call.arguments, guardrailPolicy);
    if (!argGuard.ok) {
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
      state.guardrailsBlocked += 1;
      // 护栏拦截项不真正执行工具，但沿用统一的「结果后处理」路径
      //（计数 / 截断 / 事件 / 回填），与串行版语义一致。
      planned.push({
        call,
        kind: 'execute',
        preset: { result: `guardrail blocked: ${argGuard.reason}`, errored: true }
      });
      continue;
    }
    // P6 结构化输出闸门（工具参数侧）：按注册 JSON-Schema 校验 LLM 传入参数，
    // 不合规时不执行工具，以可读错误文本回喂模型自愈（与上方护栏拦截同型：
    // preset + errored）。registry.call 契约保持不变（工具自身 error: 返回语义、
    // 直接调用方零回归）；工具内部的语义级校验（如 operation 枚举）仍由工具自管。
    const schemaErrors = tools.validateArgs(call.name, call.arguments);
    if (schemaErrors.length > 0) {
      recordError('schema.tool');
      structLog('warn', 'tool args schema mismatch', {
        phase: 'tool',
        tool: call.name,
        errors: schemaErrors.slice(0, 5).join('; '),
        runId
      });
      planned.push({
        call,
        kind: 'execute',
        preset: {
          result:
            `tool "${call.name}" 参数校验失败：${schemaErrors.slice(0, 5).join('; ')}` +
            (schemaErrors.length > 5 ? `（等 ${schemaErrors.length} 处）` : ''),
          errored: true
        }
      });
      continue;
    }
    planned.push({ call, kind: 'execute' });
  }
  if (preparedAborted) {
    fillMissingToolResults('[aborted] 运行已取消，该工具未执行');
    return { kind: 'aborted' };
  }

  // 工具结果截断：降低「工具原文逐字重发」带来的上下文膨胀与 token 成本。
  // 两级上限并存：字符级（原行为，向后兼容）与 token 级（更贴近真实计费口径，
  // 按估算器折算；两者同时配置时取先命中者）。
  const formatToolResult = (result: unknown): string => {
    let s = typeof result === 'string' ? result : JSON.stringify(result);
    const cap = maxToolResultChars;
    if (cap && cap > 0 && s.length > cap) {
      s =
        s.slice(0, cap) +
        `\n…[工具结果已截断：原长 ${s.length} 字符，仅保留前 ${cap} 字符]`;
    }
    const tokCap = maxToolResultTokens;
    if (tokCap && tokCap > 0 && estimateTokens(s) > tokCap) {
      const originalTokens = estimateTokens(s);
      // 二分逼近 token 上限：估算器是启发式，直接按比例缩放可能低估，
      // 用二分搜索截断到「估算值 ≤ 上限」的最长前缀。
      let lo = 0;
      let hi = s.length;
      let cut = 0;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (estimateTokens(s.slice(0, mid)) <= tokCap) {
          cut = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      s =
        s.slice(0, cut) +
        `\n…[工具结果已截断：原约 ${originalTokens} tokens，仅保留前 ${cut} 字符]`;
    }
    return s;
  };

  // 阶段二：仅「需真实执行」的调用进入有界并发池（去重命中 / 护栏拦截不进池）。
  const execItems = planned.filter((p) => p.kind === 'execute');
  const concRaw = Number(process.env.AH_TOOL_CONCURRENCY);
  const concurrency = Math.max(
    1,
    Math.min(Number.isFinite(concRaw) && concRaw > 0 ? Math.floor(concRaw) : 4, 16)
  );
  const done = new Map<PlannedToolCall, { result: string; errored: boolean }>();
  let runAborted = false;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < execItems.length && !runAborted) {
      const item = execItems[cursor++] as PlannedToolCall;
      const call = item.call;
      let result: unknown;
      let errored = false;
      if (item.preset) {
        // 护栏拦截等预置结果：不启动工具、不发 tool:start，直接走后处理。
        result = item.preset.result;
        errored = item.preset.errored;
      } else {
        emit({ type: 'tool:start', step: steps, call });
        // Hook: agent.pre_tool — observe tool call before execution
        void hooks.execute('agent.pre_tool', {
          runId,
          sessionKey: runId,
          tenantId,
          toolCall: { name: call.name, arguments: call.arguments },
        });
        try {
          // P4.8：工具执行纳入「中止 + 单次超时」竞速（机制在
          // harness/tool-executor.ts）：运行被中止 → 走中止路径；单次超时 →
          // 以「工具超时」作为结果回传并真实中止工具执行（含落地子进程）。
          const raced = await executeToolWithRace({
            call,
            signal,
            abortPromise,
            toolCallTimeoutMs,
            tools,
            traceId,
            sessionId,
            networkPolicy: guardrailPolicy?.network
          });
          if (raced.kind === 'aborted') {
            runAborted = true;
            return;
          }
          if (raced.kind === 'err') {
            // 工具 promise 已被转成已决值，此处恢复异常语义，
            // 走统一 catch 转为工具错误文本回传模型。
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
      const resultStr = formatToolResult(result);
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
        tenantId,
        toolResult: { output: resultStr, errored },
        toolCall: { name: call.name, arguments: call.arguments },
      });
      done.set(item, { result: resultStr, errored });
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, execItems.length)) },
      () => worker()
    )
  );

  // 阶段三：按原序回填。memory 中 tool 结果顺序与 tool_calls 严格一致；
  // dedup 命中项沿用缓存结果（不再发 tool:result，与串行版事件语义一致）。
  const flushPlanned = (): void => {
    for (const p of planned) {
      if (answeredIds.has(p.call.id)) continue;
      if (p.kind === 'skipped') continue; // 留给循环末尾 fillMissingToolResults 统一占位
      const entry =
        p.kind === 'dedup' && p.preset
          ? { result: p.preset.result as string, errored: p.preset.errored }
          : done.get(p);
      if (!entry) continue; // aborted 等场景未完成，由 fillMissingToolResults 兜底
      memory.add({
        role: 'tool',
        tool_call_id: p.call.id,
        name: p.call.name,
        content: entry.result
      });
      answeredIds.add(p.call.id);
      // 记录最近一次工具结果，供下一轮输出护栏感知业务上下文（如 kb 查空信号）。
      state.lastToolResult = { name: p.call.name, result: entry.result };
      // 加固：将执行结果写入去重缓存，供后续相同调用复用。
      if (toolDedupOn && p.kind === 'execute') {
        toolDedupCache.set(makeDedupKey(p.call), {
          result: entry.result,
          errored: entry.errored
        });
      }
    }
  };
  if (runAborted) {
    flushPlanned();
    fillMissingToolResults('[aborted] 运行已取消，该工具未执行');
    return { kind: 'aborted' };
  }
  flushPlanned();
  // 收尾补齐：被「单步调用预算」截断的 tool_calls 也要有结果占位，
  // 否则 assistant 会带着孤儿 tool_call 进入下一轮请求与持久化存档。
  fillMissingToolResults('[skipped] 本步工具调用已达上限，该调用未执行');
  return { kind: 'continue' };
}
