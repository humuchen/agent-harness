/**
 * LLM 用量记账与事件发射（P1-2：从 harness.ts 拆出）。
 *
 * 职责（对应原 runInner 内 LLM 响应到达后的记账段，语句顺序逐字保留）：
 *   1. 记录「已成功接收的最大 prompt」（自适应压缩预算上限的依据）；
 *   2. token / 成本记账（per-run 累加 + 租户维度遥测）；
 *   3. 无单价诊断日志；
 *   4. 启发式 token 拆解（system/tools/history/mcp/skills/completion）；
 *   5. 发出 run:cost / llm:usage / run:token-cache 旁路事件。
 *
 * 可变性约定：runTokens / runCost / maxAcceptedPrompt 三个累加量通过返回值
 * 交还调用方写回（原为闭包局部变量与实例字段），调用方必须按返回值原样写回，
 * 任何其它可观测副作用（emit / structLog / telemetry / memory.setContextUsage）
 * 均在本函数内部按原顺序发生。
 */
import type { LLMResponse, Message, TokenUsage, ToolSchema } from '../types';
import type { Memory } from '../memory';
import { structLog, recordTokensTenant, recordCostTenant } from '../telemetry';
import { estimateCostDetailed } from '../llm/pricing';
import { getTokenCacheStats } from '../llm/token-cache-metrics';
import {
  estimateMessageTokens,
  estimateTokens,
  estimateToolsTokens
} from '../llm/token-estimator';
import { contextWindowFor } from './context-window';
import type { HarnessEvent } from './types';

/** 记账函数的事件发射器（runInner 的防御性 emit 包装）。 */
type Emit = (e: HarnessEvent) => void;

export interface UsageAccountingParams {
  /** 本次 LLM 响应（已成功返回，非 null）。 */
  resp: LLMResponse;
  /** 实际发给 LLM 的消息序列（估算占比用）。 */
  messages: Message[];
  /** 本次实际发给 LLM 的工具 schema 子集。 */
  stepTools: ToolSchema[];
  /** 当前步号（事件负载用）。 */
  steps: number;
  /** 累加前的 run 级 token 计数。 */
  runTokens: number;
  /** 累加前的 run 级成本计数。 */
  runCost: number;
  /** 调用前的 maxAcceptedPrompt（实例字段当前值）。 */
  maxAcceptedPrompt: number;
  /** 记忆实例（setContextUsage / consumeCompressed）。 */
  memory: Memory;
  emit: Emit;
  /** 租户标识（遥测与事件负载；缺省不发）。 */
  tenantId?: string;
  /** 配置的上下文窗口（缺省回落 contextWindowFor）。 */
  contextWindow?: number;
  /** 配置的计价模型标识（resp.model 缺省时回落）。 */
  model?: string;
  /** run 标识（诊断日志用）。 */
  runId: string;
}

export interface UsageAccountingResult {
  /** 累加后的 run 级 token 计数（调用方写回局部变量）。 */
  runTokens: number;
  /** 累加后的 run 级成本计数（调用方写回局部变量）。 */
  runCost: number;
  /** 更新后的 maxAcceptedPrompt（调用方写回实例字段）。 */
  maxAcceptedPrompt: number;
}

/**
 * LLM 响应到达后的用量记账与事件发射。
 * 语句顺序与拆分前逐字一致；仅把三处累加量改为「返回值写回」。
 */
