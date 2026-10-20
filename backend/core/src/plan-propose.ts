/**
 * 计划模式（P0）propose 专用两段式规划管线。
 *
 * 设计动机（彻底重构，替代「通用 agent 循环 + 预算封顶 + 强制收尾」补丁）：
 * 旧方案让 planner 复用通用 harness 自由循环——步数耗尽时产出不了计划（调研 token 白烧）、
 * 阶段进度靠事件类型启发式去猜、调研轮数不受控。本模块把 propose 改为服务端确定性编排：
 *
 *   阶段1 理解需求（纯 LLM，无工具）→ clarify / plan / research 三分支
 *   阶段2 调研中（带检索工具的受限小循环，轮数服务端封顶，逐条发 tool 事件）
 *   阶段3 生成计划（纯 LLM，无工具；输入=原需求+目标+调研纪要；解析失败带错误反馈重试一次）
 *
 * 结构保证：阶段3 无条件执行 → 「烧了 token 没产出」不可能发生；每阶段产出都被下一阶段
 * 消费；plan:phase 事件在真实阶段边界下发（前端零改动兼容）。
 * 回退：env PLAN_PROPOSE_PIPELINE=false 时 run-queue 走旧 harness 路径。
 */

import type { LLM, LLMResponse, Message, ToolCall, ToolSchema } from './types';
import type { ToolRegistry } from './tools';
import type { HarnessEvent } from './harness';
import type { GuardrailPolicy } from './guardrails';
import { checkToolArgs } from './guardrails';
import type { Memory } from './memory';
import {
  buildPlannerPrompt,
  buildClarifyConfirmedBlock,
  clarifyMaxRounds,
  isClarifyQuestionDuplicate,
  parseClarifyReply,
  parseClarifyOutput,
  parsePlanOrClarify,
  type ClarifyReply,
  type ExecutionPlan,
  type PlanClarify,
  type PlanClarifyQuestion
} from './plan';

/** plan:phase 的三个阶段名（与前端 renderPlanPhase 的 stages 严格一致）。 */
export const PLAN_PHASES = ['理解需求', '调研中', '生成计划'] as const;

/** 管线依赖：全部由调用方（run-queue）注入，core 不感知 env / 服务端装配。 */
export interface PlanProposeDeps {
  /** LLM 适配器（与 harness 同一实例，复用租户 Key / 熔断 / 流式）。 */
  llm: LLM;
  /** 工具注册表（阶段2 只允许检索类工具，按 researchTools 白名单过滤）。 */
  tools: ToolRegistry;
  /** 用户原始需求。 */
  userInput: string;
  /** 事件回调：透传与 harness 兼容的事件流（run-queue 的 onEvent）。 */
  emit?: (e: HarnessEvent) => void;
  /** 外部取消信号（job 级 AbortController / 看门狗超时）。 */
  signal?: AbortSignal;
  circuitBreaker?: import('./circuit-breaker').CircuitBreaker;
  /** 系统提示词（与普通 run 保持同一人格基线）。 */
  systemPrompt?: string;
  /** 会话记忆：写入本轮对话，保证后续计划执行 run 的上下文连续。 */
  memory?: Memory;
  /** 阶段2 最大调研轮数（每轮可含多个工具调用）。默认 3。 */
  maxResearchRounds?: number;
  /** 单个工具结果截断长度（字符）。默认 4000，控制阶段3 输入体积。 */
  maxResultChars?: number;
  /** 是否透传 llm:token / llm:reasoning 流式事件（默认 true，服务端会抑制 token）。 */
  streamTokens?: boolean;
  /** 护栏策略（出网管控等，作用于阶段2 工具参数校验）。 */
  guardPolicy?: GuardrailPolicy;
  /** 阶段2 允许使用的工具名白名单。默认 ['builtin__web_fetch']。 */
  researchTools?: string[];
}

/** 阶段1 的解析结果。 */
export type UnderstandResult =
  | { kind: 'clarify'; clarify: PlanClarify }
  | { kind: 'go'; goal: string; queries: string[] }
  | null;

