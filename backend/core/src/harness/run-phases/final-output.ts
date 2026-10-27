// 终态判定段（runInner 段 E8）：无工具调用时的三种走向——requireCompletion 空响应
// 继续循环 / partial 断流兜底文案 / 正常最终答案。P1#21 H2 自 runInner 迁出，逐字等价。
// 循环控制以动作枚举表达（与 output-gate 同一范式）。
import type { Memory } from '../../memory';
import { PARTIAL_NOTICE } from '../../workflow/step-output';

export interface FinalOutputInput {
  /** LLM 响应的三个被消费字段（调用方从 resp 解构透传）。 */
  content: string;
  toolCalls: unknown[] | undefined;
  partial?: boolean;
  requireCompletion?: boolean;
  steps: number;
  maxSteps: number;
  memory: Memory;
}

export type FinalOutputAction =
  | { kind: 'continue' }
  | { kind: 'final'; text: string }
  | { kind: 'tools' };

export function resolveFinalOutput(input: FinalOutputInput): FinalOutputAction {
  const { content, toolCalls, partial, requireCompletion, steps, maxSteps, memory } = input;
  if (!toolCalls || toolCalls.length === 0) {
    // 可选「完成自检」：开启且模型以空响应（疑似放弃）收尾时，注入提示继续
    // 循环直到 maxSteps，避免复杂任务被「空响应即结束」提前中断。非空回复
    // 一律视为真实最终答案，不二次质疑（避免干扰正常收尾、也避免额外成本）。
    if (requireCompletion && (!content || !content.trim()) && steps < maxSteps) {
      memory.add({
        role: 'user',
        content:
          '（系统提示）你还没有给出实质性结果，请继续完成任务；若需要信息，请调用工具。'
      });
      return { kind: 'continue' };
    }
    // 中段断流兜底：provider 空闲超时后返回的是部分内容（partial:true）。
    // 显式追加「生成中断」提示，让用户清楚这是被截断而非完整回答。
    // P4.5：中断标记与 step-output 检测器共享同一常量（引擎闸门 / 黑板注记认它）。
    if (partial) {
      return {
        kind: 'final',
        text:
          `${content}\n\n` +
          `${PARTIAL_NOTICE}：与模型的连接空闲超时（可在服务端调高 LLM_STREAM_IDLE_TIMEOUT_MS）。` +
          '以上内容仅为已生成的部分结果，请重试以继续。'
      };
    }
    return { kind: 'final', text: content };
  }
  return { kind: 'tools' };
}