export function accountAndEmitUsage(
  p: UsageAccountingParams
): UsageAccountingResult {
  const { resp, messages, stepTools, steps, emit, memory, tenantId, runId } = p;
  let runTokens = p.runTokens;
  let runCost = p.runCost;

  // 记录「已成功接收的最大 prompt」，作为后续步的保守预算上限，避免反复溢出。
  const maxAcceptedPrompt = Math.max(
    p.maxAcceptedPrompt,
    resp.usage?.prompt_tokens ?? 0
  );
  recordTokensTenant(resp.usage, tenantId);

  // 成本记账：按实际使用模型（响应优先，回落配置 model）查单价表估算，
  // 累加进 per-run 与全局指标，并发出 run:cost 事件供 UI 实时展示。
  const costModel = resp.model ?? p.model;
  const estimate = estimateCostDetailed(costModel, resp.usage);
  const stepCost = estimate.cost;
  runCost += stepCost;
  runTokens += resp.usage?.total_tokens ?? 0;
  recordCostTenant(stepCost, costModel, tenantId);

  // 未找到单价且未配置默认价时发出诊断日志，便于排查「cost 始终为 0」的根因。
  if (
    !estimate.found &&
    stepCost === 0 &&
    (resp.usage?.prompt_tokens || resp.usage?.completion_tokens)
  ) {
    structLog('warn', 'model pricing not found, cost estimate is zero', {
      model: costModel,
      usage: resp.usage,
      runId
    });
  }

  // 本地拆解四项占比（启发式估算，仅用于链路可视化；权威值仍以 provider 的 usage 为准）。
  // 系统在「系统提示」项，工具 schema 在「工具」项，其余消息累计为「历史」，
  // 模型本次输出（含 tool_calls 参数）计入「输出」项，便于定位高 token 消耗的固定开销来源。
  //
  // 多模态计费口径：走 estimateMessageTokens 而非 JSON.stringify + estimateTokens。
  // 后者会把整段图片 base64 序列化后按「4 字符 = 1 token」折算，一张 1MB 图即约
  // 34 万虚假 token，使「历史」一项高估 1~2 个数量级（曾出现 858,118 tok 的失真展示）。
  // 现改为图片按视觉 token 计（low=85 / high=85+170×512 分块数），与真实计费同量级。
  let estSystem = 0;
  let estHistory = 0;
  for (const m of messages) {
    const t = estimateMessageTokens(m);
    if (m.role === 'system') estSystem += t;
    else estHistory += t;
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
    const usage: TokenUsage = resp.usage;
    emit({
      type: 'run:cost',
      step: steps,
      model: costModel,
      usage,
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
      ...(tenantId ? { tenantId } : {})
    } as HarnessEvent);

    // 上下文用量（精确）：以 provider 的 usage 为权威总量，按各组件序列化 token
    // 占比把 prompt 拆到五类（系统/工具/对话/MCP/技能），供前端浮层展示精确占比。
    const promptTokens = resp.usage.prompt_tokens ?? 0;
    const completionTokens = resp.usage.completion_tokens ?? 0;
    const window =
      p.contextWindow && p.contextWindow > 0
        ? p.contextWindow
        : contextWindowFor(costModel);

    // 把真实上下文占用喂给记忆，驱动 token 级压缩护栏（在占用率越过阈值时
    // 于后续 add() 中淘汰最旧历史，避免上下文撑爆导致模型 400）。
    memory.setContextUsage(promptTokens, window);
    // 优化：scale 基于「实际新计费 token」（排除缓存命中），避免 cached_tokens 被归到 tools 占比上
    const actualPromptTokens = promptTokens - (resp.usage?.cached_tokens ?? 0);
    const promptEst =
      estSystem + estToolsBuiltin + estHistory + estMcp + estSkills;
    const scale = promptEst > 0 ? actualPromptTokens / promptEst : 0;
    emit({
      type: 'llm:usage',
      step: steps,
      model: costModel,
      window,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      // 「自上次用量上报以来」是否发生过上下文压缩：读取即清零，
      // 避免会话级 sticky 标志导致「已压缩」徽标亮起后永不消失、
      // 与真实用量变化脱钩。
      compressed: memory.consumeCompressed(),
      breakdown: {
        system: Math.round(estSystem * scale),
        tools: Math.round(estToolsBuiltin * scale),
        messages: Math.round(estHistory * scale),
        mcp: Math.round(estMcp * scale),
        skills: Math.round(estSkills * scale),
        completion: completionTokens,
        // 新增：本次供应商侧缓存命中 token，前端可展示节省量
        cached: resp.usage?.cached_tokens ?? 0
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
      ...(tenantId ? { tenantId } : {})
    } as HarnessEvent);
  }

  return { runTokens, runCost, maxAcceptedPrompt };
}
