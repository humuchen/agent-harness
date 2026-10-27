// 输出护栏门禁（runInner 段 E6）：产出后按「计划 propose / 计划任务 / 普通输出」
// 三种口径选择校验函数，拦截时走三档优雅兜底（safeReply / 温和重试 / 中性兜底）。
// P1#21 H2 自 runInner 迁出，语义逐字等价。
//
// 循环控制契约：runLoop 中本段含 continue（重试注入后跳回下一步）与 return（终态），
// 提取为函数后以动作枚举表达——调用方按 kind 分派，语义与内联版完全一致。
import type { Memory } from '../../memory';
import type { GuardrailPolicy } from '../../guardrails';
import {
  checkStructuredOutput,
  checkTaskOutput,
  checkOutputAsync,
} from '../../guardrails';
import { parsePlanOutput } from '../../plan';
import { recordError, structLog } from '../../telemetry';
import { GUARDRAIL_FALLBACK_PREFIX } from '../../workflow/step-output';
import type { HarnessEvent } from '../types';

export type OutputGateAction =
  | { kind: 'pass' }
  | { kind: 'continue' }
  | { kind: 'final'; text: string };

export interface OutputGateInput {
  content: string;
  planPropose?: boolean;
  planTask?: boolean;
  guardrailPolicy?: GuardrailPolicy;
  /** 最近一次工具结果（输出护栏的业务上下文，如知识库查空信号）。 */
  recentTool?: { name: string; result: string } | null;
  /** 进入本步时的剩余温和重试次数（调用方在返回后写回 result.guardrailRetriesLeft）。 */
  guardrailRetriesLeft: number;
  memory: Memory;
  emit: (e: HarnessEvent) => void;
  runId: string;
}

export interface OutputGateResult {
  action: OutputGateAction;
  /** 新的剩余温和重试次数（continue 路径已 -1，其余不变）。 */
  guardrailRetriesLeft: number;
  /** 新的累计拦截次数（拦截路径 +1，pass 不变）。 */
  guardrailsBlocked: number;
}

export async function runOutputGate(input: OutputGateInput): Promise<OutputGateResult> {
  const { content, memory, emit, runId } = input;
  let guardrailRetriesLeft = input.guardrailRetriesLeft;

  // 计划模式 propose（P0）：输出能解析为合法计划 JSON 时，仅做密钥/注入扫描
  // （checkStructuredOutput），跳过业务自定义规则与上下文规则——结构化任务描述
  // 极易被领域合规正则（如医疗广告法关键词）误伤，导致计划永远生成失败。
  // 解析不出计划的输出（含中间工具调用轮次）仍走完整 checkOutput，行为不变。
  // 计划任务执行（planTask）：输出为面向用户的教学/执行内容，走 checkTaskOutput
  // ——「system prompt」等弱信号短语与宽松的密钥赋值样例正则会把架构讲解
  // 误拦成兜底话术（实测 stealth/ox-alpha 概念综述即被拦）；安全底线
  // （真实密钥格式 + 强信号注入短语）不放松。普通问答仍走完整 checkOutput。
  const structuredPlan = input.planPropose ? parsePlanOutput(content) : null;
  const outGuard = structuredPlan
    ? checkStructuredOutput(content, input.guardrailPolicy)
    : input.planTask
    ? checkTaskOutput(content, input.guardrailPolicy)
    : await checkOutputAsync(
        content,
        input.guardrailPolicy,
        input.recentTool ? { recentTool: input.recentTool } : undefined
      );
  if (outGuard.ok) return { action: { kind: 'pass' }, guardrailRetriesLeft, guardrailsBlocked: 0 };

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
  // 拦截计数（三档兜底均计）。
  const guardrailsBlockedDelta = 1;

  // 优雅兜底（三档，避免向用户暴露 [guardrail] blocked 方括号文本）：
  // 1) 拦截规则自带合规安全回复（如知识库查空的标准「建议预约面诊」话术）→ 直接采用，
  //    零额外 LLM 成本、零幻觉风险，体验最佳。
  if (outGuard.safeReply) {
    return { action: { kind: 'final', text: outGuard.safeReply }, guardrailRetriesLeft, guardrailsBlocked: guardrailsBlockedDelta };
  }

  // 密钥 / 注入类拦截：重试无意义且可能再次泄露，直接走中性兜底。
  const isSecretOrInjection =
    !!outGuard.reason &&
    (outGuard.reason.includes('secret') || outGuard.reason.includes('injection'));

  // 2) 合规内容类拦截（非密钥/注入）→ 温和重试一次：注入纠正提示让模型重新生成。
  //    计划模式 propose 下，纠正提示必须保持「只输出计划 JSON」的格式约束，
  //    否则模型会被带偏成合规话术，计划解析必然失败。
  if (!isSecretOrInjection && guardrailRetriesLeft > 0) {
    guardrailRetriesLeft -= 1;
    memory.add({
      role: 'user',
      content: input.planPropose
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
    return { action: { kind: 'continue' }, guardrailRetriesLeft, guardrailsBlocked: guardrailsBlockedDelta };
  }

  // 3) 重试仍不通过 / 无 safeReply → 中性安全兜底，绝不暴露内部拦截文本。
  // P4.5：兜底话术前缀与 step-output 检测器共享同一常量（单源，防字面量漂移）。
  return {
    action: { kind: 'final', text: GUARDRAIL_FALLBACK_PREFIX + '。如有进一步需求，建议您通过官方正规渠道咨询。' },
    guardrailRetriesLeft,
    guardrailsBlocked: guardrailsBlockedDelta,
  };
}