/** 阶段1 提示词：理解需求 + 三分支决策（clarify / 直接规划 / 需要调研）。 */
export function buildProposeUnderstandPrompt(
  userInput: string,
  clarifyReply?: ClarifyReply | null
): string {
  const lines = [
    '你是资深任务规划师，当前处于「规划」的第一步：理解需求。不要执行任务。',
    '',
    `用户需求：${userInput}`,
    // 澄清回复轮：把用户已回答的 Q&A 显式注入并下禁重问规则（防循环追问，见 plan.ts 契约）。
    ...(clarifyReply ? ['', buildClarifyConfirmedBlock(clarifyReply)] : []),
    '',
    '请只输出一个 JSON 对象（三选一，不要任何其他文字或 markdown 围栏）：',
    '',
    '1. 需求清晰，且拆分计划不需要外部资料：',
    '{"action": "plan", "goal": "一句话复述用户的目标与关键约束"}',
    '',
    '2. 需求清晰，但计划强依赖外部资料/数据（行业数据、最新动态、文档内容等）：',
    '{"action": "research", "goal": "一句话复述目标", "queries": ["具体检索意图1", "具体检索意图2"]}',
    '- queries 最多 3 条，每条是一句可直接执行的检索意图；能不查就不查，宁缺毋滥。',
    '',
    '3. 需求模糊 / 关键前提缺失 / 涉及不可逆或高风险操作且目标未对齐：',
    '{"clarify": true, "goalDraft": "你对目标的初步理解草稿", "questions": [{"q": "需用户确认的具体问题", "options": ["候选答案1", "候选答案2"]}], "needs": "缺失的关键信息（可选）"}',
    '- questions 1~5 条，必须具体，不要泛泛而问。',
    '- 每个问题必须附 options：2~4 个最常见的候选答案（短词/短语，覆盖典型场景），供用户直接点选。',
    ...(clarifyReply && clarifyReply.round >= clarifyMaxRounds()
      ? [
          '',
          `（硬性）本轮已是用户第 ${clarifyReply.round} 轮澄清回复，禁止再输出第 3 种澄清 JSON，必须输出第 1 / 2 种分支。`
        ]
      : [])
  ];
  return lines.join('\n');
}

/** 阶段2 提示词：受限调研（只收集资料，不产出计划）。 */
export function buildProposeResearchPrompt(
  userInput: string,
  goal: string,
  maxRounds: number
): string {
  return [
    `你的唯一任务：为下述规划目标收集外部资料。用户需求：${userInput}`,
    `已确认目标：${goal}`,
    '',
    '规则：',
    `1. 你最多有 ${maxRounds} 轮工具调用机会，只允许使用检索类工具（如 builtin__web_fetch 抓取网页）；`,
    '   每轮抓取最有价值的一个资料源，资料足够即停止调用工具。',
    '2. 全部收集完成后，直接输出一段「调研纪要」纯文本：分条列出与目标相关的事实与数据（尽量带来源），',
    '   获取失败的资料标注「数据缺口：...」，不要反复重试。',
    '3. 不要输出计划 JSON —— 计划由下一步基于你的纪要生成。'
  ].join('\n');
}

/** 阶段3 提示词：基于调研纪要产出最终计划/澄清 JSON（复用 buildPlannerPrompt 的格式契约）。 */
export function buildProposeFinalPrompt(
  userInput: string,
  goal: string,
  researchNotes: string,
  clarifyReply?: ClarifyReply | null
): string {
  return [
    buildPlannerPrompt(userInput),
    '',
    `已确认目标：${goal}`,
    '',
    '调研纪要（拆分时作为事实依据；标注「数据缺口」的部分，相关任务的 expectedOutput 须显式说明缺口）：',
    researchNotes ||
      '（无外部调研资料，基于通用知识规划，并在产出中说明数据缺口）',
    '',
    '联网能力对齐（硬性）：若上述纪要存在「数据缺口」或本次未提供任何调研资料，说明执行环境大概率没有联网检索工具——',
    '此时计划的任务不得把「真实外部数据 / 实时引用 / 具体统计数字」设为硬性验收条件；',
    '相关任务的 steps 应写明「无联网时以【数据缺口：待补充项】占位」，expectedOutput 只要求结构性内容 + 缺口标注完整，',
    'outputChecks 只放宽泛主题词（如「竞品」「风险」），禁止放「xxxx年市场数据」「xx个案例」这类必须联网才能满足的断言。',
    '',
    // 澄清轮次达上限：与阶段1 同一把尺子，阶段3 也禁止再产出澄清 JSON（防跨阶段绕过上限）。
    ...(clarifyReply && clarifyReply.round >= clarifyMaxRounds()
      ? [
          `（硬性）用户已完成 ${clarifyReply.round} 轮澄清回复，禁止再输出澄清 JSON（格式 B），必须只输出计划 JSON（格式 A）。`
        ]
      : []),
    '现在输出最终结果：需求清晰输出计划 JSON（格式 A），需求不清输出澄清 JSON（格式 B）。只输出一个 JSON 对象。'
  ].join('\n');
}

/** 容错提取阶段1 的 JSON（直接 parse → 去围栏 → 截取首尾括号）。 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text || !text.trim()) return null;
  const candidates: string[] = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1] ?? '');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first)
    candidates.push(text.slice(first, last + 1));
  for (const raw of candidates) {
    try {
      const data = JSON.parse(raw.trim());
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return data as Record<string, unknown>;
      }
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null;
}

/** 解析阶段1 输出：clarify 优先，其次 plan / research 分支。 */
export function parseUnderstandOutput(text: string): UnderstandResult {
  const clarify = parseClarifyOutput(text);
  if (clarify) return { kind: 'clarify', clarify };
  const d = extractJsonObject(text);
  if (!d) return null;
  const action = typeof d.action === 'string' ? d.action.trim() : '';
  const goal = typeof d.goal === 'string' ? d.goal.trim() : '';
  if (!goal) return null;
  if (action === 'plan') return { kind: 'go', goal, queries: [] };
  if (action === 'research') {
    const queries = Array.isArray(d.queries)
      ? (d.queries as unknown[])
          .map((q) => String(q).trim())
          .filter(Boolean)
          .slice(0, 3)
      : [];
    return { kind: 'go', goal, queries };
  }
  return null;
}

/** 截断工具结果，控制阶段3 输入体积。 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断）`;
}

export class PlanProposeAbortedError extends Error {
  constructor() {
    super('plan propose aborted');
    this.name = 'PlanProposeAbortedError';
  }
}

/**
 * 澄清防循环兜底计划：用户已回答全部问题、模型却仍重复追问时，用已确认目标合成一个
 * 最小可执行计划收口——「确认并继续」之后必须落到计划卡片，绝不再次弹出澄清卡。
 */
export function buildClarifyFallbackPlan(goal: string): ExecutionPlan {
  const g = (goal || '').trim() || '按已确认信息完成用户需求';
  return {
    goal: g,
    tasks: [
      {
        id: 't1',
        title: '围绕已确认目标交付结果',
        steps: [
          '复述已确认的目标与关键约束',
          '按目标逐项完成分析/制作，缺失信息以【数据缺口：待补充项】占位',
          '输出结构化结论与缺口清单'
        ],
        dependsOn: [],
        expectedOutput: '围绕已确认目标输出完整、可验收的结果（含数据缺口标注）'
      }
    ]
  };
}

/**
 * 运行 propose 管线，返回「计划 / 澄清 JSON 文本」作为 run 的 final。
 * 服务端 run:end 处的 parsePlanOrClarify 分发（plan:proposed / plan:clarify）保持不变。
 * 阶段3 无条件执行：即使阶段2 全部失败，也会基于空纪要产出计划（标注数据缺口）。
 * 澄清回复轮（输入带「—— 目标澄清回复 ——」标记）启用防重问守卫：模型把已回答问题
 * 换措辞重问时，带「已答清单」反馈重试一次；仍不收敛则剔除重复问题，无新问题可问时
 * 以兜底计划收口（guardClarifyEcho，见下）。
 */
export async function runPlanPropose(deps: PlanProposeDeps): Promise<string> {
  const emit = deps.emit ?? (() => {});
  const emitPhase = (idx: number): void => {
    emit({
      type: 'plan:phase',
      phase: PLAN_PHASES[idx] ?? '理解需求',
      ts: Date.now()
    });
  };
  const signal = deps.signal;
  const maxRounds = Math.max(1, deps.maxResearchRounds ?? 3);
  const maxResultChars = Math.max(500, deps.maxResultChars ?? 4000);
  const streamOn = deps.streamTokens !== false;
  let step = 0;

  const checkAborted = (): void => {
    if (signal?.aborted) throw new PlanProposeAbortedError();
  };

  /** 单次 LLM 调用（统一事件 + 流式 + 熔断接线）。 */
  const callLLM = async (
    messages: Message[],
    tools: ToolSchema[]
  ): Promise<LLMResponse> => {
    checkAborted();
    step += 1;
    emit({
      type: 'llm:call',
      step,
      messageCount: messages.length,
      toolCount: tools.length
    });
    const resp = await deps.llm(messages, tools, {
      signal,
      circuitBreaker: deps.circuitBreaker,
      ...(streamOn
        ? {
            onToken: (delta: string) => {
              emit({ type: 'llm:token', step, delta });
            },
            onReasoning: (delta: string) => {
              emit({ type: 'llm:reasoning', step, delta });
            }
          }
        : {})
    });
    emit({
      type: 'llm:response',
      step,
      content: resp.content,
      toolCalls: resp.tool_calls
    });
    return resp;
  };

  emit({ type: 'run:start', runId: 'plan-propose', input: deps.userInput });

  // ---- 会话记忆接线（与 harness 同一模式：system 一次性注入 + user/assistant 成对追加）----
  const memory = deps.memory;
  if (memory) {
    try {
      if (memory.hasPersistence) await memory.load();
      const ctx = memory.systemContext();
      const sys = deps.systemPrompt
        ? ctx
          ? `${deps.systemPrompt}\n\n${ctx}`
          : deps.systemPrompt
        : '';
      if (sys && !memory.history().some((m) => m.role === 'system')) {
        memory.add({ role: 'system', content: sys });
      }
    } catch {
      /* 记忆加载失败不阻断规划 */
    }
  }
  const history = (): Message[] => (memory ? memory.history() : []);
  const remember = (m: Message): void => {
    try {
      memory?.add(m);
    } catch {
      /* 记忆写入失败不阻断规划 */
    }
  };

  // 澄清回复轮识别（前端「确认并继续」再次派发）：输入带回复标记时启用防重问守卫。
  const clarifyReply = parseClarifyReply(deps.userInput);

  /**
   * 澄清防重问守卫（阶段1 / 阶段3 共用）：text 若是「重复追问已回答问题」的澄清 JSON，
   * 带「已答清单 + 禁重问」反馈重试一次；仍不收敛 → 剔除重复问题；无新问题可问 →
   * 以兜底计划收口。返回可直接作为 run final 的文本。
   * baseMsgs：重试时追加 assistant + 反馈的消息底座（阶段1 传 understandMsgs，阶段3 传 finalMsgs）。
   */
  const guardClarifyEcho = async (
    text: string,
    baseMsgs: Message[],
    fallbackGoal: string
  ): Promise<string> => {
    if (!clarifyReply) return text;
    const dupsOf = (c: PlanClarify): PlanClarifyQuestion[] =>
      c.questions.filter((q) =>
        isClarifyQuestionDuplicate(q.q, q.options, clarifyReply.qa)
      );
    const first = parsePlanOrClarify(text);
    if (!first || first.kind !== 'clarify') return text;
    const dups = dupsOf(first.clarify);
    if (dups.length === 0) return text; // 真正的新问题：正常多轮澄清，放行
    const echoed = dups.map((d) => d.q).join('；');
    const forcePlan = clarifyReply.round >= clarifyMaxRounds();
    const retried =
      (
        await callLLM(
          [
            ...baseMsgs,
            { role: 'assistant' as const, content: text },
            {
              role: 'user' as const,
              content:
                `（系统提示）你再次提问了用户已回答的问题：${echoed}。` +
                (forcePlan
                  ? `这已是用户第 ${clarifyReply.round} 轮澄清回复，禁止再输出澄清 JSON。`
                  : '禁止重复提问已回答的问题。') +
                '请立即基于已确认信息只输出计划 JSON：{"goal": string, "tasks": [{"id": "t1", "title": string, "steps": string[], "dependsOn": string[], "expectedOutput": string}]}，不要任何其他文字。'
            }
          ],
          []
        )
      ).content ?? '';
    const second = parsePlanOrClarify(retried);
    if (second && second.kind !== 'clarify') return retried; // 收敛为计划
    const src = second && second.kind === 'clarify' ? second.clarify : first.clarify;
    const fresh = src.questions.filter(
      (q) => !isClarifyQuestionDuplicate(q.q, q.options, clarifyReply.qa)
    );
    if (fresh.length > 0) {
      // 仍有用户未回答的新问题：只保留新问题，剥离重复项。
      return JSON.stringify({
        clarify: true,
        goalDraft: src.goalDraft,
        questions: fresh,
        ...(src.needs ? { needs: src.needs } : {})
      });
    }
    // 没有任何新问题可问：用已确认目标合成最小计划收口（绝不再弹澄清卡）。
    return JSON.stringify(buildClarifyFallbackPlan(src.goalDraft || fallbackGoal));
  };

  // ================= 阶段1：理解需求 =================
  emitPhase(0);
  remember({ role: 'user', content: deps.userInput });
  const understandMsgs: Message[] = [
    ...(deps.systemPrompt
      ? [{ role: 'system' as const, content: deps.systemPrompt }]
      : []),
    {
      role: 'user' as const,
      content: buildProposeUnderstandPrompt(deps.userInput, clarifyReply)
    }
  ];
  let understand = await callLLM(understandMsgs, []);
  let parsed = parseUnderstandOutput(understand.content ?? '');
  if (!parsed) {
    // 阶段1 解析失败：带错误反馈重试一次（不烧工具调用，成本可控）。
    understand = await callLLM(
      [
        ...understandMsgs,
        { role: 'assistant' as const, content: understand.content ?? '' },
        {
          role: 'user' as const,
          content:
            '（系统提示）上面的输出不是合法 JSON。请重新只输出一个符合要求的 JSON 对象（三分支之一），不要任何其他文字。'
        }
      ],
      []
    );
    parsed = parseUnderstandOutput(understand.content ?? '');
  }

  // 澄清分支：阶段1 的澄清 JSON 已满足契约，直接作为 final（服务端 parseClarifyOutput 分发）。
  // 防重问守卫（多轮澄清闭环修复）：这些问题用户上一轮已回答（换措辞重问，弱模型高发）、
  // 或澄清轮次已达上限时，不再弹澄清卡——按目标草稿继续走规划管线，由阶段3 守卫收敛。
  if (parsed?.kind === 'clarify') {
    const echoed =
      !!clarifyReply &&
      (clarifyReply.round >= clarifyMaxRounds() ||
        parsed.clarify.questions.some((q) =>
          isClarifyQuestionDuplicate(q.q, q.options, clarifyReply.qa)
        ));
    if (!echoed) {
      const finalText = understand.content ?? '';
      remember({ role: 'assistant', content: finalText });
      return finalText;
    }
    // 落到下方「直接规划」分支：goal 取目标草稿，queries 置空（不再调研，直奔阶段3）。
  }

  // 阶段1 两次解析均失败 / 澄清被防重问守卫收敛：带目标兜底走「直接规划」，不让整轮作废。
  const goal =
    parsed?.kind === 'go'
      ? parsed.goal
      : parsed?.kind === 'clarify' && parsed.clarify.goalDraft
        ? parsed.clarify.goalDraft
        : deps.userInput.slice(0, 200);
  const queries = parsed?.kind === 'go' ? parsed.queries : [];

  // ================= 阶段2：调研（受限小循环，服务端封顶）=================
  let researchNotes = '';
  const researchAllow = new Set(deps.researchTools ?? ['builtin__web_fetch']);
  const researchSchemas = deps.tools
    .schemas()
    .filter((t) => researchAllow.has(t.name));
  const hasResearchTools =
    researchSchemas.length > 0 && (queries.length > 0 || parsed?.kind === 'go');

  if (hasResearchTools) {
    emitPhase(1);
    const msgs: Message[] = [
      ...(deps.systemPrompt
        ? [{ role: 'system' as const, content: deps.systemPrompt }]
        : []),
      {
        role: 'user' as const,
        content: buildProposeResearchPrompt(deps.userInput, goal, maxRounds)
      }
    ];
    const collected: string[] = [];

    for (let round = 0; round < maxRounds; round++) {
      checkAborted();
      const resp = await callLLM(msgs, researchSchemas);
      msgs.push({
        role: 'assistant',
        content: resp.content ?? '',
        ...(resp.tool_calls?.length ? { tool_calls: resp.tool_calls } : {})
      });
      const calls: ToolCall[] = resp.tool_calls ?? [];
      if (calls.length === 0) {
        // 模型提前收尾：把其文本视为调研纪要。
        if (resp.content && resp.content.trim())
          collected.push(resp.content.trim());
        break;
      }
      for (const call of calls) {
        const args = (
          call.arguments && typeof call.arguments === 'object'
            ? call.arguments
            : {}
        ) as Record<string, unknown>;
        emit({
          type: 'tool:start',
          step,
          call: { id: call.id, name: call.name, arguments: args }
        });
        // 出网管控等护栏：被拦视为该条调研失败（记缺口），不作废整轮。
        const guard = checkToolArgs(call.name, args, deps.guardPolicy);
        if (!guard.ok) {
          const reason = `工具 ${call.name} 被护栏拦截：${
            guard.reason ?? 'policy'
          }`;
          collected.push(`数据缺口：${reason}`);
          emit({
            type: 'tool:result',
            step,
            call: { id: call.id, name: call.name, arguments: args },
            result: reason,
            errored: true
          });
          msgs.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: reason
          });
          continue;
        }
        try {
          const out = await deps.tools.call(call.name, args);
          const text = clip(
            typeof out === 'string' ? out : JSON.stringify(out ?? ''),
            maxResultChars
          );
          collected.push(`【${call.name}】${JSON.stringify(args)}\n${text}`);
          emit({
            type: 'tool:result',
            step,
            call: { id: call.id, name: call.name, arguments: args },
            result: text,
            errored: false
          });
          msgs.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: text
          });
        } catch (e: unknown) {
          const msg = `工具调用失败：${
            e instanceof Error ? e.message : String(e)
          }`;
          collected.push(`数据缺口：${msg}`);
          emit({
            type: 'tool:result',
            step,
            call: { id: call.id, name: call.name, arguments: args },
            result: msg,
            errored: true
          });
          msgs.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: msg
          });
        }
      }
    }
    researchNotes = collected.join('\n\n').slice(0, maxResultChars * 3);
  }

  // ================= 阶段3：生成计划（无工具，无条件执行）=================
  checkAborted();
  emitPhase(2);
  const finalMsgs: Message[] = [
    ...(deps.systemPrompt
      ? [{ role: 'system' as const, content: deps.systemPrompt }]
      : []),
    {
      role: 'user' as const,
      content: buildProposeFinalPrompt(
        deps.userInput,
        goal,
        researchNotes,
        clarifyReply
      )
    }
  ];
  let fin = await callLLM(finalMsgs, []);
  let finalText = fin.content ?? '';
  if (!parsePlanOrClarify(finalText)) {
    // 解析失败：附错误反馈重试一次（仍无工具，纯文本修复）。
    fin = await callLLM(
      [
        ...finalMsgs,
        { role: 'assistant' as const, content: finalText },
        {
          role: 'user' as const,
          content:
            '（系统提示）上面的输出不是合法的计划/澄清 JSON。请重新只输出一个合法 JSON 对象（格式 A 计划或格式 B 澄清），不要任何其他文字。'
        }
      ],
      []
    );
    finalText = fin.content ?? '';
  }
  // 澄清防重问守卫（阶段3）：模型仍把已回答问题换措辞重问时，带「已答清单」反馈重试
  // 一次；仍不收敛则剔除重复问题，无新问题可问时以兜底计划收口——保证「确认并继续」
  // 之后必然拿到计划卡片，而不是下一张澄清卡（修复重复追问死循环）。
  if (clarifyReply) {
    finalText = await guardClarifyEcho(finalText, finalMsgs, goal);
  }
  // 最终仍不可解析：不再把空/垃圾文本当 final 上抛。此前该路径把 '' 直接交给服务端
  // run:end，前端既无计划也无内容，只能渲染「规划未完成：连接可能已中断或处理超时」
  // 死路占位（已烧掉的 token 全部作废，用户唯一出路是整轮重发）。现按已确认目标合成
  // 最小计划收口，与防重问守卫同一兜底哲学：propose 必须产出计划或澄清，绝不返回空。
  // 典型触发：provider 思考期超过 LLM_STREAM_IDLE_TIMEOUT_MS（默认 120s）被空闲超时
  // 截断、返回空 content —— 空响应重试一次仍空，走到这里。
  if (!parsePlanOrClarify(finalText)) {
    finalText = JSON.stringify(buildClarifyFallbackPlan(goal));
  }
  remember({ role: 'assistant', content: finalText });
  return finalText;
}
